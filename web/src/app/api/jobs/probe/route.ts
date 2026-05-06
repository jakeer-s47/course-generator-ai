import { NextResponse } from "next/server";
import { getOrCreateSessionId } from "@/lib/session";
import { probePlaylist, probeUrl } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_URL_LENGTH = 2000;

/**
 * POST /api/jobs/probe
 *
 * Synchronous probe — given a URL, return what kind of resource it points
 * at and its preview metadata. Does NOT create any DB rows.
 *
 * Body: { sourceUrl: string }
 *
 * Response shapes:
 *   200 { kind: "video",    preview: { title, durationSec, channel, approxSizeBytes } }
 *   200 { kind: "playlist", preview: { title, totalCount, entries: [...] } }
 *   400 { error, code }     — bad URL, live stream, geo-blocked, etc.
 *
 * The client uses this to render the right confirmation UI before
 * committing to a single Job (POST /api/jobs) or N Jobs (POST /api/jobs/playlist).
 */
export async function POST(request: Request) {
  // Force a session cookie to exist so any subsequent create-job call
  // shares the same anonymous identity.
  await getOrCreateSessionId();

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

  // Try playlist probe first. If yt-dlp returns _type !== "playlist" for the
  // given URL, probePlaylist returns null and we fall through to the
  // single-video probe.
  try {
    const playlist = await probePlaylist(sourceUrl);
    if (playlist) {
      return NextResponse.json({
        kind: "playlist",
        preview: playlist,
      });
    }
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "E_YTDLP";
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, code }, { status: 400 });
  }

  // Single video.
  try {
    const video = await probeUrl(sourceUrl);
    return NextResponse.json({
      kind: "video",
      preview: video,
    });
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "E_YTDLP";
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, code }, { status: 400 });
  }
}
