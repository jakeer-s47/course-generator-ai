// ─── Post-merge video polish (intro + outro title cards) ──────────────
//
// What this provides:
//   polishVideo(inputAbsPath, topic, chunkNumber, totalChunks)
//     → adds a 3-sec intro card (topic + "Chunk N of M") and a 2-sec
//       outro card ("End of chapter") to the merged chunk video.
//
// Design:
//   - Single ffmpeg invocation re-encodes to libx264/aac and concats
//     intro + main + outro via the `concat` filter (handles codec
//     differences in one pass).
//   - In-place replacement of the input file (atomic-ish rename).
//   - Caller (merge endpoint) wraps the call in try/catch and falls back
//     to the unpolished concat output on any failure — paid renders are
//     never lost to a polish bug.
//   - Hard-cap on output duration via probe so the Render.durationSec
//     reflects the polished length (intro + main + outro).
//
// The render route's existing parts → ffmpeg-concat → output.mp4 flow is
// untouched. This is purely a post-merge enrichment.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

const exec = promisify(execFile);

// ffmpeg drawtext needs a fontfile to be reliable across docker/headless
// envs (where fontconfig may not resolve a default). Pick the first
// existing path; if none of these exist, omit fontfile and trust the
// system to pick something — that path is the least reliable but at
// least it doesn't error out.
const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
];
const FONT_PATH = (() => {
  for (const p of FONT_CANDIDATES) if (existsSync(p)) return p;
  return null;
})();

// Escape a string for ffmpeg drawtext. Single quotes are the delimiter
// inside the filter graph, and `:` / `\` / `%` have special meaning.
function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    // drawtext renders newlines literally; collapse to spaces.
    .replace(/\s+/g, " ")
    .trim();
}

async function probeStream(inputAbsPath: string): Promise<{
  width: number;
  height: number;
  fps: number;
}> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate",
    "-of", "json",
    inputAbsPath,
  ]);
  const data = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
  };
  const s = data.streams?.[0] ?? {};
  const [num, den] = String(s.r_frame_rate ?? "30/1").split("/").map(Number);
  return {
    width: s.width ?? 1280,
    height: s.height ?? 720,
    fps: den ? num / den : 30,
  };
}

async function probeDuration(inputAbsPath: string): Promise<number> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    inputAbsPath,
  ]);
  return Number(stdout.trim()) || 0;
}

/**
 * Add intro + outro title cards to a video and re-encode in place.
 *
 * Intro (3 s): topic title (large) + "Chunk N of M" subtitle.
 * Outro (2 s): "End of chapter" centered.
 * Both cards: dark slate (#0f172a) background, white type. The intro
 * matches the existing wizard aesthetic.
 *
 * Throws on any ffmpeg/ffprobe failure. The caller is expected to fall
 * back to the unpolished input — the input file is NEVER mutated if
 * this function throws (we write to a sibling .polished.mp4 first and
 * only rename on success).
 */
export async function polishVideo(params: {
  inputAbsPath: string;
  topic: string;
  chunkNumber: number; // 1-based
  totalChunks: number;
}): Promise<{ durationSec: number }> {
  const { inputAbsPath, topic, chunkNumber, totalChunks } = params;
  const tempAbsPath = `${inputAbsPath}.polished.mp4`;

  const { width, height, fps } = await probeStream(inputAbsPath);

  // Scale type sizes with resolution so 720p and 1080p both look balanced.
  const titleSize = Math.max(28, Math.floor(height * 0.075));
  const subtitleSize = Math.max(16, Math.floor(height * 0.032));

  const introTopic = escapeDrawtext(topic);
  const introSub = escapeDrawtext(`Chunk ${chunkNumber} of ${totalChunks}`);
  const outroText = escapeDrawtext("End of chapter");

  const fontfile = FONT_PATH ? `:fontfile='${FONT_PATH}'` : "";

  // Two-line intro: title centered vertically, subtitle one line below.
  const introFilter = [
    `drawtext=text='${introTopic}':fontcolor=white:fontsize=${titleSize}${fontfile}:x=(w-text_w)/2:y=(h/2)-${Math.floor(titleSize * 0.9)}`,
    `drawtext=text='${introSub}':fontcolor=0x94a3b8:fontsize=${subtitleSize}${fontfile}:x=(w-text_w)/2:y=(h/2)+${Math.floor(subtitleSize * 0.5)}`,
  ].join(",");

  const outroFilter = `drawtext=text='${outroText}':fontcolor=white:fontsize=${titleSize}${fontfile}:x=(w-text_w)/2:y=(h-text_h)/2`;

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    // [0] intro video (3 s solid color)
    "-f", "lavfi", "-i",
      `color=c=0x0f172a:s=${width}x${height}:d=3:r=${Math.round(fps) || 30}`,
    // [1] intro silent audio
    "-f", "lavfi", "-i", `anullsrc=cl=stereo:r=44100:d=3`,
    // [2] main video (the merged parts)
    "-i", inputAbsPath,
    // [3] outro video (2 s solid color)
    "-f", "lavfi", "-i",
      `color=c=0x0f172a:s=${width}x${height}:d=2:r=${Math.round(fps) || 30}`,
    // [4] outro silent audio
    "-f", "lavfi", "-i", `anullsrc=cl=stereo:r=44100:d=2`,
    "-filter_complex",
      `[0:v]${introFilter}[introv]; ` +
      `[3:v]${outroFilter}[outrov]; ` +
      `[introv][1:a][2:v][2:a][outrov][4:a]concat=n=3:v=1:a=1[outv][outa]`,
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-c:a", "aac",
    "-pix_fmt", "yuv420p",
    "-preset", "fast",
    "-movflags", "+faststart",
    tempAbsPath,
  ];

  try {
    await exec("ffmpeg", args, { maxBuffer: 100 * 1024 * 1024 });
  } catch (err) {
    await fs.unlink(tempAbsPath).catch(() => {});
    throw err;
  }

  await fs.rename(tempAbsPath, inputAbsPath);
  const durationSec = await probeDuration(inputAbsPath);
  return { durationSec };
}
