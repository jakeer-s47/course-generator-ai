import { prisma } from "@/lib/db";
import { runTranscription } from "@/app/api/jobs/[id]/transcribe/route";
import { runCleaning } from "@/app/api/jobs/[id]/clean/route";
import { runSegmentation } from "@/app/api/jobs/[id]/segment/route";

export type CascadeOptions = {
  cleanLevel: "light" | "standard" | "aggressive";
  targetMin: number;
};

const DEFAULT_OPTIONS: CascadeOptions = {
  cleanLevel: "aggressive",
  targetMin: 20,
};

// In-memory map of child jobIds → their cascade options. The user opts
// in via the "Process all" button on BatchWizardShell. Each child stores
// the cleanup level + target chunk size to use when its turn comes; the
// download / extract runners read this on success.
//
// Lost on server restart by design — the boot-sweep instrumentation
// won't re-cascade orphans, the user has to click "Process all" again.
// This is acceptable because cascadeChild is idempotent on already-ready
// rows.
const cascadeMap = new Map<string, CascadeOptions>();

export function markForCascade(
  jobId: string,
  opts: Partial<CascadeOptions> = {},
): void {
  cascadeMap.set(jobId, { ...DEFAULT_OPTIONS, ...opts });
}

export function shouldCascade(jobId: string): boolean {
  return cascadeMap.has(jobId);
}

export function clearCascadeFlag(jobId: string): void {
  cascadeMap.delete(jobId);
}

function getCascadeOptions(jobId: string): CascadeOptions {
  return cascadeMap.get(jobId) ?? DEFAULT_OPTIONS;
}

// Process-local FIFO mutex — TRANSCRIBE only.
//
// Transcription uses a single-tenant FastAPI service holding one model
// in RAM, so running multiple transcribes concurrently across children
// would just queue at the GIL anyway. We serialize them at the cascade
// level so the rest of the work (clean + split) for previously-transcribed
// children can run in parallel against OpenAI.
//
// Clean and split are NOT gated — they call OpenAI which handles parallel
// requests fine. So while child N is transcribing, children 1..N-1 can
// be cleaning/splitting concurrently against the OpenAI API.
let transcribeInFlight = false;
const transcribeWaiters: Array<() => void> = [];

async function acquireTranscribeSlot(): Promise<void> {
  if (!transcribeInFlight) {
    transcribeInFlight = true;
    return;
  }
  await new Promise<void>((resolve) => {
    transcribeWaiters.push(resolve);
  });
  transcribeInFlight = true;
}

function releaseTranscribeSlot(): void {
  const next = transcribeWaiters.shift();
  if (next) next();
  else transcribeInFlight = false;
}

/**
 * Auto-cascade pipeline for batch / playlist children.
 *
 * Single-job uploads gate every step on a manual click (cost control).
 * Multi-file batch and playlist children are different — the user
 * already opted in by clicking "Process all" on the overview page, so we
 * chain transcript → clean → split for them automatically. Step 6
 * (Render) stays manual because it needs an avatar + voice choice.
 *
 * Concurrency model:
 *   - **Transcribe** is globally serialized (transcribeSlot semaphore=1)
 *     because the FastAPI whisper service is single-tenant. Children
 *     queue in arrival order.
 *   - **Clean + split** run without any cross-child lock. So while
 *     child N is transcribing, children 1..N-1 can be cleaning /
 *     splitting concurrently. OpenAI's GPT-4o handles the parallel
 *     requests; the per-stage atomic-claim guards inside each route
 *     protect against double-spending.
 *
 * Errors are logged and stored on the appropriate sibling row's
 * errorMessage; this function never throws.
 */
export async function cascadeChild(jobId: string): Promise<void> {
  const opts = getCascadeOptions(jobId);
  try {
    await runTranscribePhase(jobId);
    // Clean + split run without the transcribe lock — multiple children
    // can be in this phase concurrently.
    await runCleanAndSplitPhase(jobId, opts);
  } catch (err) {
    console.error("[cascade] failed for", jobId, err);
  }
}

/**
 * If this child still needs transcription, acquire the transcribe slot
 * and run it. No-op (without acquiring the slot) if the cascade for this
 * child is already past transcribe.
 */
