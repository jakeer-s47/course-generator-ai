import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { absPathFor, wordsJsonKey } from "@/lib/storage";
import { getSessionId } from "@/lib/session";
import { transcribeAudio as transcribeOpenAI } from "@/lib/whisper";
import { transcribeAudio as transcribeLocal } from "@/lib/whisper-local";
import { transcribeAudio as transcribePython } from "@/lib/whisper-python";

// Pick the transcription engine.
//   "openai" (default) — OpenAI Whisper API (needs OPENAI_API_KEY)
//   "local"            — nodejs-whisper / whisper.cpp on this machine
//   "python"           — faster-whisper via a Python subprocess
const RAW_PROVIDER = (process.env.TRANSCRIBE_PROVIDER ?? "openai").toLowerCase();
const TRANSCRIBE_PROVIDER: "openai" | "local" | "python" =
  RAW_PROVIDER === "local"
    ? "local"
    : RAW_PROVIDER === "python"
      ? "python"
      : "openai";

const transcribeAudio =
  TRANSCRIBE_PROVIDER === "local"
    ? transcribeLocal
    : TRANSCRIBE_PROVIDER === "python"
      ? transcribePython
      : transcribeOpenAI;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60 * 10; // 10 min — Whisper across all chunks

/**
 * POST /api/jobs/[id]/transcribe
 *
 * Starts Whisper transcription. Returns the Transcript row (202) while the
 * background task chunks the audio, hits Whisper per chunk, and stitches
 * word-level timestamps. The single `job_status` row is updated as chunks
 * complete:
 *   status="transcript", progress=0..100 during, then
 *   status="clean", progress=0 when transcription finishes.
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    include: { audio: true, transcript: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!job.audio || job.audio.status !== "ready") {
    return NextResponse.json(
      { error: "Audio not ready" },
      { status: 409 },
    );
  }

  // Idempotent: if a transcript is already running or done, just return it.
  // STALE-CLAIM RECOVERY: a row stuck in `transcribing` for >30 min is
  // almost certainly orphaned (runner crashed, Python service died,
  // network drop). Whisper runs are CPU-bound and can legitimately
  // take 20+ min on long lectures, so we err on the side of patience
  // (30 min) before assuming stale. Recovered rows are flipped to
  // `failed` and fall through to a fresh claim below.
  const STALE_MINUTES = 30;
  const transcript = job.transcript;
  const isStuck =
    transcript?.status === "transcribing" &&
    !!transcript.startedAt &&
    Date.now() - new Date(transcript.startedAt).getTime() >
      STALE_MINUTES * 60_000;
  if (
    transcript &&
    !isStuck &&
    (transcript.status === "transcribing" || transcript.status === "ready")
  ) {
    return NextResponse.json(transcript, { status: 200 });
  }
  if (isStuck && transcript) {
    console.warn(
      `[transcribe] stale-claim recovery for job=${id} — row stuck in 'transcribing' for >${STALE_MINUTES} min, resetting`,
    );
    await prisma.transcript
      .update({
        where: { id: transcript.id },
        data: {
          status: "failed",
          errorCode: "E_STALE_CLAIM",
          errorMessage: `Recovered: runner stuck in 'transcribing' for >${STALE_MINUTES} min`,
        },
      })
      .catch(() => {});
  }

  // The OPENAI_API_KEY guard only matters when we're using the OpenAI
  // provider. Local whisper.cpp runs offline.
  if (TRANSCRIBE_PROVIDER === "openai" && !process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        error:
          "Transcription is not configured. Set OPENAI_API_KEY in web/.env.local and restart the dev server, or set TRANSCRIBE_PROVIDER=local to use the bundled whisper.cpp.",
        code: "E_OPENAI_AUTH",
      },
      { status: 503 },
    );
  }

  // Atomic claim — see /extract route for the full rationale. Two
  // concurrent POSTs without this can both fall past the idempotency
  // check above and both fire Whisper, double-spending the API quota.
  let claimed = false;
  if (!job.transcript) {
    try {
      await prisma.transcript.create({
        data: {
          jobId: id,
          status: "transcribing",
          progress: 0,
          startedAt: new Date(),
        },
      });
      claimed = true;
    } catch {
      // Lost the create race; fall through to conditional update.
    }
  }
  if (!claimed) {
    const result = await prisma.transcript.updateMany({
      where: { jobId: id, status: { in: ["pending", "failed"] } },
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

  const transcriptRow = await prisma.transcript.findUnique({
    where: { jobId: id },
  });
  if (!transcriptRow) {
    return NextResponse.json(
      { error: "Failed to claim transcription slot" },
      { status: 500 },
    );
  }
  if (!claimed) {
    return NextResponse.json(transcriptRow, { status: 200 });
  }

  // Move the single job_status row to "transcript" step, progress 0.
  await prisma.jobStatus.upsert({
    where: { jobId: id },
    create: { jobId: id, status: "transcript", progress: 0 },
    update: { status: "transcript", progress: 0 },
  });

  void runTranscription({
    jobId: id,
    transcriptId: transcriptRow.id,
    audioStorageKey: job.audio.storageKey,
    audioDurationSec: job.audio.durationSec ?? job.sourceDurationSec ?? 0,
  }).catch((err) => console.error("[transcribe] background crashed", err));

  return NextResponse.json(transcriptRow, { status: 202 });
}

export async function runTranscription(params: {
  jobId: string;
  transcriptId: string;
  audioStorageKey: string;
  audioDurationSec: number;
}) {
  const { jobId, transcriptId, audioStorageKey, audioDurationSec } = params;
  const audioAbs = absPathFor(audioStorageKey);

  try {
    let lastWriteAt = 0;
    const result = await transcribeAudio({
      absPath: audioAbs,
      totalDurationSec: audioDurationSec,
      onChunkDone: async ({ percent, partialText }) => {
        const now = Date.now();
        // Throttle DB writes — but always commit the final chunk.
        if (percent < 100 && now - lastWriteAt < 400) return;
        lastWriteAt = now;
        await prisma.transcript
          .update({
            where: { id: transcriptId },
            data: { progress: percent, rawText: partialText },
          })
          .catch(() => {});
        await prisma.jobStatus
          .update({ where: { jobId }, data: { progress: percent } })
          .catch(() => {});
      },
    });

    // Persist word-level timestamps to disk; rawText stays in the DB.
    const wordsKey = wordsJsonKey(jobId);
    const wordsAbs = absPathFor(wordsKey);
    await fs.mkdir(path.dirname(wordsAbs), { recursive: true });
    await fs.writeFile(
      wordsAbs,
      JSON.stringify(
        {
          language: result.language,
          durationSec: result.durationSec,
          words: result.words,
        },
        null,
        2,
      ),
      "utf8",
    );

    await prisma.transcript.update({
      where: { id: transcriptId },
      data: {
        status: "ready",
        progress: 100,
        rawText: result.text,
        language: result.language,
        wordCount: result.words.length,
        durationSec: result.durationSec,
        wordsJsonKey: wordsKey,
        readyAt: new Date(),
      },
    });

    // Transcript step done → advance to the next step.
    await prisma.jobStatus.update({
      where: { jobId },
      data: { status: "clean", progress: 0 },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      (err as { code?: string } | null)?.code ?? "E_WHISPER";
    console.error("[transcribe] failed", code, message);
    await prisma.transcript
      .update({
        where: { id: transcriptId },
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
