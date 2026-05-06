import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { prisma } from "@/lib/db";
import { absPathFor } from "@/lib/storage";
import { getSessionId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/jobs/[id]/audio/file
 *
 * Streams the extracted audio MP3 so the browser's <audio> element can play
 * and scrub it. Honours HTTP Range requests so seeking works.
 * Session-scoped: must match the cookie that created the job.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    include: { audio: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!job.audio || job.audio.status !== "ready") {
    return NextResponse.json(
      { error: "Audio not ready" },
      { status: 404 },
    );
  }

  const absPath = absPathFor(job.audio.storageKey);

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return NextResponse.json({ error: "File missing" }, { status: 410 });
  }

  const total = stat.size;
  const rangeHeader = request.headers.get("range");

  // Range request → 206 Partial Content. Audio players require this to scrub.
  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : total - 1;
      if (start >= total || end >= total || start > end) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${total}` },
        });
      }
      const fh = await fs.open(absPath, "r");
      try {
        const chunkLen = end - start + 1;
        const buf = Buffer.alloc(chunkLen);
        await fh.read(buf, 0, chunkLen, start);
        return new Response(buf, {
          status: 206,
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Length": String(chunkLen),
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
          },
        });
      } finally {
        await fh.close();
      }
    }
  }

  // Full download — safe for the small (<100 MB) mp3s this POC produces.
  const buf = await fs.readFile(absPath);
  return new Response(buf, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
    },
  });
}
