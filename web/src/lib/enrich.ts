import OpenAI from "openai";

// ─── Per-chunk enrichment AGENT (Pass 4 of Step 5) ──────────────────────
//
// Turns ONE split topic chunk into a "perfect technical script" through a
// 4-pass agent loop that REVIEWS the cleaned transcript, identifies which
// concepts the instructor was thin on, ADDS grounded technical content,
// VERIFIES every addition against the original transcript, and ASSEMBLES
// the final continuous narration.
//
// PASS 1 — REVIEW. Read the transcript and emit a structured inventory of
//   the sub-topics covered + every concept the instructor mentioned, each
//   anchored to an exact instructor quote with a completeness rating
//   (thin / partial / full). Concept ids become the only legal anchors for
//   later passes.
//
// PASS 2 — ENRICH. For each concept rated thin or partial, generate ONE
//   addition (a precise definition / mechanism explanation / clarifying
//   example) bound to that concept's id. Cannot introduce a concept that
//   wasn't in the Pass 1 inventory.
//
// PASS 3 — VERIFY. Adversarial self-review. For each Pass 2 addition,
//   judge whether it stays grounded to its concept's instructor quote
//   without inventing specifics. Each addition gets a boolean verdict.
//
// PASS 4 — ASSEMBLE. Write the final continuous narration in the
//   instructor's sub-topic order. May only use (a) the instructor's
//   teaching, paraphrased for clarity, plus (b) ACCEPTED additions woven
//   in at the relevant sub-topic.
//
// STRICT GROUNDING mode (the only mode for now): every addition must be
// anchored to a Pass 1 concept. Adjacent-but-unmentioned textbook context
// is NOT allowed.
//
// Best-effort: callers MUST wrap calls in try/catch. On throw, the caller
// stores enrichmentStatus="failed" and Step 6 falls back to `chunk.text`.
//
// CONTRACT FOR STEP 6 (HEYGEN): send `chunk.enrichedText ?? chunk.text`.

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

// How many sub-topic Assemble calls to run in parallel. Tune with
// ENRICH_CONCURRENCY env var. Default 4 — modest enough to stay under
// tier-1 rate limits even on long chunks with 8+ sub-topics.
const ENRICH_CONCURRENCY = Math.max(
  1,
  Math.min(6, Number(process.env.ENRICH_CONCURRENCY) || 4),
);

// Public types ───────────────────────────────────────────────────────────

/**
 * Kept for backward compatibility with already-saved enrichmentSources
 * data on disk + DB rows. New runs never produce these; the field is
 * always [] in the EnrichmentResult below.
 */
export type EnrichmentSource = {
  url: string;
  title: string;
  snippet: string;
};

export type EnrichmentResult = {
  enrichedText: string;
  /** Always [] under the GPT-only design. Kept for API shape stability. */
  sources: EnrichmentSource[];
};

// ─── Shared helpers ────────────────────────────────────────────────────

const HARD_RULES = `HARD ANTI-HALLUCINATION RULES (never break):
- NO fabricated specifics: no invented numbers, benchmarks, dates, version
  numbers, percentages, or statistics.
- NO made-up code, commands, API names, function signatures, or library
  names the instructor did not show.
- NO new named tools, libraries, products, or people the instructor did
  not mention (a generic widely-known example is fine; a specific product
  claim is not).
- NO putting words in the instructor's mouth about their own demo/project.
- Only stable, consensus, textbook-level facts. If unsure, leave it out.
- Plain spoken prose ONLY — no markdown, headings, bullets, or citations.`;

/**
 * GPT-4o occasionally leaks a JSON wrapper or stray braces into a string
 * field. Strip them so the avatar never speaks "narration" / braces aloud.
 */
