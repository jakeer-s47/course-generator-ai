import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STYLES = new Set(["instructor", "animated", "whiteboard"]);

/**
 * PATCH /api/jobs/[id]/render-prefs
 *
 * Body: { renderStyle: "instructor" | "animated" | "whiteboard" }
 *
 * Persists the user's Step 6 style choice on the Job row so it
 * survives a page refresh. The actual avatar / animated / whiteboard
 * generation runs against whichever provider is wired downstream
 * (HeyGen for instructor; future providers for animated + whiteboard).
 */
export async function PATCH(
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

  const body = (await request.json().catch(() => ({}))) as {
    renderStyle?: string;
    voiceId?: string | null;
    voiceSpeed?: number | null;
  };

  // Partial-patch semantics: any subset of (renderStyle, voiceId,
  // voiceSpeed) can be sent; the others are left untouched. The UI uses
  // this for "user changed voice" and "user changed speed" updates
  // independently of the style picker.
  const data: {
    renderStyle?: string;
    voiceId?: string | null;
    voiceSpeed?: number | null;
  } = {};

  if (body.renderStyle !== undefined) {
    if (!body.renderStyle || !VALID_STYLES.has(body.renderStyle)) {
      return NextResponse.json(
        {
          error:
            "renderStyle must be 'instructor' | 'animated' | 'whiteboard'",
        },
        { status: 400 },
      );
    }
    data.renderStyle = body.renderStyle;
  }

  if (body.voiceId !== undefined) {
    // null clears it back to env default. Empty string = also clear.
    const v = body.voiceId === null ? null : body.voiceId.trim();
    if (v !== null && v.length > 100) {
      return NextResponse.json(
        { error: "voiceId looks malformed (too long)" },
        { status: 400 },
      );
    }
    data.voiceId = v === "" ? null : v;
  }

  if (body.voiceSpeed !== undefined) {
    if (body.voiceSpeed === null) {
      data.voiceSpeed = null;
    } else if (
      typeof body.voiceSpeed === "number" &&
      Number.isFinite(body.voiceSpeed) &&
      body.voiceSpeed >= 0.5 &&
      body.voiceSpeed <= 2.0
    ) {
      data.voiceSpeed = body.voiceSpeed;
    } else {
      return NextResponse.json(
        { error: "voiceSpeed must be a number between 0.5 and 2.0" },
        { status: 400 },
      );
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      {
        error:
          "Send at least one of renderStyle, voiceId, voiceSpeed",
      },
      { status: 400 },
    );
  }

  const updated = await prisma.job.update({
    where: { id },
    data,
    select: {
      renderStyle: true,
      instructorPhotoKey: true,
      voiceId: true,
      voiceSpeed: true,
    },
  });
  return NextResponse.json(updated);
}

/**
 * GET /api/jobs/[id]/render-prefs
 * Returns the persisted render-style + photo-key for hydration on
 * page refresh.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();
  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      sessionCookie: true,
      renderStyle: true,
      instructorPhotoKey: true,
      voiceId: true,
      voiceSpeed: true,
    },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.sessionCookie && job.sessionCookie !== sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    renderStyle: job.renderStyle,
    instructorPhotoKey: job.instructorPhotoKey,
    voiceId: job.voiceId,
    voiceSpeed: job.voiceSpeed,
  });
}
