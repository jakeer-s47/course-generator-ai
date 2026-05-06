import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { absPathFor, chunksJsonKey } from "@/lib/storage";

/**
 * Re-write the on-disk chunks.json for a SegmentRun from the current chunk
 * rows in the DB. Used by merge / split / rename routes to keep the JSON
 * file (which Step 6's render path consumes) in sync after user edits.
 *
 * Best-effort: a missing run or write failure is logged but doesn't throw —
 * the DB is the source of truth, the file is a denormalized copy.
 */
export async function rewriteChunksJson(runId: string): Promise<void> {
  const run = await prisma.segmentRun.findUnique({
    where: { id: runId },
    include: { chunks: { orderBy: { idx: "asc" } } },
  });
  if (!run) return;

  const key = chunksJsonKey(run.jobId, run.cleanLevel, run.targetMin);
  const abs = absPathFor(key);
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(
      abs,
      JSON.stringify(
        {
          cleanLevel: run.cleanLevel,
          targetMin: run.targetMin,
          chunks: run.chunks.map((c) => ({
            idx: c.idx,
            topic: c.topic,
            preview: c.preview,
            startSec: c.startSec,
            endSec: c.endSec,
            wordCount: c.wordCount,
            text: c.text,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    console.error("[rewriteChunksJson] failed for run", runId, err);
  }
}
