import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nodewhisper } from "nodejs-whisper";

/**
 * Local-Whisper transcription provider — same shape as `./whisper.ts` but
 * runs whisper.cpp on this machine via the `nodejs-whisper` npm package.
 * No OpenAI API key required.
 *
 * Trade-offs vs the OpenAI variant:
 *   - First run downloads the model file (~150 MB for base.en, ~3 GB for
 *     large-v3). Cached at WHISPER_LOCAL_MODEL_ROOT (default `web/.whisper-models`).
 *   - CPU transcription is 3–5× slower than OpenAI's API for `base.en`,
 *     comparable with a CUDA GPU + `large-v3-turbo`.
 *
 * Env vars (all optional):
 *   WHISPER_LOCAL_MODEL        whisper.cpp model name (default "base.en")
 *   WHISPER_LOCAL_MODEL_ROOT   absolute path to model dir (default
 *                              `<cwd>/.whisper-models`)
 *   WHISPER_LOCAL_CUDA         "1" to enable CUDA inference if available
 *
 * Progress reporting reuses the OpenAI flow's chunking strategy: split the
 * full audio into ≤ 10-min slices via ffmpeg, transcribe each with
 * whisper.cpp, fire `onChunkDone` between chunks. whisper.cpp can handle
 * long audio in one go, but we'd lose incremental progress in the UI.
 */

const CHUNK_SECONDS = 600;

const MODEL_NAME = process.env.WHISPER_LOCAL_MODEL ?? "base.en";
const MODEL_ROOT =
  process.env.WHISPER_LOCAL_MODEL_ROOT ??
  path.join(process.cwd(), ".whisper-models");
const USE_CUDA = process.env.WHISPER_LOCAL_CUDA === "1";

export type WhisperWord = {
  word: string;
  start: number; // seconds, in the FULL audio timeline
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

/** Split a long mp3 into ≤ CHUNK_SECONDS slices using ffmpeg's stream copy. */
async function splitAudio(
  srcAbsPath: string,
  totalDurationSec: number,
  outDir: string,
): Promise<{ absPath: string; startSec: number }[]> {
  await fs.mkdir(outDir, { recursive: true });
  const chunks: { absPath: string; startSec: number }[] = [];
  const count = Math.max(1, Math.ceil(totalDurationSec / CHUNK_SECONDS));

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

// Shape of the whisper.cpp `--output-json` (`-oj`) file. With `-ml 1`
// (wordTimestamps), each transcription entry is approximately one word.
type WhisperJsonSegment = {
  offsets?: { from: number; to: number }; // milliseconds
  text?: string;
};
type WhisperJsonFile = {
  result?: { language?: string };
  transcription?: WhisperJsonSegment[];
};

/** Transcribe a single chunk and return word-aligned results. */
async function transcribeChunkLocal(
  chunkAbsPath: string,
  startSec: number,
): Promise<{ text: string; language: string | null; words: WhisperWord[] }> {
  await fs.mkdir(MODEL_ROOT, { recursive: true });

  // nodejs-whisper writes output files NEXT TO the input audio
  // (`<input>.json`, converted `<input>.wav`). Our chunks already live in
  // a temp dir, so the side-files don't pollute uploads/.
  await nodewhisper(chunkAbsPath, {
    modelName: MODEL_NAME,
    autoDownloadModelName: MODEL_NAME,
    modelRootPath: MODEL_ROOT,
    withCuda: USE_CUDA,
    removeWavFileAfterTranscription: true,
    whisperOptions: {
      outputInJson: true,
      wordTimestamps: true,
      splitOnWord: true,
    },
  });

  // whisper.cpp writes alongside the (possibly-converted) input. nodejs-whisper
  // converts mp3 → wav and points whisper at the wav, so the JSON is named
  // after the wav. Look in both locations.
  const wavJsonPath = chunkAbsPath.replace(/\.[^.]+$/, ".wav.json");
  const mp3JsonPath = chunkAbsPath + ".json";
  const jsonPath = (await fileExists(wavJsonPath))
    ? wavJsonPath
    : mp3JsonPath;

  const raw = await fs.readFile(jsonPath, "utf8");
  const data = JSON.parse(raw) as WhisperJsonFile;

  const words: WhisperWord[] = (data.transcription ?? [])
    .map((seg): WhisperWord | null => {
      const text = (seg.text ?? "").trim();
      if (!text) return null;
      const fromMs = seg.offsets?.from ?? 0;
      const toMs = seg.offsets?.to ?? fromMs;
      return {
        word: text,
        start: fromMs / 1000 + startSec,
        end: toMs / 1000 + startSec,
      };
    })
    .filter((w): w is WhisperWord => w !== null);

  const text = words.map((w) => w.word).join(" ");

  return {
    text,
    language: data.result?.language ?? null,
    words,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Transcribe the full audio at `absPath` using local whisper.cpp.
 *
 * Same contract as `./whisper.ts`'s `transcribeAudio` so the route can
 * call either one based on env config.
 */
export async function transcribeAudio(params: {
  absPath: string;
  totalDurationSec: number;
  onChunkDone?: (
    p: ChunkProgress & { partialText: string },
  ) => Promise<void> | void;
}): Promise<WhisperResult> {
  const { absPath, totalDurationSec, onChunkDone } = params;

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chapter-ai-whisper-local-"),
  );

  try {
    const chunks = await splitAudio(absPath, totalDurationSec, tempDir);
    const totalChunks = chunks.length;

    let partialText = "";
    const allWords: WhisperWord[] = [];
    let language: string | null = null;

    for (let i = 0; i < totalChunks; i++) {
      const { absPath: chunkPath, startSec } = chunks[i];
      const res = await transcribeChunkLocal(chunkPath, startSec);

      if (!language && res.language) language = res.language;
      partialText = (partialText + " " + res.text).trim();
      allWords.push(...res.words);

      const percent = Math.round(((i + 1) / totalChunks) * 100);
      await onChunkDone?.({
        chunkIndex: i,
        totalChunks,
        percent,
        partialText,
      });
    }

    return {
      text: partialText,
      words: allWords,
      language,
      durationSec: totalDurationSec,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