function stripLeakedJson(s: string): string {
  let out = s;
  const wrapped = /\{\s*"[a-zA-Z_]+"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  out = out.replace(wrapped, (_m, inner: string) => {
    try {
      return JSON.parse(`"${inner}"`);
    } catch {
      return inner;
    }
  });
  out = out.replace(/\{\s*"[a-zA-Z_]+"\s*:\s*"?/g, "").replace(/"\s*\}/g, "");
  return out.trim();
}

// Pull OpenAI's "Please try again in N.NNNs" hint out of a 429 error.
// OpenAI's SDK surfaces the wait either in the error MESSAGE
// ("Rate limit reached … Please try again in 4.916s.") or in the
// `retry-after-ms` / `retry-after` response headers. We check both,
// take whichever is longer, and clamp to a sensible upper bound so a
// runaway header doesn't wedge the runner for minutes.
function parseOpenAiRetryAfterMs(err: unknown): number {
  const e = err as {
    message?: string;
    headers?: Record<string, string | undefined>;
  } | null;
  let waitMs = 0;
  const msg = e?.message ?? "";
  // "Please try again in 4.916s." OR "in 4ms" / "in 1.2s" / "in 1m20s"
  const secMatch = /try again in ([\d.]+)\s*s/i.exec(msg);
  const msMatch = /try again in ([\d.]+)\s*ms/i.exec(msg);
  if (msMatch) waitMs = Math.max(waitMs, Number(msMatch[1]));
  else if (secMatch) waitMs = Math.max(waitMs, Number(secMatch[1]) * 1000);
  const hRetryMs = Number(e?.headers?.["retry-after-ms"]);
  const hRetrySec = Number(e?.headers?.["retry-after"]);
  if (Number.isFinite(hRetryMs) && hRetryMs > 0) waitMs = Math.max(waitMs, hRetryMs);
  else if (Number.isFinite(hRetrySec) && hRetrySec > 0) waitMs = Math.max(waitMs, hRetrySec * 1000);
  if (waitMs <= 0) waitMs = 5_000; // sensible default when OpenAI didn't say
  // Cap at 60s — we'd rather fail than wedge the runner indefinitely on a
  // mis-parsed retry-after.
  return Math.min(waitMs, 60_000);
}

async function callJson<T>(params: {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
}): Promise<T> {
  // Generic-error attempt budget. 429s do NOT consume this budget — they
  // get their own delay-and-resume cycle since they're recoverable and
  // we want the runner to wait OpenAI's TPM window out rather than fail.
  // Cap the cumulative 429-wait at 5 min so the runner can't hang forever
  // on a permanently broken account quota.
  const MAX_NON_429_ATTEMPTS = 3;
  const MAX_429_WAIT_MS = 5 * 60_000;
  let lastErr: unknown = null;
  let total429WaitMs = 0;
  let attempt = 0;
  while (attempt < MAX_NON_429_ATTEMPTS) {
    try {
      const completion = await client().chat.completions.create({
        model: MODEL,
        temperature: params.temperature ?? 0.2,
        max_tokens: params.maxTokens,
        messages: [
          { role: "system", content: params.system },
          { role: "user", content: params.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: params.schemaName,
            strict: true,
            schema: params.schema,
          },
        },
      });
      const raw = completion.choices[0]?.message?.content;
      if (!raw) throw new Error("empty content");
      return JSON.parse(raw) as T;
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
      // Rate-limit (TPM/RPM): respect OpenAI's wait hint and resume
      // without consuming the non-429 attempt budget. Each enrichment
      // call may legitimately wait the cooldown out several times during
      // a heavy re-segmentation.
      if (status === 429) {
        const waitMs = parseOpenAiRetryAfterMs(err) + 500; // +500ms safety buffer
        if (total429WaitMs + waitMs > MAX_429_WAIT_MS) {
          throw Object.assign(
            new Error(
              `Enrichment hit OpenAI rate limit for over ${Math.round(MAX_429_WAIT_MS / 1000)}s total — bump OpenAI tier or lower ENRICH_CONCURRENCY.`,
            ),
            { code: "E_OPENAI_RATE_LIMIT" },
          );
        }
        console.warn(
          `[enrich] OpenAI 429 — waiting ${Math.round(waitMs)}ms (cumulative ${Math.round((total429WaitMs + waitMs) / 1000)}s)`,
        );
        total429WaitMs += waitMs;
        await new Promise((r) => setTimeout(r, waitMs));
        // Do NOT increment attempt — 429 isn't a "failed attempt".
        continue;
      }
      attempt++;
      if (attempt < MAX_NON_429_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500 * attempt ** 2));
      }
    }
  }
  throw Object.assign(
    new Error(
      `Enrichment call failed after retries: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    ),
    { code: "E_OPENAI_RESPONSE" },
  );
}

// ─── PASS 1 — REVIEW ────────────────────────────────────────────────────
// Read the cleaned transcript and emit a structured inventory.

type Concept = {
  id: string;
  sub_topic_id: string;
  term: string;
  instructor_quote: string;
  completeness: "thin" | "partial" | "full";
};

type SubTopic = {
  id: string;
  title: string;
  instructor_summary: string;
};

type Review = {
  sub_topics: SubTopic[];
  concepts: Concept[];
};

const REVIEW_SCHEMA = {
  type: "object",
  required: ["sub_topics", "concepts"],
  additionalProperties: false,
  properties: {
    sub_topics: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "instructor_summary"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          instructor_summary: { type: "string" },
        },
      },
    },
    concepts: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "sub_topic_id", "term", "instructor_quote", "completeness"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          sub_topic_id: { type: "string" },
          term: { type: "string" },
          instructor_quote: { type: "string" },
          completeness: {
            type: "string",
            enum: ["thin", "partial", "full"],
          },
        },
      },
    },
  },
} as const;

async function reviewTranscript(
  topic: string,
  text: string,
  contextHint?: string,
): Promise<Review> {
  const ctx = contextHint
    ? `\nBROADER COURSE CONTEXT: ${contextHint}`
    : "";
  const system = `You are the REVIEW pass of an enrichment agent. Read the lecture
transcript for ONE topic and emit a structured inventory. This inventory is
the ONLY thing later passes are allowed to reference — any concept not
listed here will be rejected by the verify pass.

What to emit:
- sub_topics: ORDERED list of distinct sub-topics the instructor actually
  covers within this topic. Use stable ids like "s1", "s2". Each carries a
  short instructor_summary describing what the instructor said about it.
- concepts: every distinct concept, term, mechanism, formula, or named
  pattern the instructor mentions. Use stable ids "c1", "c2", etc. Each
  concept has:
    · sub_topic_id pointing at its parent sub_topic
    · term: the canonical name of the concept
    · instructor_quote: a SHORT verbatim phrase from the transcript that
      mentions this concept (the anchor — must be findable in the source)
    · completeness:
        "thin"    — only mentioned by name, almost no explanation
        "partial" — partially explained but missing key details
        "full"    — instructor gave a complete definition + example

Rules:
- Base everything on the transcript. Do NOT invent concepts the instructor
  did not raise.
- Skip non-teaching noise (audio checks, comprehension checks, banter).
- Use the instructor's own terminology in 'term' (you may add a canonical
  form in parentheses if the instructor was imprecise — e.g.
  "civil score (CIBIL score)").
- BE COMPREHENSIVE. A substantive 10-15 min chunk usually has 4-8
  distinct sub-topics and 8-20 concepts. Every worked example, every
  named pattern, every formal definition is a concept. Capture them all
  — the later passes can only narrate what you list here. Under-listing
  means under-narration. Err toward LISTING MORE sub-topics rather than
  fewer; the assembly step can always merge if needed but cannot
  re-discover content you skipped.
- A "sub-topic" is a distinct teaching unit: a single definition, a
  single worked example, a single comparison, a single multi-step
  walkthrough. If the instructor switches example or shifts framing,
  that's a NEW sub-topic.

${HARD_RULES}

Return JSON matching the schema.`;
  const user = `LESSON TOPIC: ${topic}${ctx}

TRANSCRIPT:
${text}`;
  return await callJson<Review>({
    system,
    user,
    schemaName: "review_inventory",
    schema: REVIEW_SCHEMA,
    maxTokens: 3000,
  });
}

// ─── PASS 2 — ENRICH ────────────────────────────────────────────────────
// For each thin/partial concept, generate one grounded addition.

type Addition = {
  id: string;
  concept_id: string;
  type: "definition" | "mechanism" | "example" | "clarification";
  content: string;
};

type EnrichResult = { additions: Addition[] };

const ENRICH_SCHEMA = {
  type: "object",
  required: ["additions"],
  additionalProperties: false,
  properties: {
    additions: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "concept_id", "type", "content"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          concept_id: { type: "string" },
          type: {
            type: "string",
            enum: ["definition", "mechanism", "example", "clarification"],
          },
          content: { type: "string" },
        },
      },
    },
  },
} as const;

async function generateAdditions(
  topic: string,
  text: string,
  review: Review,
  contextHint?: string,
): Promise<EnrichResult> {
  const targets = review.concepts.filter(
    (c) => c.completeness === "thin" || c.completeness === "partial",
  );
  if (targets.length === 0) return { additions: [] };

  const ctx = contextHint
    ? `\nBROADER COURSE CONTEXT: ${contextHint}`
    : "";
  const system = `You are the ENRICH pass of an enrichment agent. The REVIEW pass
already produced a concept inventory. For each "thin" or "partial" concept,
write ONE addition that completes it with grounded technical content.

STRICT GROUNDING (hard rules — Pass 3 will reject violations):
- Every addition's concept_id MUST equal one of the ids in the inventory.
  You may NOT invent a new concept_id.
- Every addition must be a textbook-level, well-established explanation of
  the SAME concept the instructor mentioned. You may NOT pivot to a related
  but different topic.
- An addition may be:
    · type="definition"  — a precise, canonical definition of the term
    · type="mechanism"   — how/why the thing works
    · type="example"     — a widely-known example that illustrates THIS
                          concept (not a similar one)
    · type="clarification" — clarifies a phrasing the instructor used
      loosely (e.g. instructor said "civil score" → clarification states
      this is CIBIL score, a credit score in India)
- One addition per concept, no more.
- Content is plain prose, 1-4 sentences.
- If a "thin" concept is too vague to deepen safely without inventing
  specifics, SKIP it. Better to under-add than to drift.

${HARD_RULES}

Return JSON: { "additions": [...] }`;

  const inventoryJson = JSON.stringify(
    { targets, sub_topics: review.sub_topics },
    null,
    2,
  );
  const user = `LESSON TOPIC: ${topic}${ctx}

TRANSCRIPT (for grounding):
${text}

CONCEPT INVENTORY (only these concept_ids are legal targets):
${inventoryJson}

Write one addition per concept_id where the concept is thin or partial.
Skip the rest. Skip any you can't deepen without inventing specifics.`;

  return await callJson<EnrichResult>({
    system,
    user,
    schemaName: "enrichment_additions",
    schema: ENRICH_SCHEMA,
    maxTokens: 4000,
    temperature: 0.3,
  });
}

