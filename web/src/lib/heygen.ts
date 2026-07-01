// ─── HeyGen v2 API wrapper ─────────────────────────────────────────────
//
// What this provides:
//   - uploadTalkingPhoto(absPath)  → returns talking_photo_id
//   - createVideo({ ... })         → returns video_id
//   - pollStatus(videoId)          → returns { status, videoUrl?, ... }
//   - downloadVideo(url, outPath)  → streams mp4 to disk
//
// The Step 6 background runner in
// `web/src/app/api/jobs/[id]/render/route.ts` orchestrates these calls
// per chunk. This file only knows HeyGen's HTTP contract — no DB, no
// disk-layout logic beyond the download path the caller provides.
//
// Auth: HEYGEN_API_KEY env var. Missing → every function throws
// E_HEYGEN_AUTH so callers can flip the render row to failed cleanly.
//
// Docs reference: https://docs.heygen.com/reference

import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const HEYGEN_BASE = "https://api.heygen.com";
const UPLOAD_BASE = "https://upload.heygen.com";
const POLL_TIMEOUT_MS = 15_000;

function apiKey(): string {
  const key = process.env.HEYGEN_API_KEY?.trim();
  if (!key) {
    throw Object.assign(new Error("HEYGEN_API_KEY is not set"), {
      code: "E_HEYGEN_AUTH",
    });
  }
  return key;
}

// HeyGen's TTS reads `input_text` literally, so any non-speech artifact
// (markdown, citation markers, timecodes, bullets) would be spoken aloud
// or break prosody. The enrichment prompt already forbids these, but the
// model occasionally slips, and the fallback path (raw chunk.text) can
// carry stray characters too. This is the last line of defence before
// the script becomes spoken audio.
const MAX_SCRIPT_CHARS = 60_000; // generous; ~2 hr of speech. Guards runaway input.

/**
 * Scrub a script into clean, speakable narration prose. Applied to the
 * text immediately before sending to HeyGen `createVideo`.
 *
 * Removes / normalises:
 *   - markdown emphasis (**bold**, *italic*, _under_, `code`)
 *   - markdown headings (leading #), blockquotes (leading >)
 *   - bullet / numbered-list markers at line starts
 *   - citation markers like [1], [2], [12]
 *   - leftover [mm:ss] / [hh:mm:ss] timecodes (defensive)
 *   - HTML tags
 *   - URLs (an avatar reading "h-t-t-p-colon-slash-slash" is awful)
 *   - collapses all whitespace runs (incl. newlines) into single spaces
 *   - trims, then hard-caps length at a sentence boundary
 */
