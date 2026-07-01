import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { prisma } from "@/lib/db";
import { getSessionId } from "@/lib/session";
import { absPathFor } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/jobs/[id]/render/[renderId]/file
 *
 * Streams the rendered mp4 for a single Render row. Supports HTTP
 * Range requests so the browser's <video> can scrub. Returns 404
 * until the render hits status="ready" and the mp4 has been
 * downloaded to disk by the background runner.
 *
 * Used by:
 *   - VideoPreviewModal in AvatarStep.tsx for the in-modal preview
 *   - CompletionScreen for the per-chunk video player
 *   - The "Download MP4" button (forces application/octet-stream
 *     via the ?download=1 query param)
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; renderId: string }> },
) {
  const { id, renderId } = await ctx.params;
  const sessionId = await getSessionId();

  const render = await prisma.render.findUnique({
    where: { id: renderId },
    select: {
      jobId: true,
      outputKey: true,
      status: true,
      job: { select: { sessionCookie: true } },
    },
  });
  if (!render) {
    return NextResponse.json({ error: "Render not found" }, { status: 404 });
  }
  if (render.jobId !== id) {
    return NextResponse.json({ error: "Render not in this job" }, { status: 400 });
  }
  if (render.job.sessionCookie && render.job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!render.outputKey || render.status !== "ready") {
    return NextResponse.json(
      { error: "Render not ready yet", status: render.status },
      { status: 409 },
    );
  }

  const abs = absPathFor(render.outputKey);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return NextResponse.json(
      { error: "Rendered file missing on disk" },
      { status: 410 },
    );
  }
  const total = stat.size;
  const range = request.headers.get("range");
  const url = new URL(request.url);
  const forceDownload = url.searchParams.get("download") === "1";

  const baseHeaders: Record<string, string> = {
    "Content-Type": forceDownload ? "application/octet-stream" : "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
  };
  if (forceDownload) {
    baseHeaders[
      "Content-Disposition"
    ] = `attachment; filename="chunk-${renderId}.mp4"`;
  }

  // Range request — slice the file. The browser's <video> tag sends
  // these for seek/scrub operations.
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) {
      return new NextResponse("Invalid Range header", { status: 416 });
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (start >= total || end >= total || start > end) {
      return new NextResponse("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    const stream = createReadStream(abs, { start, end });
    return new Response(
      Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(end - start + 1),
        },
      },
    );
  }

  // Full-file response.
  const stream = createReadStream(abs);
  return new Response(
    Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
    {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Length": String(total),
      },
    },
  );
}
