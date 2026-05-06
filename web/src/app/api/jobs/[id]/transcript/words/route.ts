import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { prisma } from "@/lib/db";
import { absPathFor } from "@/lib/storage";
import { getSessionId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/jobs/[id]/transcript/words
 *
 * Streams the saved Whisper words.json (word-level start/end times) so the
 * timestamped-transcript view can render real timecodes.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    select: { sessionCookie: true, transcript: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (
    !job.transcript ||
    job.transcript.status !== "ready" ||
    !job.transcript.wordsJsonKey
  ) {
    return NextResponse.json(
      { error: "Words not ready" },
      { status: 404 },
    );
  }

  const absPath = absPathFor(job.transcript.wordsJsonKey);
  let text: string;
  try {
    text = await fs.readFile(absPath, "utf8");
  } catch {
    return NextResponse.json({ error: "File missing" }, { status: 410 });
  }

  return new Response(text, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}
