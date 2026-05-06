import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { absPathFor, chunksJsonKey } from "@/lib/storage";
import { getSessionId } from "@/lib/session";
import { segmentTranscript, type WordEntry } from "@/lib/segmenter";

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
  if (existing?.status === "segmenting") {
    return NextResponse.json(existing, { status: 200 });
  }
  // ready/failed rows fall through and re-run (UI's explicit Re-segment).

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
}) {
  const { jobId, runId, cleanLevel, targetMin, cleanedWordsKey } = params;

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
      // Two-pass GPT: 50% after boundaries, 100% after titles.
      onProgress: async ({ pass, percent }) => {
        // Reserve 25-50% for pass 1 boundaries, 50-90% for pass 2 titles.
        const mapped =
          pass === "boundaries"
            ? 25 + Math.round((percent / 100) * 25)
            : 50 + Math.round((percent / 100) * 40);
        await prisma.segmentRun
          .update({ where: { id: runId }, data: { progress: mapped } })
          .catch(() => {});
        await prisma.jobStatus
          .update({ where: { jobId }, data: { progress: mapped } })
          .catch(() => {});
      },
    });

    // 90% — GPT done, about to write outputs to disk.
    await prisma.segmentRun
      .update({ where: { id: runId }, data: { progress: 90 } })
      .catch(() => {});
    await prisma.jobStatus
      .update({ where: { jobId }, data: { progress: 90 } })
      .catch(() => {});

    // Persist chunks.json on disk (alongside cleaned outputs).
    const chunksKey = chunksJsonKey(jobId, cleanLevel, targetMin);
    const chunksAbs = absPathFor(chunksKey);
    await fs.mkdir(path.dirname(chunksAbs), { recursive: true });
    await fs.writeFile(
      chunksAbs,
      JSON.stringify(
        {
          cleanLevel,
          targetMin,
          chunks: result.chunks,
        },
        null,
        2,
      ),
      "utf8",
    );

    // Insert chunks one batch.
    if (result.chunks.length > 0) {
      await prisma.chunk.createMany({
        data: result.chunks.map((c, idx) => ({
          segmentRunId: runId,
          idx,
          topic: c.topic,
          preview: c.preview,
          startSec: c.startSec,
          endSec: c.endSec,
          wordCount: c.wordCount,
          text: c.text,
        })),
      });
    }

    await prisma.segmentRun.update({
      where: { id: runId },
      data: {
        status: "ready",
        progress: 100,
        chunkCount: result.chunks.length,
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
