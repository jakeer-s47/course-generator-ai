import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { prisma } from "@/lib/db";
import { absPathFor } from "@/lib/storage";
import { getSessionId } from "@/lib/session";
import { rewriteChunksJson } from "@/lib/chunksFile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WordEntry = { word: string; start: number; end: number };

/**
 * POST /api/jobs/[id]/chunks/[chunkId]/split
 *
 * Body: { atSec?: number }
 *
 * Splits THIS chunk into two adjacent chunks. The split point defaults to
 * the midpoint, but the client can pass `atSec` to choose any second within
 * the chunk's range. The text and word_count are recomputed against the
 * cleaned word array on disk so timing stays exact.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; chunkId: string }> },
) {
  const { id, chunkId } = await ctx.params;
  const sessionId = await getSessionId();

  const body = (await request.json().catch(() => ({}))) as { atSec?: number };

  const target = await prisma.chunk.findUnique({
    where: { id: chunkId },
    include: {
      segmentRun: {
        include: {
          job: {
            include: {
              cleanedVersions: true,
            },
          },
        },
      },
    },
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

  const midpoint = Math.round((target.startSec + target.endSec) / 2);
  const atSec =
    typeof body.atSec === "number" && Number.isFinite(body.atSec)
      ? Math.round(body.atSec)
      : midpoint;
  if (atSec <= target.startSec + 5 || atSec >= target.endSec - 5) {
    return NextResponse.json(
      { error: "Split point must be at least 5 seconds from each boundary" },
      { status: 400 },
    );
  }

  // Re-derive text + word counts for both halves from the cleaned source.
  const sourceCleaned = target.segmentRun.job.cleanedVersions.find(
    (cv) => cv.cleanLevel === target.segmentRun.cleanLevel,
  );
  if (!sourceCleaned?.cleanedWordsKey) {
    return NextResponse.json(
      { error: "Source cleaned words missing" },
      { status: 409 },
    );
  }
  const wordsAbs = absPathFor(sourceCleaned.cleanedWordsKey);
  let words: WordEntry[] = [];
  try {
    const buf = await fs.readFile(wordsAbs, "utf8");
    const f = JSON.parse(buf) as { words: WordEntry[] };
    words = Array.isArray(f.words) ? f.words : [];
  } catch {
    return NextResponse.json(
      { error: "Couldn't read cleaned words" },
      { status: 410 },
    );
  }

  const inRange = (start: number, end: number) =>
    words.filter((w) => w.start >= start && w.start < end);
  const joinText = (ws: WordEntry[]) =>
    ws
      .map((w) => w.word.trim())
      .join(" ")
      .replace(/\s+([.,!?;:])/g, "$1")
      .trim();

  const aWords = inRange(target.startSec, atSec);
  const bWords = inRange(atSec, target.endSec);

  const aData = {
    topic: `${target.topic} (Part 1)`,
    preview: target.preview,
    startSec: target.startSec,
    endSec: atSec,
    wordCount: aWords.length,
    text: joinText(aWords),
  };
  const bData = {
    topic: `${target.topic} (Part 2)`,
    preview: target.preview,
    startSec: atSec,
    endSec: target.endSec,
    wordCount: bWords.length,
    text: joinText(bWords),
  };

  await prisma.$transaction(async (tx) => {
    // 1. Bump sibling followers' idx by +1. Scoped to the same parent
    //    under hierarchical model. (segmentRunId, idx) unique was
    //    dropped when hierarchy was added — single pass works.
    const followers = await tx.chunk.findMany({
      where: {
        segmentRunId: target.segmentRunId,
        parentChunkId: target.parentChunkId,
        idx: { gt: target.idx },
      },
      orderBy: { idx: "desc" }, // descending → no transient collisions
    });
    for (const c of followers) {
      await tx.chunk.update({
        where: { id: c.id },
        data: { idx: c.idx + 1 },
      });
    }
    // 2. Update target → first half.
    await tx.chunk.update({
      where: { id: target.id },
      data: aData,
    });
    // 3. Insert second half right after, inheriting the same parent +
    //    level so the new sibling lives at the same tree depth.
    await tx.chunk.create({
      data: {
        segmentRunId: target.segmentRunId,
        idx: target.idx + 1,
        parentChunkId: target.parentChunkId,
        level: target.level,
        ...bData,
      },
    });
    // 4. Bump SegmentRun's chunkCount.
    await tx.segmentRun.update({
      where: { id: target.segmentRunId },
      data: { chunkCount: { increment: 1 } },
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
