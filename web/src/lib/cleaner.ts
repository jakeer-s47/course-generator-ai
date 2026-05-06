import OpenAI from "openai";

// Reusing the same singleton pattern as src/lib/whisper.ts so that auth
// errors map consistently across the pipeline.
let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("OPENAI_API_KEY is not set"), {
      code: "E_OPENAI_AUTH",
    });
  }
  _client = new OpenAI({ apiKey });
  return _client;
}

const MODEL = "gpt-4o-2024-11-20";

// We chunk the transcript by time so each GPT call's output stays well under
// the model's 16K output-token cap. Without chunking, an Aggressive run on a
// 48-min lecture emits ~200 segments and truncates mid-JSON.
const CHUNK_SECONDS = 600; // 10 min per chunk — same boundary as Whisper

export type CleanLevel = "light" | "standard" | "aggressive";

export type WordEntry = { word: string; start: number; end: number };

export type RemovedCategory =
  | "filler"
  | "admin"
  | "tangent"
  | "recap"
  | "redundant"
  | "falsestart";

export type RemovedSegment = {
  start_sec: number;
  end_sec: number;
  category: RemovedCategory;
  reason: string;
};

export type CleanResult = {
  removedSegments: RemovedSegment[];
  cleanedText: string;
  cleanedWords: WordEntry[];
  stats: {
    originalWords: number;
    cleanedWords: number;
    removedSegmentsCount: number;
    removedDurSec: number;
  };
};

