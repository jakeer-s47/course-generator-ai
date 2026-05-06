import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { prisma } from "@/lib/db";
import { absPathFor } from "@/lib/storage";
import { getSessionId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Level = "light" | "standard" | "aggressive";
const VALID: ReadonlyArray<Level> = ["light", "standard", "aggressive"];

/**
 * GET /api/jobs/[id]/clean/words?level=<level>
 *
 * Streams the cleaned_words.json for the requested level (the survived word
 * array with full timing). Step 5 (Split) consumes this directly.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionId = await getSessionId();

  const param = new URL(request.url).searchParams.get("level");
  const level: Level | null = VALID.includes(param as Level)
    ? (param as Level)
    : null;
  if (!level) {
    return NextResponse.json(
      { error: "Missing or invalid ?level=" },
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

  const row = await prisma.cleanedTranscript.findUnique({
    where: { jobId_cleanLevel: { jobId: id, cleanLevel: level } },
  });
  if (!row || row.status !== "ready" || !row.cleanedWordsKey) {
    return NextResponse.json(
      { error: "Cleaned words not ready" },
      { status: 404 },
    );
  }

  const absPath = absPathFor(row.cleanedWordsKey);
  let text: string;
  try {
    text = await fs.readFile(absPath, "utf8");
  } catch {
    return NextResponse.json({ error: "File missing" }, { status: 410 });
  }

  return new Response(text, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}
