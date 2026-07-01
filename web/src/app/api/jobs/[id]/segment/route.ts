import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { prisma } from "@/lib/db";
import { absPathFor, chunksJsonKey } from "@/lib/storage";
import { getSessionId } from "@/lib/session";
import { segmentTranscript, type WordEntry } from "@/lib/segmenter";
import { findDuplicates, type CandidateChunk } from "@/lib/dedupe";
import { enrichChunk, type EnrichmentSource } from "@/lib/enrich";
import { rewriteChunksJson } from "@/lib/chunksFile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60 * 5;

type CleanLevel = "light" | "standard" | "aggressive";
const VALID_LEVELS: ReadonlyArray<CleanLevel> = [
  "light",
  "standard",
  "aggressive",
];

const MIN_TARGET = 5;
const MAX_TARGET = 60;

function clampTarget(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 20;
  return Math.max(MIN_TARGET, Math.min(MAX_TARGET, Math.round(v)));
}

function parseLevel(raw: string | null): CleanLevel | null {
  return VALID_LEVELS.includes(raw as CleanLevel) ? (raw as CleanLevel) : null;
}

/**
 * GET /api/jobs/[id]/segment
 *
 * - With both `?level=` and `?targetMin=` → returns the single SegmentRun
 *   (used by the wizard for polling). 404 if no row exists.
 * - Without query params → returns the array of all SegmentRuns for this
 *   job (used to hydrate the source picker).
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    select: { sessionCookie: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const level = parseLevel(url.searchParams.get("level"));
  const targetParam = url.searchParams.get("targetMin");

  if (level && targetParam) {
    const targetMin = clampTarget(targetParam);
    const row = await prisma.segmentRun.findUnique({
      where: {
        jobId_cleanLevel_targetMin: {
          jobId: id,
          cleanLevel: level,
          targetMin,
        },
      },
    });
    if (!row) {
      return NextResponse.json(
        { error: "No segment run for that level + target" },
        { status: 404 },
      );
    }
    return NextResponse.json(row);
  }

  const rows = await prisma.segmentRun.findMany({
    where: { jobId: id },
    orderBy: [{ cleanLevel: "asc" }, { targetMin: "asc" }],
  });
  return NextResponse.json(rows);
}

/**
 * POST /api/jobs/[id]/segment
 *
 * Body: { cleanLevel: "light"|"standard"|"aggressive", targetMin: 5..60 }
 *
 * Starts (or re-runs) GPT-4o topic segmentation against the chosen
 * cleaned source at the requested target chunk size. Each (jobId,
 * cleanLevel, targetMin) gets its own row + chunks so the user can
 * compare combinations without re-running.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const body = (await request.json().catch(() => ({}))) as {
    cleanLevel?: string;
    targetMin?: number;
  };
  const cleanLevel = parseLevel(body.cleanLevel ?? null);
  if (!cleanLevel) {
    return NextResponse.json(
      { error: "Missing or invalid cleanLevel" },
      { status: 400 },
    );
  }
  const targetMin = clampTarget(body.targetMin);

  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      cleanedVersions: { where: { cleanLevel } },
      segmentRuns: {
        where: { cleanLevel, targetMin },
      },
    },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cleanedRow = job.cleanedVersions[0];
  if (!cleanedRow || cleanedRow.status !== "ready") {
    return NextResponse.json(
      { error: `No ready cleaned transcript at the ${cleanLevel} level` },
      { status: 409 },
    );
  }
  if (!cleanedRow.cleanedWordsKey) {
    return NextResponse.json(
      { error: "Cleaned transcript missing word-level data" },
      { status: 409 },
    );
  }

  const existing = job.segmentRuns[0] ?? null;
  // Idempotency: a run already in flight for this combo → return as-is.
  // STALE-CLAIM RECOVERY: a row stuck in `segmenting` for >10 min is
  // almost certainly orphaned (runner crashed mid-pass). Reset to
  // `failed` so re-segment can claim it. 10 min ≫ a typical 2-3 min
  // segmentation run.
  const STALE_MINUTES = 10;
  const isStuck =
    existing?.status === "segmenting" &&
    !!existing.startedAt &&
    Date.now() - new Date(existing.startedAt).getTime() >
      STALE_MINUTES * 60_000;
  if (existing?.status === "segmenting" && !isStuck) {
    return NextResponse.json(existing, { status: 200 });
  }
  if (isStuck) {
    console.warn(
      `[segment] stale-claim recovery for job=${id} — row stuck in 'segmenting' for >${STALE_MINUTES} min, resetting`,
    );
    await prisma.segmentRun
      .update({
        where: { id: existing!.id },
        data: {
          status: "failed",
          errorCode: "E_STALE_CLAIM",
          errorMessage: `Recovered: runner stuck in 'segmenting' for >${STALE_MINUTES} min`,
        },
      })
      .catch(() => {});
  }
  // ready/failed rows (and recovered-stale rows) fall through and re-run.

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        error:
          "Segmentation is not configured. Set OPENAI_API_KEY in web/.env.local and restart the dev server.",
        code: "E_OPENAI_AUTH",
      },
      { status: 503 },
    );
  }

  // Atomic claim — see /extract route for the pattern. Without this, two
  // concurrent POSTs (e.g. rapid double-click on Auto-detect topics) can
  // both pass the existing.status === "segmenting" guard and both fire
  // the runner, doubling the GPT-4o spend and racing on chunks.json.
  let claimed = false;
  if (!existing) {
    try {
      await prisma.segmentRun.create({
        data: {
          jobId: id,
          cleanLevel,
          targetMin,
          status: "segmenting",
          progress: 10,
          startedAt: new Date(),
        },
      });
      claimed = true;
    } catch {
      // Lost the create race; fall through to conditional update.
    }
  }
  if (!claimed) {
    const result = await prisma.segmentRun.updateMany({
      where: {
        jobId: id,
        cleanLevel,
        targetMin,
        status: { in: ["pending", "ready", "failed"] },
      },
      data: {
        status: "segmenting",
        progress: 10,
        chunkCount: null,
        totalWordCount: null,
        chunksJsonKey: null,
        errorCode: null,
        errorMessage: null,
        startedAt: new Date(),
        readyAt: null,
      },
    });
    claimed = result.count === 1;
  }

  const runRow = await prisma.segmentRun.findUnique({
    where: {
      jobId_cleanLevel_targetMin: { jobId: id, cleanLevel, targetMin },
    },
  });
  if (!runRow) {
    return NextResponse.json(
      { error: "Failed to claim segmentation slot" },
      { status: 500 },
    );
  }
  if (!claimed) {
    return NextResponse.json(runRow, { status: 200 });
  }

  // Capture manual edits BEFORE wiping the prior chunks so we can
  // re-apply them after the new tree is built. We can't strictly
  // distinguish GPT-named from user-renamed chunks (we don't track an
  // `originalTopic` field), so the heuristic is: any prior chunk
  // whose time range substantially overlaps a new planet's range
  // donates its topic to the new planet. When the user re-segments
  // with the SAME (cleanLevel, targetMin), boundaries are usually
  // near-identical, so renames survive. When they change params,
  // shifted boundaries → less overlap → new GPT titles win.
  const priorPlanetTopics: Array<{
    topic: string;
    preview: string;
    startSec: number;
    endSec: number;
  }> = await prisma.chunk.findMany({
    where: {
      segmentRunId: runRow.id,
      level: "planet",
    },
    select: { topic: true, preview: true, startSec: true, endSec: true },
  });

  // Wipe any previous chunks for this run (re-runs only).
  await prisma.chunk.deleteMany({ where: { segmentRunId: runRow.id } });

  // Move JobStatus to "split". The user advances manually to step 6.
  await prisma.jobStatus.upsert({
    where: { jobId: id },
    create: { jobId: id, status: "split", progress: 10 },
    update: { status: "split", progress: 10 },
  });

  void runSegmentation({
    jobId: id,
    runId: runRow.id,
    cleanLevel,
    targetMin,
    cleanedWordsKey: cleanedRow.cleanedWordsKey,
    // Pass cleaned-timeline duration (source minus removed). The runner
    // still prefers wordsFile.durationSec from disk if present; this is
    // the fallback when the cleaned_words.json lacks a duration field.
    totalDurationSec: Math.max(
      0,
      (job.sourceDurationSec ?? 0) - (cleanedRow.removedDurSec ?? 0),
    ),
    // Forward parent-job id so the runner can decide whether to run the
    // cross-video dedup pass. NULL for standalone single-video jobs —
    // dedup is skipped entirely and behavior is unchanged from before.
    parentJobId: job.parentJobId,
    // Manual edits from prior run, to be re-applied to overlapping new
    // planets so user renames survive Re-segment. Empty on first run.
    priorPlanetTopics,
  }).catch((err) => console.error("[segment] background crashed", err));

  return NextResponse.json(runRow, { status: 202 });
}

export async function runSegmentation(params: {
  jobId: string;
  runId: string;
  cleanLevel: CleanLevel;
  targetMin: number;
  cleanedWordsKey: string;
  totalDurationSec: number;
  // Set for child jobs (kind=playlist_video / batch_file). NULL for
  // standalone jobs — when NULL, the cross-video dedup pass is skipped.
  parentJobId?: string | null;
  // Optional: manual topic edits from a prior run of THIS exact
  // (cleanLevel, targetMin) combo. Re-applied to overlapping new
  // planets so user renames survive Re-segment. See route POST handler
  // for how this is captured before the chunk wipe.
  priorPlanetTopics?: Array<{
    topic: string;
    preview: string;
    startSec: number;
    endSec: number;
  }>;
}) {
  const {
    jobId,
    runId,
    cleanLevel,
    targetMin,
    cleanedWordsKey,
    parentJobId,
    priorPlanetTopics = [],
  } = params;

  try {
    const wordsAbs = absPathFor(cleanedWordsKey);
    const wordsBuf = await fs.readFile(wordsAbs, "utf8");
    const wordsFile = JSON.parse(wordsBuf) as { words: WordEntry[]; durationSec?: number };
    const cleanedWords = Array.isArray(wordsFile.words) ? wordsFile.words : [];
    // Use the cleaned-words file's own duration if present (already
    // accounts for removed segments). Falls back to job source duration.
    const totalDurationSec =
      wordsFile.durationSec ?? params.totalDurationSec ?? 0;

    // 25% — inputs loaded, about to call GPT for boundary detection.
    await prisma.segmentRun
      .update({ where: { id: runId }, data: { progress: 25 } })
      .catch(() => {});
    await prisma.jobStatus
      .update({ where: { jobId }, data: { progress: 25 } })
      .catch(() => {});

    const result = await segmentTranscript({
      cleanedWords,
      targetMin,
      totalDurationSec,
      // Two-pass GPT inside the segmenter library, then dedup + enrich
      // afterwards. Re-budgeted progress to leave room for Pass 3 (dedup)
      // and Pass 4 (enrich):
      //   25% inputs loaded
      //   25→45% Pass 1 boundaries
      //   45→70% Pass 2 titles
      //   70% disk write
      //   75% dedup done
      //   80→95% enrich
      //   95→100% DB writes
      onProgress: async ({ pass, percent }) => {
        const mapped =
          pass === "boundaries"
            ? 25 + Math.round((percent / 100) * 20)
            : 45 + Math.round((percent / 100) * 25);
        await prisma.segmentRun
          .update({ where: { id: runId }, data: { progress: mapped } })
          .catch(() => {});
        await prisma.jobStatus
          .update({ where: { jobId }, data: { progress: mapped } })
          .catch(() => {});
      },
    });

    // 70% — Pass 1+2 done, about to write chunks.json to disk.
    await prisma.segmentRun
      .update({ where: { id: runId }, data: { progress: 70 } })
      .catch(() => {});
    await prisma.jobStatus
      .update({ where: { jobId }, data: { progress: 70 } })
      .catch(() => {});

    // ─── Tree flattening helpers ──────────────────────────────────
    // The segmenter returns a 3-level tree (suns ▸ planets ▸ moons).
    // Dedup + enrich operate ONLY on planets (the render unit). We
    // flatten the planets here, key everything by a string path
    // "sunIdx.planetIdx", then walk the tree at insert time to attach
    // dedup/enrich metadata to the right rows.
    type PlanetRef = {
      sunIdx: number;
      planetIdx: number;
      planet: (typeof result.suns)[number]["planets"][number];
    };
    const planetRefs: PlanetRef[] = [];
    for (const [sunIdx, sun] of result.suns.entries()) {
      for (const [planetIdx, p] of sun.planets.entries()) {
        planetRefs.push({ sunIdx, planetIdx, planet: p });
      }
    }
    const planetCount = planetRefs.length;

    // ----- Cross-video dedup (child jobs only) -----
    // Operates on PLANETS only. Suns are navigation labels; moons are
    // sub-sections. Best-effort: a thrown error logs and skips dedup
    // for the run; segmentation still produces chunks.
    const dedupByPath = new Map<
      string,
      { canonicalId: string; reason: string }
    >();
    if (parentJobId && planetCount > 0) {
      try {
        const siblingChunks = await prisma.chunk.findMany({
          where: {
            duplicateOfChunkId: null,
            // Sibling pool is canonical PLANETS only — suns/moons don't
            // participate in dedup.
            level: "planet",
            segmentRun: {
              job: {
                parentJobId,
                NOT: { id: jobId },
              },
            },
          },
          select: { id: true, topic: true, preview: true },
          orderBy: { createdAt: "desc" },
          take: 200,
        });

        if (siblingChunks.length > 0) {
          const siblingCandidates: CandidateChunk[] = siblingChunks.map(
            (s) => ({ id: s.id, topic: s.topic, preview: s.preview }),
          );
          const newCandidates: CandidateChunk[] = planetRefs.map((r) => ({
            id: "",
            topic: r.planet.topic,
            preview: r.planet.preview,
          }));

          const matches = await findDuplicates({
            newChunks: newCandidates,
            siblingChunks: siblingCandidates,
          });

          for (const m of matches) {
            const ref = planetRefs[m.newIdx];
            if (!ref) continue;
            dedupByPath.set(`${ref.sunIdx}.${ref.planetIdx}`, {
              canonicalId: m.canonicalId,
              reason: m.reason,
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[segment] dedup skipped for job ${jobId} (parent ${parentJobId}): ${message}`,
        );
      }
    }

    // 75% — dedup done (or skipped), about to enrich.
    await prisma.segmentRun
      .update({ where: { id: runId }, data: { progress: 75 } })
      .catch(() => {});
    await prisma.jobStatus
      .update({ where: { jobId }, data: { progress: 75 } })
      .catch(() => {});

    // ----- Pass 4: per-chunk web enrichment (planets only) -----
    type EnrichEntry =
      | { status: "ready"; text: string; sources: EnrichmentSource[] }
      | { status: "skipped"; reason: string }
      | { status: "failed"; error: string };
    const enrichByPath = new Map<string, EnrichEntry>();

    if (planetCount > 0) {
      // Enrichment now runs through OpenAI only (Tavily was removed —
      // the GPT-only polish pass doesn't need web search). The OpenAI
      // key is already required for Step 4 + Pass 1/2/3 above, so we
      // only fall into the "skipped" branch in tests / misconfigured
      // dev setups.
      const openaiKeyPresent = !!process.env.OPENAI_API_KEY?.trim();

      // Mark every duplicate planet as skipped first.
      for (const r of planetRefs) {
        const path = `${r.sunIdx}.${r.planetIdx}`;
        if (dedupByPath.has(path)) {
          enrichByPath.set(path, {
            status: "skipped",
            reason: "duplicate of another chunk",
          });
        }
      }

      if (!openaiKeyPresent) {
        console.warn(
          `[segment] enrichment skipped for job ${jobId}: OPENAI_API_KEY not set`,
        );
        for (const r of planetRefs) {
          const path = `${r.sunIdx}.${r.planetIdx}`;
          if (!enrichByPath.has(path)) {
            enrichByPath.set(path, {
              status: "skipped",
              reason: "OPENAI_API_KEY not configured",
            });
          }
        }
      } else {
        const jobMeta = await prisma.job
          .findUnique({
            where: { id: jobId },
            select: { sourceName: true },
          })
          .catch(() => null);
        const contextHint = jobMeta?.sourceName ?? undefined;

        const ENRICH_CONCURRENCY = Math.max(
          1,
          Math.min(8, Number(process.env.ENRICH_CONCURRENCY) || 3),
        );

        const canonicalRefs = planetRefs.filter(
          (r) => !enrichByPath.has(`${r.sunIdx}.${r.planetIdx}`),
        );

        let done = 0;
        for (let i = 0; i < canonicalRefs.length; i += ENRICH_CONCURRENCY) {
          const batch = canonicalRefs.slice(i, i + ENRICH_CONCURRENCY);
          await Promise.all(
            batch.map(async (r) => {
              const path = `${r.sunIdx}.${r.planetIdx}`;
              try {
                const out = await enrichChunk({
                  topic: r.planet.topic,
                  text: r.planet.text,
                  contextHint,
                });
                enrichByPath.set(path, {
                  status: "ready",
                  text: out.enrichedText,
                  sources: out.sources,
                });
              } catch (err) {
                const message =
                  err instanceof Error ? err.message : String(err);
                console.warn(
                  `[segment] enrich failed for job ${jobId} planet ${path} (${r.planet.topic}): ${message}`,
                );
                enrichByPath.set(path, {
                  status: "failed",
                  error: message.slice(0, 500),
                });
              }
            }),
          );
          done += batch.length;
          const mapped =
            80 + Math.round((done / Math.max(1, canonicalRefs.length)) * 15);
          await prisma.segmentRun
            .update({ where: { id: runId }, data: { progress: mapped } })
            .catch(() => {});
          await prisma.jobStatus
            .update({ where: { jobId }, data: { progress: mapped } })
            .catch(() => {});
        }
      }
    }

    // 95% — enrich done, about to insert chunks bottom-up.
    await prisma.segmentRun
      .update({ where: { id: runId }, data: { progress: 95 } })
      .catch(() => {});
    await prisma.jobStatus
      .update({ where: { jobId }, data: { progress: 95 } })
      .catch(() => {});

    // ─── Tree insert (single transaction) ─────────────────────────
    // Insert top-down so child rows can reference their parent's id.
    // Suns first, then planets under each sun, then moons under each
    // planet. Suns + moons get enrichmentStatus="skipped" with a clear
    // reason — they aren't render units, so Pass 4 doesn't apply.
    let totalRowsInserted = 0;
    if (result.suns.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const [sunIdx, sun] of result.suns.entries()) {
          const sunRow = await tx.chunk.create({
            data: {
              segmentRunId: runId,
              idx: sunIdx,
              level: "sun",
              parentChunkId: null,
              topic: sun.topic,
              preview: sun.preview,
              startSec: sun.startSec,
              endSec: sun.endSec,
              // Suns have no own text/word slice — they're navigation
              // groupings. wordCount=0, text=null is the convention.
              wordCount: 0,
              text: null,
              duplicateOfChunkId: null,
              duplicateReason: null,
              enrichedText: null,
              enrichmentSources: null as never,
              enrichmentStatus: "skipped",
              enrichmentError: "navigation node — not rendered",
            },
          });
          totalRowsInserted++;

          for (const [planetIdx, planet] of sun.planets.entries()) {
            const path = `${sunIdx}.${planetIdx}`;
            const dup = dedupByPath.get(path);
            const enr = enrichByPath.get(path);
            const enrichStatus = enr?.status ?? "skipped";
            const enrichedText =
              enr?.status === "ready" ? enr.text : null;
            const enrichmentSources =
              enr?.status === "ready" ? enr.sources : null;
            const enrichmentError =
              enr?.status === "failed" ? enr.error : null;

            // Preserve manual topic edits from the prior run by
            // overlap-matching this new planet against priorPlanetTopics.
            // If a prior planet's time range overlaps this one by ≥70 %
            // (relative to the larger of the two), assume the user's
            // intent transfers and keep the prior topic + preview.
            // Threshold is generous enough that small boundary shifts
            // from re-segmenting at the same params don't drop edits,
            // but tight enough that wildly different boundaries (e.g.
            // changing targetMin) revert to the new GPT title.
            const preserved = findBestOverlapMatch(
              { startSec: planet.startSec, endSec: planet.endSec },
              priorPlanetTopics,
              0.7,
            );

            const planetRow = await tx.chunk.create({
              data: {
                segmentRunId: runId,
                idx: planetIdx,
                level: "planet",
                parentChunkId: sunRow.id,
                topic: preserved?.topic ?? planet.topic,
                preview: preserved?.preview ?? planet.preview,
                startSec: planet.startSec,
                endSec: planet.endSec,
                wordCount: planet.wordCount,
                text: planet.text,
                duplicateOfChunkId: dup?.canonicalId ?? null,
                duplicateReason: dup?.reason ?? null,
                enrichedText,
                enrichmentSources: enrichmentSources as never,
                enrichmentStatus: enrichStatus,
                enrichmentError,
              },
            });
            totalRowsInserted++;

            for (const [moonIdx, moon] of planet.moons.entries()) {
              await tx.chunk.create({
                data: {
                  segmentRunId: runId,
                  idx: moonIdx,
                  level: "moon",
                  parentChunkId: planetRow.id,
                  topic: moon.topic,
                  preview: moon.preview,
                  startSec: moon.startSec,
                  endSec: moon.endSec,
                  wordCount: moon.wordCount,
                  text: moon.text,
                  duplicateOfChunkId: null,
                  duplicateReason: null,
                  enrichedText: null,
                  enrichmentSources: null as never,
                  enrichmentStatus: "skipped",
                  enrichmentError:
                    "sub-section of planet — rendered as part of parent's script",
                },
              });
              totalRowsInserted++;
            }
          }
        }
      });
    }

    // Persist chunks.json on disk AFTER the inserts so it captures the
    // real DB ids (parentChunkId references). Helper rebuilds from DB.
    await rewriteChunksJson(runId);
    const chunksKey = chunksJsonKey(jobId, cleanLevel, targetMin);

    await prisma.segmentRun.update({
      where: { id: runId },
      data: {
        status: "ready",
        progress: 100,
        // chunkCount = number of PLANETS (the render units). This is
        // what's user-visible as "N chunks at 20 min" and what Step 6
        // iterates to render avatar videos.
        chunkCount: planetCount,
        totalWordCount: result.totalWordCount,
        chunksJsonKey: chunksKey,
        readyAt: new Date(),
      },
    });

    // Advance JobStatus to "render" so Step 6 unlocks.
    await prisma.jobStatus.update({
      where: { jobId },
      data: { status: "render", progress: 0 },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code ?? "E_OPENAI_NETWORK";
    console.error("[segment] failed", code, message);
    await prisma.segmentRun
      .update({
        where: { id: runId },
        data: {
          status: "failed",
          errorCode: code,
          errorMessage: message.slice(0, 500),
        },
      })
      .catch(() => {});
    await prisma.jobStatus
      .update({ where: { jobId }, data: { status: "failed" } })
      .catch(() => {});
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Find the prior chunk whose time range best overlaps `target`, IF the
 * overlap ratio (relative to the larger of the two ranges) meets the
 * threshold. Returns null when no candidate clears the bar.
 *
 * Used by Re-segment to preserve user-renamed planet topics when their
 * boundaries roughly survive a re-run with the same parameters.
 */
function findBestOverlapMatch<T extends { startSec: number; endSec: number }>(
  target: { startSec: number; endSec: number },
  candidates: readonly T[],
  minRatio: number,
): T | null {
  let best: T | null = null;
  let bestRatio = 0;
  const targetLen = target.endSec - target.startSec;
  if (targetLen <= 0) return null;
  for (const c of candidates) {
    const cLen = c.endSec - c.startSec;
    if (cLen <= 0) continue;
    const overlap = Math.max(
      0,
      Math.min(target.endSec, c.endSec) - Math.max(target.startSec, c.startSec),
    );
    if (overlap <= 0) continue;
    const ratio = overlap / Math.max(targetLen, cLen);
    if (ratio >= minRatio && ratio > bestRatio) {
      bestRatio = ratio;
      best = c;
    }
  }
  return best;
}
