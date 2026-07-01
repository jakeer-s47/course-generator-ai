import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/db";
import { getSessionId } from "@/lib/session";
import { absPathFor, instructorPhotoKey } from "@/lib/storage";

const exec = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB cap on the photo
// We canonicalise every upload to PNG via ffmpeg below, so the user can
// drop almost any image format and HeyGen still sees real PNG bytes. We
// only reject obviously-not-image MIME types up front to avoid spending
// an ffmpeg cycle on a junk upload.
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
  // Browsers sometimes send octet-stream when the extension is unknown
  // (e.g. an AVIF saved as .jpg) — let it through and rely on ffmpeg to
  // decode-or-reject.
  "application/octet-stream",
]);

/**
 * POST /api/jobs/[id]/instructor-photo
 *
 * Body: multipart/form-data with field `photo`.
 *
 * Stores the uploaded instructor photo at
 * uploads/<jobId>/render/instructor.<ext> and persists the key on the
 * Job row. Used when renderStyle = "instructor" at Step 6 — the
 * talking-head avatar provider (HeyGen / Synthesia) will be passed
 * this image when rendering kicks off.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    select: { sessionCookie: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data body" },
      { status: 400 },
    );
  }
  const photo = form.get("photo");
  if (!(photo instanceof File)) {
    return NextResponse.json(
      { error: "Missing `photo` file field" },
      { status: 400 },
    );
  }
  if (photo.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Photo too large (max ${MAX_BYTES / 1024 / 1024} MB)` },
      { status: 413 },
    );
  }
  const mime = photo.type || "";
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json(
      { error: `Unsupported image type ${mime || "(unknown)"} — use JPEG or PNG` },
      { status: 415 },
    );
  }

  // Always canonicalise to PNG via ffmpeg. The browser's reported MIME is
  // unreliable — Chrome's "Save image as" silently writes AVIF bytes to a
  // file the user named `.jpg`, and HeyGen's Talking Photo upload then
  // 400s with "Image format not supported". Transcoding here catches:
  // AVIF / HEIC / WebP / WBMP / oversized JPEGs / EXIF-rotated JPEGs.
  // ffmpeg auto-detects the source format; on decode failure we surface
  // a clean 415 instead of leaking ffmpeg's stderr.
  const key = instructorPhotoKey(id, "png");
  const abs = absPathFor(key);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const buffer = Buffer.from(await photo.arrayBuffer());
  const tmpIn = path.join(
    os.tmpdir(),
    `instructor-upload-${id}-${process.pid}-${Math.floor(Math.random() * 1e9)}.bin`,
  );
  await fs.writeFile(tmpIn, buffer);
  try {
    await exec("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      tmpIn,
      // Drop alpha + strip metadata for a maximally-compatible PNG that
      // HeyGen will accept across all of its endpoints.
      "-pix_fmt",
      "rgb24",
      "-map_metadata",
      "-1",
      abs,
    ]);
  } catch (err) {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(abs).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[instructor-photo] ffmpeg transcode failed (mime=${mime}): ${msg.slice(0, 200)}`,
    );
    return NextResponse.json(
      {
        error:
          "Could not decode the uploaded image. Save it as a real JPEG or PNG and try again.",
      },
      { status: 415 },
    );
  }
  await fs.unlink(tmpIn).catch(() => {});

  // Clear the cached HeyGen talking_photo_id — it belongs to the PREVIOUS
  // photo. Without this, re-uploading a new photo would still render the
  // old face (the runner reuses instructorPhotoHeygenId when present).
  await prisma.job.update({
    where: { id },
    data: { instructorPhotoKey: key, instructorPhotoHeygenId: null },
  });

  const finalSize = (await fs.stat(abs)).size;
  return NextResponse.json({ key, size: finalSize });
}

/**
 * GET /api/jobs/[id]/instructor-photo
 *
 * Streams the stored photo so the UI can preview it after a refresh.
 * Returns 404 when no photo has been uploaded yet.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    select: { sessionCookie: true, instructorPhotoKey: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!job.instructorPhotoKey) {
    return NextResponse.json({ error: "No photo uploaded" }, { status: 404 });
  }
  const abs = absPathFor(job.instructorPhotoKey);
  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch {
    return NextResponse.json({ error: "Photo missing on disk" }, { status: 404 });
  }
  const ext = path.extname(job.instructorPhotoKey).slice(1);
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : "application/octet-stream";
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: { "Content-Type": mime, "Cache-Control": "private, max-age=60" },
  });
}