async function runTranscribePhase(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { status: true, audio: true, transcript: true },
  });
  if (!job) return;
  const status = job.status?.status;
  if (status === "render" || status === "done" || status === "failed") return;
  // If transcript is already ready, skip the slot entirely so we don't
  // briefly block other children's transcribes.
  if (job.transcript?.status === "ready") return;
  // Audio MUST be ready before we can transcribe.
  if (!job.audio || job.audio.status !== "ready") return;
  // For URL/playlist children at status="transcript" + clean/split, this
  // is the right time to grab the slot.
  if (status !== "transcript") return;

  await acquireTranscribeSlot();
  try {
    await ensureTranscribe(jobId, job.audio);
  } finally {
    releaseTranscribeSlot();
  }
}

/**
 * Run the clean and split stages for this child. Reads job state fresh
 * (transcribe phase may have just updated it) and recursively walks
 * through clean → split. No cross-child lock — children at this phase
 * run concurrently against OpenAI.
 */
async function runCleanAndSplitPhase(
  jobId: string,
  opts: CascadeOptions,
): Promise<void> {
  await runFromCurrentStage(jobId, opts);
}

async function runFromCurrentStage(
  jobId: string,
  opts: CascadeOptions,
): Promise<void> {
  const { cleanLevel, targetMin } = opts;
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      status: true,
      audio: true,
      transcript: true,
      cleanedVersions: { where: { cleanLevel } },
      segmentRuns: { where: { cleanLevel, targetMin } },
    },
  });
  if (!job) return;
  const status = job.status?.status;
  // Already terminal — nothing to do.
  if (status === "render" || status === "done" || status === "failed") return;

  // Transcribe is no longer handled here — runTranscribePhase ran (and
  // either completed transcription or no-op'd) before this function was
  // called. If we still see status === "transcript" it means transcribe
  // couldn't proceed (audio not ready, or another runner is already
  // claimed). Either way, we exit without bypassing the transcribe slot.
  if (status === "transcript") return;

  // Clean stage.
  if (status === "clean") {
    if (!job.transcript || job.transcript.status !== "ready") return;
    if (!job.transcript.wordsJsonKey) return;
    const existing = job.cleanedVersions[0] ?? null;
    if (!existing || existing.status !== "ready") {
      await ensureClean(job.id, job.transcript, cleanLevel);
    }
    return runFromCurrentStage(jobId, opts);
  }

  // Split stage.
  if (status === "split") {
    const cleaned = await prisma.cleanedTranscript.findUnique({
      where: {
        jobId_cleanLevel: { jobId: job.id, cleanLevel },
      },
    });
    if (!cleaned || cleaned.status !== "ready" || !cleaned.cleanedWordsKey) {
      // The selected level isn't ready yet — fall back to running cleanup
      // at this level first, then resume the cascade.
      if (job.transcript?.status === "ready" && job.transcript.wordsJsonKey) {
        await ensureClean(job.id, job.transcript, cleanLevel);
        return runFromCurrentStage(jobId, opts);
      }
      return;
    }
    const existing = job.segmentRuns[0] ?? null;
    if (!existing || existing.status !== "ready") {
      await ensureSegment(job.id, cleaned, cleanLevel, targetMin);
    }
    // Stop here — Step 6 (Render) needs user-chosen avatar + voice.
    return;
  }

  // status === "audio" or "downloading" — extraction/download still in
  // flight. Their runners advance status to "transcript" when done; the
  // caller of cascadeChild should re-fire after that. Nothing to do now.
}

async function ensureTranscribe(
  jobId: string,
  audio: { storageKey: string; durationSec: number | null },
): Promise<void> {
  // Atomic claim — same pattern as the route handler. Only the call that
  // flips an existing row from terminal to "transcribing" gets to fire
  // the runner.
  let claimed = false;
  try {
    await prisma.transcript.create({
      data: {
        jobId,
        status: "transcribing",
        progress: 0,
        startedAt: new Date(),
      },
    });
    claimed = true;
  } catch {
    const result = await prisma.transcript.updateMany({
      where: { jobId, status: { in: ["pending", "failed"] } },
      data: {
        status: "transcribing",
        progress: 0,
        rawText: null,
        wordsJsonKey: null,
        language: null,
        wordCount: null,
        durationSec: null,
        errorCode: null,
        errorMessage: null,
        startedAt: new Date(),
        readyAt: null,
      },
    });
    claimed = result.count === 1;
  }
  if (!claimed) {
    // Another runner already in flight; nothing to do — its completion
    // path will continue the cascade if cascadeChild is called again.
    return;
  }
  const transcript = await prisma.transcript.findUnique({
    where: { jobId },
  });
  if (!transcript) return;

  await prisma.jobStatus.update({
    where: { jobId },
    data: { status: "transcript", progress: 0 },
  });

  await runTranscription({
    jobId,
    transcriptId: transcript.id,
    audioStorageKey: audio.storageKey,
    audioDurationSec: audio.durationSec ?? 0,
  });
  // The runner advanced status to "clean" (or "failed"). Recurse to fire
  // the next stage in the cascade.
  await runFromCurrentStage(jobId, getCascadeOptions(jobId));
}

