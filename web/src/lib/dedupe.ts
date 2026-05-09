import OpenAI from "openai";

// Same singleton pattern as cleaner.ts / segmenter.ts so auth errors map
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

// Inputs ----------------------------------------------------------------------

export type CandidateChunk = {
  // Stable identifier the caller can map back to its own row.
  // Sibling chunks pass their DB id; new chunks pass their pre-insert idx
  // serialized as a string ("new:<idx>"). The dedup function is agnostic.
  id: string;
  topic: string;
  preview: string;
  // Optional richer context — first N words of the chunk's transcript.
  // The titler already produced topic + preview so this is usually
  // unnecessary; we include it only when the caller wants higher recall.
  textHead?: string;
};

export type DedupMatch = {
  // Index into the `newChunks` array passed in.
  newIdx: number;
  // Id of the canonical sibling this new chunk duplicates. References
  // CandidateChunk.id from the `siblingChunks` array.
  canonicalId: string;
  // Short reason GPT-4o gave for the match — shown in the UI tooltip.
  reason: string;
};

// Output schema --------------------------------------------------------------

const DEDUP_SCHEMA = {
  type: "object",
  required: ["matches"],
  additionalProperties: false,
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        required: ["new_idx", "canonical_id", "reason"],
        additionalProperties: false,
        properties: {
          new_idx: { type: "number" },
          canonical_id: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

type DedupResponse = {
  matches: Array<{ new_idx: number; canonical_id: string; reason: string }>;
};

// Prompts --------------------------------------------------------------------

function dedupPrompt(): string {
  return `You compare topic chunks from multiple lecture videos in the same playlist or course and identify duplicates.

GOAL:
You will be given two lists of chunks:
- SIBLINGS: canonical chunks from earlier videos in this course. Each has an id.
- NEW: chunks from the video being segmented right now. Each has a numeric index.

For every NEW chunk that covers the SAME TOPIC as a SIBLING chunk, emit one match: { new_idx, canonical_id, reason }.

WHAT COUNTS AS THE SAME TOPIC (be strict):
- Both chunks teach the same concept, skill, or definition.
- Same subject AND same level of detail. ("Intro to variables" vs "Variable scoping rules" are NOT duplicates — different sub-topics.)
- The titles describe substantively the same content. Surface-level wording differences are fine if the substance is identical.
- Examples of TRUE duplicates:
  ✓ "What is JavaScript" / "Introduction to JavaScript" (same scope, same content)
  ✓ "Declaring Variables with let and const" / "Variables: let, const, and var" (same scope)
  ✓ "Linear Regression Loss Function" / "MSE Loss for Linear Regression" (same concept named two ways)
- Examples that are NOT duplicates:
  ✗ "Variables" vs "Variable Scoping" (one is intro, the other is a sub-topic — keep both)
  ✗ "Functions" vs "Higher-Order Functions" (different scope — keep both)
  ✗ "Loops" vs "While Loops" (specific is a sub-topic of general — keep both)

WHEN UNSURE: do NOT flag a duplicate. False negatives (missing a duplicate) are MUCH cheaper than false positives (hiding unique content the user paid to record).

REASON FIELD:
- 6 to 14 words.
- Name what's the same. Example: "Both cover the JavaScript const keyword and immutability."
- Do NOT say "they look similar" — say WHAT is the same.

OUTPUT:
- JSON: { "matches": [{ "new_idx": 2, "canonical_id": "<sibling-id>", "reason": "..." }, ...] }
- Empty matches array is valid and common.
- One NEW chunk can match AT MOST ONE sibling — if it could match several, pick the closest.
- Do NOT include a NEW chunk in matches if it has no clear duplicate among siblings.`;
}

function userBody(siblings: CandidateChunk[], newChunks: CandidateChunk[]): string {
  const sibBlock = siblings.length
    ? siblings
        .map(
          (s) =>
            `- id="${s.id}"\n  topic: ${s.topic}\n  preview: ${s.preview}`,
        )
        .join("\n")
    : "(none — no sibling videos have been segmented yet)";

  const newBlock = newChunks
    .map(
      (n, i) =>
        `- new_idx=${i}\n  topic: ${n.topic}\n  preview: ${n.preview}`,
    )
    .join("\n");

  return `SIBLINGS (canonical chunks from earlier videos):
${sibBlock}

NEW (chunks from the video being segmented now):
${newBlock}`;
}

// Main entry -----------------------------------------------------------------

/**
 * Compare a video's freshly-segmented chunks against canonical chunks from
 * sibling videos in the same playlist/batch, and return a list of duplicate
 * matches.
 *
 * BEST-EFFORT: callers must wrap this in try/catch and treat any thrown
 * error as "no duplicates found." A dedup failure should never fail the
 * surrounding segmentation step. The whole point is graceful degradation —
 * the user always gets their chunks; cross-video dedup is a nice-to-have.
 *
 * Returns an empty array when:
 * - siblings is empty (first video in the playlist)
 * - newChunks is empty
 * - GPT returns no matches
 */
export async function findDuplicates(params: {
  newChunks: CandidateChunk[];
  siblingChunks: CandidateChunk[];
}): Promise<DedupMatch[]> {
  const { newChunks, siblingChunks } = params;

  if (newChunks.length === 0 || siblingChunks.length === 0) {
    return [];
  }

  const completion = await client().chat.completions.create({
    model: MODEL,
    temperature: 0,
    // Output is small (one line per match, usually 0-5 matches per video).
    // 4K is generous headroom even on a 50-video course.
    max_tokens: 4000,
    messages: [
      { role: "system", content: dedupPrompt() },
      { role: "user", content: userBody(siblingChunks, newChunks) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "dedup_response",
        strict: true,
        schema: DEDUP_SCHEMA,
      },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw Object.assign(new Error("AI returned empty content"), {
      code: "E_OPENAI_RESPONSE",
    });
  }

  let parsed: DedupResponse;
  try {
    parsed = JSON.parse(raw) as DedupResponse;
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
  if (!Array.isArray(parsed.matches)) {
    throw Object.assign(new Error("Missing matches array"), {
      code: "E_OPENAI_RESPONSE",
    });
  }

  const validSiblingIds = new Set(siblingChunks.map((s) => s.id));
  // Defensive: drop any match where GPT hallucinated an id or out-of-range
  // new_idx. Belt-and-suspenders even with strict json_schema.
  const out: DedupMatch[] = [];
  const seenNewIdx = new Set<number>();
  for (const m of parsed.matches) {
    if (
      typeof m.new_idx !== "number" ||
      !Number.isInteger(m.new_idx) ||
      m.new_idx < 0 ||
      m.new_idx >= newChunks.length
    ) {
      continue;
    }
    if (seenNewIdx.has(m.new_idx)) continue; // one canonical per new chunk
    if (!validSiblingIds.has(m.canonical_id)) continue;
    if (typeof m.reason !== "string" || !m.reason.trim()) continue;
    seenNewIdx.add(m.new_idx);
    out.push({
      newIdx: m.new_idx,
      canonicalId: m.canonical_id,
      reason: m.reason.trim().slice(0, 300),
    });
  }
  return out;
}
