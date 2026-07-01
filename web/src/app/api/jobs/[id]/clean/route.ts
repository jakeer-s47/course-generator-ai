import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import {
  absPathFor,
  cleanedTextKey,
  cleanedWordsKey,
  removedSegmentsKey,
} from "@/lib/storage";
import { getSessionId } from "@/lib/session";
import {
  cleanTranscript,
  type CleanLevel,
  type WordEntry,
} from "@/lib/cleaner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60 * 5; // 5 min — generous for GPT round-trip

const VALID_LEVELS: ReadonlyArray<CleanLevel> = [
  "light",
  "standard",
  "aggressive",
];

function parseLevelQuery(url: string): CleanLevel | null {
  const param = new URL(url).searchParams.get("level");
  if (!param) return null;
  return VALID_LEVELS.includes(param as CleanLevel)
    ? (param as CleanLevel)
    : null;
}

/**
 * GET /api/jobs/[id]/clean
 *
 * - Without `?level=` → returns ALL cleaned versions for this job (array,
 *   ordered by createdAt desc). Used for hydrating the wizard with all
 *   3 levels' rows on first paint.
 * - With `?level=light|standard|aggressive` → returns the single matching
 *   row (used for polling progress on a specific level).
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const job = await prisma.job.findUnique({
    where: { id },
    select: { sessionCookie: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const level = parseLevelQuery(request.url);

  if (level) {
    const row = await prisma.cleanedTranscript.findUnique({
      where: { jobId_cleanLevel: { jobId: id, cleanLevel: level } },
    });
    if (!row) {
      return NextResponse.json(
        { error: "No cleaned transcript for that level" },
        { status: 404 },
      );
    }
    return NextResponse.json(row);
  }

  const rows = await prisma.cleanedTranscript.findMany({
    where: { jobId: id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(rows);
}

/**
 * POST /api/jobs/[id]/clean
 *
 * Body: { level: "light" | "standard" | "aggressive" }
 *
 * Starts (or re-runs) GPT-4o cleaning for THIS level. Each level has its
 * own row in `cleaned_transcripts` (composite unique on jobId+cleanLevel),
 * so all 3 levels can coexist and the UI can flip between them instantly.
 *
 * Returns the row (202) while a background task hits GPT and writes
 * outputs under `uploads/{jobId}/cleaned/{level}/`.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const body = (await request.json().catch(() => ({}))) as {
    level?: string;
  };
  const level: CleanLevel = VALID_LEVELS.includes(body.level as CleanLevel)
    ? (body.level as CleanLevel)
    : "standard";

  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      transcript: true,
      // Only include the row matching this level — others (other levels)
      // are unaffected by this run.
      cleanedVersions: { where: { cleanLevel: level } },
    },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!job.transcript || job.transcript.status !== "ready") {
    return NextResponse.json(
      { error: "Transcript not ready" },
      { status: 409 },
    );
  }
  if (!job.transcript.wordsJsonKey) {
    return NextResponse.json(
      { error: "Transcript missing word-level data" },
      { status: 409 },
    );
  }

  const existing = job.cleanedVersions[0] ?? null;

  // Idempotency: a run already in flight for this level → return as-is.
  // (A second POST while the first is still streaming would just waste API
  // quota and confuse the UI's polling loop.)
  //
  // STALE-CLAIM RECOVERY: a row stuck in `cleaning` for >5 min is
  // almost certainly orphaned — the runner crashed before the
  // try/catch could flip status to `failed` (network drop, OOM,
  // process killed, etc.). Without this recovery, the row blocks
  // every subsequent Re-clean indefinitely. Treat it as failed and
  // fall through to the re-run path below.
  const STALE_MINUTES = 5;
  const isStuck =
    existing?.status === "cleaning" &&
    !!existing.startedAt &&
    Date.now() - new Date(existing.startedAt).getTime() >
      STALE_MINUTES * 60_000;
  if (existing?.status === "cleaning" && !isStuck) {
    return NextResponse.json(existing, { status: 200 });
  }
  if (isStuck) {
    console.warn(
      `[clean] stale-claim recovery for job=${id} level=${level} — row stuck in 'cleaning' for >${STALE_MINUTES} min, resetting`,
    );
    await prisma.cleanedTranscript
      .update({
        where: { id: existing!.id },
        data: {
          status: "failed",
          errorCode: "E_STALE_CLAIM",
          errorMessage: `Recovered: runner stuck in 'cleaning' for >${STALE_MINUTES} min`,
        },
      })
      .catch(() => {});
  }
  // For ready/failed rows (and recovered-stale rows), fall through and
  // re-run. The UI's explicit "Re-clean" button is exactly this case.

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        error:
          "Cleanup is not configured. Set OPENAI_API_KEY in web/.env.local and restart the dev server.",
        code: "E_OPENAI_AUTH",
      },
      { status: 503 },
    );
  }

  // Atomic claim — without this, two concurrent POSTs (e.g. fast double-
  // click on Re-clean) can both pass the `existing.status === "cleaning"`
  // check above, both upsert, and both fire GPT-4o, double-spending quota
  // and racing on the same on-disk files. See /extract route for the full
  // pattern explanation.
  let claimed = false;
  if (!existing) {
    try {
      await prisma.cleanedTranscript.create({
        data: {
          jobId: id,
          cleanLevel: level,
          status: "cleaning",
          progress: 10,
          startedAt: new Date(),
        },
      });
      claimed = true;
    } catch {
      // Lost the create race; fall through to conditional update.
    }
  }
  if (!claimed) {
    const result = await prisma.cleanedTranscript.updateMany({
      where: {
        jobId: id,
        cleanLevel: level,
        status: { in: ["pending", "ready", "failed"] },
      },
      data: {
        status: "cleaning",
        progress: 10,
        cleanedText: null,
        cleanedWordsKey: null,
        removedJsonKey: null,
        originalWords: null,
        cleanedWords: null,
        removedSegments: null,
        removedDurSec: null,
        errorCode: null,
        errorMessage: null,
        startedAt: new Date(),
        readyAt: null,
      },
    });
    claimed = result.count === 1;
  }

  const cleanedRow = await prisma.cleanedTranscript.findUnique({
    where: { jobId_cleanLevel: { jobId: id, cleanLevel: level } },
  });
  if (!cleanedRow) {
    return NextResponse.json(
      { error: "Failed to claim cleaning slot" },
      { status: 500 },
    );
  }
  if (!claimed) {
    return NextResponse.json(cleanedRow, { status: 200 });
  }

  // Wipe the previous run's on-disk artifacts for THIS level only, so a
  // re-clean that fails mid-flight can never leave stale cleaned.txt /
  // cleaned_words.json / removed_segments.json behind. Other levels'
  // directories (light/standard/aggressive) are namespaced separately
  // and untouched.
  if (existing) {
    const levelDirAbs = path.dirname(absPathFor(cleanedTextKey(id, level)));
    await fs.rm(levelDirAbs, { recursive: true, force: true }).catch(() => {});
  }

  // The job-status row tracks the *currently-running* stage. We point it at
  // "clean" while ANY level is running — once all desired levels are done
  // the user advances manually to step 5.
  await prisma.jobStatus.upsert({
    where: { jobId: id },
    create: { jobId: id, status: "clean", progress: 10 },
    update: { status: "clean", progress: 10 },
  });

  void runCleaning({
    jobId: id,
    cleanedId: cleanedRow.id,
    rawText: job.transcript.rawText ?? "",
    wordsJsonKey: job.transcript.wordsJsonKey,
    totalDurationSec: job.transcript.durationSec ?? job.sourceDurationSec ?? 0,
    level,
  }).catch((err) => console.error("[clean] background crashed", err));

  return NextResponse.json(cleanedRow, { status: 202 });
}

export async function runCleaning(params: {
  jobId: string;
  cleanedId: string;
  rawText: string;
  wordsJsonKey: string;
  totalDurationSec: number;
  level: CleanLevel;
}) {
  const {
    jobId,
    cleanedId,
    rawText,
    wordsJsonKey,
    totalDurationSec,
    level,
  } = params;

  try {
    const wordsAbs = absPathFor(wordsJsonKey);
    const wordsBuf = await fs.readFile(wordsAbs, "utf8");
    const wordsFile = JSON.parse(wordsBuf) as { words: WordEntry[] };
    const words = Array.isArray(wordsFile.words) ? wordsFile.words : [];

    const result = await cleanTranscript({
      rawText,
      words,
      level,
      totalDurationSec,
      onChunkDone: async ({ percent }) => {
        await prisma.cleanedTranscript
          .update({ where: { id: cleanedId }, data: { progress: percent } })
          .catch(() => {});
        await prisma.jobStatus
          .update({ where: { jobId }, data: { progress: percent } })
          .catch(() => {});
      },
    });

    // Each level writes to its own subdirectory so re-running another level
    // never clobbers this one's outputs.
    const textKey = cleanedTextKey(jobId, level);
    const wordsKey = cleanedWordsKey(jobId, level);
    const removedKey = removedSegmentsKey(jobId, level);

    const textAbs = absPathFor(textKey);
    const cleanedWordsAbs = absPathFor(wordsKey);
    const removedAbs = absPathFor(removedKey);

    await fs.mkdir(path.dirname(textAbs), { recursive: true });
    await Promise.all([
      fs.writeFile(textAbs, result.cleanedText, "utf8"),
      fs.writeFile(
        cleanedWordsAbs,
        JSON.stringify(
          {
            level,
            durationSec: totalDurationSec,
            words: result.cleanedWords,
          },
          null,
          2,
        ),
        "utf8",
      ),
      fs.writeFile(
        removedAbs,
        JSON.stringify(
          {
            level,
            segments: result.removedSegments,
          },
          null,
          2,
        ),
        "utf8",
      ),
    ]);

    await prisma.cleanedTranscript.update({
      where: { id: cleanedId },
      data: {
        status: "ready",
        progress: 100,
        cleanedText: result.cleanedText,
        cleanedWordsKey: wordsKey,
        removedJsonKey: removedKey,
        originalWords: result.stats.originalWords,
        cleanedWords: result.stats.cleanedWords,
        removedSegments: result.stats.removedSegmentsCount,
        removedDurSec: result.stats.removedDurSec,
        readyAt: new Date(),
      },
    });

    await prisma.jobStatus.update({
      where: { jobId },
      data: { status: "split", progress: 0 },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      (err as { code?: string } | null)?.code ?? "E_OPENAI_NETWORK";
    console.error("[clean] failed", code, message);
    await prisma.cleanedTranscript
      .update({
        where: { id: cleanedId },
        data: {
          status: "failed",
          errorCode: code,
          errorMessage: message.slice(0, 500),
        },
      })
      .catch(() => {});
    await prisma.jobStatus
      .update({ where: { jobId }, data: { status: "failed" } })
      .catch(() => {});
  }
}
