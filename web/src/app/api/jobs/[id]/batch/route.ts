import { NextResponse } from "next/server";
import { prisma, serializeJob } from "@/lib/db";
import { getSessionId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/jobs/[id]/batch
 *
 * Returns a multi-file batch parent's children with their individual
 * statuses. Used by the batch-overview page (and the inline progress card
 * on Step 1) to render the per-file list.
 *
 * Mirrors `GET /api/jobs/[id]/playlist` exactly — only the kind check
 * differs.
 *
 * 200  { parent: Job, children: [{ ...job, status: {...} }] }
 * 404  if id doesn't exist
 * 409  if id refers to a non-batch Job
 * 403  if session doesn't own the job
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const parent = await prisma.job.findUnique({
    where: { id },
    include: {
      children: {
        include: { status: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!parent) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (parent.sessionCookie && parent.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (parent.kind !== "batch") {
    return NextResponse.json(
      { error: "This job is not a batch parent" },
      { status: 409 },
    );
  }

  const { children, ...rest } = parent;
  return NextResponse.json({
    parent: serializeJob(rest),
    children: children.map((c) => {
      const { status, ...job } = c;
      return { ...serializeJob(job), status: status ?? null };
    }),
  });
}
