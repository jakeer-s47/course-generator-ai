import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import youtubeDl from "youtube-dl-exec";
import { probeDuration } from "./ffmpeg";

// Shape of the metadata blob returned by `yt-dlp -j`. Only fields we care
// about are typed; the rest is ignored.
type YtdlpMeta = {
  id?: string;
  title?: string;
  duration?: number;          // seconds
  ext?: string;
  filesize_approx?: number;
  uploader?: string;
  channel?: string;
  is_live?: boolean;
  webpage_url?: string;
};

export type ProbeResult = {
  title: string;
  durationSec: number;
  channel: string | null;
  approxSizeBytes: number | null;
};

export type DownloadProgress = {
  percent: number;             // 0..100
};

export type AudioMeta = {
  absPath: string;
  sizeBytes: number;
  durationSec: number;
  sampleRateHz: number;
  channels: number;
  codec: string;
  bitrateKbps: number;
};

export type YtdlpErrorCode =
  | "E_YTDLP_BAD_URL"
  | "E_YTDLP_LIVE"
  | "E_YTDLP_AUTH"
  | "E_YTDLP_GEO"
  | "E_YTDLP";

const FRIENDLY_MESSAGES: Record<YtdlpErrorCode, string> = {
  E_YTDLP_BAD_URL:
    "We couldn't recognise that link. Try YouTube, Vimeo, or a direct video URL.",
  E_YTDLP_LIVE:
    "Live broadcasts aren't supported yet — wait until the recording is published.",
  E_YTDLP_AUTH:
    "This video requires sign-in. Download it manually and upload the file instead.",
  E_YTDLP_GEO:
    "This video isn't available from this server's region.",
  E_YTDLP:
    "Couldn't fetch the video. Check the URL and try again.",
};

/** Map yt-dlp stderr text to a code + UI-friendly message. */
export function classifyYtdlpError(
  stderr: string,
): { code: YtdlpErrorCode; message: string } {
  if (/sign in to confirm/i.test(stderr)) {
    return { code: "E_YTDLP_AUTH", message: FRIENDLY_MESSAGES.E_YTDLP_AUTH };
  }
  if (/is live event will begin/i.test(stderr) || /\bis live\b/i.test(stderr)) {
    return { code: "E_YTDLP_LIVE", message: FRIENDLY_MESSAGES.E_YTDLP_LIVE };
  }
  if (/Unsupported URL/i.test(stderr)) {
    return { code: "E_YTDLP_BAD_URL", message: FRIENDLY_MESSAGES.E_YTDLP_BAD_URL };
  }
  if (
    /HTTP Error 403/i.test(stderr) ||
    /not available in your country/i.test(stderr) ||
    /blocked it on copyright/i.test(stderr)
  ) {
    return { code: "E_YTDLP_GEO", message: FRIENDLY_MESSAGES.E_YTDLP_GEO };
  }
  return { code: "E_YTDLP", message: FRIENDLY_MESSAGES.E_YTDLP };
}

/**
 * Quick metadata-only probe (~1 sec). Returns the title + duration so the
 * UI can show a confirmation card before committing to a full download.
 *
 * Spawns the binary directly (instead of going through youtube-dl-exec's
 * promise wrapper) so we don't trip over the wrapper's stdout-buffering
 * behaviour on long videos — the metadata for a 3.5-hr course can be
 * 600+ KB of single-line JSON.
 *
 * Throws an Error with `.code` and `.message` on failure.
 */
