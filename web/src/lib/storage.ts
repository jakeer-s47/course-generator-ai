import fs from "node:fs/promises";
import path from "node:path";

const STORAGE_DIR = process.env.STORAGE_DIR ?? "./uploads";

/** Absolute path to the storage root (resolved from CWD, which is web/ during dev). */
function root(): string {
  return path.resolve(process.cwd(), STORAGE_DIR);
}

/** Build the key (relative path) for a job's original source file. */
export function originalKey(jobId: string, extension: string): string {
  const ext = extension.replace(/^\./, "").toLowerCase() || "bin";
  return path.join(jobId, `original.${ext}`);
}

/** Build the key (relative path) for a job's extracted audio file. */
export function audioKey(jobId: string): string {
  return path.join(jobId, "audio.mp3");
}

/** Build the key (relative path) for a job's word-level Whisper output. */
export function wordsJsonKey(jobId: string): string {
  return path.join(jobId, "words.json");
}

// Cleaned outputs are namespaced by level so light / standard / aggressive
// runs can coexist on disk without overwriting each other.

/** Build the key (relative path) for the cleaned plain-text output. */
export function cleanedTextKey(jobId: string, level: string): string {
  return path.join(jobId, "cleaned", level, "cleaned.txt");
}

/** Build the key (relative path) for the cleaned word-level array. */
export function cleanedWordsKey(jobId: string, level: string): string {
  return path.join(jobId, "cleaned", level, "cleaned_words.json");
}

/** Build the key (relative path) for the removed-segments record. */
export function removedSegmentsKey(jobId: string, level: string): string {
  return path.join(jobId, "cleaned", level, "removed_segments.json");
}

// Step 5 (Split) outputs are namespaced by (cleanLevel, targetMin) so
// every combination can coexist on disk without collision.

/** Build the key (relative path) for the chunks.json output. */
export function chunksJsonKey(
  jobId: string,
  level: string,
  targetMin: number,
): string {
  return path.join(jobId, "chunks", level, `${targetMin}min`, "chunks.json");
}

/** Absolute path for a given storage key. */
export function absPathFor(key: string): string {
  return path.resolve(root(), key);
}

/**
 * Persist a browser-uploaded File (via request.formData()) to disk.
 * Returns info about where it landed.
 */
export async function saveFileToDisk(
  jobId: string,
  file: File,
): Promise<{ key: string; absPath: string; size: number }> {
  const extFromName = path.extname(file.name);
  const extFromType = file.type.split("/")[1] ?? "";
  const extension = extFromName || (extFromType ? `.${extFromType}` : ".bin");
  const key = originalKey(jobId, extension);
  const absPath = absPathFor(key);

  await fs.mkdir(path.dirname(absPath), { recursive: true });

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.writeFile(absPath, buffer);

  return { key, absPath, size: buffer.byteLength };
}

/** Delete all files for a job (used on retry/rollback). */
export async function deleteJobFiles(jobId: string): Promise<void> {
  const jobDir = path.resolve(root(), jobId);
  await fs.rm(jobDir, { recursive: true, force: true });
}

/** Exposed for debugging / future scripts. */
export function storageRoot(): string {
  return root();
}
