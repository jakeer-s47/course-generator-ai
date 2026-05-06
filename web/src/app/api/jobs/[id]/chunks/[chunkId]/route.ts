import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionId } from "@/lib/session";
import { rewriteChunksJson } from "@/lib/chunksFile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/jobs/[id]/chunks/[chunkId]
 *
 * Body: { topic?: string, preview?: string, text?: string }
 *
 * Edits a single chunk's metadata (topic, preview) or its full transcript
 * text. Structural fields (start_sec, end_sec, word_count) remain
 * immutable — use /merge or /split to change those. word_count is
 * recomputed automatically from the new text on text edits.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; chunkId: string }> },
) {
  const { id, chunkId } = await ctx.params;
  const sessionId = await getSessionId();

  const body = (await request.json().catch(() => ({}))) as {
    topic?: string;
    preview?: string;
    text?: string;
  };
  const update: {
    topic?: string;
    preview?: string;
    text?: string;
    wordCount?: number;
  } = {};
  if (typeof body.topic === "string") {
    const trimmed = body.topic.trim();
    if (trimmed.length === 0) {
      return NextResponse.json(
        { error: "Topic cannot be empty" },
        { status: 400 },
      );
    }
    if (trimmed.length > 200) {
      return NextResponse.json(
        { error: "Topic too long" },
        { status: 400 },
      );
    }
    update.topic = trimmed;
  }
  if (typeof body.preview === "string") {
    const trimmed = body.preview.trim();
    if (trimmed.length > 1000) {
      return NextResponse.json(
        { error: "Preview too long" },
        { status: 400 },
      );
    }
    update.preview = trimmed;
  }
  if (typeof body.text === "string") {
    // 200 K chars is enough for ~30 K words, larger than any realistic
    // chunk. Reject anything bigger to keep DB rows sane.
    if (body.text.length > 200_000) {
      return NextResponse.json(
        { error: "Text too long" },
        { status: 400 },
      );
    }
    update.text = body.text;
    // Re-derive word_count from the edited text so downstream stages
    // (HeyGen render cost estimation, UI stats) stay accurate.
    update.wordCount = body.text
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "Nothing to update" },
      { status: 400 },
    );
  }

  // Authorise: chunk → run → job → session.
  const chunk = await prisma.chunk.findUnique({
    where: { id: chunkId },
    include: { segmentRun: { include: { job: true } } },
  });
  if (!chunk || chunk.segmentRun.jobId !== id) {
    return NextResponse.json({ error: "Chunk not found" }, { status: 404 });
  }
  if (
    chunk.segmentRun.job.sessionCookie &&
    chunk.segmentRun.job.sessionCookie !== sessionId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const updated = await prisma.chunk.update({
    where: { id: chunkId },
    data: update,
  });
  // Keep chunks.json on disk in sync — Step 6 (Render) reads it.
  await rewriteChunksJson(chunk.segmentRunId);
  return NextResponse.json(updated);
}