export async function probeUrl(url: string): Promise<ProbeResult> {
  // -J (== --dump-single-json) emits one JSON object on stdout. We read
  // chunks manually because the default execFile buffer (200 KB) gets
  // blown by long-format videos.
  const args = [
    "-J",
    "--no-warnings",
    "--no-playlist",
    "--skip-download",
    url,
  ];

  let stdout = "";
  let stderr = "";
  let exitCode: number;
  try {
    const child = spawn(ytdlpBinaryPath(), args);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.error("[probeUrl] spawn failed:", text);
    const { code, message } = classifyYtdlpError(text);
    throw Object.assign(new Error(message), { code, stderr: text });
  }

  if (exitCode !== 0) {
    console.error(
      "[probeUrl] yt-dlp exited",
      exitCode,
      "stderr:",
      stderr.slice(0, 1000),
    );
    const { code, message } = classifyYtdlpError(stderr);
    throw Object.assign(new Error(message), {
      code,
      stderr: stderr.slice(0, 1000),
    });
  }

  let meta: YtdlpMeta;
  try {
    meta = JSON.parse(stdout) as YtdlpMeta;
  } catch (err) {
    console.error(
      "[probeUrl] JSON parse failed (",
      err instanceof Error ? err.message : String(err),
      ") stdout length:",
      stdout.length,
    );
    throw Object.assign(
      new Error("Couldn't parse video metadata. Try the URL again."),
      { code: "E_YTDLP" as YtdlpErrorCode, stderr: stdout.slice(0, 500) },
    );
  }

  if (meta.is_live) {
    throw Object.assign(new Error(FRIENDLY_MESSAGES.E_YTDLP_LIVE), {
      code: "E_YTDLP_LIVE",
    });
  }
  const title = (meta.title ?? meta.id ?? url).trim() || url;
  const durationSec = Number.isFinite(meta.duration)
    ? Math.max(0, Math.round(meta.duration!))
    : 0;
  return {
    title,
    durationSec,
    channel: meta.uploader ?? meta.channel ?? null,
    approxSizeBytes:
      typeof meta.filesize_approx === "number" ? meta.filesize_approx : null,
  };
}

// ---------------------------------------------------------------------------
// Playlist probe
// ---------------------------------------------------------------------------

export type PlaylistEntry = {
  id: string;
  title: string;
  durationSec: number;
  sourceUrl: string;
};

export type PlaylistProbeResult = {
  title: string;
  totalCount: number;
  entries: PlaylistEntry[];
};

type YtdlpPlaylistEntry = {
  id?: string;
  title?: string;
  duration?: number;
  url?: string;
  webpage_url?: string;
};

type YtdlpPlaylistMeta = {
  _type?: string;
  title?: string;
  playlist_count?: number;
  entries?: YtdlpPlaylistEntry[];
};

/**
 * Probe a URL and detect whether it points at a single video or a playlist.
 * Returns the playlist shape when `_type === "playlist"`.
 *
 * Uses `--flat-playlist` so yt-dlp doesn't fetch each video's full metadata
 * (which would balloon a 25-video probe from ~2 s to ~30+ s). Each entry
 * still gets id + title + duration + canonical URL.
 *
 * Returns `null` when the URL is a single video (caller should fall back
 * to `probeUrl`).
 */
