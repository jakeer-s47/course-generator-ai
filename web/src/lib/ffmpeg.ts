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

/**
 * Probe the FIRST audio stream of a file for its codec + sample rate +
 * channel count. Used to decide whether we can `-c:a copy` (skip
 * re-encoding) when the source is already mp3 / 16 kHz / mono — the
 * exact shape we want for Whisper.
 *
 * Returns null if the file has no audio stream or ffprobe fails.
 */
async function probeAudioStream(
  absPath: string,
): Promise<{ codec: string; sampleRate: number; channels: number } | null> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,sample_rate,channels",
      "-of",
      "default=noprint_wrappers=1",
      absPath,
    ]);
    let out = "";
    p.stdout.on("data", (buf) => {
      out += buf.toString();
    });
    p.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const result: Record<string, string> = {};
      for (const line of out.split("\n")) {
        const [k, v] = line.split("=");
        if (k && v) result[k.trim()] = v.trim();
      }
      const codec = result.codec_name;
      const sampleRate = Number(result.sample_rate);
      const channels = Number(result.channels);
      if (!codec || !Number.isFinite(sampleRate) || !Number.isFinite(channels)) {
        return resolve(null);
      }
      resolve({ codec, sampleRate, channels });
    });
    p.on("error", () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// Process-local semaphore for ffmpeg audio extraction. Mirrors the yt-dlp
// semaphore in `ytdlp.ts`. Single-file uploads pay one acquire per click —
// no observable impact. Multi-file batch uploads queue here so at most
// MAX_EXTRACT_CONCURRENCY ffmpeg processes run at once; the rest wait.
//
// Set to 2 — a single ffmpeg invocation already saturates a couple of CPU
// cores (especially with -threads 0 below), and two parallel processes
// roughly halves wall-clock time on multi-file batches without thrashing
// the disk on a modern machine. Bump higher if you're on a dedicated
// transcoding box.
//
// When we move to a worker package (Phase 2c), this gets replaced by a real
// queue.
// ---------------------------------------------------------------------------

const MAX_EXTRACT_CONCURRENCY = 2;
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

  // Fast path — if the source is already mp3 at 16 kHz mono (e.g. a user
  // uploaded a podcast feed or an already-processed lecture), skip the
  // re-encode entirely with `-c:a copy`. This is ~10x faster than a full
  // re-encode because ffmpeg just stream-copies the audio packets and
  // strips the (possibly absent) video container.
  const probed = await probeAudioStream(srcAbsPath);
  const canCopy =
    probed?.codec === "mp3" &&
    probed?.sampleRate === 16000 &&
    probed?.channels === 1;

  // ffmpeg args chosen for speech-to-text downstream:
  //   -vn         drop video
  //   -ac 1       downmix to mono (speech models don't need stereo)
  //   -ar 16000   sample rate 16 kHz — Whisper's native input rate.
  //               Encoding directly to 16 kHz (vs 48 kHz) avoids an
  //               internal resample inside Whisper AND shrinks the mp3
  //               ~3x, so the upload to the Python service is faster
  //               and the model spends less time on every chunk.
  //   -b:a 64k    bitrate adequate for 16 kHz speech (was 128 k @ 48 kHz)
  //   -threads 0  let ffmpeg auto-detect host cores instead of running
  //               single-threaded (the default for libmp3lame). 2-3x
  //               faster encoding on a multi-core machine.
  //   -progress pipe:1  emit key=value progress lines to stdout
  //   -nostats + -loglevel warning  keep stderr quiet
  //   -y          overwrite output
  const baseArgs = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostats",
    "-progress",
    "pipe:1",
    "-y",
    "-threads",
    "0",
    "-i",
    srcAbsPath,
    "-vn",
  ];
  const encodingArgs = canCopy
    ? // Stream-copy fast path. No -ac/-ar/-b:a flags — we're not
      // re-encoding, just remuxing the audio packets to a bare mp3.
      ["-c:a", "copy", outAbsPath]
    : [
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        outAbsPath,
      ];
  const args = [...baseArgs, ...encodingArgs];

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
    sampleRateHz: 16000,
    channels: 1,
    codec: "mp3",
    bitrateKbps: 64,
  };
}

/**
 * Concatenate N mp4 files into one output mp4 using ffmpeg's concat demuxer
 * with stream copy. Works without re-encoding when the input files share
 * the same codec parameters (codec, resolution, frame rate, audio sample
 * rate) — which is the case for sub-videos generated back-to-back by the
 * same HeyGen avatar render. Falls back to re-encoding (libx264 + aac) on
 * `Non-monotonic DTS` or similar concat-demuxer rejections.
 *
 * Used by Step 6 to stitch multi-part HeyGen renders (each ≤5,000-char
 * script segment) into one continuous chunk video.
 */
export async function concatMp4Files(params: {
  partAbsPaths: string[];
  outAbsPath: string;
}): Promise<{ sizeBytes: number; durationSec: number }> {
  const { partAbsPaths, outAbsPath } = params;
  if (partAbsPaths.length === 0) {
    throw Object.assign(new Error("concatMp4Files called with zero parts"), {
      code: "E_FFMPEG_CONCAT",
    });
  }
  if (partAbsPaths.length === 1) {
    // Single part — just copy/rename, no ffmpeg needed.
    await fs.mkdir(path.dirname(outAbsPath), { recursive: true });
    await fs.copyFile(partAbsPaths[0], outAbsPath);
    const stat = await fs.stat(outAbsPath);
    const dur = (await probeDuration(outAbsPath)) ?? 0;
    return { sizeBytes: stat.size, durationSec: dur };
  }

  await fs.mkdir(path.dirname(outAbsPath), { recursive: true });
  // Write the filelist next to the output so the relative-path debugging
  // is local. The concat demuxer reads `file '<path>'` lines.
  const listPath = `${outAbsPath}.concatlist.txt`;
  const listBody = partAbsPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listPath, listBody);

  // First try stream copy (fast, lossless).
  let err: Error | null = null;
  try {
    await runFfmpegConcat(listPath, outAbsPath, /*reencode*/ false);
  } catch (e) {
    err = e as Error;
    // Re-try with re-encoding only on concat-typical failure modes.
    const msg = err.message;
    if (
      /Non-monotonic DTS|codec|invalid argument|Could not write header/i.test(
        msg,
      )
    ) {
      console.warn(
        `[ffmpeg] concat stream-copy failed (${msg.slice(0, 120)}); re-encoding`,
      );
      await runFfmpegConcat(listPath, outAbsPath, /*reencode*/ true);
      err = null;
    }
  }
  // Cleanup listfile (best-effort)
  await fs.rm(listPath, { force: true }).catch(() => {});
  if (err) throw err;

  const stat = await fs.stat(outAbsPath);
  const dur = (await probeDuration(outAbsPath)) ?? 0;
  return { sizeBytes: stat.size, durationSec: dur };
}

function runFfmpegConcat(
  listPath: string,
  outAbsPath: string,
  reencode: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostats",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      ...(reencode
        ? ["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-c:a", "aac"]
        : ["-c", "copy"]),
      outAbsPath,
    ];
    const child = spawn("ffmpeg", args);
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          Object.assign(
            new Error(
              `ffmpeg concat exited ${code}: ${stderr.slice(0, 400)}`,
            ),
            { code: "E_FFMPEG_CONCAT" },
          ),
        );
    });
  });
}
