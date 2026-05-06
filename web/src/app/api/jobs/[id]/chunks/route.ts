import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CleanLevel = "light" | "standard" | "aggressive";
const VALID_LEVELS: ReadonlyArray<CleanLevel> = [
  "light",
  "standard",
  "aggressive",
];

/**
 * GET /api/jobs/[id]/chunks?level=<level>&targetMin=<n>
 *
 * Returns the chunks array for the specified SegmentRun. Both query
 * parameters are required since one job can have many runs (different
 * levels + target sizes).
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const url = new URL(request.url);
  const levelParam = url.searchParams.get("level");
  const targetParam = url.searchParams.get("targetMin");
  const cleanLevel = VALID_LEVELS.includes(levelParam as CleanLevel)
    ? (levelParam as CleanLevel)
    : null;
  const targetMin = Number(targetParam);

  if (!cleanLevel || !Number.isFinite(targetMin)) {
    return NextResponse.json(
      { error: "Missing or invalid level / targetMin" },
      { status: 400 },
    );
  }

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

  const run = await prisma.segmentRun.findUnique({
    where: {
      jobId_cleanLevel_targetMin: {
        jobId: id,
        cleanLevel,
        targetMin,
      },
    },
    include: { chunks: { orderBy: { idx: "asc" } } },
  });
  if (!run) {
    return NextResponse.json({ error: "No segment run" }, { status: 404 });
  }

  return NextResponse.json({
    run: {
      id: run.id,
      cleanLevel: run.cleanLevel,
      targetMin: run.targetMin,
      status: run.status,
      progress: run.progress,
      chunkCount: run.chunkCount,
      totalWordCount: run.totalWordCount,
    },
    chunks: run.chunks,
  });
}
