import path from "node:path";
import { prisma } from "@/lib/db";
import { absPathFor, audioKey } from "@/lib/storage";
import { downloadAudio } from "@/lib/ytdlp";
import { cascadeChild, shouldCascade } from "@/lib/cascade";

/**
 * Background task that pulls audio for a URL-ingestion job. Lives in its
 * own module so both POST /api/jobs (initial submission) and POST
 * /api/jobs/[id]/download (retry) can fire it.
 *
 * Updates the existing `job_status` row as it goes — no sibling status
 * table for downloads, per the minimal-schema design.
 */
export async function runDownload(params: {
  jobId: string;
  sourceUrl: string;
  /** Title from the synchronous probe — used if mid-run probe disagrees */
  fallbackTitle: string;
}): Promise<void> {
  const { jobId, sourceUrl, fallbackTitle } = params;

  // Output directory: uploads/{jobId}/  — same convention as file uploads.
  const outAudioKey = audioKey(jobId);                 // e.g. "{jobId}/audio.mp3"
  const outAudioAbs = absPathFor(outAudioKey);
  const outDirAbs = path.dirname(outAudioAbs);

  try {
    // The 1% "we just started" bump happens INSIDE downloadAudio after
    // it acquires its semaphore slot. Bumping here would mark every
    // queued child as 1% even though only one is actually running.
    const meta = await downloadAudio({
      url: sourceUrl,
      outDirAbs,
      onProgress: async ({ percent }) => {
        // ytdlp.ts already throttles emissions at 2% / 200 ms — no need
        // to double-throttle here. Forward every emission to the DB so
        // the UI sees fresh values whenever yt-dlp emits a fragment.
        await prisma.jobStatus
          .update({
            where: { jobId },
            // Never go BACKWARDS in progress — clamp to ≥1 so we don't
            // reset to 0 if yt-dlp emits a stale 0% line.
            data: { progress: Math.max(1, percent) },
          })
          .catch(() => {});
      },
    });

    // Backfill the Job row's source columns now that we know what
    // actually landed on disk. We deliberately do NOT replace sourceName
    // with the title yet — keeping the URL in sourceName lets a retry
    // of a partially-failed run find the URL again. The rename happens
    // at the end of this function, after every other write has succeeded.
    await prisma.job.update({
      where: { id: jobId },
      data: {
        sourceKey: outAudioKey,
        sourceSize: BigInt(meta.sizeBytes),
        sourceType: "audio/mpeg",
        sourceDurationSec: meta.durationSec || null,
      },
    });

    // Insert the Audio row as already-ready so Step 3 (Transcribe) doesn't
    // ask the user to extract anything. Mirrors what the file-upload +
    // ffmpeg pipeline produces, but skips the intermediate "extracting"
    // state.
    await prisma.audio.upsert({
      where: { jobId },
      create: {
        jobId,
        storageKey: outAudioKey,
        status: "ready",
        progress: 100,
        sizeBytes: BigInt(meta.sizeBytes),
        durationSec: meta.durationSec,
        sampleRateHz: meta.sampleRateHz,
        channels: meta.channels,
        codec: meta.codec,
        bitrateKbps: meta.bitrateKbps,
        startedAt: new Date(),
        readyAt: new Date(),
      },
      update: {
        storageKey: outAudioKey,
        status: "ready",
        progress: 100,
        sizeBytes: BigInt(meta.sizeBytes),
        durationSec: meta.durationSec,
        sampleRateHz: meta.sampleRateHz,
        channels: meta.channels,
        codec: meta.codec,
        bitrateKbps: meta.bitrateKbps,
        errorCode: null,
        errorMessage: null,
        readyAt: new Date(),
      },
    });

    // Skip "audio" — yt-dlp produced audio directly. Step 3 unlocks now.
    await prisma.jobStatus.update({
      where: { jobId },
      data: { status: "transcript", progress: 0 },
    });

    // Now that everything else is durably saved, swap sourceName to the
    // human-friendly title. If anything above failed, the URL is still
    // sitting in sourceName so a Retry POST can recover it.
    await prisma.job
      .update({
        where: { id: jobId },
        data: { sourceName: fallbackTitle },
      })
      .catch(() => {});

    // Auto-cascade for playlist children that opted in via "Process all".
    if (shouldCascade(jobId)) {
      void cascadeChild(jobId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "E_YTDLP";
    console.error("[runDownload] failed", code, message);
    await prisma.jobStatus
      .update({ where: { jobId }, data: { status: "failed" } })
      .catch(() => {});
  }
}
