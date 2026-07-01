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
    // Order by createdAt so a tree-traversal insertion order (suns →
    // their planets → their moons) survives the round-trip. idx is now
    // sibling-position within parent, so it alone is no longer enough
    // to globally sort the rows.
    include: {
      chunks: { orderBy: [{ createdAt: "asc" }, { idx: "asc" }] },
    },
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
          // Flat list of rows. `level` + `parentChunkId` let Step 6
          // (HeyGen) rebuild the tree if it cares — typically it just
          // filters to `level === "planet"` and renders one video per
          // canonical planet (`duplicateOfChunkId === null`).
          chunks: run.chunks.map((c) => ({
            id: c.id,
            idx: c.idx,
            level: c.level,
            parentChunkId: c.parentChunkId,
            topic: c.topic,
            preview: c.preview,
            startSec: c.startSec,
            endSec: c.endSec,
            wordCount: c.wordCount,
            text: c.text,
            enrichedText: c.enrichedText,
            enrichmentStatus: c.enrichmentStatus,
            duplicateOfChunkId: c.duplicateOfChunkId,
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
