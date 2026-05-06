import { NextResponse } from "next/server";
import { prisma, serializeJob } from "@/lib/db";
import { getOrCreateSessionId } from "@/lib/session";
import { probePlaylist } from "@/lib/ytdlp";
import { runDownload } from "../[id]/download/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_URL_LENGTH = 2000;
const MAX_PLAYLIST_ENTRIES = 25;

/**
 * POST /api/jobs/playlist
 *
 * Body: { sourceUrl: string }
 *
 * Probes the URL as a playlist and creates ONE parent Job + N child Jobs
 * (one per video). Each child runs the existing single-URL download
 * pipeline; the parent is a placeholder row that owns no audio.
 *
 * Response: 201 { parentId: string, childCount: number, skipped: number }
 *
 * Failure modes:
 *   400 — playlist > 25 videos, empty playlist, or URL isn't a playlist
 *   400 — yt-dlp probe failure with friendly code/message
 */
export async function POST(request: Request) {
  let body: { sourceUrl?: unknown };
  try {
    body = (await request.json()) as { sourceUrl?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sourceUrl =
    typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
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

  // Synchronously probe the playlist. ~2 s with --flat-playlist.
  let playlist;
  try {
    playlist = await probePlaylist(sourceUrl);
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "E_YTDLP";
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, code }, { status: 400 });
  }

  if (!playlist) {
    return NextResponse.json(
      {
        error: "That URL doesn't look like a playlist. Use the single-video flow instead.",
        code: "E_YTDLP_NOT_PLAYLIST",
      },
      { status: 400 },
    );
  }

  const validEntries = playlist.entries;
  const skipped = playlist.totalCount - validEntries.length;

  if (validEntries.length === 0) {
    return NextResponse.json(
      { error: "Playlist appears empty.", code: "E_YTDLP_EMPTY" },
      { status: 400 },
    );
  }

  if (validEntries.length > MAX_PLAYLIST_ENTRIES) {
    return NextResponse.json(
      {
        error: `Playlist too long — max ${MAX_PLAYLIST_ENTRIES} videos. Cherry-pick individual videos instead.`,
        code: "E_YTDLP_TOO_LONG",
        totalCount: validEntries.length,
        maxAllowed: MAX_PLAYLIST_ENTRIES,
      },
      { status: 400 },
    );
  }

  const sessionId = await getOrCreateSessionId();

  // Create parent + N children in a single transaction. Parent has no
  // job_status row (the existing pipeline keys off job_status.job_id, so
  // a parent with no row is invisible to downstream stages — exactly what
  // we want).
  const totalDurationSec = validEntries.reduce(
    (sum, e) => sum + (e.durationSec ?? 0),
    0,
  );

  const { parent, children } = await prisma.$transaction(async (tx) => {
    const parent = await tx.job.create({
      data: {
        sessionCookie: sessionId,
        kind: "playlist",
        sourceName: playlist.title,
        sourceKey: "",
        sourceSize: BigInt(0),
        sourceType: "audio/playlist",
        sourceDurationSec: totalDurationSec,
        // No `status: { create: ... }` — parents are placeholders.
      },
    });

    const children = await Promise.all(
      validEntries.map((entry) =>
        tx.job.create({
          data: {
            sessionCookie: sessionId,
            kind: "playlist_video",
            parentJobId: parent.id,
            sourceName: entry.title,
            sourceKey: "",
            sourceSize: BigInt(0),
            sourceType: "audio/mpeg",
            sourceDurationSec: entry.durationSec || null,
            status: { create: { status: "downloading", progress: 0 } },
          },
        }),
      ),
    );

    return { parent, children };
  });

  // Fire one runDownload per child. The semaphore inside downloadAudio
  // caps in-flight yt-dlp processes at 1 — extra children block on
  // acquireDownloadSlot until the active one releases. So all N runners
  // are alive in memory, but exactly one is actually downloading at a
  // time (the rest sit at progress=0, "Waiting" in the UI).
  for (const [idx, child] of children.entries()) {
    void runDownload({
      jobId: child.id,
      sourceUrl: validEntries[idx].sourceUrl,
      fallbackTitle: validEntries[idx].title,
    }).catch((err) =>
      console.error("[playlist child runner crashed]", child.id, err),
    );
  }

  return NextResponse.json(
    {
      parent: serializeJob(parent),
      parentId: parent.id,
      childCount: children.length,
      skipped: skipped > 0 ? skipped : 0,
    },
    { status: 201 },
  );
}
