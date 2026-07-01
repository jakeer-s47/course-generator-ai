import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma, serializeJob } from "@/lib/db";
import { audioKey, deleteJobFiles, saveFileToDisk } from "@/lib/storage";
import { getOrCreateSessionId } from "@/lib/session";
import { probeUrl } from "@/lib/ytdlp";
import { runDownload } from "./[id]/download/runner";
import { runExtraction } from "./[id]/extract/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB — Phase 1 dev cap
const MAX_URL_LENGTH = 2000;
const MAX_BATCH_FILES = 25;
const ACCEPTED_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
]);
// Fallback when the browser reports application/octet-stream (common for
// .mkv on Safari, .m4a on some Firefox builds, etc.). We accept any of
// these extensions even when the MIME is missing or generic.
const ACCEPTED_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".flac",
  ".aac",
]);

function isAcceptedFile(f: File): boolean {
  if (f.type && ACCEPTED_TYPES.has(f.type.toLowerCase())) return true;
  // Extract extension by hand — the File object doesn't expose one.
  const dot = f.name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = f.name.slice(dot).toLowerCase();
  return ACCEPTED_EXTENSIONS.has(ext);
}

/**
 * POST /api/jobs
 *
 * Two flavours:
 *   - JSON body { sourceUrl: string }       → URL flow (yt-dlp pulls audio)
 *   - multipart/form-data with `file` field → existing file-upload flow
 *
 * Content-Type is the discriminator. JSON returns 201 + the job row with
 * `job_status.status = "downloading"` and a background runner already
 * spawned. multipart matches the previous behaviour exactly.
 */
export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return handleUrlPost(request);
  }
  return handleFilePost(request);
}

async function handleFilePost(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data body" },
      { status: 400 },
    );
  }

  // Accept N files under the same `file` field. Single-file uploads still
  // send exactly one File; multi-file uploads append the same key per file.
  const files = formData.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json(
      { error: "`file` field is required" },
      { status: 400 },
    );
  }
  if (files.length > MAX_BATCH_FILES) {
    return NextResponse.json(
      {
        error: `Too many files — max ${MAX_BATCH_FILES} per upload.`,
        code: "E_TOO_MANY_FILES",
        totalCount: files.length,
        maxAllowed: MAX_BATCH_FILES,
      },
      { status: 400 },
    );
  }

  for (const f of files) {
    if (f.size === 0) {
      return NextResponse.json(
        { error: `File "${f.name}" is empty` },
        { status: 400 },
      );
    }
    if (f.size > MAX_SIZE_BYTES) {
      return NextResponse.json(
        {
          error: `File "${f.name}" is too large (${f.size} > ${MAX_SIZE_BYTES})`,
        },
        { status: 413 },
      );
    }
    // Reject anything that's clearly not an audio / video file. Saves
    // disk space + Step 2 ffmpeg cycles on a random binary the user
    // dropped by mistake.
    if (!isAcceptedFile(f)) {
      return NextResponse.json(
        {
          error: `File "${f.name}" isn't a supported audio or video format. Use mp4, mov, mkv, webm, mp3, wav, m4a, ogg, flac, or aac.`,
          code: "E_UNSUPPORTED_FORMAT",
          filename: f.name,
          contentType: f.type || "(none)",
        },
        { status: 415 },
      );
    }
  }

  // Per-file duration hints (optional). Client appends `durationSec` once
  // per file in the same order — empty string means "unknown, ffprobe will
  // figure it out later".
  const durationRaws = formData.getAll("durationSec");
  const durations: (number | null)[] = files.map((_, i) => {
    const raw = durationRaws[i];
    if (typeof raw !== "string" || raw.trim() === "") return null;
    const parsed = Math.round(Number(raw));
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 60 * 60 * 24
      ? parsed
      : null;
  });

  if (files.length === 1) {
    return handleSingleFilePost(files[0], durations[0]);
  }
  return handleMultiFilePost(files, durations);
}

/**
 * Single-file upload — unchanged from the original behaviour. One Job
 * (`kind="file"`), one `original.{ext}` on disk, status=`audio/0`. The
 * user clicks "Extract audio" on Step 2 to actually trigger ffmpeg.
 */
