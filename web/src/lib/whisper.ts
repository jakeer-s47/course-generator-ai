import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";

// Whisper has a 25 MB upload limit per request. Our extracted audio is
// 48 kHz mono mp3 at 128 kbps ≈ 16 KB/sec, so a 10-minute slice (~9.6 MB)
// stays comfortably under the cap with headroom for VBR jitter.
const CHUNK_SECONDS = 600;

// We pad each chunk with this many extra seconds on each side so a word
// straddling the boundary lands inside both chunks (rather than getting
// cut mid-syllable by ffmpeg's frame-aligned `-c copy`). After Whisper
// returns, we de-dup by "owned region": each word is kept by exactly one
// chunk — the one whose nominal [i*CHUNK, (i+1)*CHUNK) range contains
// the word's global start.
const OVERLAP_SEC = 2;

export type WhisperWord = {
  word: string;
  start: number; // seconds, in the FULL audio timeline (after stitching)
  end: number;
};

export type WhisperResult = {
  text: string;
  words: WhisperWord[];
  language: string | null;
  durationSec: number;
};

export type ChunkProgress = {
  /** 0-based chunk index just completed */
  chunkIndex: number;
  /** Total number of chunks for this audio */
  totalChunks: number;
  /** 0..100 — fraction of chunks completed */
  percent: number;
};

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("OPENAI_API_KEY is not set"), {
      code: "E_OPENAI_AUTH",
    });
  }
  _client = new OpenAI({ apiKey });
  return _client;
}

type AudioChunk = {
  absPath: string;
  /** Global timeline offset for chunk-local timestamps. Equals the -ss arg. */
  ssSec: number;
  /** Lower bound of this chunk's owned region (global, inclusive). */
  ownedStart: number;
  /** Upper bound of this chunk's owned region (global, exclusive). Infinity for the last chunk. */
  ownedEnd: number;
};

/**
 * Split a long mp3 into overlapping ≤ CHUNK_SECONDS slices using ffmpeg's
 * stream copy. Each chunk extends OVERLAP_SEC into its neighbours so that
 * boundary-straddling words appear in both — the de-dup step in the
 * caller picks which chunk owns each word.
 */
async function splitAudio(
  srcAbsPath: string,
  totalDurationSec: number,
  outDir: string,
): Promise<AudioChunk[]> {
  await fs.mkdir(outDir, { recursive: true });
  const chunks: AudioChunk[] = [];
  const count = Math.max(1, Math.ceil(totalDurationSec / CHUNK_SECONDS));

  for (let i = 0; i < count; i++) {
    const ownedStart = i * CHUNK_SECONDS;
    const ownedEnd =
      i === count - 1
        ? Number.POSITIVE_INFINITY
        : Math.min((i + 1) * CHUNK_SECONDS, totalDurationSec);
    // Pad each side with OVERLAP_SEC. First/last chunk clamp at audio bounds.
    const ssSec = Math.max(0, ownedStart - OVERLAP_SEC);
    const targetEndSec = Math.min(
      totalDurationSec || (ownedStart + CHUNK_SECONDS + OVERLAP_SEC),
      i * CHUNK_SECONDS + CHUNK_SECONDS + OVERLAP_SEC,
    );
    const tSec = Math.max(0.001, targetEndSec - ssSec);

    const outPath = path.join(outDir, `chunk_${String(i).padStart(3, "0")}.mp3`);
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostats",
      "-y",
      "-ss",
      String(ssSec),
      "-t",
      String(tSec),
      "-i",
      srcAbsPath,
      "-c",
      "copy",
      outPath,
    ]);
    chunks.push({ absPath: outPath, ssSec, ownedStart, ownedEnd });
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

type WhisperVerboseJson = {
  text: string;
  language?: string;
  duration?: number;
  words?: { word: string; start: number; end: number }[];
};