async function ensureClean(
  jobId: string,
  transcript: {
    rawText: string | null;
    wordsJsonKey: string | null;
    durationSec: number | null;
  },
  cleanLevel: CascadeOptions["cleanLevel"],
): Promise<void> {
  if (!transcript.wordsJsonKey) return;

  let claimed = false;
  try {
    await prisma.cleanedTranscript.create({
      data: {
        jobId,
        cleanLevel,
        status: "cleaning",
        progress: 10,
        startedAt: new Date(),
      },
    });
    claimed = true;
  } catch {
    const result = await prisma.cleanedTranscript.updateMany({
      where: {
        jobId,
        cleanLevel,
        status: { in: ["pending", "ready", "failed"] },
      },
      data: {
        status: "cleaning",
        progress: 10,
        cleanedText: null,
        cleanedWordsKey: null,
        removedJsonKey: null,
        originalWords: null,
        cleanedWords: null,
        removedSegments: null,
        removedDurSec: null,
        errorCode: null,
        errorMessage: null,
        startedAt: new Date(),
        readyAt: null,
      },
    });
    claimed = result.count === 1;
  }
  if (!claimed) return;

  const cleaned = await prisma.cleanedTranscript.findUnique({
    where: { jobId_cleanLevel: { jobId, cleanLevel } },
  });
  if (!cleaned) return;

  await prisma.jobStatus.update({
    where: { jobId },
    data: { status: "clean", progress: 10 },
  });

  await runCleaning({
    jobId,
    cleanedId: cleaned.id,
    rawText: transcript.rawText ?? "",
    wordsJsonKey: transcript.wordsJsonKey,
    totalDurationSec: transcript.durationSec ?? 0,
    level: cleanLevel,
  });
  await runFromCurrentStage(jobId, getCascadeOptions(jobId));
}

async function ensureSegment(
  jobId: string,
  cleaned: {
    cleanedWordsKey: string | null;
    removedDurSec: number | null;
  },
  cleanLevel: CascadeOptions["cleanLevel"],
  targetMin: number,
): Promise<void> {
  if (!cleaned.cleanedWordsKey) return;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    // parentJobId is forwarded into runSegmentation so the dedup pass
    // fires for playlist / batch children. NULL for standalone jobs —
    // dedup skipped there, behavior unchanged.
    select: { sourceDurationSec: true, parentJobId: true },
  });
  if (!job) return;

  let claimed = false;
  try {
    await prisma.segmentRun.create({
      data: {
        jobId,
        cleanLevel,
        targetMin,
        status: "segmenting",
        progress: 10,
        startedAt: new Date(),
      },
    });
    claimed = true;
  } catch {
    const result = await prisma.segmentRun.updateMany({
      where: {
        jobId,
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
  if (!claimed) return;

  const run = await prisma.segmentRun.findUnique({
    where: {
      jobId_cleanLevel_targetMin: { jobId, cleanLevel, targetMin },
    },
  });
  if (!run) return;

  // Re-segment wipes any existing chunks for this combo.
  await prisma.chunk.deleteMany({ where: { segmentRunId: run.id } });

  await prisma.jobStatus.upsert({
    where: { jobId },
    create: { jobId, status: "split", progress: 10 },
    update: { status: "split", progress: 10 },
  });

  await runSegmentation({
    jobId,
    runId: run.id,
    cleanLevel,
    targetMin,
    cleanedWordsKey: cleaned.cleanedWordsKey,
    totalDurationSec: Math.max(
      0,
      (job.sourceDurationSec ?? 0) - (cleaned.removedDurSec ?? 0),
    ),
    parentJobId: job.parentJobId,
  });
}