async function handleSingleFilePost(
  file: File,
  sourceDurationSec: number | null,
) {
  const type = file.type || "application/octet-stream";
  const acceptedGuess =
    ACCEPTED_TYPES.has(type) ||
    type.startsWith("video/") ||
    type.startsWith("audio/");

  const sessionId = await getOrCreateSessionId();
  const jobId = randomUUID();

  let savedKey: string;
  let savedSize: number;
  try {
    const result = await saveFileToDisk(jobId, file);
    savedKey = result.key;
    savedSize = result.size;
  } catch (err) {
    console.error("[POST /api/jobs] save to disk failed:", err);
    return NextResponse.json(
      { error: "Failed to persist upload" },
      { status: 500 },
    );
  }

  try {
    const job = await prisma.job.create({
      data: {
        id: jobId,
        sessionCookie: sessionId,
        sourceName: file.name,
        sourceKey: savedKey,
        sourceSize: BigInt(savedSize),
        sourceType: type,
        sourceDurationSec,
        status: {
          create: { status: "audio", progress: 0 },
        },
      },
      include: { status: true },
    });

    return NextResponse.json(
      { ...serializeJob(job), acceptedMime: acceptedGuess },
      { status: 201 },
    );
  } catch (err) {
    console.error("[POST /api/jobs] DB insert failed:", err);
    // Roll back the on-disk write so we don't leak a file with no row.
    await deleteJobFiles(jobId).catch(() => {});
    return NextResponse.json(
      { error: "Failed to record job" },
      { status: 500 },
    );
  }
}

/**
 * Multi-file upload (2..MAX_BATCH_FILES) — mirror the playlist pattern.
 * Creates ONE parent Job (kind="batch", no job_status row) plus N child
 * Jobs (kind="batch_file", parent_job_id=parent.id, status=audio/0). Each
 * child also gets an Audio row pre-seeded as `extracting/0` so the runner
 * can update it directly.
 *
 * After the transaction commits, fires `runExtraction` per child. The
 * ffmpeg semaphore in `lib/ffmpeg.ts` (concurrency=1) serializes them so
 * the user sees one row "Extracting…" + N-1 rows "Waiting".
 */
