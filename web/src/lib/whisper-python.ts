import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Python-backed transcription provider — same shape as `./whisper.ts` and
 * `./whisper-local.ts`. Forwards each audio chunk to a long-running
 * FastAPI service that wraps faster-whisper (see `python/server.py`).
 *
 * Why a service instead of `spawn(python3 transcribe.py …)`:
 *
 *   - The faster-whisper model takes ~1-2 s to load. With per-chunk
 *     spawning we paid that load cost N times per video. With the
 *     service, the model is loaded ONCE on container startup and reused
 *     for every /transcribe call — saves ~10 s on a 6-chunk video, more
 *     on longer ones.
 *   - Cleaner separation of concerns: the web image no longer needs
 *     Python or faster-whisper installed. Whisper is a separate compose
 *     service with its own Dockerfile.
 *
 * Setup:
 *   - Docker:  `docker compose up` brings up the `whisper` service at
 *              http://whisper:8000 automatically.
 *   - Local:   start it manually:
 *                cd python
 *                pip install -r requirements.txt
 *                uvicorn server:app --host 0.0.0.0 --port 8000
 *              and set `WHISPER_API_URL=http://localhost:8000` in
 *              `web/.env.local`.
 *
 * Environment:
 *   TRANSCRIBE_PROVIDER=python
 *   WHISPER_API_URL=http://whisper:8000     // service base URL
 *   WHISPER_PYTHON_MODEL=base.en            // forwarded as a hint, but
 *                                              the service was launched
 *                                              with its own WHISPER_MODEL
 *                                              env var, which wins.
 *   WHISPER_PYTHON_PARALLEL=auto            // K parallel HTTP calls
 *   WHISPER_PYTHON_CHUNK_SECONDS=600        // chunk length (default 10 min)
 *   WHISPER_PYTHON_VAD=1                    // forward to service
 */

// Default uses 127.0.0.1 (not localhost) so Node's fetch hits IPv4
// directly. uvicorn binds 0.0.0.0:8000 (IPv4 only); on dual-stack Linux
// "localhost" can resolve to ::1 first, and Node's undici doesn't always
// fall back to IPv4 fast enough — surfaces as "fetch failed". Docker
// compose overrides this with WHISPER_API_URL=http://whisper:8000.
const API_URL = (
  process.env.WHISPER_API_URL ?? "http://127.0.0.1:8000"
).replace(/\/+$/, "");

const CHUNK_SECONDS = (() => {
  const raw = process.env.WHISPER_PYTHON_CHUNK_SECONDS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 60 ? Math.floor(n) : 600;
})();

/** Resolve K — number of parallel chunk-transcription HTTP calls. */
function resolveParallelism(): number {
  const raw = (process.env.WHISPER_PYTHON_PARALLEL ?? "auto").trim();
  if (raw === "auto") {
    return Math.max(1, Math.min(4, os.cpus().length - 1));
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

const VAD_FILTER = (process.env.WHISPER_PYTHON_VAD ?? "1") !== "0";

export type WhisperWord = {
  word: string;
  start: number;
  end: number;
};

export type WhisperResult = {
  text: string;
  words: WhisperWord[];
  language: string | null;
  durationSec: number;
};

export type ChunkProgress = {
  chunkIndex: number;
  totalChunks: number;
  percent: number;
};

type ChunkSlice = {
  /** absolute path of the chunk mp3 */
  absPath: string;
  /** offset in seconds, relative to the FULL audio timeline */
  startSec: number;
};

/** Split a long mp3 into ≤ CHUNK_SECONDS slices using ffmpeg's stream copy. */
async function splitAudio(
  srcAbsPath: string,
  totalDurationSec: number,
  outDir: string,
): Promise<ChunkSlice[]> {
  await fs.mkdir(outDir, { recursive: true });
  const chunks: ChunkSlice[] = [];
  // Always at least 1 chunk even when totalDurationSec is 0/unknown — we
  // hand the whole file to one worker in that case.
  const count =
    totalDurationSec > 0
      ? Math.max(1, Math.ceil(totalDurationSec / CHUNK_SECONDS))
      : 1;

  for (let i = 0; i < count; i++) {
    const startSec = i * CHUNK_SECONDS;
    const outPath = path.join(outDir, `chunk_${String(i).padStart(3, "0")}.mp3`);
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostats",
      "-y",
      "-ss",
      String(startSec),
      "-t",
      String(CHUNK_SECONDS),
      "-i",
      srcAbsPath,
      "-c",
      "copy",
      outPath,
    ]);
    chunks.push({ absPath: outPath, startSec });
  }
  return chunks;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
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
              `ffmpeg split exited ${code}: ${stderr.slice(0, 300)}`,
            ),
            { code: "E_FFMPEG_SPLIT" },
          ),
        );
    });
  });
}

/** Result of transcribing a single chunk. */
type ChunkResult = {
  language: string | null;
  /** Words with start/end already shifted to the FULL audio timeline. */
  words: WhisperWord[];
};

type ServiceResponse = {
  text: string;
  language: string | null;
  duration: number;
  words: WhisperWord[];
};

/**
 * POST one chunk file to the FastAPI /transcribe endpoint and shift its
 * word timestamps onto the full-audio timeline before returning.
 */