const SCHEMA = {
  type: "object",
  required: ["removed_segments"],
  additionalProperties: false,
  properties: {
    removed_segments: {
      type: "array",
      items: {
        type: "object",
        required: ["start_sec", "end_sec", "category", "reason"],
        additionalProperties: false,
        properties: {
          start_sec: { type: "number" },
          end_sec: { type: "number" },
          category: {
            type: "string",
            enum: [
              "filler",
              "admin",
              "tangent",
              "recap",
              "redundant",
              "falsestart",
            ],
          },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, "0");
}

function mmss(sec: number): string {
  return `${pad2(sec / 60)}:${pad2(sec % 60)}`;
}

/**
 * Group word-level entries into ~10-second lines prefixed with [mm:ss].
 * Compact representation for GPT — about 3-5x fewer tokens than streaming
 * the raw words[] array as JSON.
 */
function buildTimestampedLines(words: WordEntry[], bucketSec = 10): string {
  if (words.length === 0) return "";
  const lines: string[] = [];
  let curStart = words[0].start;
  let cur: string[] = [];
  for (const w of words) {
    if (w.start - curStart >= bucketSec && cur.length > 0) {
      lines.push(`[${mmss(curStart)}] ${cur.join(" ").trim()}`);
      curStart = w.start;
      cur = [];
    }
    cur.push(w.word.trim());
  }
  if (cur.length > 0) {
    lines.push(`[${mmss(curStart)}] ${cur.join(" ").trim()}`);
  }
  return lines.join("\n");
}

function systemPrompt(level: CleanLevel): string {
  const allowed: Record<CleanLevel, string> = {
    light: "filler, falsestart",
    standard: "filler, falsestart, admin, tangent",
    aggressive: "filler, falsestart, admin, tangent, recap, redundant",
  };

  // Tone hint per level. Light errs heavily on the side of keep; aggressive
  // is allowed to remove even useful-but-redundant content.
  const tone: Record<CleanLevel, string> = {
    light:
      "Be VERY conservative. Remove only obvious verbal stumbles. If a phrase has any teaching value, KEEP IT.",
    standard:
      "Balanced editing. Remove housekeeping and clear off-topic asides, but preserve all instructional content.",
    aggressive:
      "Tight editing for a polished version. Drop content that's already been covered, even when phrased differently.",
  };

  return `You clean instructional lecture transcripts by identifying spans the listener should NOT hear.

CATEGORIES (use ONLY these):
- filler — "um/uh/like/you know", stutters, hesitations
- falsestart — incomplete or restarted sentences
- admin — schedule notes, "let me check the time", roll call, housekeeping
- tangent — off-topic anecdotes, side conversations, jokes unrelated to the topic
- recap — explicit "as I told you before…" repetition of already-covered material
- redundant — clearly restated content within the same paragraph

NEVER REMOVE:
- definitions, derivations, worked examples
- code, syntax, commands, technical terminology
- instructional transitions ("now let's look at…", "the next thing is…")
- analogies or examples that illustrate the concept
- anything where the speaker is teaching, explaining, or demonstrating

EXAMPLES (good vs. bad removals):

Example 1 — KEEP (instructional transition):
  "[03:21] Now let's look at how variables work in JavaScript."
  → DO NOT remove. This is a transition into teaching content.

Example 2 — REMOVE (filler):
  "[03:24] So, um, you know, like a variable is, uh, a container."
  → Remove just "um, you know, like" and "uh" — keep the definition.
  → category: filler  reason: stutters around definition

Example 3 — REMOVE (admin) at standard+:
  "[12:05] Hey before we continue, the assignment is due Friday at 5pm."
  → Remove the whole sentence.
  → category: admin  reason: assignment deadline note

Example 4 — KEEP at standard, REMOVE at aggressive (recap):
  "[28:10] As I mentioned earlier, JavaScript is dynamic, meaning..."
  → "As I mentioned earlier" is a recap signal. At aggressive, remove the
    full restatement; at standard, keep it (the listener may have skipped).

Example 5 — KEEP (analogy, not tangent):
  "[15:40] Think of an object like a box with labelled compartments."
  → DO NOT remove. Analogies illustrating the concept are teaching content.

STRICTNESS LEVEL: ${level}
${tone[level]}
For this run, only emit segments whose category is one of: ${allowed[level]}.
If a span doesn't clearly fit one of those categories at this level, DO NOT remove it. When in doubt, KEEP IT.

SPAN BOUNDARIES:
- Prefer boundaries that align with sentence or clause endings. Do NOT cut mid-clause unless the entire clause is a removal candidate.
- Each span should be ≤ 15 seconds. For longer issues, emit multiple shorter spans.
- Avoid back-to-back spans with a gap of < 1 second between them — merge into one.

OUTPUT:
- Return JSON matching the schema (removed_segments array).
- Each segment's start_sec / end_sec MUST come from the [mm:ss] timecodes in the transcript (convert to seconds: mm*60+ss).
- end_sec MUST be > start_sec.
- reason: ≤ 8 words explaining why this span is being removed.
- If nothing should be removed, return { "removed_segments": [] }.`;
}

function userPrompt(timestampedLines: string): string {
  return `Here is the timestamped lecture transcript. Identify spans to remove per the rules.

${timestampedLines}`;
}

type ParsedResponse = {
  removed_segments: RemovedSegment[];
};

async function callGptOnce(
  level: CleanLevel,
  timestampedLines: string,
): Promise<RemovedSegment[]> {
  const completion = await client().chat.completions.create({
    model: MODEL,
    temperature: 0,
    // GPT-4o's per-call output cap is 16,384 tokens. A 10-min chunk's
    // removed-segments JSON is normally a few thousand tokens, but a
    // filler-dense lecture can blow past 8 K — we saw real truncation
    // at position 29754 (~8 K tokens). Sit just under the model max;
    // the chunk-split fallback in cleanTranscript handles anything
    // that still doesn't fit.
    max_tokens: 16000,
    messages: [
      { role: "system", content: systemPrompt(level) },
      { role: "user", content: userPrompt(timestampedLines) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "removed_segments_response",
        strict: true,
        schema: SCHEMA,
      },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw Object.assign(new Error("AI returned empty content"), {
      code: "E_OPENAI_RESPONSE",
    });
  }
  let parsed: ParsedResponse;
  try {
    parsed = JSON.parse(raw) as ParsedResponse;
  } catch (err) {
    throw Object.assign(
      new Error(
        `AI returned malformed content: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { code: "E_OPENAI_RESPONSE" },
    );
  }
  if (!Array.isArray(parsed.removed_segments)) {
    throw Object.assign(
      new Error("AI response missing required fields"),
      { code: "E_OPENAI_RESPONSE" },
    );
  }
  return parsed.removed_segments;
}

async function callGptWithRetry(
  level: CleanLevel,
  timestampedLines: string,
): Promise<RemovedSegment[]> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callGptOnce(level, timestampedLines);
    } catch (err) {
      lastErr = err;
      const status =
        err && typeof err === "object" && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      if (status === 401 || status === 403) {
        throw Object.assign(
          new Error("OpenAI auth failed (check OPENAI_API_KEY)"),
          { code: "E_OPENAI_AUTH" },
        );
      }
      const code = (err as { code?: string } | null)?.code;
      // Don't retry deterministic schema-shape errors.
      if (code === "E_OPENAI_RESPONSE" && attempt > 0) break;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1) ** 2));
    }
  }
  // Preserve the underlying code when it's a deterministic schema-shape
  // error — otherwise the chunk-split fallback in cleanTranscript can't
  // detect truncation and falls back to surfacing E_OPENAI_NETWORK to
  // the user. Only wrap as NETWORK for transient/unknown failures.
  const lastCode = (lastErr as { code?: string } | null)?.code;
  if (lastCode === "E_OPENAI_RESPONSE") {
    throw Object.assign(
      new Error(
        lastErr instanceof Error ? lastErr.message : String(lastErr),
      ),
      { code: "E_OPENAI_RESPONSE" },
    );
  }
  throw Object.assign(
    new Error(
      `AI cleanup failed after retries: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    ),
    { code: "E_OPENAI_NETWORK" },
  );
}

// Hard cap on a single span. Matches the guidance we give GPT in the
// system prompt; any longer ranges are likely the model being too eager.
const MAX_SPAN_SEC = 20;

/**
 * Drop ranges where end <= start, clamp to [0, duration], split absurdly long
 * spans, sort, and merge overlapping or near-touching ranges so the kept-text
 * reconstruction doesn't double-count.
 */
function normalizeRanges(
  segments: RemovedSegment[],
  totalDurationSec: number,
): RemovedSegment[] {
  // Stage 1 — basic validity + clamping.
  const valid = segments.filter(
    (s) =>
      Number.isFinite(s.start_sec) &&
      Number.isFinite(s.end_sec) &&
      s.end_sec > s.start_sec,
  );
  for (const s of valid) {
    s.start_sec = Math.max(0, s.start_sec);
    s.end_sec = Math.min(totalDurationSec, s.end_sec);
  }

  // Stage 2 — drop any span longer than MAX_SPAN_SEC. GPT occasionally
  // marks an entire 60-second monologue when only a sentence was the
  // problem; rather than guess where the problem was, we discard it.
  const lengthOk = valid.filter((s) => s.end_sec - s.start_sec <= MAX_SPAN_SEC);

  // Stage 3 — sort + merge overlaps. We only merge spans that (a) actually
  // overlap or exactly touch (no 1s gap tolerance — that could swallow a
  // kept word that lives between two near-but-distinct ranges) and
  // (b) share the same category — otherwise an adjacent `filler` and
  // `tangent` would collapse into a single span tagged `filler` and the
  // inspector would mislabel half its content.
  lengthOk.sort((a, b) => a.start_sec - b.start_sec);
  const merged: RemovedSegment[] = [];
  for (const s of lengthOk) {
    const last = merged[merged.length - 1];
    if (last && s.category === last.category && s.start_sec <= last.end_sec) {
      last.end_sec = Math.max(last.end_sec, s.end_sec);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

/** True if `t` falls inside any [start, end) range in segments. */
function isInsideAnyRange(t: number, segments: RemovedSegment[]): boolean {
  // segments is sorted; could binary-search, but linear is fine for ~hundreds.
  for (const s of segments) {
    if (t < s.start_sec) return false;
    if (t < s.end_sec) return true;
  }
  return false;
}

/** Group words into ~CHUNK_SECONDS slices so each GPT call stays small. */
function chunkWordsByTime(words: WordEntry[]): WordEntry[][] {
  if (words.length === 0) return [];
  const chunks: WordEntry[][] = [];
  let cur: WordEntry[] = [];
  let chunkStart = words[0].start;
  for (const w of words) {
    if (w.start - chunkStart >= CHUNK_SECONDS && cur.length > 0) {
      chunks.push(cur);
      cur = [];
      chunkStart = w.start;
    }
    cur.push(w);
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export type ChunkProgress = {
  chunkIndex: number;
  totalChunks: number;
  percent: number;
};

/**
 * Main entry: pass the original transcript + words; returns the cleaned data.
 *
 * - The transcript is split into 10-minute chunks, then GPT-4o is asked
 *   per chunk to emit `removed_segments` (start/end in absolute seconds).
 *   This keeps each call's output well under the 16K-token cap.
 * - GPT-4o is asked to mark spans for removal (not to rewrite text), which
 *   keeps word-level timing alignment intact for downstream Steps 5 + 6.
 * - The cleaned word array is filtered from the original; cleanedText is
 *   reassembled from the surviving words.
 */
export async function cleanTranscript(params: {
  rawText: string;
  words: WordEntry[];
  level: CleanLevel;
  totalDurationSec: number;
  onChunkDone?: (p: ChunkProgress) => Promise<void> | void;
}): Promise<CleanResult> {
  const { words, level, totalDurationSec, onChunkDone } = params;

  if (words.length === 0) {
    return {
      removedSegments: [],
      cleanedText: "",
      cleanedWords: [],
      stats: {
        originalWords: 0,
        cleanedWords: 0,
        removedSegmentsCount: 0,
        removedDurSec: 0,
      },
    };
  }

  // Process a slice of words, recursively halving on truncation.
  // GPT-4o output is capped at ~16 K tokens; in the rare case that a
  // single chunk still exceeds that, we split the words in half and
  // try each half. Bound the recursion at depth 3 so a pathological
  // chunk can't fork forever (3 splits = 8 micro-calls max).
  const processSlice = async (
    slice: WordEntry[],
    depth: number,
  ): Promise<RemovedSegment[]> => {
    if (slice.length === 0) return [];
    try {
      return await callGptWithRetry(level, buildTimestampedLines(slice));
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "E_OPENAI_RESPONSE" && depth < 3 && slice.length > 50) {
        const mid = Math.floor(slice.length / 2);
        const left = await processSlice(slice.slice(0, mid), depth + 1);
        const right = await processSlice(slice.slice(mid), depth + 1);
        return [...left, ...right];
      }
      throw err;
    }
  };

  const chunks = chunkWordsByTime(words);
  const totalChunks = chunks.length;
  const allSegments: RemovedSegment[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const segs = await processSlice(chunks[i], 0);
    allSegments.push(...segs);
    const percent = Math.round(((i + 1) / totalChunks) * 100);
    await onChunkDone?.({ chunkIndex: i, totalChunks, percent });
  }

  const removedSegments = normalizeRanges(allSegments, totalDurationSec);

  const cleanedWords = words.filter(
    (w) => !isInsideAnyRange(w.start, removedSegments),
  );

  const cleanedText = cleanedWords
    .map((w) => w.word.trim())
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();

  const removedDurSec = Math.round(
    removedSegments.reduce((sum, s) => sum + (s.end_sec - s.start_sec), 0),
  );

  return {
    removedSegments,
    cleanedText,
    cleanedWords,
    stats: {
      originalWords: words.length,
      cleanedWords: cleanedWords.length,
      removedSegmentsCount: removedSegments.length,
      removedDurSec,
    },
  };
}