async function handleMultiFilePost(
  files: File[],
  durations: (number | null)[],
) {
  const sessionId = await getOrCreateSessionId();

  // Pre-allocate child IDs so the on-disk paths line up with DB rows.
  const childIds = files.map(() => randomUUID());
  const parentId = randomUUID();

  // Save every file to disk BEFORE the DB transaction. If any write fails,
  // bail out and clean up partial state — easier to reason about than
  // inside-transaction filesystem work.
  //
  // Files are saved in PARALLEL batches of BATCH_WRITE_CONCURRENCY. A
  // 10-file batch with 500 MB each used to take 10 × per-file time
  // sequentially; now it runs 3-wide so the wall-clock is roughly
  // ceil(N/3) × per-file time. The streaming write in saveFileToDisk
  // means concurrent saves don't multiply the heap footprint.
  const savedFiles: { key: string; size: number; mime: string }[] = new Array(
    files.length,
  );
  const BATCH_WRITE_CONCURRENCY = 3;
  try {
    for (
      let start = 0;
      start < files.length;
      start += BATCH_WRITE_CONCURRENCY
    ) {
      const slice = files.slice(start, start + BATCH_WRITE_CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (file, j) => {
          const i = start + j;
          const result = await saveFileToDisk(childIds[i], file);
          return {
            idx: i,
            key: result.key,
            size: result.size,
            mime: file.type || "application/octet-stream",
          };
        }),
      );
      for (const r of results) {
        savedFiles[r.idx] = { key: r.key, size: r.size, mime: r.mime };
      }
    }
  } catch (err) {
    console.error("[POST /api/jobs batch] save to disk failed:", err);
    // Best-effort cleanup of any files that did land.
    await Promise.all(childIds.map((id) => deleteJobFiles(id).catch(() => {})));
    return NextResponse.json(
      { error: "Failed to persist one or more uploads" },
      { status: 500 },
    );
  }

  const totalSize = savedFiles.reduce((sum, f) => sum + f.size, 0);
  const totalDuration = durations.reduce<number | null>((sum, d) => {
    if (d == null) return sum;
    return (sum ?? 0) + d;
  }, null);

  // Friendly batch title — first file's name + "+N more".
  const firstName = files[0].name;
  const batchTitle =
    files.length === 2
      ? `${firstName} + 1 more`
      : `${firstName} + ${files.length - 1} more`;

  let parent;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const parentJob = await tx.job.create({
        data: {
          id: parentId,
          sessionCookie: sessionId,
          kind: "batch",
          sourceName: batchTitle,
          sourceKey: "",
          sourceSize: BigInt(totalSize),
          sourceType: "application/x-batch",
          sourceDurationSec: totalDuration,
          // No job_status row — parent is invisible to the pipeline.
        },
      });

      // Children + their audio rows in parallel.
      await Promise.all(
        files.map((file, i) =>
          tx.job.create({
            data: {
              id: childIds[i],
              sessionCookie: sessionId,
              kind: "batch_file",
              parentJobId: parentJob.id,
              sourceName: file.name,
              sourceKey: savedFiles[i].key,
              sourceSize: BigInt(savedFiles[i].size),
              sourceType: savedFiles[i].mime,
              sourceDurationSec: durations[i],
              status: { create: { status: "audio", progress: 0 } },
              audio: {
                create: {
                  storageKey: audioKey(childIds[i]),
                  status: "extracting",
                  progress: 0,
                  startedAt: new Date(),
                },
              },
            },
          }),
        ),
      );

      return parentJob;
    });
    parent = result;
  } catch (err) {
    console.error("[POST /api/jobs batch] DB insert failed:", err);
    await Promise.all([
      deleteJobFiles(parentId).catch(() => {}),
      ...childIds.map((id) => deleteJobFiles(id).catch(() => {})),
    ]);
    return NextResponse.json(
      { error: "Failed to record batch" },
      { status: 500 },
    );
  }

  // Fire one extraction runner per child. The ffmpeg semaphore in
  // lib/ffmpeg.ts (concurrency=1) serializes them: only one ffmpeg process
  // is alive at a time, the others sit at progress=0 ("Waiting") until
  // their turn. Returning before they finish — they update the DB on their
  // own and the client polls /api/jobs/[parentId]/batch.
  for (let i = 0; i < files.length; i++) {
    const childId = childIds[i];
    const dur = durations[i] ?? 0;
    void (async () => {
      // Look up the child's audio.id (we need it for runExtraction). Cheap
      // — indexed unique on jobId.
      const audio = await prisma.audio.findUnique({
        where: { jobId: childId },
        select: { id: true },
      });
      if (!audio) {
        console.error("[batch child] audio row missing for", childId);
        return;
      }
      await runExtraction({
        jobId: childId,
        audioId: audio.id,
        srcKey: savedFiles[i].key,
        outKey: audioKey(childId),
        sourceDurationSec: dur,
      });
    })().catch((err) =>
      console.error("[batch child runner crashed]", childId, err),
    );
  }

  return NextResponse.json(
    {
      parent: serializeJob(parent),
      parentId: parent.id,
      childCount: files.length,
    },
    { status: 201 },
  );
}

/**
 * URL-ingestion flow: probe the URL synchronously to fail fast on bad
 * links, then create a Job whose source_name holds the URL (or resolved
 * title, after probe) and fire a background task that pulls audio via
 * yt-dlp.
 */
