import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionId } from "@/lib/session";
import { rewriteChunksJson } from "@/lib/chunksFile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/jobs/[id]/chunks/[chunkId]/merge
 *
 * Merges THIS chunk into the previous chunk (idx - 1). The previous chunk
 * absorbs this chunk's range, words, and text. This chunk is deleted and
 * subsequent chunks have their idx renumbered. Returns the updated chunk
 * list.
 *
 * Errors with 409 if this is the first chunk (no previous to merge into).
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string; chunkId: string }> },
) {
  const { id, chunkId } = await ctx.params;
  const sessionId = await getSessionId();

  const target = await prisma.chunk.findUnique({
    where: { id: chunkId },
    include: { segmentRun: { include: { job: true } } },
  });
  if (!target || target.segmentRun.jobId !== id) {
    return NextResponse.json({ error: "Chunk not found" }, { status: 404 });
  }
  if (
    target.segmentRun.job.sessionCookie &&
    target.segmentRun.job.sessionCookie !== sessionId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (target.idx === 0) {
    return NextResponse.json(
      { error: "First chunk has nothing to merge with above" },
      { status: 409 },
    );
  }

  const prev = await prisma.chunk.findUnique({
    where: {
      segmentRunId_idx: {
        segmentRunId: target.segmentRunId,
        idx: target.idx - 1,
      },
    },
  });
  if (!prev) {
    return NextResponse.json(
      { error: "Previous chunk missing — refresh and try again" },
      { status: 409 },
    );
  }

  // Apply the merge in a transaction so we never end up with gaps in idx.
  await prisma.$transaction(async (tx) => {
    // 1. Update the previous chunk to span both ranges.
    await tx.chunk.update({
      where: { id: prev.id },
      data: {
        endSec: target.endSec,
        wordCount: prev.wordCount + target.wordCount,
        text:
          prev.text || target.text
            ? `${prev.text ?? ""} ${target.text ?? ""}`.trim()
            : null,
      },
    });
    // 2. Delete the merged chunk.
    await tx.chunk.delete({ where: { id: target.id } });
    // 3. Renumber subsequent chunks. Two-pass to avoid unique-constraint
    //    collisions (idx is unique within a run).
    const followers = await tx.chunk.findMany({
      where: {
        segmentRunId: target.segmentRunId,
        idx: { gt: target.idx },
      },
      orderBy: { idx: "asc" },
    });
    // Pass 1 — bump way out of the way.
    for (const c of followers) {
      await tx.chunk.update({
        where: { id: c.id },
        data: { idx: c.idx + 100000 },
      });
    }
    // Pass 2 — settle to consecutive starting at target.idx.
    for (let i = 0; i < followers.length; i++) {
      await tx.chunk.update({
        where: { id: followers[i].id },
        data: { idx: target.idx + i },
      });
    }
    // 4. Update SegmentRun stats.
    await tx.segmentRun.update({
      where: { id: target.segmentRunId },
      data: { chunkCount: { decrement: 1 } },
    });
  });

  const chunks = await prisma.chunk.findMany({
    where: { segmentRunId: target.segmentRunId },
    orderBy: { idx: "asc" },
  });
  // Keep chunks.json on disk in sync — Step 6 (Render) reads it.
  await rewriteChunksJson(target.segmentRunId);
  return NextResponse.json({ chunks });
}
