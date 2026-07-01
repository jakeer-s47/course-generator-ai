import { NextResponse } from "next/server";
import { listVoices, type HeyGenVoice } from "@/lib/heygen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Give the upstream listVoices() its full 90s window without the route
// itself timing out at the Next.js default. Important during HeyGen
// slow-but-eventual incidents where the catalogue trickles in over
// 60-90 seconds before serving a real 200 (measured 76s direct curl).
export const maxDuration = 120;

// HeyGen has ~2,400 voices; the catalogue changes rarely. Cache the
// fetched+filtered list in-process so the picker doesn't re-hit HeyGen on
// every page load. TTL 1 hour.
let _cache: { at: number; voices: HeyGenVoice[] } | null = null;
const TTL_MS = 60 * 60 * 1000;

/**
 * GET /api/heygen/voices
 *
 * Returns English HeyGen voices for the Step 6 voice picker:
 *   { voices: [{ voiceId, name, gender, language }], total }
 *
 * 503 if HEYGEN_API_KEY is unset/rejected, 502 on other HeyGen errors.
 */
export async function GET() {
  if (!process.env.HEYGEN_API_KEY?.trim()) {
    return NextResponse.json(
      {
        error:
          "HeyGen not configured. Set HEYGEN_API_KEY in web/.env.local and restart the dev server.",
        code: "E_HEYGEN_AUTH",
        voices: [],
      },
      { status: 503 },
    );
  }

  if (_cache && Date.now() - _cache.at < TTL_MS) {
    return NextResponse.json({ voices: _cache.voices, total: _cache.voices.length });
  }

  try {
    const all = await listVoices();
    // English voices only — the pipeline's content is English. Sort by
    // gender then name so male/female group together in the dropdown.
    const english = all
      .filter((v) => v.language.toLowerCase().includes("english"))
      .sort(
        (a, b) =>
          a.gender.localeCompare(b.gender) || a.name.localeCompare(b.name),
      );
    const voices = english.length > 0 ? english : all;
    _cache = { at: Date.now(), voices };
    return NextResponse.json({ voices, total: voices.length });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? "E_HEYGEN_HTTP";
    const status = code === "E_HEYGEN_AUTH" ? 503 : 502;
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to load voices",
        code,
        voices: [],
      },
      { status },
    );
  }
}