async function handleUrlPost(request: Request) {
  let body: { sourceUrl?: unknown };
  try {
    body = (await request.json()) as { sourceUrl?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
  if (!sourceUrl) {
    return NextResponse.json(
      { error: "`sourceUrl` is required" },
      { status: 400 },
    );
  }
  if (sourceUrl.length > MAX_URL_LENGTH) {
    return NextResponse.json({ error: "URL too long" }, { status: 400 });
  }
  if (!/^https?:\/\//i.test(sourceUrl)) {
    return NextResponse.json(
      { error: "URL must start with http:// or https://" },
      { status: 400 },
    );
  }

  // Probe synchronously so we can return useful errors (bad URL, live, etc.)
  // before committing a Job row. Cost: ~1 sec.
  let probed;
  try {
    probed = await probeUrl(sourceUrl);
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "E_YTDLP";
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, code }, { status: 400 });
  }

  const sessionId = await getOrCreateSessionId();
  const jobId = randomUUID();

  let job;
  try {
    job = await prisma.job.create({
      data: {
        id: jobId,
        sessionCookie: sessionId,
        kind: "url",
        // Show the resolved title in the wizard. We keep the raw URL too —
        // sourceKey is empty until the download lands; some downstream code
        // could also stash it elsewhere later if needed.
        sourceName: probed.title || sourceUrl,
        sourceKey: "",
        sourceSize: BigInt(0),
        sourceType: "audio/mpeg", // we'll always end up with mp3 audio
        sourceDurationSec: probed.durationSec || null,
        status: {
          create: { status: "downloading", progress: 0 },
        },
      },
      include: { status: true },
    });
  } catch (err) {
    console.error("[POST /api/jobs URL] DB insert failed:", err);
    return NextResponse.json({ error: "Failed to record job" }, { status: 500 });
  }

  // Fire-and-forget background task. Errors are recorded on job_status.
  void runDownload({
    jobId,
    sourceUrl,
    fallbackTitle: probed.title || sourceUrl,
  }).catch((err) => console.error("[runDownload] crashed:", err));

  return NextResponse.json(
    {
      ...serializeJob(job),
      sourceUrl,                  // echo for the client
      probed: {
        title: probed.title,
        durationSec: probed.durationSec,
        channel: probed.channel,
        approxSizeBytes: probed.approxSizeBytes,
      },
    },
    { status: 201 },
  );
}

/**
 * GET /api/jobs
 *
 * Returns the session's "top-level" jobs for Recent Jobs:
 *   - File / single-URL jobs (kind in 'file', 'url') — unchanged
 *   - Playlist parents (kind = 'playlist') — with aggregate child stats
 *
 * Children of playlists (kind = 'playlist_video') are EXCLUDED from this
 * list. They surface inside the playlist overview page instead.
 */
export async function GET() {
  const sessionId = await getOrCreateSessionId();

  // Pull standalone jobs + playlist parents. Children (parent_job_id is set)
  // are filtered out — they live inside their parent's overview page.
  const rows = await prisma.job.findMany({
    where: {
      sessionCookie: sessionId,
      parentJobId: null,
    },
    orderBy: { createdAt: "desc" },
    include: {
      status: true,
      // For playlist parents, pull their children's status rows so the
      // home page can compute "8 of 15 done" without an extra round-trip.
      children: {
        include: { status: true },
      },
    },
    take: 50,
  });

  return NextResponse.json(
    rows.map((row) => {
      const { children, ...job } = row;
      const base = serializeJob(job);
      // Both group-parent kinds aggregate child stats: playlists count
      // children that have moved past "downloading"; batches count children
      // that have moved past "audio". We use the same "anything past the
      // group's starting step counts as done" heuristic for both.
      if (job.kind === "playlist" || job.kind === "batch") {
        const childStatuses = children.map(
          (c) => c.status?.status ?? (job.kind === "playlist" ? "downloading" : "audio"),
        );
        const total = children.length;
        const done = childStatuses.filter((s) =>
          ["transcript", "clean", "split", "render", "done"].includes(s),
        ).length;
        // For playlists, "in progress" means actively downloading; for
        // batches, it means actively extracting. Both are the group's
        // first step.
        const startStep = job.kind === "playlist" ? "downloading" : "audio";
        const inProgress = childStatuses.filter((s) => s === startStep).length;
        const failed = childStatuses.filter((s) => s === "failed").length;
        // Reuse the existing `playlist` field name on the response — the
        // frontend reads `doneChildren / totalChildren` regardless of
        // source. Renaming to `group` would touch every consumer.
        return {
          ...base,
          playlist: {
            totalChildren: total,
            doneChildren: done,
            inProgressChildren: inProgress,
            failedChildren: failed,
          },
        };
      }
      // Standalone jobs return identical payloads to the previous API.
      return base;
    }),
  );
}