export function sanitizeNarrationScript(raw: string): string {
  let s = raw;

  // Strip HTML tags first (rare, but defensive).
  s = s.replace(/<[^>]+>/g, " ");

  // Citation markers [1], [12] — but NOT [mm:ss] which we handle next.
  s = s.replace(/\[\d{1,3}\]/g, " ");

  // Timecodes [mm:ss] or [hh:mm:ss] that survived cleaning.
  s = s.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, " ");

  // Markdown headings / blockquote markers at the start of a line.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  s = s.replace(/^[ \t]*>[ \t]?/gm, "");

  // Bullet + numbered-list markers at the start of a line.
  s = s.replace(/^[ \t]*([-*•]|\d{1,3}[.)])[ \t]+/gm, "");

  // Inline code backticks → keep the inner word, drop the ticks.
  s = s.replace(/`([^`]*)`/g, "$1");

  // Bold / italic emphasis. Order matters: doubles before singles.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1");

  // Bare URLs — replace with nothing; reading a URL aloud is unusable.
  s = s.replace(/https?:\/\/\S+/gi, "");

  // Stray curly braces — never meaningful in spoken narration; they only
  // show up when the script mentions code (e.g. an empty dict "{}"). A TTS
  // engine would read or stumble on them. Drop them (keep any inner text).
  s = s.replace(/[{}]/g, " ");

  // Em-dashes / en-dashes → comma. HeyGen treats every "—" as a long
  // pause, which the enrichment agent emits constantly ("Agents — autonomous
  // systems — that — when prompted — decide"). Converting to commas keeps a
  // natural micro-pause without the long breath that makes the avatar
  // sound hesitant. Hyphens stay as hyphens (read inline).
  s = s.replace(/\s*[—–]\s*/g, ", ");

  // Ellipses → space. HeyGen reads "..." as a ~1 sec hanging pause that
  // makes the narration feel sluggish. The enrichment agent occasionally
  // emits "and so on..." or "for example...". Drop the dots; the comma
  // before usually already handles cadence.
  s = s.replace(/\.{2,}/g, " ");
  s = s.replace(/…/g, " ");

  // Connector-word periods → commas. The enrichment agent constantly
  // starts sentences with "However.", "But.", "So.", "Now.", which HeyGen
  // reads as: "However. <1s pause> The agent must…". Folding into the
  // prior clause kills the long pause: "However, the agent must…".
  // Pattern: <word ending in .> <space> <Connector> → <word>, <connector>
  const CONNECTORS = [
    "However", "Moreover", "Furthermore", "Additionally", "Also",
    "Therefore", "Thus", "Hence", "Consequently", "So", "But",
    "Now", "Then", "Next", "First", "Second", "Third", "Lastly",
    "Finally", "Meanwhile", "Indeed", "Still", "Yet", "Although",
  ];
  const connectorRe = new RegExp(
    `(\\w)\\. (${CONNECTORS.join("|")}),? `,
    "g",
  );
  s = s.replace(connectorRe, (_m, before, conn) => `${before}, ${conn.toLowerCase()} `);

  // Collapse runs of two or more commas/periods that the substitution
  // above can produce (e.g. ", , word" → ", word").
  s = s.replace(/([,.])\s*\1+/g, "$1");
  // Trim "word , word" → "word, word" — the comma joins to the preceding
  // word without a leading space, matching prose convention.
  s = s.replace(/\s+,/g, ",");

  // Collapse all whitespace (newlines, tabs, multiple spaces) to one space.
  s = s.replace(/\s+/g, " ").trim();

  // Tighten spaces left before punctuation by the substitutions above.
  s = s.replace(/\s+([.,!?;:])/g, "$1");

  // Hard length cap — truncate at the last sentence boundary under the
  // limit so the avatar never cuts off mid-word.
  if (s.length > MAX_SCRIPT_CHARS) {
    const head = s.slice(0, MAX_SCRIPT_CHARS);
    const lastStop = Math.max(
      head.lastIndexOf(". "),
      head.lastIndexOf("! "),
      head.lastIndexOf("? "),
    );
    s = lastStop > MAX_SCRIPT_CHARS * 0.5 ? head.slice(0, lastStop + 1) : head;
  }

  // Mid-thought truncation guard. The enrichment Assemble pass occasionally
  // produces narration that ends with a comma, "and", a colon, or a
  // half-formed sentence ("…the second example involves a system that"),
  // which makes the avatar narrate confidently into a wall. Trim everything
  // after the last completed sentence so the video ends on a real period.
  // We only truncate if the script actually ends without a terminator AND
  // we'd keep at least 60% of the script — otherwise we leave it alone
  // (better to ship the full content than chop a paragraph for cosmetics).
  const lastChar = s.slice(-1);
  if (lastChar && !/[.!?]/.test(lastChar)) {
    const lastTerm = Math.max(
      s.lastIndexOf("."),
      s.lastIndexOf("!"),
      s.lastIndexOf("?"),
    );
    if (lastTerm > s.length * 0.6) {
      s = s.slice(0, lastTerm + 1);
    }
  }

  return s.trim();
}

function authHeader(): Record<string, string> {
  return { "X-Api-Key": apiKey() };
}

// HeyGen's `voice.text.input_text` cap is PER-VOICE, not universal:
//   - Many standard voices: 5,000 chars
//   - Many of the popular default voices (incl. "1bd001e7e50f421d891986…"):
//     3,000 chars — the API returns "Text is N characters, which exceeds
//     the 3000-character limit for this voice model".
//   - Some older voices: as low as 1,500 chars.
// HeyGen's /v2/voices endpoint does NOT expose per-voice limits, so we
// can't pick the right cap dynamically. We default to the most restrictive
// mainstream cap (3,000) with a 200-char safety margin so a sentence-
// boundary split never overshoots after HeyGen normalises whitespace.
// Tune with HEYGEN_PER_VIDEO_MAX_CHARS env var if your account uses voices
// that allow the full 5K — bumping it cuts the render-call count and
// wall-clock time roughly in half.
export const HEYGEN_PER_VIDEO_MAX_CHARS = Math.max(
  500,
  Math.min(
    5_000,
    Number(process.env.HEYGEN_PER_VIDEO_MAX_CHARS) || 2_800,
  ),
);

/**
 * Split a long narration script into ≤ HEYGEN_PER_VIDEO_MAX_CHARS windows
 * at sentence boundaries so each window can be sent as its own HeyGen
 * generate call.
 *
 * Sentence-boundary aware (".", "!", "?", "…") — never cuts mid-sentence
 * unless one sentence by itself exceeds the cap (ASR run-on), in which
 * case it falls back to a word-boundary cut at the cap.
 *
 * Returns an array of trimmed sub-scripts. If the input fits in one
 * window, returns [text] — callers can use `.length === 1` to skip the
 * concat path entirely.
 */
export function splitScriptForHeygen(
  text: string,
  maxChars = HEYGEN_PER_VIDEO_MAX_CHARS,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  // Match each sentence including its terminator + trailing whitespace.
  // The trailing `[^]` clause catches a final fragment with no terminator.
  const sentenceRe = /[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g;
  const sentences = trimmed.match(sentenceRe) ?? [trimmed];

  const parts: string[] = [];
  let cur = "";
  const pushCur = () => {
    const t = cur.trim();
    if (t) parts.push(t);
    cur = "";
  };

  for (const s of sentences) {
    if (s.length > maxChars) {
      // Pathological single sentence — split at word boundaries.
      pushCur();
      let buf = s;
      while (buf.length > maxChars) {
        const cut = buf.lastIndexOf(" ", maxChars);
        const end = cut > maxChars * 0.5 ? cut : maxChars;
        parts.push(buf.slice(0, end).trim());
        buf = buf.slice(end).trim();
      }
      cur = buf;
      continue;
    }
    if (cur.length + s.length > maxChars) pushCur();
    cur += s;
  }
  pushCur();

  // Tail-merge — if the last part is small (< 25% of the cap, e.g. ~30 sec
  // of video), try to fold it back into the previous part. Each HeyGen
  // sub-render costs a credit at minimum even for a tiny clip, so avoiding
  // a near-empty trailing part saves both wall-clock time and ~1 credit
  // per chunk. Only merges when the combined length stays under the cap
  // (we never push back over).
  if (parts.length >= 2) {
    const TAIL_THRESHOLD = Math.floor(maxChars * 0.25);
    const tail = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    if (
      tail.length <= TAIL_THRESHOLD &&
      prev.length + 1 + tail.length <= maxChars
    ) {
      parts[parts.length - 2] = `${prev} ${tail}`;
      parts.pop();
    }
  }

  return parts;
}

/**
 * Map a HeyGen error (HTTP status + response body) to a stable code and a
 * user-facing message. Lets the UI show "out of credits" / "rate limited"
 * / "video too long" instead of a raw HTTP dump.
 */
function classifyHeyGenError(
  status: number,
  bodyText: string,
): { code: string; message: string } {
  const lower = bodyText.toLowerCase();
  if (status === 401 || status === 403) {
    return {
      code: "E_HEYGEN_AUTH",
      message: "HeyGen auth rejected — check HEYGEN_API_KEY.",
    };
  }
  if (
    status === 429 ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    return {
      code: "E_HEYGEN_RATE_LIMIT",
      message: "HeyGen rate limit hit. Wait a moment and retry.",
    };
  }
  if (
    status === 402 ||
    lower.includes("credit") ||
    lower.includes("quota") ||
    lower.includes("insufficient") ||
    lower.includes("not enough") ||
    lower.includes("upgrade your plan") ||
    lower.includes("limit reached") ||
    lower.includes("exceeded your")
  ) {
    return {
      code: "E_HEYGEN_QUOTA",
      message:
        "HeyGen credits/quota exhausted. Check your HeyGen plan and billing, then retry.",
    };
  }
  if (
    lower.includes("duration") ||
    lower.includes("too long") ||
    lower.includes("max length") ||
    lower.includes("character limit") ||
    lower.includes("text is too")
  ) {
    return {
      code: "E_HEYGEN_LIMIT",
      message:
        "HeyGen rejected the script (likely exceeds your plan's max video length / text size). Try a shorter chunk.",
    };
  }
  return {
    code: "E_HEYGEN_HTTP",
    message: `HeyGen error ${status}: ${bodyText.slice(0, 200)}`,
  };
}

// ─── Account quota ─────────────────────────────────────────────────────

/**
 * Returns the account's remaining HeyGen API credit balance. One credit
 * roughly corresponds to one minute of generated video. Used as a
 * pre-flight check before kicking off a render so the user gets a clear
 * "out of credits" error instead of wasting credits on a doomed run that
 * fails at Part 3 of 5.
 *
 * Throws E_HEYGEN_AUTH on 401/403, E_HEYGEN_HTTP otherwise.
 */
export async function getRemainingQuota(): Promise<number> {
  const resp = await fetch(
    `${HEYGEN_BASE}/v2/user/remaining_quota`,
    { method: "GET", headers: authHeader() },
  );
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(
      new Error("HeyGen auth rejected (check HEYGEN_API_KEY)"),
      { code: "E_HEYGEN_AUTH" },
    );
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(
      new Error(`HeyGen quota HTTP ${resp.status}: ${t.slice(0, 200)}`),
      { code: "E_HEYGEN_HTTP" },
    );
  }
  const data = (await resp.json().catch(() => null)) as {
    data?: { remaining_quota?: number; details?: { api?: number } };
  } | null;
  const api = data?.data?.details?.api ?? data?.data?.remaining_quota;
  return typeof api === "number" ? api : 0;
}

// ─── Voice catalogue ───────────────────────────────────────────────────

export type HeyGenVoice = {
  voiceId: string;
  name: string;
  gender: string;
  language: string;
  // Public mp3 URL of a short TTS sample. HeyGen returns this as
  // `preview_audio` on /v2/voices — the Step 6 voice picker streams it
  // when the user clicks Play next to a voice.
  previewUrl?: string;
};

/**
 * Fetch the account's available HeyGen voices.
 * Endpoint: GET https://api.heygen.com/v2/voices
 * Returns a simplified, id-deduped list. Throws E_HEYGEN_AUTH on 401/403.
 */
export async function listVoices(): Promise<HeyGenVoice[]> {
  // 60s cap. HeyGen's /v2/voices endpoint normally responds in 2–5s
  // with the ~900 KB catalogue, but during their incidents it can take
  // 30–60 seconds to trickle the full body. UI shows a Loader2 spinner
  // and a Retry button, so it's fine to wait long enough to catch the
  // slow-but-eventual successes instead of erroring fast.
  const resp = await fetch(`${HEYGEN_BASE}/v2/voices`, {
    method: "GET",
    headers: authHeader(),
    signal: AbortSignal.timeout(90_000),
  }).catch((err) => {
    throw Object.assign(
      new Error(
        `HeyGen voices request failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
      { code: "E_HEYGEN_NETWORK" },
    );
  });
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(
      new Error("HeyGen auth rejected (check HEYGEN_API_KEY)"),
      { code: "E_HEYGEN_AUTH" },
    );
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(
      new Error(`HeyGen voices HTTP ${resp.status}: ${t.slice(0, 200)}`),
      { code: "E_HEYGEN_HTTP" },
    );
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw Object.assign(new Error("HeyGen voices returned non-JSON"), {
      code: "E_HEYGEN_PARSE",
    });
  }
  const root = data as {
    data?: { voices?: unknown[] };
    voices?: unknown[];
  };
  const arr = root.data?.voices ?? root.voices ?? [];
  const seen = new Set<string>();
  const out: HeyGenVoice[] = [];
  for (const raw of arr) {
    const v = raw as {
      voice_id?: string;
      name?: string;
      gender?: string;
      language?: string;
      preview_audio?: string;
    };
    const voiceId = (v.voice_id ?? "").trim();
    if (!voiceId || seen.has(voiceId)) continue;
    seen.add(voiceId);
    const preview = (v.preview_audio ?? "").trim();
    out.push({
      voiceId,
      // HeyGen's catalog has markdown-style decoration in many names
      // (e.g. `**Sarah**`, `__Premium__`, `[PRO] Voice`, `<NEW> Ben`).
      // Strip every common decorator + collapse whitespace so the picker
      // shows clean "Sarah", "Premium", "Voice", "Ben". Done server-side
      // so every consumer of listVoices() gets the same clean strings.
      name: sanitizeVoiceName(v.name ?? "") || "Unnamed",
      gender: (v.gender ?? "").trim(),
      language: (v.language ?? "").trim(),
      previewUrl: preview || undefined,
    });
  }
  return out;
}

