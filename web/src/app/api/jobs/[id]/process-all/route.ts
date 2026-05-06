import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionId } from "@/lib/session";
import { cascadeChild, markForCascade } from "@/lib/cascade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/jobs/[id]/process-all
 *
 * Triggers the auto-cascade pipeline for every non-terminal child of a
 * batch / playlist parent. Children currently mid-extract or mid-download
 * are flagged so their existing runner picks up the cascade on completion;
 * children already past extract/download are kicked off immediately.
 *
 * Idempotent: if all children are already terminal, returns 200 with a
 * count of 0 started.
 *
 * 200  { started: number, alreadyDone: number, failed: number }
 * 404  parent not found
 * 403  session doesn't own the parent
 * 409  parent is not a batch/playlist
 */
const VALID_LEVELS = ["light", "standard", "aggressive"] as const;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  // Optional body — overrides cascade defaults. Falls back to standard / 20.
  const body = (await request.json().catch(() => ({}))) as {
    cleanLevel?: unknown;
    targetMin?: unknown;
  };
  const cleanLevel = VALID_LEVELS.includes(body.cleanLevel as never)
    ? (body.cleanLevel as "light" | "standard" | "aggressive")
    : "aggressive";
  const rawTarget = Number(body.targetMin);
  const targetMin = Number.isFinite(rawTarget) && rawTarget >= 5 && rawTarget <= 60
    ? Math.round(rawTarget)
    : 20;

  const parent = await prisma.job.findUnique({
    where: { id },
    include: {
      children: { include: { status: true } },
    },
  });
  if (!parent) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (parent.sessionCookie && parent.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (parent.kind !== "batch" && parent.kind !== "playlist") {
    return NextResponse.json(
      { error: "This job isn't a multi-file or playlist parent" },
      { status: 409 },
    );
  }

  let started = 0;
  let alreadyDone = 0;
  let failed = 0;

  for (const child of parent.children) {
    const status = child.status?.status ?? "audio";
    if (status === "render" || status === "done") {
      alreadyDone += 1;
      continue;
    }
    if (status === "failed") {
      failed += 1;
      continue;
    }
    // Mark every still-running child for cascade. Their existing runner
    // (extract or download) will check this on success and continue the
    // cascade automatically.
    markForCascade(child.id, { cleanLevel, targetMin });
    started += 1;
    // Children already past extract/download (status >= transcript) need
    // an immediate kick — no other runner is going to fire for them.
    if (status === "transcript" || status === "clean" || status === "split") {
      void cascadeChild(child.id);
    }
  }

  return NextResponse.json({ started, alreadyDone, failed });
}
