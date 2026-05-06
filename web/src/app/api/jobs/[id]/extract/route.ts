import { NextResponse } from "next/server";
import { prisma, serializeAudio } from "@/lib/db";
import { audioKey } from "@/lib/storage";
import { getSessionId } from "@/lib/session";
import { runExtraction } from "./runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60 * 10; // 10 min

/**
 * POST /api/jobs/[id]/extract
 *
 * Starts audio extraction. Returns the Audio row (202) while ffmpeg runs in
 * the background. The single `job_status` row is updated as extraction
 * progresses:
 *   status="audio", progress=0..100 during, then
 *   status="transcript", progress=0 when extraction finishes.
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    include: { audio: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // URL-ingestion jobs already produce audio.mp3 directly via yt-dlp; the
  // Audio row is inserted as `ready` by runDownload. Refuse extraction —
  // there's no source video to ffmpeg, and `sourceKey` is empty so the
  // child process would run with `-i ""` and fail noisily.
  if (job.kind === "url" || job.kind === "playlist_video") {
    return NextResponse.json(
      { error: "URL-ingestion jobs skip the extract step" },
      { status: 409 },
    );
  }

  // Atomic claim. Two concurrent POSTs from a fast double-click both pass
  // an `if (audio && status !== "failed")` check, both upsert, and both
  // fire ffmpeg — racing on the same audio.mp3. Instead we do an atomic
  // conditional create/update: only the call that actually flips the row
  // from a terminal state ("pending"/"failed"/missing) to "extracting"
  // gets to fire the runner.
  let claimed = false;
  if (!job.audio) {
    try {
      await prisma.audio.create({
        data: {
          jobId: id,
          storageKey: audioKey(id),
          status: "extracting",
          progress: 0,
          startedAt: new Date(),
        },
      });
      claimed = true;
    } catch {
      // Lost the race — another POST created it. Fall through to
      // updateMany which will see "extracting" and return 0.
    }
  }
  if (!claimed) {
    const result = await prisma.audio.updateMany({
      where: { jobId: id, status: { in: ["pending", "failed"] } },
      data: {
        storageKey: audioKey(id),
        status: "extracting",
        progress: 0,
        errorCode: null,
        errorMessage: null,
        startedAt: new Date(),
        readyAt: null,
      },
    });
    claimed = result.count === 1;
  }

  const audioRow = await prisma.audio.findUnique({ where: { jobId: id } });
  if (!audioRow) {
    return NextResponse.json(
      { error: "Failed to claim extraction slot" },
      { status: 500 },
    );
  }

  // If we didn't actually claim the slot, return the current row as a
  // no-op 200 — preserves the documented "in-flight POST is idempotent"
  // contract and the "ready row returns 200" semantics.
  if (!claimed) {
    return NextResponse.json(serializeAudio(audioRow), { status: 200 });
  }

  // Move the single job_status row to "audio" step, progress 0.
  await prisma.jobStatus.upsert({
    where: { jobId: id },
    create: { jobId: id, status: "audio", progress: 0 },
    update: { status: "audio", progress: 0 },
  });

  void runExtraction({
    jobId: id,
    audioId: audioRow.id,
    srcKey: job.sourceKey,
    outKey: audioKey(id),
    sourceDurationSec: job.sourceDurationSec ?? 0,
  }).catch((err) => console.error("[extract] background crashed", err));

  return NextResponse.json(serializeAudio(audioRow), { status: 202 });
}