function sanitizeVoiceName(raw: string): string {
  return raw
    // Strip markdown-style emphasis runs (** __ *** ___).
    .replace(/[*_]{1,4}/g, "")
    // Strip bracketed tags ([PRO], [NEW], <BETA>, {PREMIUM}, …).
    .replace(/[<\[{][^>\]}]*[>\]}]/g, "")
    // Strip leading/trailing punctuation noise.
    .replace(/^[\s\-–—_:;,.]+|[\s\-–—_:;,.]+$/g, "")
    // Collapse internal whitespace runs.
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Talking-photo upload ──────────────────────────────────────────────

/**
 * Upload an instructor photo to HeyGen and get back a `talking_photo_id`
 * that can be passed to `createVideo`. The photo is reusable across
 * many videos — callers should cache the returned id on the Job row
 * (Job.instructorPhotoHeygenId) to avoid re-uploading per chunk.
 *
 * Endpoint: POST https://upload.heygen.com/v1/talking_photo
 * Body: raw image bytes (NOT multipart). Content-Type identifies the
 * format (image/jpeg or image/png).
 */
export async function uploadTalkingPhoto(params: {
  absPath: string;
  mimeType: string;
}): Promise<string> {
  const { absPath, mimeType } = params;
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
    throw Object.assign(
      new Error(
        `HeyGen Talking Photo upload requires image/jpeg or image/png, got ${mimeType}`,
      ),
      { code: "E_HEYGEN_BAD_PHOTO" },
    );
  }
  const buf = await fs.readFile(absPath);

  const resp = await fetch(`${UPLOAD_BASE}/v1/talking_photo`, {
    method: "POST",
    headers: {
      ...authHeader(),
      "Content-Type": mimeType,
    },
    body: new Uint8Array(buf),
    signal: AbortSignal.timeout(60_000),
  }).catch((err) => {
    throw Object.assign(
      new Error(
        `HeyGen upload request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_HEYGEN_NETWORK" },
    );
  });

  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(
      new Error(`HeyGen auth rejected (status ${resp.status})`),
      { code: "E_HEYGEN_AUTH" },
    );
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw Object.assign(
      new Error(`HeyGen upload HTTP ${resp.status}: ${body.slice(0, 300)}`),
      { code: "E_HEYGEN_HTTP" },
    );
  }

  let data: { code?: number; data?: { talking_photo_id?: string } };
  try {
    data = (await resp.json()) as typeof data;
  } catch (err) {
    throw Object.assign(
      new Error(
        `HeyGen upload returned non-JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_HEYGEN_PARSE" },
    );
  }

  const id = data.data?.talking_photo_id;
  if (!id || typeof id !== "string") {
    throw Object.assign(
      new Error(
        `HeyGen upload returned no talking_photo_id: ${JSON.stringify(data).slice(0, 300)}`,
      ),
      { code: "E_HEYGEN_PARSE" },
    );
  }
  return id;
}

// ─── Video creation ────────────────────────────────────────────────────

/**
 * Create a HeyGen Talking-Photo video job. Returns the video_id which
 * the caller polls via `pollStatus`.
 *
 * Endpoint: POST https://api.heygen.com/v2/video/generate
 */
/**
 * Public wrapper — retries `createVideoOnce` on TRANSIENT failures
 * (network blip, HTTP 5xx, HeyGen rate-limit). Terminal failures (auth,
 * quota, length, malformed schema) propagate immediately without retry.
 */
export async function createVideo(params: {
  talkingPhotoId: string;
  voiceId: string;
  text: string;
  speed?: number;
  dimension?: { width: number; height: number };
  background?: { type: "color"; value: string };
}): Promise<string> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await createVideoOnce(params);
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string } | null)?.code ?? "";
      // Terminal codes — do not retry; the user/account needs to act.
      if (
        code === "E_HEYGEN_AUTH" ||
        code === "E_HEYGEN_QUOTA" ||
        code === "E_HEYGEN_LIMIT" ||
        code === "E_HEYGEN_PARSE"
      ) {
        throw err;
      }
      if (attempt + 1 < MAX_ATTEMPTS) {
        // 1s, 3s backoff (rate-limit gets longer waits).
        const wait =
          code === "E_HEYGEN_RATE_LIMIT" ? 5_000 * (attempt + 1) : 1_000 * (attempt + 1) ** 2;
        console.warn(
          `[heygen] createVideo ${code || "transient error"} — retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${wait}ms`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function createVideoOnce(params: {
  talkingPhotoId: string;
  voiceId: string;
  text: string;
  speed?: number;
  dimension?: { width: number; height: number };
  background?: { type: "color"; value: string };
}): Promise<string> {
  const {
    talkingPhotoId,
    voiceId,
    text,
    speed,
    dimension = { width: 1280, height: 720 },
    background = { type: "color", value: "#f6f6fc" },
  } = params;

  // HeyGen accepts 0.5..2.0. Clamp to that range, fall back to 1.0.
  const effectiveSpeed =
    typeof speed === "number" && Number.isFinite(speed)
      ? Math.max(0.5, Math.min(2.0, speed))
      : 1.0;

  const body = {
    video_inputs: [
      {
        character: {
          type: "talking_photo",
          talking_photo_id: talkingPhotoId,
          // 'square' for a 1:1 crop around the head, 'circle' if we want
          // a portrait vignette. Default 'square' keeps the lecture feel.
          talking_photo_style: "square",
        },
        voice: {
          type: "text",
          input_text: text,
          voice_id: voiceId,
          speed: effectiveSpeed,
        },
        background,
      },
    ],
    dimension,
    test: false,
  };

  const resp = await fetch(`${HEYGEN_BASE}/v2/video/generate`, {
    method: "POST",
    headers: {
      ...authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((err) => {
    throw Object.assign(
      new Error(
        `HeyGen generate request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_HEYGEN_NETWORK" },
    );
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    const { code, message } = classifyHeyGenError(resp.status, t);
    throw Object.assign(new Error(message), { code });
  }

  let data: { data?: { video_id?: string }; error?: { message?: string } };
  try {
    data = (await resp.json()) as typeof data;
  } catch (err) {
    throw Object.assign(
      new Error(
        `HeyGen generate returned non-JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_HEYGEN_PARSE" },
    );
  }

  const videoId = data.data?.video_id;
  if (!videoId) {
    // HeyGen sometimes returns HTTP 200 with an error object (e.g. quota).
    const msg = data.error?.message ?? JSON.stringify(data).slice(0, 300);
    const { code, message } = classifyHeyGenError(200, msg);
    if (code === "E_HEYGEN_HTTP") {
      throw Object.assign(
        new Error(`HeyGen generate returned no video_id: ${msg}`),
        { code: "E_HEYGEN_PARSE" },
      );
    }
    throw Object.assign(new Error(message), { code });
  }
  return videoId;
}

// ─── Avatar IV (motion-capable) video creation ─────────────────────────
//
// Parallel path to `createVideo` above. Uses HeyGen's v3 API + Avatar IV
// engine to produce a video where the instructor's hands and body move
// in sync with the script, driven by a natural-language `motion_prompt`.
//
// Same talking_photo_id from `uploadTalkingPhoto` works as the avatar_id
// here — HeyGen treats them interchangeably under the avatar_iv engine.
// No new upload endpoint, no Photo Avatar Group training, no schema
// changes required.
//
// Endpoint: POST https://api.heygen.com/v3/videos
// Status:   GET  https://api.heygen.com/v3/videos/{video_id}
//
// Confirmed working via web/scripts/heygen-iv-smoke.mjs.

/**
 * Sensible default motion prompt for a lecturer-style narration. Override
 * per-call when the chunk topic calls for it (e.g. "demonstrates with
 * open palms when explaining the diagram").
 */
// Natural-gesture prompt for full-body source photos. Allows visible
// hand and body motion (the diffusion model gestures, sways, nods) while
// explicitly forbidding the worst drift patterns we observed: held
// objects (watches, pens), rings appearing/disappearing, and finger
// hallucination. Pair with expressiveness: "low" to keep motion subdued
// enough to look natural without going stylized.
// Override per-call or via HEYGEN_AVATAR_IV_MOTION_PROMPT env.
export const DEFAULT_AVATAR_IV_MOTION_PROMPT =
  "Speaks naturally and confidently to camera, gesturing calmly with both hands to emphasize key points. Subtle body motion and head movement. Hands stay relaxed at their natural position with no objects, no props, no rings, no holding anything.";

export async function createAvatarIVVideo(params: {
  talkingPhotoId: string;
  voiceId: string;
  text: string;
  speed?: number;
  title?: string;
  motionPrompt?: string;
  expressiveness?: "high" | "medium" | "low";
  resolution?: "4k" | "1080p" | "720p";
}): Promise<string> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await createAvatarIVVideoOnce(params);
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string } | null)?.code ?? "";
      if (
        code === "E_HEYGEN_AUTH" ||
        code === "E_HEYGEN_QUOTA" ||
        code === "E_HEYGEN_LIMIT" ||
        code === "E_HEYGEN_PARSE"
      ) {
        throw err;
      }
      if (attempt + 1 < MAX_ATTEMPTS) {
        const wait =
          code === "E_HEYGEN_RATE_LIMIT"
            ? 5_000 * (attempt + 1)
            : 1_000 * (attempt + 1) ** 2;
        console.warn(
          `[heygen] createAvatarIVVideo ${code || "transient error"} — retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${wait}ms`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function createAvatarIVVideoOnce(params: {
  talkingPhotoId: string;
  voiceId: string;
  text: string;
  speed?: number;
  title?: string;
  motionPrompt?: string;
  expressiveness?: "high" | "medium" | "low";
  resolution?: "4k" | "1080p" | "720p";
}): Promise<string> {
  const {
    talkingPhotoId,
    voiceId,
    text,
    speed,
    title = "Chapter AI render",
    motionPrompt = DEFAULT_AVATAR_IV_MOTION_PROMPT,
    // "low" minimises body movement → fewer hand/object hallucinations
    // and less tooth flicker on mouth-open frames. Bump to "medium"/"high"
    // per call when a chunk genuinely needs expressive gestures.
    expressiveness = "low",
    resolution = "720p",
  } = params;

  // Engine choice: avatar_iv (default) or avatar_v. Avatar V is HeyGen's
  // newer engine with better temporal consistency for hand/body motion
  // on full-body source photos — costs more per minute but flickers less.
  // Override via HEYGEN_AVATAR_ENGINE env.
  const engineType = (process.env.HEYGEN_AVATAR_ENGINE ?? "avatar_iv").toLowerCase();
  const engine = engineType === "avatar_v" ? "avatar_v" : "avatar_iv";

  // Avatar V rejects `expressiveness` — only Avatar IV accepts it.
  // Build the body conditionally so we don't 400 on the v engine.
  const body: Record<string, unknown> = {
    type: "avatar",
    avatar_id: talkingPhotoId,
    script: text,
    voice_id: voiceId,
    title,
    motion_prompt: motionPrompt,
    engine: { type: engine },
    resolution,
  };
  if (engine === "avatar_iv") {
    body.expressiveness = expressiveness;
  }
  // HeyGen v3 voice speed goes inside voice_settings. Clamp to 0.5..2.0
  // (anything outside that range gets rejected with invalid_parameter).
  // Skip the field entirely when speed is undefined/1.0 so we don't
  // override HeyGen's natural default.
  if (typeof speed === "number" && Number.isFinite(speed) && speed !== 1.0) {
    const clamped = Math.max(0.5, Math.min(2.0, speed));
    body.voice_settings = { speed: clamped };
  }

  const resp = await fetch(`${HEYGEN_BASE}/v3/videos`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((err) => {
    throw Object.assign(
      new Error(
        `HeyGen v3 generate request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_HEYGEN_NETWORK" },
    );
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    const { code, message } = classifyHeyGenError(resp.status, t);
    throw Object.assign(new Error(message), { code });
  }

  let data: { data?: { video_id?: string }; error?: { message?: string } };
  try {
    data = (await resp.json()) as typeof data;
  } catch (err) {
    throw Object.assign(
      new Error(
        `HeyGen v3 generate returned non-JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_HEYGEN_PARSE" },
    );
  }

  const videoId = data.data?.video_id;
  if (!videoId) {
    const msg = data.error?.message ?? JSON.stringify(data).slice(0, 300);
    const { code, message } = classifyHeyGenError(200, msg);
    if (code === "E_HEYGEN_HTTP") {
      throw Object.assign(
        new Error(`HeyGen v3 generate returned no video_id: ${msg}`),
        { code: "E_HEYGEN_PARSE" },
      );
    }
    throw Object.assign(new Error(message), { code });
  }
  return videoId;
}

// ─── Polling ────────────────────────────────────────────────────────────

export type RenderStatus =
  | { status: "processing"; progress: number | null }
  | { status: "waiting"; progress: number | null }
  | { status: "pending"; progress: number | null }
  | {
      status: "completed";
      videoUrl: string;
      thumbnailUrl: string | null;
      durationSec: number | null;
    }
  | { status: "failed"; reason: string };

/**
 * Fetch the current status of a HeyGen video render. Callers should
 * poll every ~5-15 sec while status is `processing | waiting | pending`.
 *
 * apiVersion="v1" (default) — polls v2-created Talking Photo renders:
 *   GET https://api.heygen.com/v1/video_status.get?video_id=X
 *
 * apiVersion="v3" — polls v3-created Avatar IV renders:
 *   GET https://api.heygen.com/v3/videos/{video_id}
 *
 * Response shape is the same across both versions (data.status,
 * data.video_url, data.duration, data.error?.message), so the parsing
 * logic below is shared.
 */
export async function pollStatus(
  videoId: string,
  apiVersion: "v1" | "v3" = "v1",
): Promise<RenderStatus> {
  const url =
    apiVersion === "v3"
      ? `${HEYGEN_BASE}/v3/videos/${encodeURIComponent(videoId)}`
      : `${HEYGEN_BASE}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`;
  const resp = await fetch(url, {
    headers: authHeader(),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  }).catch((err) => {
    throw Object.assign(
      new Error(
        `HeyGen poll request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_HEYGEN_NETWORK" },
    );
  });

  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(
      new Error(`HeyGen auth rejected (status ${resp.status})`),
      { code: "E_HEYGEN_AUTH" },
    );
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(
      new Error(`HeyGen poll HTTP ${resp.status}: ${t.slice(0, 300)}`),
      { code: "E_HEYGEN_HTTP" },
    );
  }

  let data: {
    data?: {
      status?: string;
      video_url?: string;
      thumbnail_url?: string;
      duration?: number;
      error?: { message?: string } | null;
    };
  };
  try {
    data = (await resp.json()) as typeof data;
  } catch (err) {
    throw Object.assign(
      new Error(
        `HeyGen poll returned non-JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_HEYGEN_PARSE" },
    );
  }

  const s = data.data?.status ?? "pending";
  if (s === "completed") {
    const videoUrl = data.data?.video_url;
    if (!videoUrl) {
      return { status: "failed", reason: "HeyGen completed but no video_url" };
    }
    return {
      status: "completed",
      videoUrl,
      thumbnailUrl: data.data?.thumbnail_url ?? null,
      durationSec: typeof data.data?.duration === "number" ? data.data.duration : null,
    };
  }
  if (s === "failed") {
    const msg = data.data?.error?.message ?? "Render failed (no reason given)";
    return { status: "failed", reason: msg.slice(0, 500) };
  }
  if (s === "processing" || s === "waiting" || s === "pending") {
    return { status: s, progress: null };
  }
  // Unknown status — treat as still processing so we don't fail
  // prematurely on a value HeyGen adds in the future.
  return { status: "processing", progress: null };
}

// ─── Download ───────────────────────────────────────────────────────────

/**
 * Stream the rendered mp4 from HeyGen's signed URL to disk. Caller
 * provides the absolute output path; we ensure the parent directory
 * exists. Returns the byte size on success.
 */
export async function downloadVideo(params: {
  videoUrl: string;
  outAbsPath: string;
}): Promise<{ sizeBytes: number }> {
  const { videoUrl, outAbsPath } = params;
  await fs.mkdir(path.dirname(outAbsPath), { recursive: true });

  const resp = await fetch(videoUrl, {
    signal: AbortSignal.timeout(5 * 60_000), // mp4 can be tens of MB
  }).catch((err) => {
    throw Object.assign(
      new Error(
        `HeyGen download failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_HEYGEN_NETWORK" },
    );
  });
  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(
      new Error(`HeyGen download HTTP ${resp.status}: ${t.slice(0, 200)}`),
      { code: "E_HEYGEN_HTTP" },
    );
  }
  await pipeline(
    Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(outAbsPath),
  );
  const stat = await fs.stat(outAbsPath);
  return { sizeBytes: stat.size };
}
