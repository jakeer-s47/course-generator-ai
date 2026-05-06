import { PrismaClient } from "@prisma/client";

// Next.js hot-reloads in dev can leak Prisma connections. Stash on globalThis
// so a single client persists across module re-evaluation.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") global.__prisma = prisma;

// Helper: serialize BigInt fields (source_size) for JSON responses.
// Works on a Job row whether or not `.status` is included.
export function serializeJob<T extends { sourceSize: bigint }>(
  job: T,
): Omit<T, "sourceSize"> & { sourceSize: number } {
  return { ...job, sourceSize: Number(job.sourceSize) };
}

// Helper: serialize BigInt fields on the Audio row for JSON responses
export function serializeAudio<T extends { sizeBytes: bigint | null }>(
  audio: T,
): Omit<T, "sizeBytes"> & { sizeBytes: number | null } {
  return { ...audio, sizeBytes: audio.sizeBytes == null ? null : Number(audio.sizeBytes) };
}

// Transcript rows have no BigInt fields, but giving them a serializer keeps
// the API surface consistent and makes future schema additions painless.
export function serializeTranscript<T extends object>(transcript: T): T {
  return transcript;
}