export async function probePlaylist(
  url: string,
): Promise<PlaylistProbeResult | null> {
  const args = [
    "-J",
    "--flat-playlist",
    "--no-warnings",
    "--skip-download",
    url,
  ];

  let stdout = "";
  let stderr = "";
  let exitCode: number;
  try {
    const child = spawn(ytdlpBinaryPath(), args);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.error("[probePlaylist] spawn failed:", text);
    const { code, message } = classifyYtdlpError(text);
    throw Object.assign(new Error(message), { code, stderr: text });
  }

  if (exitCode !== 0) {
    console.error(
      "[probePlaylist] yt-dlp exited",
      exitCode,
      "stderr:",
      stderr.slice(0, 1000),
    );
    const { code, message } = classifyYtdlpError(stderr);
    throw Object.assign(new Error(message), {
      code,
      stderr: stderr.slice(0, 1000),
    });
  }

  let meta: YtdlpPlaylistMeta;
  try {
    meta = JSON.parse(stdout) as YtdlpPlaylistMeta;
  } catch (err) {
    console.error(
      "[probePlaylist] JSON parse failed:",
      err instanceof Error ? err.message : String(err),
      "stdout length:",
      stdout.length,
    );
    throw Object.assign(
      new Error("Couldn't parse playlist metadata. Try the URL again."),
      { code: "E_YTDLP" as YtdlpErrorCode },
    );
  }

  // Single video — caller should use probeUrl instead.
  if (meta._type !== "playlist") return null;

  const rawEntries = Array.isArray(meta.entries) ? meta.entries : [];
  // Filter out null/unavailable entries (yt-dlp emits null entries for
  // private/removed videos in flat-playlist mode).
  const entries: PlaylistEntry[] = rawEntries
    .filter((e): e is YtdlpPlaylistEntry => e != null && typeof e === "object")
    .map((e) => ({
      id: String(e.id ?? "").trim(),
      title: (e.title ?? e.id ?? "Untitled").trim(),
      durationSec: Number.isFinite(e.duration)
        ? Math.max(0, Math.round(e.duration!))
        : 0,
      sourceUrl: e.webpage_url ?? e.url ?? "",
    }))
    .filter((e) => e.id.length > 0 && e.sourceUrl.length > 0);

  return {
    title: (meta.title ?? "Untitled playlist").trim(),
    totalCount: meta.playlist_count ?? entries.length,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Concurrency control for parallel downloads (used by the playlist runner).
// Process-local semaphore — caps in-flight yt-dlp processes at
// MAX_DOWNLOAD_CONCURRENCY. Extra callers wait their turn.
//
// Set to 2 so a playlist's children download in pairs — total
// wall-clock for an N-video playlist is roughly N/2 × per-video time
// (plus tail). The UI still shows one "Currently downloading" + at
// most one peer; queued children sit at "Waiting". A higher value
// risks YouTube's per-IP rate limiter on quick-fire playlists; if
// you want maximum throughput on a stable network, bump to 3.
//
// When we move to the worker package this gets replaced by a real queue.
// ---------------------------------------------------------------------------

const MAX_DOWNLOAD_CONCURRENCY = 2;
let inFlight = 0;
const waiters: Array<() => void> = [];

/**
 * Block until a download slot is available. Always pair with
 * `releaseDownloadSlot()` in a finally — losing a release leaks the slot
 * for the rest of the process lifetime.
 */
export async function acquireDownloadSlot(): Promise<void> {
  // Wait until a slot is free. The while-loop guards against races: when
  // a release wakes a waiter, that waiter MIGHT find the slot already
  // taken by a fresher acquirer and need to sleep again.
  while (inFlight >= MAX_DOWNLOAD_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
  inFlight++;
}

export function releaseDownloadSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

/**
 * Spawn yt-dlp via the binary that `youtube-dl-exec` ships in `node_modules`.
 * We bypass the wrapper's promise API for the actual download so we can
 * read stdout line-by-line for progress updates.
 *
 * `youtube-dl-exec` exposes the binary path on its `.exec()` variant —
 * we grab it indirectly by inspecting the package's known location.
 */
function ytdlpBinaryPath(): string {
  // youtube-dl-exec ships the yt-dlp binary at this path on POSIX. The
  // wrapper exposes a `binaryPath` getter on its default export; fall back
  // to walking node_modules if that's not there in the installed version.
  const fromExport = (
    youtubeDl as unknown as { binaryPath?: string }
  ).binaryPath;
  if (fromExport && fromExport.length > 0) return fromExport;
  return path.resolve(
    process.cwd(),
    "node_modules/youtube-dl-exec/bin/yt-dlp",
  );
}

/**
 * Download just the audio track for a URL, post-process to 48 kHz mono mp3
 * (matching what ffmpeg.ts produces for file uploads), and probe the
 * result. Streams progress as percent values via `onProgress`.
 *
 * Output: `<outDirAbs>/audio.mp3`.
 */
export async function downloadAudio(params: {
  url: string;
  outDirAbs: string;
  onProgress?: (p: DownloadProgress) => Promise<void> | void;
}): Promise<AudioMeta> {
  const { url, outDirAbs, onProgress } = params;
  // Throttle parallel yt-dlp processes (e.g. when a 10-video playlist
  // fires 10 runDownload tasks at once). With concurrency=1, queued
  // callers wait here — they have NOT emitted any progress yet, so
  // their job_status row stays at progress=0 ("Waiting" in the UI).
  await acquireDownloadSlot();
  try {
    // Now we own a slot. Emit a 1% bump so the UI flips from "Waiting"
    // to "Downloading…" the moment we start. yt-dlp's first percent
    // line can take 5-8 seconds to arrive (handshake + manifest fetch),
    // and without this bump the row would sit at 0 visually identical
    // to a queued sibling.
    await onProgress?.({ percent: 1 });
    return await runDownloadAudio(params);
  } finally {
    releaseDownloadSlot();
  }
}

async function runDownloadAudio(params: {
  url: string;
  outDirAbs: string;
  onProgress?: (p: DownloadProgress) => Promise<void> | void;
}): Promise<AudioMeta> {
  const { url, outDirAbs, onProgress } = params;
  await fs.mkdir(outDirAbs, { recursive: true });

  // yt-dlp will emit a file named e.g. `audio.mp3` thanks to --audio-format.
  // The `%(ext)s` placeholder is replaced post-conversion.
  const outTemplate = path.join(outDirAbs, "audio.%(ext)s");
  const finalAbs = path.join(outDirAbs, "audio.mp3");

  // Args tuned for fast audio-only ingestion. The progress template is
  // custom so we can grep deterministically without dealing with
  // yt-dlp's default ANSI status line.
  const args = [
    "--no-warnings",
    "--no-playlist",
    "--no-progress",          // suppress default human-readable progress
    "--newline",              // one update per line (no carriage-return rewrites)
    "--progress",             // re-enable progress (machine-templated below)
    "--progress-template",
    "download:%(progress._percent_str)s",
    // BIGGEST DOWNLOAD-SPEED WIN: pull only the audio stream, never
    // the full video. YouTube's `bestaudio` is typically a 50–100 MB
    // m4a/webm vs 200–500 MB for the muxed mp4. Falls back to `best`
    // for hosts that don't expose an audio-only track. After the
    // post-processor below re-encodes to 16 kHz mono mp3 we end up
    // ~10–20 MB final.
    "--format",
    "bestaudio/best",
    // Fetch fragments in parallel. YouTube DASH streams are split
    // into 5–10s chunks; default is sequential. 4 in flight gives
    // a 2–4x speedup on the network side.
    "--concurrent-fragments",
    "4",
    // Retry transient network failures instead of giving up on
    // first 5xx / connection reset.
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "64K",
    "--postprocessor-args",
    // 16 kHz mono — Whisper's native input rate. Matches what
    // src/lib/ffmpeg.ts:extractAudio produces for file uploads, so URL
    // and file ingestion produce identical audio.
    "ffmpeg:-ac 1 -ar 16000",
    "--output",
    outTemplate,
    url,
  ];

  const child = spawn(ytdlpBinaryPath(), args);

  let stderr = "";
  let lastWriteAt = 0;
  let lastPercent = -1;

  child.stdout.on("data", (buf: Buffer) => {
    const text = buf.toString();
    for (const line of text.split("\n")) {
      const m = /download:\s*(\d+(?:\.\d+)?)%/.exec(line);
      if (!m) continue;
      const percent = Math.min(100, Math.max(0, Math.round(Number(m[1]))));
      const now = Date.now();
      // Tight throttle so the UI can render every yt-dlp emission. Most
      // YouTube DASH downloads only emit a percent line every 5–10 sec
      // (one per fragment), so we want to forward every one of them.
      // Skip only if a near-identical update (<2% delta within 200 ms).
      if (percent - lastPercent < 2 && now - lastWriteAt < 200) continue;
      lastPercent = percent;
      lastWriteAt = now;
      void onProgress?.({ percent });
    }
  });

  child.stderr.on("data", (b: Buffer) => {
    stderr += b.toString();
  });

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const { code, message } = classifyYtdlpError(stderr);
    throw Object.assign(
      new Error(`${message} (yt-dlp exit ${exitCode})`),
      { code, stderr: stderr.slice(0, 1000) },
    );
  }

  // Sanity-check the output file exists and has content.
  let stat;
  try {
    stat = await fs.stat(finalAbs);
  } catch {
    throw Object.assign(
      new Error("yt-dlp completed but audio.mp3 wasn't found on disk"),
      { code: "E_YTDLP" as YtdlpErrorCode },
    );
  }

  // Re-probe with ffprobe to populate audio metadata (matches what
  // extractAudio in ffmpeg.ts populates for file-uploaded jobs).
  const durationSec = (await probeDuration(finalAbs)) ?? 0;

  return {
    absPath: finalAbs,
    sizeBytes: stat.size,
    durationSec,
    sampleRateHz: 16000,
    channels: 1,
    codec: "mp3",
    bitrateKbps: 64,
  };
}
