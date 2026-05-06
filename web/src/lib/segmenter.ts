import OpenAI from "openai";

// Same singleton pattern as whisper.ts / cleaner.ts so auth errors map
// consistently across the pipeline.
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

export type WordEntry = { word: string; start: number; end: number };

export type SegmentChunk = {
  topic: string;
  preview: string;
  startSec: number;
  endSec: number;
  wordCount: number;
  text: string; // joined transcript slice for this chunk
};

export type SegmentResult = {
  chunks: SegmentChunk[];
  totalWordCount: number;
};

// ---------------------------------------------------------------------------
// Pass 1 — boundary detection only. We deliberately do NOT ask GPT for
// titles here, because in single-pass mode the model tends to generate a
// plausible list of canonical topic titles for the lecture's domain and
// then assign them to its boundaries in document order, leading to
// titles that drift away from the actual content at those timestamps.
// ---------------------------------------------------------------------------

const BOUNDARY_SCHEMA = {
  type: "object",
  required: ["boundaries"],
  additionalProperties: false,
  properties: {
    boundaries: {
      type: "array",
      items: {
        type: "object",
        required: ["start_sec", "end_sec"],
        additionalProperties: false,
        properties: {
          start_sec: { type: "number" },
          end_sec: { type: "number" },
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
 * Group words into ~10-second timestamped lines. GPT reasons about topic
 * boundaries far better when it can see the [mm:ss] anchor than when it
 * gets a raw words array — and it cuts input tokens 3-5x.
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

function boundariesPrompt(targetMin: number, totalDurationSec: number): string {
  const totalMin = Math.max(1, Math.round(totalDurationSec / 60));
  // Topic-driven mode: target is just a HINT for "split very long topics"
  // and "merge very short ones". The chunk count comes from the number of
  // distinct topics in the transcript, not from any time-based formula.
  const splitAbove = Math.max(180, Math.round(targetMin * 60 * 1.5));
  const mergeBelow = Math.max(45, Math.round(targetMin * 60 * 0.25));

  return `You split instructional lecture transcripts into topic chunks. In this PASS, your job is to find every distinct topic in the transcript and emit ONE BOUNDARY per topic. Do NOT title or summarize anything — that's a separate step.

PRIMARY RULE: ONE CHUNK PER TOPIC.
- Read the whole transcript and identify every distinct topic the speaker covers.
- Each distinct topic becomes ONE chunk.
- The number of chunks = the number of topics. It is NOT determined by the target length.
- If the lecture has 7 topics, you emit 7 chunks. If 3, you emit 3.

TARGET LENGTH IS A SOFT HINT (NOT A HARD CONSTRAINT):
The user picked ~${targetMin} min as their preferred chunk size. Use it ONLY for these two edge cases:
- If a single topic runs much longer than ${targetMin} min (above ~${splitAbove}s), look for a sub-topic boundary inside it and split there. Otherwise leave it as one chunk even if it's long.
- If two adjacent topics are both extremely short (below ~${mergeBelow}s each) AND clearly related, merge them into one chunk.

Do NOT split topics just because they're slightly over target. Do NOT merge topics just because the chunks would be slightly under target. Topic boundaries take priority.

WHAT COUNTS AS A DISTINCT TOPIC:
A topic is a single concept, skill, or section the speaker is teaching. The speaker usually signals topic shifts with one or more of these cues:
1. EXPLICIT verbal cues: "now let's look at…", "the next thing is…", "let's talk about…", "moving on to…", "alright, now…", "in the next lecture…", "let's see what … is".
2. NEW CONCEPT INTRODUCTION (strongest signal): speaker names a new technical term/concept and starts explaining it. Examples in a JS lecture: "let's declare a variable" (= variables topic), "what is an object" (= objects topic), "let's look at functions" (= functions topic), "we have two types of programming languages" (= dynamic typing topic).
3. CLOSING + OPENING pair: speaker wraps one topic ("so that's how X works") and immediately starts another ("now let's…").
4. THEORY ↔ DEMO pivot: speaker stops explaining and starts coding/demonstrating (or vice versa) for a clearly different concept.
5. SUBSTANTIVE CONTENT CHANGE: subject matter clearly shifts even without an explicit cue.

WHAT IS NOT A TOPIC SHIFT (do NOT cut here):
- Mid-derivation, mid-example, mid-equation, mid-code block.
- Within a single demo or worked example.
- During a list ("first… second… third…").
- A side comment or aside that doesn't introduce a new topic.

PROCESS:
1. Read the transcript fully.
2. List every distinct topic you can identify (one line per topic, with its rough start time).
3. Apply the soft hints: split topics > ${splitAbove}s where there's a clean sub-boundary; merge adjacent topics < ${mergeBelow}s if related.
4. Emit one boundary per resulting topic.

HARD RULES:
- The first chunk's start_sec MUST equal 0.
- The last chunk's end_sec MUST equal ${totalDurationSec}.
- Chunks MUST be contiguous: boundaries[i].end_sec === boundaries[i+1].start_sec. No gaps. No overlaps.
- Every chunk MUST be at least 30 seconds long.
- All times in seconds. The transcript uses [mm:ss] — convert: mm*60 + ss.

OUTPUT:
- Return JSON: { "boundaries": [{ start_sec, end_sec }, ...] }
- No titles. No previews. One entry per topic.`;
}

function boundariesUserPrompt(timestampedLines: string): string {
  return `Here is the timestamped cleaned transcript. Identify topic-shift boundaries per the rules.

${timestampedLines}`;
}

type RawBoundary = { start_sec: number; end_sec: number };
type BoundaryResponse = { boundaries: RawBoundary[] };

async function callBoundariesOnce(
  targetMin: number,
  totalDurationSec: number,
  timestampedLines: string,
): Promise<RawBoundary[]> {
  const completion = await client().chat.completions.create({
    model: MODEL,
    temperature: 0,
    // GPT-4o's per-call output cap is 16,384 tokens. We sit just under
    // that — the boundaries-only JSON for a 3-hr lecture with 30 topics
    // is roughly 1.5 K tokens, but headroom prevents truncation if the
    // model decides to be more granular.
    max_tokens: 16000,
    messages: [
      {
        role: "system",
        content: boundariesPrompt(targetMin, totalDurationSec),
      },
      { role: "user", content: boundariesUserPrompt(timestampedLines) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "boundaries_response",
        strict: true,
        schema: BOUNDARY_SCHEMA,
      },
    },
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw Object.assign(new Error("AI returned empty content"), {
      code: "E_OPENAI_RESPONSE",
    });
  }
  let parsed: BoundaryResponse;
  try {
    parsed = JSON.parse(raw) as BoundaryResponse;
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
  if (!Array.isArray(parsed.boundaries)) {
    throw Object.assign(new Error("Missing boundaries array"), {
      code: "E_OPENAI_RESPONSE",
    });
  }
  return parsed.boundaries;
}

// ---------------------------------------------------------------------------
// Pass 2 — titling. Each chunk is shown to GPT WITH ITS ACTUAL TEXT, so
// the model can only title from what's physically in that chunk. This
// structurally prevents the title/content drift seen with single-pass.
// ---------------------------------------------------------------------------

const TITLES_SCHEMA = {
  type: "object",
  required: ["chunks"],
  additionalProperties: false,
  properties: {
    chunks: {
      type: "array",
      items: {
        type: "object",
        required: ["idx", "topic", "preview"],
        additionalProperties: false,
        properties: {
          idx: { type: "number" },
          topic: { type: "string" },
          preview: { type: "string" },
        },
      },
    },
  },
} as const;

function titlesPrompt(): string {
  return `You write topic titles and previews for lecture chunks. You will receive an array of chunks, each with its actual transcript text. Your job is to identify EVERY major concept inside each chunk and produce a title + preview that reflects ALL of them.

CRITICAL — SCAN THE FULL CHUNK BEFORE TITLING:
A chunk often contains multiple distinct concepts in sequence (e.g. constants, then primitive types, then dynamic typing). Do NOT title the chunk based only on the first sub-topic you read. Read the WHOLE chunk text first, list every major concept the speaker teaches, and put all of them into the title.

EXAMPLES OF DRIFT TO AVOID:
✗ Chunk text covers: separating JS from HTML → Node execution → variables intro
   Bad title: "Separating JavaScript from HTML" (misses Node and variables)
   Good title: "Separating JS from HTML, Running with Node, Variables Intro"
✗ Chunk text covers: const keyword → primitive types → dynamic typing
   Bad title: "Declaring Variables with let and const" (misses types and dynamic typing)
   Good title: "Constants, Primitive Types, and Dynamic Typing"

GUIDELINES:
- Use specific terminology FROM the transcript. If the transcript says "dot notation" and "bracket notation", the title should use those words verbatim.
- Each chunk is independent. Do NOT make titles "flow" sequentially. Each title stands alone, derived from its own text.
- The title MUST describe what the chunk's text ACTUALLY contains. NEVER generate plausible-sounding titles based on what JS courses typically cover.

FOR EACH CHUNK:
- topic: 5–12 words, Title Case. Name EVERY distinct major concept in the chunk, separated by commas or "and". If there are 3+ concepts, list the top 2-3 and use a unifying phrase.
  ✓ "Constants, Primitive Types, and Dynamic Typing"
  ✓ "Separating JS from HTML, Running with Node"
  ✓ "What JavaScript Is and Where It Runs"
  ✓ "Functions: Parameters, Arguments, and Return Values"
  ✗ "Introduction" (generic — what's the chunk introducing?)
  ✗ "Variables" (when chunk also covers types and typing — misleading)
  ✗ "JavaScript Basics" (uninformative)
- preview: ONE concrete sentence (≤ 28 words). LIST the chunk's main concepts in the order they appear in the text. Use terminology from the actual transcript.
  ✓ "Covers the const keyword for immutable bindings, the five primitive types (string, number, boolean, undefined, null), and how variable types change at runtime."
  ✗ "Learn about JavaScript variables and other things." (vague — gives no real info)

PROCESS BEFORE WRITING:
1. Read the full chunk text from start to finish.
2. List every distinct concept the speaker teaches (e.g. "concept A: const keyword", "concept B: primitive types", "concept C: dynamic typing").
3. Confirm the title mentions all of them.
4. Confirm the preview lists them in order.

OUTPUT:
- JSON: { "chunks": [{ "idx": 0, "topic": "...", "preview": "..." }, ...] }
- Output one entry per input chunk, in input order, idx matching the input idx.`;
}

type SliceForTitling = {
  idx: number;
  startSec: number;
  endSec: number;
  text: string;
};

type TitleResponse = {
  chunks: Array<{ idx: number; topic: string; preview: string }>;
};

function clampPreviewText(text: string, maxChars = 32000): string {
  // We need GPT to see the FULL chunk text to title accurately — chunks
  // often contain multiple sub-topics, and an 8K truncation made the
  // titler describe only the first sub-topic and miss the rest.
  // 32K chars ≈ 8K tokens per chunk; with ~6-10 chunks per lecture the
  // total input stays well within GPT-4o's 128K context.
  if (text.length <= maxChars) return text;
  // For ultra-long chunks, sample BOTH ends so the titler doesn't only
  // see the start (which caused the original drift bug).
  const head = Math.floor(maxChars * 0.55);
  const tail = maxChars - head - 20;
  return (
    text.slice(0, head) +
    "\n\n[…middle truncated…]\n\n" +
    text.slice(text.length - tail)
  );
}

async function callTitlesOnce(
  slices: SliceForTitling[],
): Promise<Array<{ idx: number; topic: string; preview: string }>> {
  // Pretty-format the user message so GPT can clearly distinguish chunks.
  const userBody = slices
    .map(
      (s) =>
        `--- Chunk ${s.idx} (${mmss(s.startSec)}–${mmss(s.endSec)}) ---\n` +
        clampPreviewText(s.text),
    )
    .join("\n\n");

  const completion = await client().chat.completions.create({
    model: MODEL,
    temperature: 0.2, // tiny bit of creativity for naming
    // 20+ chunks × ~110 tokens each ≈ 2.2 K tokens — clipped at 2000
    // truncated the JSON mid-string. Bump to GPT-4o's 16 K output max.
    max_tokens: 16000,
    messages: [
      { role: "system", content: titlesPrompt() },
      {
        role: "user",
        content: `Title and preview each chunk below, using ONLY the words within each.

${userBody}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "titles_response",
        strict: true,
        schema: TITLES_SCHEMA,
      },
    },
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw Object.assign(new Error("AI returned empty content"), {
      code: "E_OPENAI_RESPONSE",
    });
  }
  let parsed: TitleResponse;
  try {
    parsed = JSON.parse(raw) as TitleResponse;
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
  if (!Array.isArray(parsed.chunks)) {
    throw Object.assign(new Error("Missing chunks array"), {
      code: "E_OPENAI_RESPONSE",
    });
  }
  return parsed.chunks;
}

// ---------------------------------------------------------------------------
// Retry wrappers (shared between both passes)
// ---------------------------------------------------------------------------

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
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
      if (code === "E_OPENAI_RESPONSE" && attempt > 0) break;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1) ** 2));
    }
  }
  // Preserve E_OPENAI_RESPONSE so callers can react to truncation
  // (e.g. retry with a smaller input) instead of seeing it as a generic
  // network failure.
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
      `${label} failed after retries: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    ),
    { code: "E_OPENAI_NETWORK" },
  );
}

// ---------------------------------------------------------------------------
// Boundary normalisation (shared)
// ---------------------------------------------------------------------------

function normalizeBoundaries(
  raw: RawBoundary[],
  totalDurationSec: number,
): RawBoundary[] {
  const valid = raw
    .filter(
      (c) =>
        Number.isFinite(c.start_sec) &&
        Number.isFinite(c.end_sec) &&
        c.end_sec > c.start_sec,
    )
    .map((c) => ({ ...c }));

  valid.sort((a, b) => a.start_sec - b.start_sec);
  if (valid.length === 0) return [];

  // Clamp endpoints to lecture bounds.
  valid[0].start_sec = 0;
  valid[valid.length - 1].end_sec = totalDurationSec;

  // Close gaps + overlaps.
  for (let i = 0; i < valid.length - 1; i++) {
    const cur = valid[i];
    const next = valid[i + 1];
    if (next.start_sec !== cur.end_sec) {
      const mid = (cur.end_sec + next.start_sec) / 2;
      cur.end_sec = mid;
      next.start_sec = mid;
    }
  }

  // Drop chunks shorter than 30s by absorbing into the previous chunk.
  const result: RawBoundary[] = [];
  for (const c of valid) {
    const last = result[result.length - 1];
    if (c.end_sec - c.start_sec < 30 && last) {
      last.end_sec = c.end_sec;
    } else {
      result.push(c);
    }
  }
  if (result.length >= 2 && result[0].end_sec - result[0].start_sec < 30) {
    result[1].start_sec = result[0].start_sec;
    result.shift();
  }

  return result;
}

/**
 * Enforce a hard duration cap on every chunk. If a single topic chunk is
 * longer than `maxSec`, slice it into N equal-length parts where
 * N = ceil(duration / maxSec). This keeps every part ≤ maxSec while
 * spreading the content evenly — no stunted 5-min tail for a 45-min topic
 * at target=20.
 *
 * Examples (target = 20 min):
 *   45 min → 3 × 15 min
 *   50 min → 3 × 16.67 min
 *   60 min → 3 × 20 min
 *   70 min → 4 × 17.5 min
 */
function enforceMaxDuration(
  boundaries: RawBoundary[],
  maxSec: number,
): RawBoundary[] {
  const out: RawBoundary[] = [];
  for (const b of boundaries) {
    const duration = b.end_sec - b.start_sec;
    if (duration <= maxSec) {
      out.push(b);
      continue;
    }
    const n = Math.ceil(duration / maxSec);
    const partLen = duration / n;
    for (let i = 0; i < n; i += 1) {
      const start = b.start_sec + i * partLen;
      // Snap the last part to b.end_sec exactly to avoid float drift.
      const end = i === n - 1 ? b.end_sec : b.start_sec + (i + 1) * partLen;
      out.push({ start_sec: start, end_sec: end });
    }
  }
  return out;
}

/**
 * Slice each chunk's actual transcript text + word count from the source
 * words array. This is what Step 6 (Render) sends to HeyGen, AND what we
 * send to pass 2 for titling.
 */
function attachTextSlices(
  boundaries: RawBoundary[],
  words: WordEntry[],
): Omit<SegmentChunk, "topic" | "preview">[] {
  let wordIdx = 0;
  const out: Omit<SegmentChunk, "topic" | "preview">[] = [];

  for (const c of boundaries) {
    const sliceWords: string[] = [];
    let count = 0;
    while (wordIdx < words.length && words[wordIdx].start < c.start_sec) {
      wordIdx++;
    }
    while (wordIdx < words.length && words[wordIdx].start < c.end_sec) {
      sliceWords.push(words[wordIdx].word.trim());
      count++;
      wordIdx++;
    }
    const text = sliceWords
      .join(" ")
      .replace(/\s+([.,!?;:])/g, "$1")
      .trim();
    out.push({
      startSec: Math.round(c.start_sec),
      endSec: Math.round(c.end_sec),
      wordCount: count,
      text,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main entry — two-pass orchestration.
// ---------------------------------------------------------------------------

export type ChunkProgress = {
  pass: "boundaries" | "titles";
  percent: number;
};

export async function segmentTranscript(params: {
  cleanedWords: WordEntry[];
  targetMin: number;
  totalDurationSec: number;
  onProgress?: (p: ChunkProgress) => Promise<void> | void;
}): Promise<SegmentResult> {
  const { cleanedWords, targetMin, totalDurationSec, onProgress } = params;

  if (cleanedWords.length === 0) {
    return { chunks: [], totalWordCount: 0 };
  }

  const timestamped = buildTimestampedLines(cleanedWords);

  // ----- Pass 1: boundaries -----
  const rawBoundaries = await withRetry("boundaries", () =>
    callBoundariesOnce(targetMin, totalDurationSec, timestamped),
  );
  const normalized = normalizeBoundaries(rawBoundaries, totalDurationSec);

  // Enforce the hard duration cap. Topic-driven boundaries can produce a
  // single chunk that's, say, 50 minutes long — render plans top out at
  // ~targetMin per chunk, so we slice anything bigger into back-to-back
  // parts. The titler in Pass 2 then names each part separately based on
  // its own text, so a 50-min topic naturally becomes "Variables, Part 1"
  // / "Variables, Part 2" / etc.
  const capped = enforceMaxDuration(normalized, targetMin * 60);
  await onProgress?.({ pass: "boundaries", percent: 50 });

  if (capped.length === 0) {
    return { chunks: [], totalWordCount: 0 };
  }

  // Slice text from the source word array against the post-cap ranges.
  const sliced = attachTextSlices(capped, cleanedWords);

  // ----- Pass 2: titles -----
  const titleInput: SliceForTitling[] = sliced.map((s, i) => ({
    idx: i,
    startSec: s.startSec,
    endSec: s.endSec,
    text: s.text,
  }));
  const titles = await withRetry("titles", () => callTitlesOnce(titleInput));
  await onProgress?.({ pass: "titles", percent: 100 });

  // Stitch boundaries + titles by idx. If GPT skipped any (rare), fall back
  // to placeholder titles so the run still produces something usable.
  const titlesByIdx = new Map<
    number,
    { topic: string; preview: string }
  >();
  for (const t of titles) {
    titlesByIdx.set(t.idx, {
      topic: t.topic.trim(),
      preview: t.preview.trim(),
    });
  }

  const chunks: SegmentChunk[] = sliced.map((s, i) => {
    const t = titlesByIdx.get(i);
    return {
      ...s,
      topic: t?.topic || `Chunk ${i + 1}`,
      preview: t?.preview || "",
    };
  });

  return {
    chunks,
    totalWordCount: chunks.reduce((sum, c) => sum + c.wordCount, 0),
  };
}
