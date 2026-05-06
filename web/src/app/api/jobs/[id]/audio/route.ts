import { NextResponse } from "next/server";
import { prisma, serializeAudio } from "@/lib/db";
import { getSessionId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/jobs/[id]/audio
 *
 * Returns the Audio row for this job. 404 if extraction hasn't been
 * requested yet. Used by the frontend to poll progress during extraction.
 */
export async function GET(
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
  if (!job.audio) {
    return NextResponse.json(
      { error: "Audio extraction not started yet" },
      { status: 404 },
    );
  }
  return NextResponse.json(serializeAudio(job.audio));
}
