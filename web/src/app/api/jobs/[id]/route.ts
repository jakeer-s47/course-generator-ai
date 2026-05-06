import { NextResponse } from "next/server";
import { prisma, serializeJob, serializeAudio } from "@/lib/db";
import { getSessionId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/jobs/[id]
 * Scoped to the current session cookie. Includes status, audio, and transcript
 * relations so the wizard can hydrate every step from a single fetch.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      status: true,
      audio: true,
      transcript: true,
      // Up to 3 versions (one per level). Ordered for stable rendering.
      cleanedVersions: { orderBy: { cleanLevel: "asc" } },
      // Many runs per job (one per (cleanLevel, targetMin) combination).
      // Chunks are deliberately NOT included here — fetch them via the
      // dedicated /chunks endpoint to keep this payload small.
      segmentRuns: { orderBy: [{ cleanLevel: "asc" }, { targetMin: "asc" }] },
    },
  });
  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { audio, transcript, cleanedVersions, segmentRuns, ...rest } = job;
  return NextResponse.json({
    ...serializeJob(rest),
    audio: audio ? serializeAudio(audio) : null,
    transcript: transcript ?? null,
    cleanedVersions,
    segmentRuns,
  });
}