// ─── PASS 3 — VERIFY ────────────────────────────────────────────────────
// Adversarial self-review of every addition.

type Verdict = {
  addition_id: string;
  accepted: boolean;
  reason: string;
};

type VerifyResult = { verdicts: Verdict[] };

const VERIFY_SCHEMA = {
  type: "object",
  required: ["verdicts"],
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["addition_id", "accepted", "reason"],
        additionalProperties: false,
        properties: {
          addition_id: { type: "string" },
          accepted: { type: "boolean" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

async function verifyAdditions(
  topic: string,
  text: string,
  review: Review,
  enrich: EnrichResult,
): Promise<VerifyResult> {
  if (enrich.additions.length === 0) return { verdicts: [] };
  const system = `You are the VERIFY pass of an enrichment agent. Adversarially
review each addition produced by the ENRICH pass. Default to REJECT
unless the addition clearly passes every check.

REJECT (accepted=false) when ANY of these are true:
- The addition's concept_id does not exist in the review inventory.
- The addition introduces a concept, named tool, library, product, or
  person not in the instructor's transcript.
- The addition invents specific numbers, benchmarks, dates, version
  numbers, percentages, code, API names, or function signatures the
  instructor did not show.
- The addition drifts from the original concept (e.g. instructor mentions
  RAG, addition discusses fine-tuning instead).
- The addition contradicts what the instructor said.
- The addition uses non-textbook, speculative, or contested material.
- The addition contains markdown, citations, headings, or bullets.

ACCEPT (accepted=true) only when the addition:
- Is grounded in the exact concept its concept_id points at.
- Adds canonical textbook-level technical content (definition, mechanism,
  widely-known example, or terminology clarification).
- Stays well within the safe zone above.

Return one verdict per addition, with a 1-line 'reason'. Be skeptical.`;

  const user = `LESSON TOPIC: ${topic}

TRANSCRIPT (the ground truth — what the instructor actually said):
${text}

REVIEW INVENTORY (legal concept_ids and their instructor quotes):
${JSON.stringify(review.concepts, null, 2)}

ADDITIONS TO REVIEW:
${JSON.stringify(enrich.additions, null, 2)}

Emit one verdict per addition.`;

  return await callJson<VerifyResult>({
    system,
    user,
    schemaName: "addition_verdicts",
    schema: VERIFY_SCHEMA,
    maxTokens: 2500,
    temperature: 0,
  });
}

// ─── PASS 4 — ASSEMBLE (per-sub-topic) ──────────────────────────────────
// Each sub-topic gets its own narration call so the output can't be
// summarized away — each section is constrained to a target word range and
// can only paraphrase the sub-topic's instructor content + weave in
// accepted additions for that sub-topic. Sections concatenate into the
// final continuous script.
//
// A single-shot "write the whole narration" pass produced ~200 words for a
// 1,400-word source (it summarized). Per-section forces ~300-450 words
// each × N sub-topics, so a 4-sub-topic chunk lands ~1,200-1,800 words —
// the same range the old 2-pass enricher produced when it was working.

const ASSEMBLE_SCHEMA = {
  type: "object",
  required: ["narration"],
  additionalProperties: false,
  properties: { narration: { type: "string" } },
} as const;

async function assembleSubTopicSection(params: {
  topic: string;
  text: string;
  subTopic: SubTopic;
  concepts: Concept[];
  additions: Addition[];
  contextHint?: string;
}): Promise<string> {
  const { topic, text, subTopic, concepts, additions, contextHint } = params;
  const ctx = contextHint
    ? `\nBROADER COURSE CONTEXT: ${contextHint}`
    : "";

  const system = `You are writing ONE section of a continuous spoken lesson
narration that an AI avatar will read. This section covers the sub-topic
given below.

COMPLETENESS RULE (most important): retell EVERY distinct point, claim,
analogy, walkthrough step, and example the instructor delivered for this
sub-topic. Do NOT summarize — re-tell. If the instructor used a bank-
cashier example, narrate the whole example. If they walked through three
steps, walk through all three. Output length naturally reflects how much
the instructor said: a sub-topic where the instructor was thorough lands
around 400-500 words; a sub-topic where they were brief lands around
250-350 words. The right length is the length that covers everything.

Allowed content (no other source):
  1. The instructor's teaching FROM THE TRANSCRIPT that pertains to this
     sub-topic — paraphrased for clarity and grammatical flow, BUT keep
     every distinct point/example/walkthrough the instructor delivered for
     this sub-topic. Do not summarize away worked examples.
  2. The ACCEPTED ADDITIONS listed below — woven in naturally where they
     fit alongside the instructor's content (not appended as a postscript).

Hard rules:
- Do NOT introduce content outside (1) and (2). No new examples,
  definitions, tools, numbers, or pivots.
- Do NOT contradict the instructor. Where the instructor was informally
  correct, preserve their meaning.
- This is a mid-lesson section: write as continuous prose. Do NOT add
  "in this section" / "to summarize" / headings / bullets / markdown.
- Plain spoken prose only.
- ALWAYS finish your last sentence. The avatar will narrate this script
  verbatim and a mid-thought ending sounds broken. Never end with a
  comma, "and", "but", a colon, or an incomplete clause. The final
  character must be a period, question mark, or exclamation mark.
- If you start a case scenario, EXAMPLE, or worked walkthrough, finish
  it completely — setup, action, and outcome — before moving on. Do
  not abandon an example halfway. If you do not have room to complete
  a second example, omit it entirely rather than truncate.

${HARD_RULES}

Return JSON: { "narration": "..." }`;

  const user = `LESSON TOPIC: ${topic}${ctx}

SUB-TOPIC: ${subTopic.title}
INSTRUCTOR'S SUMMARY OF THIS SUB-TOPIC (from the review pass):
${subTopic.instructor_summary}

CONCEPTS IN THIS SUB-TOPIC (with their instructor quotes — find their
content in the transcript below):
${JSON.stringify(concepts, null, 2)}

ACCEPTED ADDITIONS FOR THIS SUB-TOPIC (weave in naturally — these passed
the verify pass and are grounded to the concepts above):
${JSON.stringify(additions, null, 2)}

FULL TRANSCRIPT (find the parts that belong to this sub-topic):
${text}

Write the narration for this sub-topic now (280-450 words, continuous
prose).`;

  const res = await callJson<{ narration: string }>({
    system,
    user,
    schemaName: "subtopic_narration",
    schema: ASSEMBLE_SCHEMA,
    maxTokens: 2000,
    temperature: 0.3,
  });
  return stripLeakedJson((res.narration ?? "").trim());
}

async function assembleNarration(
  topic: string,
  text: string,
  review: Review,
  acceptedAdditions: Addition[],
  contextHint?: string,
): Promise<string> {
  // Index accepted additions + concepts by sub-topic id.
  const conceptToSubTopic = new Map<string, string>();
  for (const c of review.concepts) conceptToSubTopic.set(c.id, c.sub_topic_id);
  const additionsBySubTopic = new Map<string, Addition[]>();
  for (const a of acceptedAdditions) {
    const sid = conceptToSubTopic.get(a.concept_id);
    if (!sid) continue;
    const arr = additionsBySubTopic.get(sid) ?? [];
    arr.push(a);
    additionsBySubTopic.set(sid, arr);
  }
  const conceptsBySubTopic = new Map<string, Concept[]>();
  for (const c of review.concepts) {
    const arr = conceptsBySubTopic.get(c.sub_topic_id) ?? [];
    arr.push(c);
    conceptsBySubTopic.set(c.sub_topic_id, arr);
  }

  // Bounded-parallel narration of every sub-topic, preserving order.
  const sections: string[] = new Array(review.sub_topics.length).fill("");
  for (
    let start = 0;
    start < review.sub_topics.length;
    start += ENRICH_CONCURRENCY
  ) {
    const batch = review.sub_topics.slice(start, start + ENRICH_CONCURRENCY);
    const results = await Promise.all(
      batch.map((subTopic) =>
        assembleSubTopicSection({
          topic,
          text,
          subTopic,
          concepts: conceptsBySubTopic.get(subTopic.id) ?? [],
          additions: additionsBySubTopic.get(subTopic.id) ?? [],
          contextHint,
        }),
      ),
    );
    for (let j = 0; j < results.length; j++) sections[start + j] = results[j];
  }

  return sections
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// ─── Main entry ──────────────────────────────────────────────────────────

/**
 * Run the 4-pass enrichment agent on one cleaned-transcript chunk.
 *
 * STRICT GROUNDING: every addition is anchored to a concept the instructor
 * actually mentioned. Adjacent textbook context that the instructor did
 * not raise is rejected by Pass 3 and never lands in the final output.
 *
 * Errors thrown:
 *   - E_OPENAI_AUTH      — OPENAI_API_KEY missing / rejected
 *   - E_OPENAI_RESPONSE  — a pass failed after retries
 */
export async function enrichChunk(params: {
  topic: string;
  text: string;
  contextHint?: string;
}): Promise<EnrichmentResult> {
  const { topic, text, contextHint } = params;
  if (!text || !text.trim()) {
    return { enrichedText: "", sources: [] };
  }

  // Pass 1 — REVIEW
  const review = await reviewTranscript(topic, text, contextHint);
  if (review.sub_topics.length === 0) {
    // Nothing to enrich (all banter or empty). Return the cleaned text.
    return { enrichedText: text.trim(), sources: [] };
  }

  // Pass 2 — ENRICH
  const enrich = await generateAdditions(topic, text, review, contextHint);

  // Pass 3 — VERIFY (adversarial). Skipped when no additions to judge.
  const conceptIds = new Set(review.concepts.map((c) => c.id));
  // Mechanically reject additions whose concept_id isn't in the inventory
  // BEFORE asking the verify pass — guarantees a hard floor.
  const legalAdditions = enrich.additions.filter((a) =>
    conceptIds.has(a.concept_id),
  );
  const verify =
    legalAdditions.length > 0
      ? await verifyAdditions(
          topic,
          text,
          review,
          { additions: legalAdditions },
        )
      : { verdicts: [] };
  const acceptedIds = new Set(
    verify.verdicts.filter((v) => v.accepted).map((v) => v.addition_id),
  );
  const accepted = legalAdditions.filter((a) => acceptedIds.has(a.id));

  // Pass 4 — ASSEMBLE
  const narration = await assembleNarration(
    topic,
    text,
    review,
    accepted,
    contextHint,
  );

  // Observability — useful in dev logs to see how many additions survived.
  console.log(
    `[enrich] topic="${topic.slice(0, 40)}" subTopics=${review.sub_topics.length} concepts=${review.concepts.length} proposed=${enrich.additions.length} accepted=${accepted.length} narrationLen=${narration.length}`,
  );

  return { enrichedText: narration, sources: [] };
}
