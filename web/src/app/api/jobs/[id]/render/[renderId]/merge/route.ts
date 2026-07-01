import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { prisma } from "@/lib/db";
import { getSessionId } from "@/lib/session";
import { absPathFor, renderOutputKey } from "@/lib/storage";
import { concatMp4Files } from "@/lib/ffmpeg";
import { polishVideo } from "@/lib/polish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/jobs/[id]/render/[renderId]/merge
 *
 * After the runner finishes downloading per-part MP4s, the Render row sits
 * at status="parts_ready" with all ready RenderPart rows showing Play
 * buttons in the UI. The user clicks "Merge All Parts" → this endpoint
 * runs ffmpeg-concat over every ready part (in idx order), writes the
 * final `uploads/.../output.mp4`, marks the Render row as `ready`, and
 * cleans up the parts/ directory.
 *
 * Idempotent: if the row is already `ready` (e.g. user double-clicks),
 * returns the existing row. If it's `merging`, returns 202 with the row
 * so the UI keeps polling.
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string; renderId: string }> },
) {
  const { id, renderId } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    select: { sessionCookie: true },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const render = await prisma.render.findUnique({
    where: { id: renderId },
    include: { parts: { orderBy: { idx: "asc" } } },
  });
  if (!render || render.jobId !== id) {
    return NextResponse.json({ error: "Render not found" }, { status: 404 });
  }

  // Idempotency — already merged or mid-merge.
  if (render.status === "ready") {
    return NextResponse.json({ render }, { status: 200 });
  }
  if (render.status === "merging") {
    return NextResponse.json({ render }, { status: 202 });
  }

  // Anything other than parts_ready is a precondition violation. The UI
  // shouldn't surface the Merge button outside of parts_ready, but the
  // server enforces it defensively.
  if (render.status !== "parts_ready") {
    return NextResponse.json(
      {
        error: `Cannot merge — render is in status "${render.status}". Wait for all parts to finish, then retry.`,
        code: "E_NOT_PARTS_READY",
      },
      { status: 409 },
    );
  }

  const readyParts = render.parts.filter(
    (p) => p.status === "ready" && p.outputKey,
  );
  if (readyParts.length === 0) {
    return NextResponse.json(
      {
        error: "No ready parts to merge.",
        code: "E_NO_READY_PARTS",
      },
      { status: 409 },
    );
  }

  // Lock the row to merging so concurrent merge requests don't race. The
  // updateMany guard returns 0 if another request beat us to it.
  const locked = await prisma.render.updateMany({
    where: { id: renderId, status: "parts_ready" },
    data: { status: "merging", progress: 95 },
  });
  if (locked.count === 0) {
    const after = await prisma.render.findUnique({ where: { id: renderId } });
    return NextResponse.json(
      { render: after },
      { status: 202 },
    );
  }

  // Fire the background merge — return 202 immediately so the UI keeps
  // polling. The merge usually runs in well under a second (stream copy
  // when sub-videos share codec params, which HeyGen guarantees) but
  // keeping it async means a slow ffmpeg never blocks the HTTP response.
  void runMerge({
    renderId,
    jobId: id,
    chunkId: render.chunkId,
    partAbsPaths: readyParts.map((p) => absPathFor(p.outputKey!)),
  }).catch((err) => {
    console.error("[merge] background crashed", err);
  });

  return NextResponse.json(
    {
      render: { ...render, status: "merging", progress: 95 },
      partsToMerge: readyParts.length,
    },
    { status: 202 },
  );
}

async function runMerge(params: {
  renderId: string;
  jobId: string;
  chunkId: string;
  partAbsPaths: string[];
}): Promise<void> {
  const { renderId, jobId, chunkId, partAbsPaths } = params;
  const outKey = renderOutputKey(jobId, chunkId);
  const outAbs = absPathFor(outKey);

  try {
    const concatResult = await concatMp4Files({
      partAbsPaths,
      outAbsPath: outAbs,
    });

    // Post-merge polish: prepend a 3-sec intro card (topic + chunk
    // position) and append a 2-sec outro card. Implemented as a separate
    // ffmpeg pass that overwrites the merged output in place. Disabled
    // via POLISH_VIDEOS=0. Any failure falls back to the unpolished
    // concat output so a polish bug never costs the user their paid
    // render.
    let finalDuration = concatResult.durationSec;
    if (process.env.POLISH_VIDEOS !== "0") {
      try {
        const chunk = await prisma.chunk.findUnique({
          where: { id: chunkId },
          select: {
            topic: true,
            idx: true,
            segmentRun: { select: { chunkCount: true } },
          },
        });
        if (chunk) {
          const polished = await polishVideo({
            inputAbsPath: outAbs,
            topic: chunk.topic,
            chunkNumber: chunk.idx + 1,
            totalChunks: chunk.segmentRun?.chunkCount ?? 1,
          });
          finalDuration = polished.durationSec || finalDuration;
          console.log(
            `[polish] added intro+outro to ${outKey} → ${Math.round(finalDuration)}s`,
          );
        }
      } catch (err) {
        console.warn(
          `[polish] failed (keeping unpolished output): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await prisma.render.update({
      where: { id: renderId },
      data: {
        status: "ready",
        progress: 100,
        outputKey: outKey,
        durationSec: finalDuration || null,
        readyAt: new Date(),
        // Clear any "X of N parts ready" message now that there's a real
        // merged output.
        errorCode: null,
        errorMessage: null,
      },
    });

    // Clean up the parts/ tree — the merged output is the source of truth
    // now, and the part files would only inflate disk usage. RenderPart
    // rows stay so the UI can still show "merged from N parts" history.
    const partsDirAbs = outAbs.replace(/[^/]+$/, "parts");
    await fs.rm(partsDirAbs, { recursive: true, force: true }).catch(() => {});
    console.log(
      `[merge] renderId=${renderId} merged ${partAbsPaths.length} parts → ${outKey} (${Math.round(concatResult.sizeBytes / 1024 / 1024)} MB, ${Math.round(concatResult.durationSec)}s)`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code ?? "E_FFMPEG_CONCAT";
    console.error(`[merge] ${code} for renderId=${renderId}: ${message}`);
    await prisma.render
      .update({
        where: { id: renderId },
        data: {
          // Drop back to parts_ready so the user can retry merge — the
          // parts are still on disk and re-runnable.
          status: "parts_ready",
          errorCode: code,
          errorMessage: `Merge failed: ${message.slice(0, 300)}`,
        },
      })
      .catch(() => {});
  }
}
