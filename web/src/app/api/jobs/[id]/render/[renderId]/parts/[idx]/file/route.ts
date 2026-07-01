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
 * GET /api/jobs/[id]/render/[renderId]/parts/[idx]/file
 *
 * Streams ONE per-part mp4 (the sub-render that came back from one
 * HeyGen createVideo call). Supports HTTP Range requests so the
 * browser's <video> can scrub. Returns 404 until that part hits
 * status="ready" and its mp4 has been downloaded to disk.
 *
 * Used by the per-part Play / Download buttons in the chunk row's
 * expanded parts list, before the user has clicked Merge.
 */
export async function GET(
  request: Request,
  ctx: {
    params: Promise<{ id: string; renderId: string; idx: string }>;
  },
) {
  const { id, renderId, idx: idxRaw } = await ctx.params;
  const sessionId = await getSessionId();

  const idx = parseInt(idxRaw, 10);
  if (!Number.isInteger(idx) || idx < 0) {
    return NextResponse.json({ error: "Invalid part index" }, { status: 400 });
  }

  // Single round-trip: validate Render belongs to job + session, AND
  // fetch the specific part.
  const render = await prisma.render.findUnique({
    where: { id: renderId },
    select: {
      jobId: true,
      job: { select: { sessionCookie: true } },
      parts: {
        where: { idx },
        select: { status: true, outputKey: true, durationSec: true },
      },
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
  const part = render.parts[0];
  if (!part) {
    return NextResponse.json({ error: "Part not found" }, { status: 404 });
  }
  if (part.status !== "ready" || !part.outputKey) {
    return NextResponse.json(
      { error: "Part not ready yet", status: part.status },
      { status: 409 },
    );
  }

  const abs = absPathFor(part.outputKey);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return NextResponse.json(
      { error: "Part file missing on disk" },
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
    ] = `attachment; filename="part-${String(idx).padStart(3, "0")}.mp4"`;
  }

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