/** Transcribe a single chunk file with two retries on transient failure. */
async function transcribeChunk(
  absPath: string,
  startSec: number,
): Promise<WhisperVerboseJson & { offsetSec: number }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const file = createReadStream(absPath);
      const res = (await client().audio.transcriptions.create({
        file,
        model: "whisper-1",
        response_format: "verbose_json",
        timestamp_granularities: ["word"],
      })) as unknown as WhisperVerboseJson;
      return { ...res, offsetSec: startSec };
    } catch (err) {
      lastErr = err;
      const status =
        err && typeof err === "object" && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      // 401/403 — auth issue; don't retry
      if (status === 401 || status === 403) {
        throw Object.assign(
          new Error("OpenAI auth failed (check OPENAI_API_KEY)"),
          { code: "E_OPENAI_AUTH" },
        );
      }
      // Backoff 500 ms, then 1500 ms
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1) ** 2));
    }
  }
  throw Object.assign(
    new Error(
      `Whisper failed after retries: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    ),
    { code: "E_WHISPER" },
  );
}

/**
 * Transcribe the full audio at `absPath`.
 *
 * Splits into ≤ 10-minute chunks, calls Whisper per chunk, fires
 * `onChunkDone` after each chunk so the API route can update DB progress,
 * and returns a stitched transcript with full-timeline word offsets.
 */
export async function transcribeAudio(params: {
  absPath: string;
  totalDurationSec: number;
  onChunkDone?: (p: ChunkProgress & { partialText: string }) => Promise<void> | void;
}): Promise<WhisperResult> {
  const { absPath, totalDurationSec, onChunkDone } = params;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chapter-ai-whisper-"));
  try {
    const chunks = await splitAudio(absPath, totalDurationSec, tempDir);
    const totalChunks = chunks.length;

    // Run up to WHISPER_CONCURRENCY chunks in parallel. Whisper's API
    // is independent per chunk so this is safe; OpenAI's per-key rate
    // limits are well above 3 concurrent transcribe calls. A 1-hr
    // lecture (6 chunks × ~45s each) goes from ~4.5 min sequential to
    // ~1.5 min at concurrency 3.
    const WHISPER_CONCURRENCY = Math.min(
      Number(process.env.WHISPER_CONCURRENCY) || 3,
      Math.max(1, totalChunks),
    );

    // Per-chunk results. We index by `i` so we can stitch in original
    // order regardless of which chunk finishes first.
    type PerChunkResult = {
      words: WhisperWord[];
      language: string | null;
      durationSec: number;
    };
    const perChunk: (PerChunkResult | null)[] = new Array(totalChunks).fill(
      null,
    );
    let completed = 0;
    let nextIdx = 0;

    const dedupeWords = (
      chunk: AudioChunk,
      raw: WhisperVerboseJson["words"],
    ): WhisperWord[] => {
      const out: WhisperWord[] = [];
      if (!Array.isArray(raw)) return out;
      for (const w of raw) {
        const globalStart = w.start + chunk.ssSec;
        if (globalStart < chunk.ownedStart) continue;
        if (globalStart >= chunk.ownedEnd) continue;
        out.push({
          word: w.word,
          start: globalStart,
          end: w.end + chunk.ssSec,
        });
      }
      return out;
    };

    const stitchAll = (): {
      partialText: string;
      allWords: WhisperWord[];
    } => {
      const allWords: WhisperWord[] = [];
      for (let j = 0; j < totalChunks; j++) {
        const r = perChunk[j];
        if (r) allWords.push(...r.words);
      }
      const partialText = allWords
        .map((w) => w.word.trim())
        .filter((w) => w.length > 0)
        .join(" ")
        .replace(/\s+([.,!?;:])/g, "$1")
        .trim();
      return { partialText, allWords };
    };

    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIdx++;
        if (i >= totalChunks) return;
        const chunk = chunks[i];
        const res = await transcribeChunk(chunk.absPath, chunk.ssSec);
        perChunk[i] = {
          words: dedupeWords(chunk, res.words),
          language: res.language ?? null,
          durationSec: typeof res.duration === "number" ? res.duration : 0,
        };
        completed += 1;

        // Re-stitch from completed chunks. partialText only includes
        // contiguous-from-start chunks (gaps stay invisible until the
        // chunk lands) — keeps the displayed text monotonically growing.
        const { partialText } = stitchAll();
        const percent = Math.round((completed / totalChunks) * 100);
        await onChunkDone?.({
          chunkIndex: i,
          totalChunks,
          percent,
          partialText,
        });
      }
    };

    const workers = Array.from({ length: WHISPER_CONCURRENCY }, () =>
      worker(),
    );
    await Promise.all(workers);

    const { partialText, allWords } = stitchAll();
    let language: string | null = null;
    let durationSec = 0;
    for (const r of perChunk) {
      if (!r) continue;
      if (!language && r.language) language = r.language;
      durationSec += r.durationSec;
    }

    return {
      text: partialText,
      words: allWords,
      language,
      durationSec: Math.round(durationSec) || totalDurationSec,
    };
  } finally {
    // Best-effort cleanup of split chunks
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
