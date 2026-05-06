import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type ExtractedAudioMeta = {
  storageKey: string;
  absPath: string;
  sizeBytes: number;
  durationSec: number;
  sampleRateHz: number;
  channels: number;
  codec: string;
  bitrateKbps: number;
};

export type ExtractProgress = {
  /** 0–100; null before duration is known */
  percent: number | null;
  /** Seconds of audio produced so far (parsed from `out_time_ms`). */
  outSec: number;
};

/**
 * Get duration + stream info of a media file via ffprobe.
 * Returns null if the file can't be probed.
 */
export async function probeDuration(
  absPath: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      absPath,
    ]);
    let out = "";
    p.stdout.on("data", (buf) => {
      out += buf.toString();
    });
    p.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? Math.round(n) : null);
    });
    p.on("error", () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// Process-local semaphore for ffmpeg audio extraction. Mirrors the yt-dlp
// semaphore in `ytdlp.ts`. Single-file uploads pay one acquire per click —
// no observable impact. Multi-file batch uploads queue here so exactly one
// ffmpeg process runs at a time, the rest of the children wait their turn.
//
// When we move to a worker package (Phase 2c), this gets replaced by a real
// queue.
// ---------------------------------------------------------------------------

const MAX_EXTRACT_CONCURRENCY = 1;
let inFlight = 0;
const waiters: Array<() => void> = [];

/**
 * Block until an extract slot is available. Always pair with
 * `releaseExtractSlot()` in a finally — losing a release leaks the slot for
 * the rest of the process lifetime.
 */
export async function acquireExtractSlot(): Promise<void> {
  while (inFlight >= MAX_EXTRACT_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
  inFlight++;
}

export function releaseExtractSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

/**
 * Extract an mp3 audio track from a source file.
 *
 * - onProgress fires as ffmpeg writes `out_time_ms` lines (roughly once a
 *   second for small files, 2–3×/sec for large ones).
 * - Resolves with output metadata once ffmpeg exits cleanly.
 * - Rejects with Error(stderr) if ffmpeg exits non-zero.
 *
 * Concurrency: serialized via `acquireExtractSlot()`. The very first
 * progress emission fires AFTER the slot is acquired, so queued multi-file
 * children sit at progress=0 ("Waiting") while the active child ticks
 * 1 → 100. This mirrors the yt-dlp playlist UX.
 */
export async function extractAudio(params: {
  srcAbsPath: string;
  outAbsPath: string;
  storageKey: string; // relative path we store in DB (STORAGE_DIR-relative)
  totalDurationSec: number; // used to compute % from out_time_ms
  onProgress?: (p: ExtractProgress) => void;
}): Promise<ExtractedAudioMeta> {
  await acquireExtractSlot();
  try {
    return await runExtractAudio(params);
  } finally {
    releaseExtractSlot();
  }
}

async function runExtractAudio(params: {
  srcAbsPath: string;
  outAbsPath: string;
  storageKey: string;
  totalDurationSec: number;
  onProgress?: (p: ExtractProgress) => void;
}): Promise<ExtractedAudioMeta> {
  const { srcAbsPath, outAbsPath, storageKey, totalDurationSec, onProgress } =
    params;

  // Slot just acquired — emit a 1% bump so the row flips from "Waiting"
  // (progress=0) to "Starting…" (progress=1) the moment we own the slot,
  // before ffmpeg has produced any output. Same trick the yt-dlp runner
  // uses for playlist downloads.
  onProgress?.({ percent: 1, outSec: 0 });

  await fs.mkdir(path.dirname(outAbsPath), { recursive: true });

  // ffmpeg args chosen for speech-to-text downstream:
  //   -vn    drop video
  //   -ac 1  downmix to mono (speech models don't need stereo)
  //   -ar 48000 sample rate 48 kHz
  //   -b:a 128k  bitrate adequate for speech, small file
  //   -progress pipe:1  emit key=value progress lines to stdout
  //   -nostats + -loglevel warning  keep stderr quiet
  //   -y   overwrite output
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostats",
    "-progress",
    "pipe:1",
    "-y",
    "-i",
    srcAbsPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-b:a",
    "128k",
    outAbsPath,
  ];

  const child = spawn("ffmpeg", args);
  let stderr = "";

  child.stdout.on("data", (buf: Buffer) => {
    // progress lines look like:
    //   out_time_ms=12345678
    //   out_time_us=12345678
    //   progress=continue | progress=end
    const text = buf.toString();
    for (const line of text.split("\n")) {
      const [key, value] = line.split("=");
      if (!key || !value) continue;
      if (key.trim() === "out_time_ms" || key.trim() === "out_time_us") {
        const us = Number(value.trim());
        if (Number.isFinite(us) && us >= 0) {
          const outSec = Math.round(us / 1_000_000);
          const percent =
            totalDurationSec > 0
              ? Math.min(100, Math.round((outSec / totalDurationSec) * 100))
              : null;
          onProgress?.({ percent, outSec });
        }
      }
    }
  });

  child.stderr.on("data", (buf: Buffer) => {
    stderr += buf.toString();
  });

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(
      `ffmpeg exited with code ${exitCode}: ${stderr.slice(0, 400)}`,
    );
  }

  // Re-probe the output to get exact size + duration (ffmpeg's final frame
  // may not quite match totalDurationSec — trust the output file itself).
  const stat = await fs.stat(outAbsPath);
  const realDuration =
    (await probeDuration(outAbsPath)) ?? totalDurationSec;

  return {
    storageKey,
    absPath: outAbsPath,
    sizeBytes: stat.size,
    durationSec: realDuration,
    sampleRateHz: 48000,
    channels: 1,
    codec: "mp3",
    bitrateKbps: 128,
  };
}
