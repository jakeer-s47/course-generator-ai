import { NextResponse } from "next/server";
import { prisma, serializeJob } from "@/lib/db";
import { getSessionId } from "@/lib/session";
import { runDownload } from "./runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60 * 10;  // 10 min — generous for large URLs

/**
 * GET /api/jobs/[id]/download
 *
 * Lightweight polling endpoint for the URL-ingestion progress card. Returns
 * the job row + status. Same shape as GET /api/jobs/[id] but a smaller
 * payload that the UI can fetch on a 1500 ms loop without including the
 * heavier related rows.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    include: { status: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(serializeJob(job));
}

/**
 * POST /api/jobs/[id]/download
 *
 * Start (or retry) the audio download for a URL-ingestion job. Used by the
 * UI's Retry button after a failure, and by the original submission via
 * fire-and-forget (which uses the runner directly without going through
 * this route).
 *
 * Idempotent: while a download is in flight, returns the row unchanged.
 * On `failed`/`done` states, resets and re-runs.
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    include: { status: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Only URL-ingestion jobs (and their playlist children) can be re-downloaded.
  // We gate on `kind` rather than regexing sourceName because the runner
  // replaces sourceName with the resolved title on success, which would
  // make a regex check fail for partially-completed retries.
  if (job.kind !== "url" && job.kind !== "playlist_video") {
    return NextResponse.json(
      { error: "This job isn't a URL-ingestion job" },
      { status: 409 },
    );
  }

  // The URL: for failed/in-flight jobs, sourceName is still the URL (the
  // runner only swaps it after every other write succeeds). For jobs that
  // somehow reach this route after a successful run with sourceName already
  // swapped to the title, we have no URL to retry from — refuse cleanly.
  const sourceUrl = (job.sourceName ?? "").trim();
  if (!/^https?:\/\//i.test(sourceUrl)) {
    return NextResponse.json(
      { error: "This job already finished — nothing to retry" },
      { status: 409 },
    );
  }

  // Atomic claim — flip job_status to "downloading" only if it's not
  // already there. A second POST that races with this one will see
  // count===0 and return the row as a no-op. Without this, two retries
  // hammered in quick succession both spawn yt-dlp.
  const claimed = await prisma.jobStatus.updateMany({
    where: { jobId: id, status: { not: "downloading" } },
    data: { status: "downloading", progress: 0 },
  });

  if (claimed.count === 0) {
    return NextResponse.json(serializeJob(job), { status: 200 });
  }

  void runDownload({
    jobId: id,
    sourceUrl,
    fallbackTitle: sourceUrl,
  }).catch((err) => console.error("[download POST] runner crashed:", err));

  const refreshed = await prisma.job.findUnique({
    where: { id },
    include: { status: true },
  });
  return NextResponse.json(refreshed ? serializeJob(refreshed) : { id }, {
    status: 202,
  });
}
