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
  | "falsestart"
  | "social"
  | "discussion";

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
              "social",
              "discussion",
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
    standard: "filler, falsestart, admin, tangent, social",
    aggressive:
      "filler, falsestart, admin, tangent, recap, redundant, social, discussion",
  };

  // Tone hint per level. Light errs heavily on the side of keep; aggressive
  // is allowed to remove every non-teaching span, including Socratic Q&A
  // and student-instructor discussion blocks. The output should read like
  // a polished tutorial monologue.
  const tone: Record<CleanLevel, string> = {
    light:
      "Be VERY conservative. Remove only obvious verbal stumbles. If a phrase has any teaching value, KEEP IT.",
    standard:
      "Balanced editing. Remove housekeeping and clear off-topic asides, but preserve all instructional content.",
    aggressive:
      "EXTRACT-ONLY-TECHNICAL mode. The source is a recorded live online class with massive amounts of non-teaching chatter. The DEFAULT BEHAVIOR IS TO REMOVE. The output must read like a polished written textbook chapter — only the instructor's continuous monologues delivering definitions, derivations, worked examples, code walkthroughs, and analogies survive. Every other utterance — audio checks, reconnect noise, screen-share coordination, roll call, comprehension checks, Socratic questions, student responses, compliments, debug interludes, end-of-session housekeeping, future-session planning, goodbyes — gets removed. When you cannot decide whether a span is teaching or not, REMOVE IT. False negatives (kept noise) are worse than false positives (lost content) at this level.",
  };

  return `You clean instructional lecture transcripts by identifying spans the listener should NOT hear. The source is often a RECORDED LIVE ONLINE CLASS, so the raw transcript contains a lot of non-teaching meta-conversation that the final viewer should never hear: audio checks, reconnect chatter, roll call, student questions and responses, apologies for technical issues, pleasantries between instructor and students. Your job is to surface those spans so the backend can drop them, leaving ONLY the instructor's actual teaching.

CATEGORIES (use ONLY these):
- filler — "um/uh/like/you know", stutters, hesitations
- falsestart — incomplete or restarted sentences
- admin — class housekeeping AND tech/audio/screen coordination. Includes:
    · schedule + assignment notes ("submit by Friday", "let me check the time")
    · roll call / attendance ("is everyone here", "let me wait 2 more minutes")
    · audio checks ("can you hear me", "is my mic working", "is the audio okay")
    · screen-share coordination ("can you see my screen", "let me zoom in", "is this visible")
    · connection / reconnect noise ("internet issue", "I had to reconnect", "did you hear that part", "should I repeat")
    · platform talk ("the recording started", "I'll post this on the LMS")
- tangent — off-topic anecdotes, side conversations, jokes unrelated to the topic
- social — pleasantries and interpersonal exchanges that aren't teaching:
    · greetings + farewells ("hi everyone", "see you tomorrow", "good morning")
    · apologies / thanks ("sorry for the delay", "thanks for joining", "appreciate the patience")
    · acknowledgements ("yeah okay", "right right", "got it", "no problem")
    · instructor compliments to students ("excellent", "very nice", "very well articulated", "perfect", "good answer", "nice nice")
    · roll-call by name ("Amiska, are you there", "any other members? Money, Rakesh, Abhigna?")
- discussion — Socratic Q&A and student-instructor dialogue blocks. AT AGGRESSIVE LEVEL, treat the WHOLE Q&A block as removable, even when student answers contain partially-correct technical content. The instructor will (or already has) deliver the proper definition elsewhere — the discussion itself doesn't belong in a polished tutorial. Includes:
    · instructor prompts that solicit student input ("how do you define X?", "tell me what is an agent", "can we discuss any example?", "would you like to define X?", "any other definitions?", "can someone give me a real-life example?")
    · student attempts and partial definitions, even when they contain technical words
    · instructor recaps of student answers ("so you're saying it's a smart assistant", "very well articulated")
    · comprehension checks ("is it clear or not clear?", "any doubts?", "clear?", "tell me why?", "got it?")
    · short alternating turns where multiple speakers throw definitions or examples back and forth
- recap — explicit "as I told you before…" repetition of already-covered material
- redundant — clearly restated content within the same paragraph

NEVER REMOVE:
- definitions, derivations, worked examples
- code, syntax, commands, technical terminology, equations
- instructional transitions that introduce content ("now let's look at…", "the next thing is…")
- analogies or examples that illustrate the concept
- the instructor's ANSWER to a student's question, when that answer contains technical content (the question itself can go under social if it's just "any doubts?", but the answer stays)
- anything where the speaker is teaching, explaining, or demonstrating

EXAMPLES (good vs. bad removals):

Example 1 — KEEP (instructional transition):
  "[03:21] Now let's look at how variables work in JavaScript."
  → DO NOT remove. Transition into teaching content.

Example 2 — REMOVE (filler):
  "[03:24] So, um, you know, like a variable is, uh, a container."
  → Remove "um, you know, like" and "uh" — keep the definition.
  → category: filler

Example 3 — REMOVE (admin: live-class tech check):
  "[00:12] Yeah, I can hear you well now. Sorry for asking you to repeat this third time, but there was an internet issue."
  → Remove the whole span.
  → category: admin  reason: audio check + connection apology

Example 4 — REMOVE (social: roll call / acknowledgement):
  "[01:05] I'm in the first row, I was able to hear good. Yeah okay, good morning everyone."
  → Remove the whole span. None of this is teaching.
  → category: social  reason: roll call response and greeting

Example 5 — REMOVE (admin: screen-share coordination):
  "[14:30] Can you all see my screen? Let me zoom in a bit. Is this visible at the back?"
  → Remove the whole span.
  → category: admin  reason: screen-share coordination

Example 6 — REMOVE (social: student banter that adds no content):
  "[22:10] Rahul, are you there? Yeah good. Okay, anyone else have a question? No? Alright."
  → Remove the whole span.
  → category: social  reason: student check-in, no instructional content

Example 7 — REMOVE WHOLE Q&A BLOCK at aggressive (discussion):
  Instructor: "[18:00] How do you define something as an agent? Tell me."
  Student A:  "[18:05] It acts and learns and observes."
  Instructor: "[18:09] Nice nice. Any other definition friends?"
  Student B:  "[18:13] Agent is like a smart assistant that can think and act on its own."
  Instructor: "[18:18] Excellent, very well articulated. Any other members?"
  Student C:  "[18:23] The chatbot that books a flight, it's an agent."
  Instructor: "[18:27] Excellent, that is also one of the best examples."
  → REMOVE the ENTIRE block 18:00–18:30. The instructor will deliver the
    actual definition right after this. Even the student answers, even the
    technical-sounding ones, are part of a Socratic dialogue that doesn't
    belong in a polished tutorial.
  → category: discussion  reason: Socratic Q&A on agent definition

Example 8 — KEEP (the instructor's authoritative definition that follows):
  "[18:30] Mug up this word: autonomous. An agent is an autonomous, goal-driven component which uses memory and reasoning capability to take decisions."
  → KEEP. This is the instructor's actual teaching content.

Example 9 — REMOVE (admin: live-class screen-share + reconnect):
  "[02:40] I'm sorry friend, I'm back. Can you hear me well now? Okay, now I'm on desktop, not laptop. Let me share my screen and we will take the steps further. Hold on. Let me know when you can see Visual Studio. Can you see my Visual Studio screen now?"
  → Remove the whole span. Pure live-class meta.
  → category: admin  reason: reconnect + screen-share coordination

Example 10 — REMOVE (discussion: comprehension check):
  "[35:14] Is it clear or not clear? Clear? Any doubts? Tell me why."
  → Remove the whole span.
  → category: discussion  reason: comprehension check

Example 11 — REMOVE (admin: assignment / scheduling):
  "[12:05] Before we continue, the assignment is due Friday at 5 pm. Submit on the LMS."
  → Remove. category: admin

Example 12 — KEEP at standard, REMOVE at aggressive (recap):
  "[28:10] As I mentioned earlier, JavaScript is dynamic, meaning..."
  → "As I mentioned earlier" is a recap signal. At aggressive, remove the full restatement; at standard, keep it (the listener may have skipped).

Example 13 — KEEP (analogy, not tangent):
  "[15:40] Think of an object like a box with labelled compartments."
  → DO NOT remove. Analogies illustrating the concept ARE teaching content.

Example 14 — KEEP (worked example, even if it sounds informal):
  "[25:00] Suppose I am trying to withdraw money from my bank account. I have a 10,000 balance and I tell the cashier, please give me 15,000. The cashier will not give me the money because the cashier has the knowledge to check the balance. This is reasoning capability."
  → KEEP. This is a worked example illustrating the concept of reasoning. Even though the instructor uses informal phrasing, the content is teaching.

Example 15 — REMOVE (admin: end-of-session homework / mock-interview chatter):
  "[88:20] If you do not have any difficulties, can you tell me if you have any challenges in practicing interview questions? Many members have written complex interview questions. How are you understanding it? Can we have some mock interview starting next week?"
  → Remove the entire span. End-of-session housekeeping, no teaching content.
  → category: admin

Example 16 — REMOVE (admin: debug interlude / postponement):
  "[80:00] So one moment, let me see the version actually. So I have 1.9.7. This should be okay. This is a 2.6 so I am on the latest version. I will check on this part and get back to you actually on this environment. I will have that list ready for you tomorrow."
  → Remove the whole span. Instructor stopped teaching to debug an environment issue and postponed it. Nothing the listener can learn from.
  → category: admin  reason: debug interlude + postponement

Example 17 — REMOVE (admin: future-session planning + goodbyes):
  "[91:50] Then let us take a pause for today and we will meet tomorrow at 9:30. Sure okay thanks friends. Thank you. Hello, can you hear me? Yes sir. Okay, if you have any doubts let me know. Thank you so much."
  → Remove the entire span. Pure end-of-session housekeeping + goodbyes.
  → category: admin  reason: session close + goodbyes

Example 18 — REMOVE (discussion: instructor recapping student answer):
  "[18:00] Perfect and very nice very well articulated. Any other members? Money, Rakesh, Abhigna, would you like to define what is an agent based on your understanding?"
  → Remove. Pure compliment + roll call.
  → category: discussion  reason: compliment and roll call after student answer

Example 19 — KEEP (continuous teaching monologue, multi-sentence definition):
  "[20:00] Mug up this word: autonomous. An agent is an autonomous goal-driven component which uses memory and reasoning capability. Autonomous means self-growing, self-learning, self-operating. Goal-driven means it has certain benchmarks to recognize whether the output is correct or incorrect — if incorrect, feedback cycle improves it; if correct, maintain. Memory means the conversation memory and the context being passed. Reasoning capability is how the agent fixes the decision based on rules and context."
  → KEEP. Continuous instructor monologue delivering the definition.

Example 20 — KEEP (worked example with multiple agents):
  "[45:00] We will have a customer support agent. Its role is to collect customer details and documents. Then a document validator agent that verifies the documents and does eKYC. Then a credit history agent that fetches the CIBIL score. Then a risk assessment agent that calculates risk from documents and score. Then a decision agent that approves or rejects the loan based on rules. Then a communication agent that tells the customer the status. Last, a compliance agent that ensures regulatory adherence."
  → KEEP. Continuous teaching monologue delivering the multi-agent example.

LIVE-CLASS RULE OF THUMB:
If a span only makes sense BECAUSE the class is happening live (audio coordination, reconnect noise, "are you all there", "should I move on"), it's removable. The polished avatar-narrated output should sound like a tutorial recording, not a Zoom call.

AGGRESSIVE-ONLY: SOCRATIC Q&A REMOVAL
If you see a clear pattern of:
  (a) instructor asking students to define / give an example ("how do you define X?", "can someone give me an example?", "tell me what is an agent")
  (b) followed by ONE OR MORE short responses with informal definitions or examples
  (c) followed by instructor compliments ("excellent", "nice", "very well articulated")
  (d) eventually followed by the instructor's own authoritative explanation
…REMOVE (a)(b)(c) — keep only (d). Even when student answers contain technically correct words, they're not the polished teaching content the final viewer should hear. The instructor's monologue in (d) carries the actual lesson.

SESSION BOUNDARIES (AGGRESSIVE — REMOVE):
Live-class recordings always have non-teaching content at the start AND end of the file. REMOVE these aggressively:

OPENING (typically the first 1-3 minutes — REMOVE):
  · "Can you hear me?", "Is my audio working?", "I had an internet issue"
  · Reconnect noise: "I'm back", "Sorry I had to switch from laptop to desktop"
  · Roll call: "Are we all here?", "Amiska, did I need to repeat?"
  · Greetings: "Hi everyone, good morning"
  · Recap pings: "Did you go through the recordings? Any difficulties?"

CLOSING (typically the last 1-3 minutes — REMOVE):
  · Future session planning: "We'll meet tomorrow at 9:30", "Let's take a pause for today"
  · Mock interview / homework chatter: "How are you working on interview questions?", "Any difficulties in generators or decorators?"
  · Off-topic Q&A: "What about FastAPI?", "Are you practicing?"
  · Debug postponements: "I'll check this and get back to you tomorrow", "Let me fix the version and show you a working example"
  · Goodbyes: "Thank you", "See you tomorrow", "Hello can you hear me?", "Take care", multiple "thank you"s in sequence

DEBUG / SETUP INTERLUDES (REMOVE):
When the instructor stops teaching to fix a technical problem (wrong package version, missing variable, broken code), those minutes are NOT teaching content. Examples:
  · "I'm getting this error, let me check the version"
  · "One moment, let me see the environment"
  · "This is a 2.6, looks like the latest. Let me debug."
  · "I'll have a list ready for you tomorrow"
  → All REMOVE (category: admin) UNLESS the instructor narrates a debugging technique that's itself the lesson.

DEFAULT BIAS FOR LIVE-CLASS RECORDINGS AT AGGRESSIVE:
DEFAULT IS REMOVE. The only spans that survive are continuous instructor monologues delivering teaching content. Specifically, KEEP when ALL of these are true:
  · ≥ 3 sentences of the instructor speaking continuously
  · Content is a definition, derivation, worked example, code walkthrough, analogy, or step-by-step demonstration
  · The listener could learn the topic from the span without context from removed surrounding turns

REMOVE when ANY of these are true:
  · Short turns alternating between speakers (≤ 2 sentences each)
  · Instructor compliments / acknowledgements ("excellent", "nice", "very well articulated", "perfect")
  · Comprehension checks ("clear?", "any doubts?", "tell me why?", "got it?")
  · Audio / screen / connection talk
  · Roll call or addressing students by name
  · Future-session planning, mock-interview talk, homework discussions
  · Debug interludes where the lesson is not actually being delivered
  · Goodbyes, greetings, thank-yous
  · Socratic Q&A blocks even when student answers contain technical words

STRICTNESS LEVEL: ${level}
${tone[level]}
For this run, only emit segments whose category is one of: ${allowed[level]}.
${
  level === "aggressive"
    ? "AT AGGRESSIVE: when in doubt, REMOVE. The output must read like a single instructor's polished written tutorial. The reader should never know this came from a live class."
    : 'If a span doesn\'t clearly fit one of those categories at this level, DO NOT remove it. When in doubt, KEEP IT — but for live-class recordings at standard, be willing to remove every meta-conversation span you can clearly attribute to admin or social.'
}

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