async function transcribeChunk(chunk: ChunkSlice): Promise<ChunkResult> {
  const stat = await fs.stat(chunk.absPath);
  // Use a Blob built from a Node Readable so we don't load the whole
  // chunk into memory (~10 MB) before sending. Web fetch's Blob accepts
  // Node streams in modern undici.
  const stream = createReadStream(chunk.absPath);
  const blob = await new Response(stream as unknown as ReadableStream).blob();
  const file = new File([blob], path.basename(chunk.absPath), {
    type: "audio/mpeg",
  });
  if (file.size !== stat.size) {
    // Defensive — we expect them to match.
    console.warn(
      `[whisper-python] file size mismatch (${file.size} vs ${stat.size}) for ${chunk.absPath}`,
    );
  }

  const form = new FormData();
  form.append("file", file);
  form.append("vad_filter", String(VAD_FILTER));

  let res: Response;
  try {
    res = await fetch(`${API_URL}/transcribe`, {
      method: "POST",
      body: form,
    });
  } catch (err) {
    throw Object.assign(
      new Error(
        `Whisper service at ${API_URL} unreachable. Is the container up? ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_WHISPER_SERVICE_UNREACHABLE" },
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(
        `Whisper service returned ${res.status}: ${body.slice(0, 500)}`,
      ),
      { code: "E_WHISPER_SERVICE", status: res.status },
    );
  }

  const data = (await res.json()) as ServiceResponse;
  // Shift word offsets to the full-audio timeline NOW so the caller
  // doesn't have to think about chunk geometry.
  const shifted: WhisperWord[] = (data.words ?? []).map((w) => ({
    word: w.word,
    start: w.start + chunk.startSec,
    end: w.end + chunk.startSec,
  }));
  return { language: data.language ?? null, words: shifted };
}

/**
 * Run `worker(chunk, index)` for every input, with at most `limit` workers
 * in flight at any moment. Resolves once every chunk has completed; rejects
 * on the first chunk failure.
 */
async function runWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let aborted = false;
  let firstReject: unknown = null;

  async function loop() {
    while (true) {
      if (aborted) return;
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        aborted = true;
        firstReject = firstReject ?? err;
        return;
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => loop(),
  );
  await Promise.all(workers);
  if (firstReject) throw firstReject;
  return results;
}

/**
 * Transcribe the full audio at `absPath` by splitting + parallel chunk
 * transcription via the FastAPI service.
 *
 * Same contract as `./whisper.ts`'s `transcribeAudio` — the route is
 * provider-agnostic.
 */
export async function transcribeAudio(params: {
  absPath: string;
  totalDurationSec: number;
  onChunkDone?: (
    p: ChunkProgress & { partialText: string },
  ) => Promise<void> | void;
}): Promise<WhisperResult> {
  const { absPath, totalDurationSec, onChunkDone } = params;

  // Cross-video cap. Process-All on a 12-video playlist used to fire
  // 12 concurrent transcribeAudio() calls — each then ran up to 4
  // parallel HTTP chunks against the same Python service. The service
  // holds the GIL per inference, so those 48 calls serialised on the
  // model anyway, with all the wasted async overhead, memory churn,
  // and dropped progress reporting that implies. This semaphore caps
  // simultaneous transcribeAudio invocations at 2 so playlists still
  // see overlap between consecutive videos (one transcribing while
  // the next preloads + chunks audio) without thrashing the model.
  await acquireTranscribeSlot();

  // tempDir is created INSIDE the try so that any failure (incl. the
  // mkdtemp itself) still runs the finally → releaseTranscribeSlot().
  // Acquiring the slot then throwing before the try would leak the
  // slot forever and eventually wedge transcription process-wide.
  let tempDir: string | null = null;
  try {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "chapter-ai-whisper-py-"),
    );
    const chunks = await splitAudio(absPath, totalDurationSec, tempDir);
    const totalChunks = chunks.length;
    const parallel = Math.max(1, Math.min(resolveParallelism(), totalChunks));

    // Words accumulated as chunks complete. Indexed by chunk position so
    // we can stitch in order even when chunks finish out-of-order.
    const perChunkWords: (WhisperWord[] | undefined)[] = new Array(totalChunks);
    let language: string | null = null;
    let completed = 0;

    const buildPartialText = () => {
      const parts: string[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const ws = perChunkWords[i];
        if (!ws) continue;
        for (const w of ws) parts.push(w.word.trim());
      }
      return parts.join(" ").trim();
    };

    await runWithLimit(chunks, parallel, async (chunk, i) => {
      const res = await transcribeChunk(chunk);
      perChunkWords[i] = res.words;
      if (!language && res.language) language = res.language;
      completed += 1;
      const percent = Math.round((completed / totalChunks) * 100);
      await onChunkDone?.({
        chunkIndex: i,
        totalChunks,
        percent,
        partialText: buildPartialText(),
      });
    });

    // Stitch final word array in chunk-index order.
    const allWords: WhisperWord[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const ws = perChunkWords[i];
      if (!ws) continue;
      for (const w of ws) allWords.push(w);
    }
    const finalText = allWords.map((w) => w.word.trim()).join(" ").trim();

    return {
      text: finalText,
      words: allWords,
      language,
      durationSec: totalDurationSec,
    };
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    releaseTranscribeSlot();
  }
}

// ─── Cross-video transcription semaphore ───────────────────────────────────
// Process-local. Caps concurrent transcribeAudio() invocations so a
// playlist's children don't all hammer the GIL-bound Python service at
// once. Same pattern as ffmpeg.ts / ytdlp.ts. Bump WHISPER_CROSS_CONCURRENCY
// in .env.local if you run a dedicated GPU box and want more parallelism.

const MAX_TRANSCRIBE_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.WHISPER_CROSS_CONCURRENCY) || 2),
);
let _txInFlight = 0;
const _txWaiters: Array<() => void> = [];

async function acquireTranscribeSlot(): Promise<void> {
  while (_txInFlight >= MAX_TRANSCRIBE_CONCURRENCY) {
    await new Promise<void>((resolve) => _txWaiters.push(resolve));
  }
  _txInFlight++;
}

function releaseTranscribeSlot(): void {
  _txInFlight = Math.max(0, _txInFlight - 1);
  const next = _txWaiters.shift();
  if (next) next();
}
