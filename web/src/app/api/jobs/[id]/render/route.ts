import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { getSessionId } from "@/lib/session";
import {
  absPathFor,
  renderOutputKey,
} from "@/lib/storage";
import {
  uploadTalkingPhoto,
  createVideo,
  createAvatarIVVideo,
  pollStatus,
  downloadVideo,
  sanitizeNarrationScript,
  splitScriptForHeygen,
  getRemainingQuota,
} from "@/lib/heygen";

// HEYGEN_USE_AVATAR_IV=1 routes the per-part createVideo call through the
// v3 Avatar IV engine (hand + body motion driven by motion_prompt).
// Default (unset / 0) keeps the original v2 Talking Photo path — face-only
// animation, but cheaper and faster. Confirmed via the smoke test in
// web/scripts/heygen-iv-smoke.mjs.
const USE_AVATAR_IV = process.env.HEYGEN_USE_AVATAR_IV === "1";
const AVATAR_IV_MOTION_PROMPT = process.env.HEYGEN_AVATAR_IV_MOTION_PROMPT;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // POST/GET are quick; the background runner ticks separately

const DEFAULT_VOICE_ID =
  process.env.HEYGEN_DEFAULT_VOICE_ID ||
  // HeyGen "John Doe" — male English. Reliable mainstream voice with the
  // 3000-char per-video cap (covered by HEYGEN_PER_VIDEO_MAX_CHARS=2800).
  // Override at HEYGEN_DEFAULT_VOICE_ID. Fetch the catalogue via
  // GET https://api.heygen.com/v2/voices.
  "d92994ae0de34b2e8659b456a2f388b8";

