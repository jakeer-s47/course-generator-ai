/**
 * Next.js auto-runs `register()` once when the server boots.
 *
 * Our pipeline fires background runners with `void run<Stage>(...)`. If
 * the Node process restarts (HMR, deploy, OOM, crash) while a runner is
 * mid-flight, the sibling row stays in its `<stage>ing` state forever —
 * the route's idempotency check then refuses to restart it and the UI
 * polls indefinitely.
 *
 * On boot we scan every stage's sibling table for rows whose `startedAt`
 * is older than the staleness threshold and flip them to `failed` with
 * `errorCode='E_INTERRUPTED'`. The user can then retry from the UI.
 */
export async function register(): Promise<void> {
  // nodejs runtime only — skip the (no-op) edge runtime invocation.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Dynamic import keeps Prisma out of any non-Node bundles.
  const { prisma } = await import("@/lib/db");

  // 30 minutes is well over any legitimate single-stage run today
  // (1-hr lecture transcribe ~5-10 min, clean ~3 min, segment ~1 min,
  // playlist downloads bounded by yt-dlp semaphore). Adjust upward if
  // a real run ever legitimately takes longer than this.
  const STALE_MIN = 30;
  const cutoff = new Date(Date.now() - STALE_MIN * 60 * 1000);

  const staleErr = {
    status: "failed" as const,
    errorCode: "E_INTERRUPTED",
    errorMessage:
      "The server restarted while this step was running. Please retry.",
  };

  try {
    const [audios, transcripts, cleaned, segments, downloads] =
      await Promise.all([
        prisma.audio.updateMany({
          where: { status: "extracting", startedAt: { lt: cutoff } },
          data: staleErr,
        }),
        prisma.transcript.updateMany({
          where: { status: "transcribing", startedAt: { lt: cutoff } },
          data: staleErr,
        }),
        prisma.cleanedTranscript.updateMany({
          where: { status: "cleaning", startedAt: { lt: cutoff } },
          data: staleErr,
        }),
        prisma.segmentRun.updateMany({
          where: { status: "segmenting", startedAt: { lt: cutoff } },
          data: staleErr,
        }),
        // Downloads track state on JobStatus, which has no errorCode/
        // errorMessage columns — just flip status. The UI's URL flow
        // surfaces "failed" with a Retry button.
        prisma.jobStatus.updateMany({
          where: { status: "downloading", updatedAt: { lt: cutoff } },
          data: { status: "failed" },
        }),
      ]);

    const total =
      audios.count +
      transcripts.count +
      cleaned.count +
      segments.count +
      downloads.count;
    if (total > 0) {
      console.log(
        `[boot-sweep] marked ${total} orphaned in-flight rows as failed`,
        {
          audios: audios.count,
          transcripts: transcripts.count,
          cleaned: cleaned.count,
          segments: segments.count,
          downloads: downloads.count,
        },
      );
    }
  } catch (err) {
    // A failed sweep shouldn't block server startup. The orphans will
    // still be there; next boot tries again.
    console.error("[boot-sweep] failed", err);
  }
}
