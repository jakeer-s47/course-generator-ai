import { prisma } from "@/lib/db";
import { absPathFor } from "@/lib/storage";
import { extractAudio, probeDuration } from "@/lib/ffmpeg";
import { cascadeChild, shouldCascade } from "@/lib/cascade";

/**
 * Background ffmpeg run for a single Job. Updates the Audio row + the
 * single `job_status` row as ffmpeg writes progress lines, advances the
 * job's status to `transcript` on success, or marks it `failed` with a
 * captured stderr snippet on failure.
 *
 * Lives in its own file so both `POST /api/jobs/[id]/extract` (single-file
 * flow, user-triggered) and `POST /api/jobs` (multi-file batch flow,
 * auto-triggered for each child) can fire it.
 *
 * Pre-conditions: caller has already upserted the `Audio` row to
 * `extracting/0` and ensured `job_status` is on the audio step. The runner
 * owns updates from that point forward.
 */
export async function runExtraction(params: {
  jobId: string;
  audioId: string;
  srcKey: string;
  outKey: string;
  sourceDurationSec: number;
}): Promise<void> {
  const { jobId, audioId, srcKey, outKey, sourceDurationSec } = params;
  const srcAbs = absPathFor(srcKey);
  const outAbs = absPathFor(outKey);

  let lastWriteAt = 0;
  let lastPercent = -1;

  try {
    // If the client-side duration probe failed (browser couldn't decode
    // the container), `sourceDurationSec` is 0 — without a real number
    // ffmpeg's progress callback emits percent=null and the bar appears
    // stuck at 1% until extraction finishes. Probe with ffprobe first.
    let totalDurationSec = sourceDurationSec;
    if (!totalDurationSec || totalDurationSec <= 0) {
      const probed = await probeDuration(srcAbs);
      if (probed && probed > 0) {
        totalDurationSec = probed;
        // Backfill the Job row so other stages see the real duration too.
        await prisma.job
          .update({
            where: { id: jobId },
            data: { sourceDurationSec: totalDurationSec },
          })
          .catch(() => {});
      }
    }

    const meta = await extractAudio({
      srcAbsPath: srcAbs,
      outAbsPath: outAbs,
      storageKey: outKey,
      totalDurationSec,
      onProgress: async ({ percent }) => {
        if (percent == null) return;
        const now = Date.now();
        // Throttle DB writes — but always commit non-trivial percent jumps
        // (≥2%) within 400 ms windows. Final 100% writes regardless.
        if (
          percent < 100 &&
          percent - lastPercent < 2 &&
          now - lastWriteAt < 400
        )
          return;
        lastPercent = percent;
        lastWriteAt = now;
        await prisma.audio
          .update({ where: { id: audioId }, data: { progress: percent } })
          .catch(() => {});
        await prisma.jobStatus
          .update({ where: { jobId }, data: { progress: percent } })
          .catch(() => {});
      },
    });

    await prisma.audio.update({
      where: { id: audioId },
      data: {
        status: "ready",
        progress: 100,
        sizeBytes: BigInt(meta.sizeBytes),
        durationSec: meta.durationSec,
        sampleRateHz: meta.sampleRateHz,
        channels: meta.channels,
        codec: meta.codec,
        bitrateKbps: meta.bitrateKbps,
        readyAt: new Date(),
      },
    });

    // Audio step done → advance to the next step.
    await prisma.jobStatus.update({
      where: { jobId },
      data: { status: "transcript", progress: 0 },
    });

    // If the user opted into auto-processing (clicked "Process all" on
    // BatchOverview / PlaylistOverview), continue the cascade now.
    // No-op for single-file jobs — they only enter the cascade if the
    // user explicitly added them to the set.
    if (shouldCascade(jobId)) {
      void cascadeChild(jobId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[extract] failed", message);
    await prisma.audio
      .update({
        where: { id: audioId },
        data: {
          status: "failed",
          errorCode: "E_FFMPEG",
          errorMessage: message.slice(0, 500),
        },
      })
      .catch(() => {});
    // Mark the job itself as failed on the audio step. Frontend shows the
    // specific error via the audio row's errorMessage.
    await prisma.jobStatus
      .update({ where: { jobId }, data: { status: "failed" } })
      .catch(() => {});
  }
}