/**
 * GET /api/jobs/[id]/render
 *
 * Returns all Render rows for the job (one per chunk that has been
 * enqueued). The UI polls this every 1500 ms while any row is in a
 * non-terminal state. Once everything is `ready` or `failed`, the UI
 * stops polling.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    select: { sessionCookie: true },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await prisma.render.findMany({
    where: { jobId: id },
    orderBy: { createdAt: "asc" },
    include: {
      parts: {
        orderBy: { idx: "asc" },
        select: {
          id: true,
          idx: true,
          status: true,
          progress: true,
          providerJobId: true,
          outputKey: true,
          durationSec: true,
          charLength: true,
          errorCode: true,
          errorMessage: true,
        },
      },
    },
  });
  return NextResponse.json({ renders: rows });
}

/**
 * POST /api/jobs/[id]/render
 *
 * Body: { chunkIds?: string[] }
 *
 * Enqueues a render for each canonical planet (or for the explicit
 * chunkIds list). Each render fires a background runner that:
 *   1. Uploads the instructor photo to HeyGen (cached per job)
 *   2. Calls /v2/video/generate with the chunk's enrichedText or text
 *   3. Polls /v1/video_status.get until ready/failed
 *   4. Downloads the mp4 to uploads/<jobId>/renders/<chunkId>/output.mp4
 *
 * Idempotent: if a render row already exists for a chunk and is in a
 * non-terminal state, we return the existing row instead of starting
 * a fresh runner.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      sessionCookie: true,
      renderStyle: true,
      instructorPhotoKey: true,
      instructorPhotoHeygenId: true,
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const style = job.renderStyle ?? "instructor";
  if (style !== "instructor") {
    return NextResponse.json(
      {
        error: `Render style "${style}" is not yet wired. Only "instructor" (HeyGen Talking Photo) is supported for now.`,
        code: "E_STYLE_NOT_IMPLEMENTED",
      },
      { status: 501 },
    );
  }

  if (!job.instructorPhotoKey) {
    return NextResponse.json(
      {
        error:
          "Upload an instructor photo first (Step 6 → Instructor card → photo dropzone).",
        code: "E_PHOTO_REQUIRED",
      },
      { status: 409 },
    );
  }

  if (!process.env.HEYGEN_API_KEY?.trim()) {
    return NextResponse.json(
      {
        error:
          "Avatar render is not configured. Set HEYGEN_API_KEY in web/.env.local and restart the dev server.",
        code: "E_HEYGEN_AUTH",
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    chunkIds?: string[];
    voiceId?: string;
  };
  // Optional per-request voice override. Blank/absent → the runner uses
  // DEFAULT_VOICE_ID. Trimmed; empty string treated as "use default".
  const voiceOverride =
    typeof body.voiceId === "string" && body.voiceId.trim()
      ? body.voiceId.trim()
      : undefined;

  // Build the list of chunks to render: explicit IDs if provided,
  // else every canonical planet across the latest segment run.
  //
  // Either way, the set is validated against the DB: only canonical
  // PLANETS (level="planet", not a duplicate) belonging to THIS job are
  // render units. Suns are navigation groupings with no narration text,
  // moons are sub-sections. A stale client can send a sun id (its chunk
  // list predates the planets-only projection fix) — we must drop it here
  // rather than enqueue a render that fails with E_NO_SCRIPT.
  let targetChunkIds: string[] = [];
  const planetWhere = {
    segmentRun: { jobId: id },
    level: "planet",
    duplicateOfChunkId: null,
  } as const;
  if (Array.isArray(body.chunkIds) && body.chunkIds.length > 0) {
    const requested = body.chunkIds.filter((c) => typeof c === "string");
    const valid = await prisma.chunk.findMany({
      where: { id: { in: requested }, ...planetWhere },
      select: { id: true },
      orderBy: { idx: "asc" },
    });
    targetChunkIds = valid.map((c) => c.id);
  } else {
    const planets = await prisma.chunk.findMany({
      where: planetWhere,
      select: { id: true },
      orderBy: { idx: "asc" },
    });
    targetChunkIds = planets.map((p) => p.id);
  }

  if (targetChunkIds.length === 0) {
    return NextResponse.json(
      {
        error:
          "No canonical planet chunks to render. (Suns and sub-sections aren't render units — pick a topic/planet.)",
        code: "E_NO_PLANETS",
      },
      { status: 409 },
    );
  }

  // Upsert + claim every render row. Background runners pick up
  // anything in `pending` or `uploading` state.
  //
  // STALE-CLAIM RECOVERY: a render stuck in `uploading`/`rendering`
  // for >STALE_MINUTES is almost certainly orphaned (runner crashed,
  // server restarted mid-poll). The runner's poll budget now scales up
  // to ~45 min for long planets, so the staleness bar must sit above
  // that — 55 min — or we'd re-claim a render that's still legitimately
  // in flight. Stale rows fall through to a fresh claim instead of
  // blocking re-generation forever.
  const STALE_MINUTES = 55;
  const renders = [] as { id: string; chunkId: string; status: string }[];
  for (const chunkId of targetChunkIds) {
    const existing = await prisma.render.findUnique({
      where: { chunkId },
    });
    const inFlight =
      existing?.status === "uploading" ||
      existing?.status === "rendering" ||
      existing?.status === "merging";
    const isStale =
      inFlight &&
      !!existing?.startedAt &&
      Date.now() - new Date(existing.startedAt).getTime() >
        STALE_MINUTES * 60_000;
    if (
      existing &&
      (existing.status === "ready" || existing.status === "parts_ready")
    ) {
      // Done OR awaiting Merge. Never auto-re-render in either case —
      // re-renders are explicit. (parts_ready: the user should click
      // Merge in the UI; re-firing the runner here would silently
      // discard already-paid-for parts.)
      renders.push({
        id: existing.id,
        chunkId: existing.chunkId,
        status: existing.status,
      });
      continue;
    }
    if (inFlight && !isStale) {
      // Genuinely in flight — skip re-fire.
      renders.push({
        id: existing.id,
        chunkId: existing.chunkId,
        status: existing.status,
      });
      continue;
    }
    if (isStale) {
      console.warn(
        `[render] stale-claim recovery for job=${id} chunk=${chunkId} — stuck in '${existing!.status}' >${STALE_MINUTES} min, re-claiming`,
      );
    }
    // If a prior mp4 exists for this chunk (failed/stale re-claim), delete
    // it so the re-render overwrites cleanly and we don't leave an orphan
    // on disk. Best-effort — a missing file is fine.
    if (existing?.outputKey) {
      await fs
        .rm(absPathFor(existing.outputKey), { force: true })
        .catch(() => {});
    }
    const row = await prisma.render.upsert({
      where: { chunkId },
      create: {
        jobId: id,
        chunkId,
        style,
        status: "pending",
        progress: 0,
        startedAt: new Date(),
      },
      update: {
        status: "pending",
        progress: 0,
        startedAt: new Date(),
        readyAt: null,
        errorCode: null,
        errorMessage: null,
        outputKey: null,
        videoUrl: null,
        thumbnailUrl: null,
        durationSec: null,
        providerJobId: null,
      },
    });
    renders.push({ id: row.id, chunkId: row.chunkId, status: row.status });
    // Fire background runner — fire-and-forget, runner manages its own
    // status updates so the response returns immediately.
    void runRender({
      jobId: id,
      renderId: row.id,
      chunkId,
      voiceId: voiceOverride,
    }).catch((err) => {
      console.error("[render] background crashed", err);
    });
  }

  // Advance JobStatus to "render" so the wizard step is unlocked.
  await prisma.jobStatus
    .upsert({
      where: { jobId: id },
      create: { jobId: id, status: "render", progress: 0 },
      update: { status: "render", progress: 0 },
    })
    .catch(() => {});

  return NextResponse.json({ renders }, { status: 202 });
}

/**
 * DELETE /api/jobs/[id]/render
 *
 * Cancels in-flight renders for the job. Marks every render currently in
 * a non-terminal state (`pending`/`uploading`/`rendering`) as `cancelled`.
 * The background runner notices the status flip at its next checkpoint
 * (within ~8 s, at the poll-loop tick) and bails out without overwriting
 * the cancelled state. A cancelled render is re-claimable on the next
 * POST. Body `{ chunkIds?: string[] }` narrows the cancel to specific
 * chunks; absent → cancel all in-flight renders for the job.
 *
 * Note: HeyGen has no cancel API. If a render has already reached the
 * `rendering` stage, HeyGen may still finish (and bill) that video — we
 * just stop polling/downloading it. Cancelling during `pending`/
 * `uploading` (before the generate call) avoids the HeyGen spend.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    select: { sessionCookie: true },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    chunkIds?: string[];
  };
  const chunkIds = Array.isArray(body.chunkIds)
    ? body.chunkIds.filter((c) => typeof c === "string")
    : null;

  const result = await prisma.render.updateMany({
    where: {
      jobId: id,
      status: { in: ["pending", "uploading", "rendering", "merging"] },
      ...(chunkIds && chunkIds.length > 0 ? { chunkId: { in: chunkIds } } : {}),
    },
    data: {
      status: "cancelled",
      errorCode: null,
      errorMessage: "Cancelled by user",
    },
  });

  return NextResponse.json({ cancelled: result.count });
}

// ─── Render concurrency semaphore ──────────────────────────────────────
// Process-local. "Generate all" fires one runRender per planet at once;
// without a cap, a playlist of N chunks would open N parallel HeyGen
// upload + generate calls and trip the per-key rate limit (429). This
// caps how many renders are mid-flight (incl. the long poll). Tune with
// RENDER_CONCURRENCY (default 2).
const MAX_RENDER_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.RENDER_CONCURRENCY) || 2),
);
let _renderInFlight = 0;
const _renderWaiters: Array<() => void> = [];

async function acquireRenderSlot(): Promise<void> {
  while (_renderInFlight >= MAX_RENDER_CONCURRENCY) {
    await new Promise<void>((resolve) => _renderWaiters.push(resolve));
  }
  _renderInFlight++;
}

function releaseRenderSlot(): void {
  _renderInFlight = Math.max(0, _renderInFlight - 1);
  const next = _renderWaiters.shift();
  if (next) next();
}

// ─── Background runner ─────────────────────────────────────────────────

async function runRender(params: {
  jobId: string;
  renderId: string;
  chunkId: string;
  // Optional custom HeyGen voice_id. undefined → DEFAULT_VOICE_ID.
  voiceId?: string;
}): Promise<void> {
  const { jobId, renderId, chunkId, voiceId } = params;

  // Helpers to keep status updates terse + best-effort.
  const setStatus = async (
    status: string,
    extra: Record<string, unknown> = {},
  ) => {
    await prisma.render
      .update({ where: { id: renderId }, data: { status, ...extra } })
      .catch(() => {});
  };
  const fail = async (errorCode: string, errorMessage: string) => {
    await prisma.render
      .update({
        where: { id: renderId },
        data: {
          status: "failed",
          errorCode,
          errorMessage: errorMessage.slice(0, 500),
        },
      })
      .catch(() => {});
  };
  // True once the user has cancelled this render (DELETE flips status to
  // "cancelled"). The runner re-reads at each checkpoint and bails without
  // overwriting — otherwise the next setStatus would clobber the cancel.
  const isCancelled = async (): Promise<boolean> => {
    const r = await prisma.render
      .findUnique({ where: { id: renderId }, select: { status: true } })
      .catch(() => null);
    return r?.status === "cancelled";
  };

  // Set once we hold a concurrency slot, so the finally only releases what
  // it acquired. Acquired AFTER cheap validation so a doomed render (no
  // script / no photo) never occupies a slot.
  let acquired = false;
  // Parts now PERSIST after the runner exits — they're shown in the UI
  // for individual preview, then concatenated by the explicit Merge
  // endpoint. The runner only cleans the parts/ tree at the START of a
  // re-claim (fresh slate) and the Merge endpoint cleans it AFTER
  // successful concat. Nothing to clean up in finally.
  let succeeded = false;
  try {
    if (await isCancelled()) return;
    // 1. Load chunk text + job's photo info.
    const chunk = await prisma.chunk.findUnique({
      where: { id: chunkId },
      select: { text: true, enrichedText: true, topic: true },
    });
    if (!chunk) throw Object.assign(new Error("Chunk not found"), { code: "E_NO_CHUNK" });
    // The avatar reads input_text literally — sanitize the enriched
    // script (or raw text fallback) into clean speakable prose:
    // strips markdown, citation markers, timecodes, bullets, URLs, and
    // collapses whitespace. This is the final guard before the words
    // become spoken audio. See heygen.ts:sanitizeNarrationScript.
    const rawScript = chunk.enrichedText ?? chunk.text ?? "";
    const scriptText = sanitizeNarrationScript(rawScript);
    if (!scriptText) {
      throw Object.assign(new Error("Chunk has no text/enrichedText to narrate"), {
        code: "E_NO_SCRIPT",
      });
    }

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        instructorPhotoKey: true,
        instructorPhotoHeygenId: true,
        voiceId: true,
        voiceSpeed: true,
      },
    });
    if (!job?.instructorPhotoKey) {
      throw Object.assign(new Error("Instructor photo missing on job"), {
        code: "E_PHOTO_REQUIRED",
      });
    }
    // Voice resolution: per-job override (set by the picker) wins, then
    // per-request override (POST body), then env default. Same fallback
    // chain for speed: job.voiceSpeed > HEYGEN_VOICE_SPEED env > 1.0.
    const resolvedVoiceId = job.voiceId ?? voiceId ?? DEFAULT_VOICE_ID;
    const envSpeed = Number(process.env.HEYGEN_VOICE_SPEED);
    const resolvedSpeed =
      job.voiceSpeed ??
      (Number.isFinite(envSpeed) && envSpeed >= 0.5 && envSpeed <= 2.0
        ? envSpeed
        : 1.0);

    // Acquire a render slot before any HeyGen call. May block if other
    // renders are in flight (cap = MAX_RENDER_CONCURRENCY).
    await acquireRenderSlot();
    acquired = true;
    if (await isCancelled()) return;

    // 2. Resolve the talking_photo_id — upload if not already cached.
    let talkingPhotoId = job.instructorPhotoHeygenId;
    if (!talkingPhotoId) {
      await setStatus("uploading", { progress: 10 });
      // Only .jpg/.png are ever stored (the upload route rejects others).
      const ext = path.extname(job.instructorPhotoKey).toLowerCase();
      const mime = ext === ".png" ? "image/png" : "image/jpeg";
      try {
        talkingPhotoId = await uploadTalkingPhoto({
          absPath: absPathFor(job.instructorPhotoKey),
          mimeType: mime,
        });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        throw Object.assign(new Error(`Photo upload failed: ${e.message}`), {
          code: e.code ?? "E_HEYGEN_NETWORK",
        });
      }
      // Cache for subsequent chunk renders on this job.
      await prisma.job
        .update({
          where: { id: jobId },
          data: { instructorPhotoHeygenId: talkingPhotoId },
        })
        .catch(() => {});
    }

    // 3-6. Render the script. HeyGen's `voice.text.input_text` is hard-
    // capped at 5,000 chars per video. If the sanitized script is over
    // that, splitScriptForHeygen() returns multiple sentence-aligned
    // sub-scripts; we render each as its own HeyGen video and ffmpeg-
    // concat the mp4s into one continuous chunk video. Short scripts
    // produce a single part and the concat is just a copy.
    if (await isCancelled()) return;
    const parts = splitScriptForHeygen(scriptText);
    if (parts.length === 0) {
      throw Object.assign(new Error("Script split produced zero parts"), {
        code: "E_NO_SCRIPT",
      });
    }

    // Credit pre-check — query HeyGen's remaining quota and fail fast if the
    // account can't cover this render. Estimate cost as ~1 credit per minute
    // of estimated video (HeyGen bills by output minutes). Without this guard
    // the runner would burn through whatever credits remain mid-render and
    // fail Part N with a confusing "insufficient credit" message. Soft-skip
    // on quota-fetch failure so a transient HeyGen blip doesn't block real
    // renders — the actual createVideo call will surface the same error.
    try {
      const remaining = await getRemainingQuota();
      const estVideoMinTotal =
        scriptText.trim().split(/\s+/).filter(Boolean).length / 140;
      const estCredits = Math.max(1, Math.ceil(estVideoMinTotal));
      if (remaining < estCredits) {
        throw Object.assign(
          new Error(
            `Insufficient HeyGen credits: ${remaining} available, ~${estCredits} needed for this ~${estVideoMinTotal.toFixed(1)} min render. Top up your HeyGen API credits and retry.`,
          ),
          { code: "E_HEYGEN_QUOTA" },
        );
      }
      console.log(
        `[render] credit check OK: ${remaining} available, ~${estCredits} estimated`,
      );
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "E_HEYGEN_QUOTA" || code === "E_HEYGEN_AUTH") throw err;
      console.warn(
        `[render] credit pre-check unavailable (${code ?? "unknown"}); proceeding anyway`,
      );
    }

    await prisma.render
      .update({
        where: { id: renderId },
        data: {
          status: "rendering",
          progress: 15,
          totalParts: parts.length,
          currentPart: 0,
        },
      })
      .catch(() => {});
    if (parts.length > 1) {
      console.log(
        `[render] script len=${scriptText.length} chars → ${parts.length} HeyGen parts (sizes: ${parts
          .map((p) => p.length)
          .join(", ")})`,
      );
    }

    const outKey = renderOutputKey(jobId, chunkId);
    const outAbs = absPathFor(outKey);
    const partsDir = path.join(path.dirname(outAbs), "parts");
    // Wipe any leftover parts/ tree + RenderPart rows from a previous
    // attempt so the run starts clean.
    await fs.rm(partsDir, { recursive: true, force: true }).catch(() => {});
    await prisma.renderPart.deleteMany({ where: { renderId } }).catch(() => {});
    await fs.mkdir(partsDir, { recursive: true });

    const POLL_INTERVAL_MS = 8_000;
    // Progress 15→90 split evenly across parts. The remaining 10 covers
    // concat (92) + final DB write (100).
    const partProgressBudget = 75 / parts.length;

    const partPaths: string[] = [];
    const providerJobIds: string[] = [];
    let summedDuration = 0;
    let lastVideoUrl: string | null = null;
    let lastThumbnailUrl: string | null = null;
    // Flipped true when the user clicks Stop — labeled break exits both
    // loops cleanly so we can concat whatever's already downloaded.
    let userStopped = false;

    partsLoop: for (let p = 0; p < parts.length; p++) {
      if (await isCancelled()) {
        userStopped = true;
        break partsLoop;
      }
      const partText = parts[p];
      const partStart = 15 + p * partProgressBudget;
      const partEnd = 15 + (p + 1) * partProgressBudget;

      // Per-part poll budget — scaled to that part's spoken length.
      const partVideoMin =
        partText.trim().split(/\s+/).filter(Boolean).length / 140;
      const partBudgetMs = Math.min(
        45 * 60_000,
        Math.max(15 * 60_000, Math.ceil(partVideoMin * 4) * 60_000),
      );
      const PART_MAX_POLLS = Math.ceil(partBudgetMs / POLL_INTERVAL_MS);

      // Upsert the per-part row so the UI can show its progress
      // independently. Status flips to "uploading" before createVideo,
      // then "rendering" once HeyGen accepts it.
      const partRow = await prisma.renderPart.upsert({
        where: { renderId_idx: { renderId, idx: p } },
        create: {
          renderId,
          idx: p,
          status: "uploading",
          progress: 5,
          charLength: partText.length,
          startedAt: new Date(),
        },
        update: {
          status: "uploading",
          progress: 5,
          charLength: partText.length,
          startedAt: new Date(),
          providerJobId: null,
          outputKey: null,
          durationSec: null,
          errorCode: null,
          errorMessage: null,
          readyAt: null,
        },
      });

      // 3a. createVideo for this part. Branch on engine choice.
      let videoId: string;
      try {
        videoId = USE_AVATAR_IV
          ? await createAvatarIVVideo({
              talkingPhotoId,
              voiceId: resolvedVoiceId,
              text: partText,
              speed: resolvedSpeed,
              title: `${chunk.topic} — part ${p + 1}/${parts.length}`,
              motionPrompt: AVATAR_IV_MOTION_PROMPT,
            })
          : await createVideo({
              talkingPhotoId,
              voiceId: resolvedVoiceId,
              text: partText,
              speed: resolvedSpeed,
            });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        await prisma.renderPart
          .update({
            where: { id: partRow.id },
            data: {
              status: "failed",
              errorCode: e.code ?? "E_HEYGEN_NETWORK",
              errorMessage: e.message,
            },
          })
          .catch(() => {});
        throw Object.assign(
          new Error(
            `Generate call failed (part ${p + 1}/${parts.length}): ${e.message}`,
          ),
          { code: e.code ?? "E_HEYGEN_NETWORK" },
        );
      }
      providerJobIds.push(videoId);
      await prisma.renderPart
        .update({
          where: { id: partRow.id },
          data: { providerJobId: videoId, status: "rendering", progress: 10 },
        })
        .catch(() => {});
      await prisma.render
        .update({
          where: { id: renderId },
          data: {
            providerJobId: providerJobIds.join(","),
            progress: Math.round(partStart),
            currentPart: p + 1,
          },
        })
        .catch(() => {});

      // 3b. Poll this part until ready / failed.
      let pollResult: Awaited<ReturnType<typeof pollStatus>> | null = null;
      for (let i = 0; i < PART_MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (await isCancelled()) {
          userStopped = true;
          await prisma.renderPart
            .update({
              where: { id: partRow.id },
              data: { status: "cancelled" },
            })
            .catch(() => {});
          break partsLoop;
        }
        try {
          pollResult = await pollStatus(videoId, USE_AVATAR_IV ? "v3" : "v1");
        } catch (err) {
          console.warn(
            `[render] poll error for ${videoId} part ${p + 1} (will retry): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        if (pollResult.status === "completed") {
          await prisma.renderPart
            .update({
              where: { id: partRow.id },
              data: { progress: 90 },
            })
            .catch(() => {});
          await prisma.render
            .update({
              where: { id: renderId },
              data: { progress: Math.round(partEnd) },
            })
            .catch(() => {});
          break;
        }
        if (pollResult.status === "failed") {
          await prisma.renderPart
            .update({
              where: { id: partRow.id },
              data: {
                status: "failed",
                errorCode: "E_HEYGEN_RENDER",
                errorMessage: pollResult.reason,
              },
            })
            .catch(() => {});
          return await fail(
            "E_HEYGEN_RENDER",
            `Part ${p + 1}/${parts.length}: ${pollResult.reason}`,
          );
        }
        // Synthetic per-part progress curve (10 → 90 across the budget).
        const partInner =
          10 + Math.round((i / PART_MAX_POLLS) * 80 * 0.95);
        await prisma.renderPart
          .update({
            where: { id: partRow.id },
            data: { progress: partInner },
          })
          .catch(() => {});
        const mapped = Math.min(
          Math.round(partEnd) - 1,
          Math.round(
            partStart + (i / PART_MAX_POLLS) * partProgressBudget * 0.95,
          ),
        );
        await prisma.render
          .update({ where: { id: renderId }, data: { progress: mapped } })
          .catch(() => {});
      }
      if (!pollResult || pollResult.status !== "completed") {
        await prisma.renderPart
          .update({
            where: { id: partRow.id },
            data: {
              status: "failed",
              errorCode: "E_HEYGEN_TIMEOUT",
              errorMessage: `Not ready after ~${Math.round(partBudgetMs / 60_000)} min`,
            },
          })
          .catch(() => {});
        return await fail(
          "E_HEYGEN_TIMEOUT",
          `Part ${p + 1}/${parts.length} not ready after ~${Math.round(partBudgetMs / 60_000)} min`,
        );
      }

      // 3c. Download this part to parts/part-NNN.mp4.
      if (await isCancelled()) {
        userStopped = true;
        await prisma.renderPart
          .update({
            where: { id: partRow.id },
            data: { status: "cancelled" },
          })
          .catch(() => {});
        break partsLoop;
      }
      const partOutputKey = `${jobId}/renders/${chunkId}/parts/part-${String(p).padStart(3, "0")}.mp4`;
      const partPath = absPathFor(partOutputKey);
      try {
        await downloadVideo({
          videoUrl: pollResult.videoUrl,
          outAbsPath: partPath,
        });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        await prisma.renderPart
          .update({
            where: { id: partRow.id },
            data: {
              status: "failed",
              errorCode: e.code ?? "E_HEYGEN_NETWORK",
              errorMessage: `Download failed: ${e.message}`,
            },
          })
          .catch(() => {});
        throw Object.assign(
          new Error(
            `Download failed (part ${p + 1}/${parts.length}): ${e.message}`,
          ),
          { code: e.code ?? "E_HEYGEN_NETWORK" },
        );
      }
      partPaths.push(partPath);
      summedDuration += pollResult.durationSec ?? 0;
      lastVideoUrl = pollResult.videoUrl;
      lastThumbnailUrl = pollResult.thumbnailUrl;
      // Mark this part ready — UI will now show a Play button for it.
      await prisma.renderPart
        .update({
          where: { id: partRow.id },
          data: {
            status: "ready",
            progress: 100,
            outputKey: partOutputKey,
            durationSec: pollResult.durationSec,
            readyAt: new Date(),
          },
        })
        .catch(() => {});
    }

    // Parts loop exited. New behaviour: instead of auto-concatenating, we
    // hand off to the user. They can play each ready part in the UI, then
    // click "Merge All Parts" to trigger the explicit /merge endpoint.
    // The Render row flips to status="parts_ready" so the UI knows to
    // show the Merge button. If zero parts are ready (early cancel or
    // first-part failure), leave the existing failed/cancelled state.
    if (partPaths.length === 0) {
      if (userStopped) {
        console.log(`[render] stopped before any part downloaded — no output`);
        return;
      }
      // Should not reach here without throw, but defensive.
      return await fail("E_HEYGEN_RENDER", "No parts downloaded");
    }

    // At least one part ready — handoff to user for preview + merge.
    const readyCountInDb = await prisma.renderPart.count({
      where: { renderId, status: "ready" },
    });
    const isPartial = userStopped || readyCountInDb < parts.length;
    await prisma.render.update({
      where: { id: renderId },
      data: {
        status: "parts_ready",
        progress: 90,
        videoUrl: lastVideoUrl,
        thumbnailUrl: lastThumbnailUrl,
        durationSec: summedDuration || null,
        errorCode: isPartial ? "E_USER_STOPPED" : null,
        errorMessage: isPartial
          ? `${readyCountInDb} of ${parts.length} parts ready — click Merge to stitch them into one video.`
          : `All ${parts.length} parts ready — click Merge to stitch them into one video.`,
      },
    });
    succeeded = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code ?? "E_HEYGEN_NETWORK";
    console.error(`[render] ${code} for renderId=${renderId}: ${message}`);
    await fail(code, message);
  } finally {
    if (acquired) releaseRenderSlot();
    // Parts persist until merge or a re-claim (which wipes the parts/
    // tree at start). Nothing to clean up here.
    if (!succeeded) {
      // Note: render row already updated to "failed" by `fail()`. No
      // additional DB action — just here for clarity.
    }
  }
}
