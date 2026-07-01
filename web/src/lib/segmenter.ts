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

// ─────────────────────────────────────────────────────────────────────────
// HIERARCHICAL SEGMENTATION — Sun ▸ Planet ▸ Moon
// ─────────────────────────────────────────────────────────────────────────
//
// The segmenter produces a 3-level outline of the lecture:
//
//   ☀️ Sun    — top-level core concept, ≈ targetMin minutes. Navigation
//               only; not rendered as an avatar video.
//   🪐 Planet — render unit (≈ targetMin / 3.5 minutes). One planet
//               ↔ one HeyGen avatar video. Dedup + enrich operate
//               at this level only.
//   🌙 Moon   — optional sub-section inside a planet (1–3 min). Shown
//               as a chapter marker within the planet's script; not
//               its own video.
//
// Two-pass GPT-4o, mirrors the anti-drift discipline of the prior flat
// segmenter:
//   Pass 1 — nested boundaries only (no titles)
//   Pass 2 — title every node based on its own text
//
// After Pass 1 we apply a planet-level hard cap (`enforcePlanetMaxDuration`)
// that slices any planet longer than `targetMin × 60` seconds into
// equal-length parts within the same sun, so HeyGen videos never exceed
// the user's preferred chunk size.

export type WordEntry = { word: string; start: number; end: number };

export type SegmentMoon = {
  topic: string;
  preview: string;
  startSec: number;
  endSec: number;
  text: string;
  wordCount: number;
};

export type SegmentPlanet = {
  topic: string;
  preview: string;
  startSec: number;
  endSec: number;
  // Planet's own text — the cleaned-words slice that will be the avatar
  // script (subject to enrichment downstream). When `moons.length > 0`
  // this is the concatenation of moons' text in order; otherwise it's
  // the raw slice for the planet's range.
  text: string;
  wordCount: number;
  moons: SegmentMoon[];
};

export type SegmentSun = {
  topic: string;
  preview: string;
  startSec: number;
  endSec: number;
  // Suns have no `text` of their own — they're navigation labels.
  planets: SegmentPlanet[];
};

export type SegmentResult = {
  suns: SegmentSun[];
  // Sum of leaf word counts (planet.wordCount where there are no moons,
  // moon.wordCount summed otherwise). Mirrors the previous shape so
  // the segment route's totalWordCount stat keeps working.
  totalWordCount: number;
};

// ─────────────────────────────────────────────────────────────────────────
// Pass 1 — nested boundaries
// ─────────────────────────────────────────────────────────────────────────

const BOUNDARY_SCHEMA = {
  type: "object",
  required: ["suns"],
  additionalProperties: false,
  properties: {
    suns: {
      type: "array",
      items: {
        type: "object",
        required: ["start_sec", "end_sec", "planets"],
        additionalProperties: false,
        properties: {
          start_sec: { type: "number" },
          end_sec: { type: "number" },
          planets: {
            type: "array",
            items: {
              type: "object",
              required: ["start_sec", "end_sec", "moons"],
              additionalProperties: false,
              properties: {
                start_sec: { type: "number" },
                end_sec: { type: "number" },
                moons: {
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
            },
          },
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
  const planetTarget = Math.max(180, Math.round(targetMin * 60 * 0.3));
  const planetSplitAbove = Math.round(targetMin * 60 * 1.0);
  const moonTargetMin = 60;
  const moonTargetMax = 180;

  return `You split instructional lecture transcripts into a THREE-LEVEL OUTLINE: ☀️ suns ▸ 🪐 planets ▸ 🌙 moons. In this PASS, your job is BOUNDARIES ONLY — do not title or summarise anything.

THE THREE LEVELS:

☀️ SUN — top-level core concept (≈ ${targetMin} min each).
   A sun is one major chapter of the lecture: a self-contained body
   of teaching the instructor would naturally introduce as "now we'll
   talk about X". Examples: "Foundations of Agentic AI", "Building a
   Loan Approval Workflow", "Production Concerns and Cost".

🪐 PLANET — sub-topic inside a sun (≈ ${Math.round(planetTarget / 60)} min each).
   Each planet is ONE concrete teaching unit that can stand alone as
   a 5–10 min micro-lesson. Use cases, scenarios, worked examples,
   case studies. Examples within a sun: "Banking Use Case",
   "E-commerce Use Case", "Failure Modes", "Cost Optimisation".

🌙 MOON — sub-section inside a planet (≈ ${moonTargetMin}–${moonTargetMax} sec each).
   Moons exist ONLY when a planet has clear internal divisions:
   debugging walk-through, interview question, code demo, Q&A
   block, sub-example. If a planet is one continuous narrative,
   emit moons: [] for that planet. NOT every planet has moons.

PROCESS:
1. Read the whole transcript.
2. Identify the suns first (the major chapters).
3. Within each sun, identify planets (the use cases / scenarios).
4. Within each planet, decide: does it have clear sub-sections
   that the listener would benefit from as chapter markers? If
   yes, emit moons. If no, emit moons: [].

SOFT HINTS (NOT HARD CONSTRAINTS):
- Sun ≈ ${targetMin} min. Don't force a sun to be exactly that long;
  prefer real topic shifts. The total lecture is ${totalMin} min, so
  expect roughly ${Math.max(1, Math.round(totalMin / targetMin))} suns.
- Planet ≈ ${Math.round(planetTarget / 60)} min. If a planet exceeds
  ${Math.round(planetSplitAbove / 60)} min, look for a clean
  sub-boundary and split into two planets.
- Moon between ${moonTargetMin} and ${moonTargetMax} seconds.

HARD RULES:
- The first sun's start_sec MUST equal 0.
- The last sun's end_sec MUST equal ${totalDurationSec}.
- Suns MUST be contiguous: suns[i].end_sec === suns[i+1].start_sec.
- For each sun: its planets MUST exactly cover the sun's range
  (planets[0].start_sec === sun.start_sec, planets[-1].end_sec ===
  sun.end_sec, planets contiguous within the sun).
- For each planet with non-empty moons: moons MUST exactly cover
  the planet's range (same contiguity rule).
- For each planet with empty moons: moons must be [] (not omitted,
  not [{}]).
- Each sun MUST be at least 60 seconds long.
- Each planet MUST be at least 30 seconds long.
- Each moon MUST be at least 20 seconds long.
- All times in seconds. The transcript uses [mm:ss] — convert
  manually: mm*60 + ss.

WHAT COUNTS AS A NEW SUN:
- Major topic shift signalled by closing one chapter and opening
  another ("so that's how X works. Now let's talk about Y").
- Big pivots in subject matter even without explicit cues.
- A new mental model or framework introduction.

WHAT COUNTS AS A NEW PLANET (within a sun):
- A new concrete example, use case, scenario, or case study.
- A pivot from theory to demo or vice versa, both teaching the
  same broader topic.
- A self-contained worked example with its own setup and resolution.

WHAT COUNTS AS A NEW MOON (within a planet):
- A discrete sub-section: debugging walk-through, common error,
  interview question, code reveal, side derivation, edge-case Q&A.

WHAT IS NOT A NEW BOUNDARY (do NOT cut here):
- Mid-derivation, mid-example, mid-equation.
- Within a single demo or worked example.
- Inside an enumeration ("first… second… third…").
- A side comment that doesn't introduce a new concept.

OUTPUT:
- Return JSON: { "suns": [{ "start_sec", "end_sec", "planets": [...] }, ...] }
- No titles. No previews. Boundaries only.`;
}

function boundariesUserPrompt(timestampedLines: string): string {
  return `Here is the timestamped cleaned transcript. Identify the three-level outline per the rules above.

${timestampedLines}`;
}

type RawMoon = { start_sec: number; end_sec: number };
type RawPlanet = { start_sec: number; end_sec: number; moons: RawMoon[] };
type RawSun = { start_sec: number; end_sec: number; planets: RawPlanet[] };
type BoundaryResponse = { suns: RawSun[] };

async function callBoundariesOnce(
  targetMin: number,
  totalDurationSec: number,
  timestampedLines: string,
): Promise<RawSun[]> {
  const completion = await client().chat.completions.create({
    model: MODEL,
    temperature: 0,
    // 16 K output is generous headroom — even a 3-hr lecture with 6
    // suns × 5 planets × 3 moons (= 90 nodes) of pure boundaries is
    // <3 K tokens.
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
  if (!Array.isArray(parsed.suns)) {
    throw Object.assign(new Error("Missing suns array"), {
      code: "E_OPENAI_RESPONSE",
    });
  }
  return parsed.suns;
}

// ─────────────────────────────────────────────────────────────────────────
// Pass 2 — titles for every node in the tree
// ─────────────────────────────────────────────────────────────────────────

const TITLES_SCHEMA = {
  type: "object",
  required: ["suns"],
  additionalProperties: false,
  properties: {
    suns: {
      type: "array",
      items: {
        type: "object",
        required: ["idx", "topic", "preview", "planets"],
        additionalProperties: false,
        properties: {
          idx: { type: "number" },
          topic: { type: "string" },
          preview: { type: "string" },
          planets: {
            type: "array",
            items: {
              type: "object",
              required: ["idx", "topic", "preview", "moons"],
              additionalProperties: false,
              properties: {
                idx: { type: "number" },
                topic: { type: "string" },
                preview: { type: "string" },
                moons: {
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
            },
          },
        },
      },
    },
  },
} as const;

function titlesPrompt(): string {
  return `You write topic titles and previews for a three-level lecture outline (☀️ suns ▸ 🪐 planets ▸ 🌙 moons). You will receive the full tree with each node's actual transcript text. Title every node based ONLY on what its text contains.

CRITICAL — SCAN THE FULL NODE TEXT BEFORE TITLING:
A node often contains multiple distinct concepts in sequence. Read the WHOLE text, identify every major concept the speaker teaches in that span, and put them all into the title. NEVER generate plausible-sounding titles based on what courses typically cover — only on what's physically in the text.

PER LEVEL GUIDANCE:

☀️ SUN — title ≤ 14 words, Title Case. Names the big chapter / area.
   ✓ "Foundations of Agentic AI: Definitions and Examples"
   ✓ "Building a Multi-Agent Loan Approval Workflow"
   ✗ "Introduction" (generic)
   ✗ "Module 1" (uninformative)
   preview: ONE concrete sentence (≤ 32 words) summarising what the
   listener will learn across all the planets in this sun.

🪐 PLANET — title 5–12 words, Title Case. Names the concrete sub-topic.
   ✓ "Banking Use Case: Cashier Withdrawal Decisioning"
   ✓ "E-commerce: Cart Summary Agent with DSPy"
   ✓ "Functions: Parameters, Arguments, and Return Values"
   ✗ "Use Case" (vague — which one?)
   ✗ "Variables" (when chunk also covers types — misleading)
   preview: ONE concrete sentence (≤ 28 words) listing the planet's
   main concepts in the order they appear in the text.

🌙 MOON — title 3–8 words. Short, action-oriented or descriptive.
   ✓ "Debugging the Permission Boundary Issue"
   ✓ "Interview Question: Map vs For Loop"
   ✓ "Setting Up the DSPy Predictor"
   ✗ "Notes" (uninformative)
   preview: ONE concrete sentence (≤ 22 words) describing what
   happens in this sub-section.

GUIDELINES (ALL LEVELS):
- Use specific terminology FROM the transcript. If the transcript says "DSPy" and "predict module", use those words verbatim.
- Each node is independent. Do NOT make titles "flow" sequentially — each title stands alone.
- The title MUST describe what the node's text ACTUALLY contains.
- Even when a sub-topic appears in multiple planets, title each planet from its OWN text — don't unify them.

OUTPUT:
- JSON matching the input tree shape:
  {
    "suns": [
      {
        "idx": 0,
        "topic": "...",
        "preview": "...",
        "planets": [
          {
            "idx": 0,
            "topic": "...",
            "preview": "...",
            "moons": [{ "idx": 0, "topic": "...", "preview": "..." }, ...]
          }
        ]
      }
    ]
  }
- Output one entry per input node, in input order, idx matching the input idx.
- Empty moons array stays empty.`;
}

type SliceForTitling = {
  suns: Array<{
    idx: number;
    startSec: number;
    endSec: number;
    planets: Array<{
      idx: number;
      startSec: number;
      endSec: number;
      text: string;
      moons: Array<{
        idx: number;
        startSec: number;
        endSec: number;
        text: string;
      }>;
    }>;
  }>;
};

type TitleMoon = { idx: number; topic: string; preview: string };
type TitlePlanet = {
  idx: number;
  topic: string;
  preview: string;
  moons: TitleMoon[];
};
type TitleSun = {
  idx: number;
  topic: string;
  preview: string;
  planets: TitlePlanet[];
};
type TitleResponse = { suns: TitleSun[] };

function clampPreviewText(text: string, maxChars = 12000): string {
  // Tighter cap than the old single-pass titler since we're now sending
  // the full tree (many nodes) in one call. 12 K chars per leaf × ~30
  // leaves still fits well under GPT-4o's 128 K context.
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.55);
  const tail = maxChars - head - 20;
  return (
    text.slice(0, head) +
    "\n\n[…middle truncated…]\n\n" +
    text.slice(text.length - tail)
  );
}

async function callTitlesOnce(slices: SliceForTitling): Promise<TitleSun[]> {
  // Pretty-format the whole tree with its text. Sun headers list their
  // planets; each planet either includes its own slice text, or, when
  // it has moons, lists the moons with their slice text (the planet's
  // text in that case is the union of moons').
  const userBody = slices.suns
    .map((sun) => {
      const planetBlocks = sun.planets
        .map((p) => {
          if (p.moons.length === 0) {
            return [
              `   --- Planet ${sun.idx}.${p.idx} (${mmss(p.startSec)}–${mmss(p.endSec)}) ---`,
              clampPreviewText(p.text),
            ].join("\n");
          }
          const moonBlocks = p.moons
            .map(
              (m) =>
                `      --- Moon ${sun.idx}.${p.idx}.${m.idx} (${mmss(m.startSec)}–${mmss(m.endSec)}) ---\n${clampPreviewText(m.text)}`,
            )
            .join("\n\n");
          return `   --- Planet ${sun.idx}.${p.idx} (${mmss(p.startSec)}–${mmss(p.endSec)}) [has moons] ---\n${moonBlocks}`;
        })
        .join("\n\n");
      return `=== Sun ${sun.idx} (${mmss(sun.startSec)}–${mmss(sun.endSec)}) ===\n${planetBlocks}`;
    })
    .join("\n\n");

  const completion = await client().chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    max_tokens: 16000,
    messages: [
      { role: "system", content: titlesPrompt() },
      {
        role: "user",
        content: `Title every node in the tree below using ONLY the words within each node.

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
  if (!Array.isArray(parsed.suns)) {
    throw Object.assign(new Error("Missing suns array"), {
      code: "E_OPENAI_RESPONSE",
    });
  }
  return parsed.suns;
}

// ─────────────────────────────────────────────────────────────────────────
// Retry wrapper (shared)
// ─────────────────────────────────────────────────────────────────────────

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
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

// ─────────────────────────────────────────────────────────────────────────
// Boundary normalisation (tree-aware)
// ─────────────────────────────────────────────────────────────────────────

function normalizeRange(
  raw: { start_sec: number; end_sec: number }[],
  total: { start: number; end: number },
  minDurSec: number,
): { start_sec: number; end_sec: number }[] {
  const valid = raw
    .filter(
      (c) =>
        Number.isFinite(c.start_sec) &&
        Number.isFinite(c.end_sec) &&
        c.end_sec > c.start_sec,
    )
    .map((c) => ({ start_sec: c.start_sec, end_sec: c.end_sec }));
  valid.sort((a, b) => a.start_sec - b.start_sec);
  if (valid.length === 0) return [];
  // Clamp endpoints to the parent range.
  valid[0].start_sec = total.start;
  valid[valid.length - 1].end_sec = total.end;
  // Close gaps + overlaps by meeting in the middle.
  for (let i = 0; i < valid.length - 1; i++) {
    const cur = valid[i];
    const next = valid[i + 1];
    if (next.start_sec !== cur.end_sec) {
      const mid = (cur.end_sec + next.start_sec) / 2;
      cur.end_sec = mid;
      next.start_sec = mid;
    }
  }
  // Drop entries shorter than minDurSec by absorbing into previous.
  const out: { start_sec: number; end_sec: number }[] = [];
  for (const c of valid) {
    const last = out[out.length - 1];
    if (c.end_sec - c.start_sec < minDurSec && last) {
      last.end_sec = c.end_sec;
    } else {
      out.push(c);
    }
  }
  if (
    out.length >= 2 &&
    out[0].end_sec - out[0].start_sec < minDurSec
  ) {
    out[1].start_sec = out[0].start_sec;
    out.shift();
  }
  return out;
}

function normalizeTree(
  rawSuns: RawSun[],
  totalDurationSec: number,
): RawSun[] {
  const sunRanges = normalizeRange(
    rawSuns,
    { start: 0, end: totalDurationSec },
    60,
  );
  // Re-attach planets/moons to the normalised sun ranges by overlap.
  const attached: RawSun[] = sunRanges.map((sr) => {
    // Find original raw sun whose center falls inside this range.
    const center = (sr.start_sec + sr.end_sec) / 2;
    const orig =
      rawSuns.find(
        (s) => s.start_sec <= center && center <= s.end_sec,
      ) ?? rawSuns[0];
    const planetRanges = normalizeRange(
      orig.planets ?? [],
      { start: sr.start_sec, end: sr.end_sec },
      30,
    );
    const planets: RawPlanet[] = planetRanges.map((pr) => {
      const pcenter = (pr.start_sec + pr.end_sec) / 2;
      const origPlanet =
        (orig.planets ?? []).find(
          (p) => p.start_sec <= pcenter && pcenter <= p.end_sec,
        ) ?? null;
      const moonRanges = origPlanet
        ? normalizeRange(
            origPlanet.moons ?? [],
            { start: pr.start_sec, end: pr.end_sec },
            20,
          )
        : [];
      return {
        start_sec: pr.start_sec,
        end_sec: pr.end_sec,
        moons: moonRanges,
      };
    });
    return {
      start_sec: sr.start_sec,
      end_sec: sr.end_sec,
      planets,
    };
  });
  return attached;
}

/**
 * Slice any planet longer than `maxSec` into N equal-length parts within
 * the same sun. Mirrors the old `enforceMaxDuration` behaviour but for
 * planet level (suns can be larger than maxSec — they're navigation
 * groupings; only planets are render units).
 */
function enforcePlanetMaxDuration(suns: RawSun[], maxSec: number): RawSun[] {
  return suns.map((sun) => {
    const newPlanets: RawPlanet[] = [];
    for (const planet of sun.planets) {
      const dur = planet.end_sec - planet.start_sec;
      if (dur <= maxSec) {
        newPlanets.push(planet);
        continue;
      }
      const n = Math.ceil(dur / maxSec);
      const partLen = dur / n;
      for (let i = 0; i < n; i += 1) {
        const start = planet.start_sec + i * partLen;
        const end =
          i === n - 1
            ? planet.end_sec
            : planet.start_sec + (i + 1) * partLen;
        // Re-bucket moons that fall inside this part.
        const partMoons = (planet.moons ?? []).filter(
          (m) => m.start_sec >= start && m.end_sec <= end,
        );
        newPlanets.push({ start_sec: start, end_sec: end, moons: partMoons });
      }
    }
    return { ...sun, planets: newPlanets };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Text slicing — leaf-aware
// ─────────────────────────────────────────────────────────────────────────

function sliceText(words: WordEntry[], startSec: number, endSec: number): {
  text: string;
  wordCount: number;
} {
  let count = 0;
  const sliceWords: string[] = [];
  for (const w of words) {
    if (w.start < startSec) continue;
    if (w.start >= endSec) break;
    sliceWords.push(w.word.trim());
    count++;
  }
  const text = sliceWords
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
  return { text, wordCount: count };
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry — two-pass orchestration over the tree
// ─────────────────────────────────────────────────────────────────────────

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
    return { suns: [], totalWordCount: 0 };
  }

  const timestamped = buildTimestampedLines(cleanedWords);

  // ----- Pass 1: nested boundaries -----
  const rawSuns = await withRetry("boundaries", () =>
    callBoundariesOnce(targetMin, totalDurationSec, timestamped),
  );
  const normalised = normalizeTree(rawSuns, totalDurationSec);
  const capped = enforcePlanetMaxDuration(normalised, targetMin * 60);
  await onProgress?.({ pass: "boundaries", percent: 100 });

  if (capped.length === 0) {
    return { suns: [], totalWordCount: 0 };
  }

  // Slice text for every leaf node so Pass 2 can title from real text.
  const slicedForTitling: SliceForTitling = {
    suns: capped.map((sun, sunIdx) => ({
      idx: sunIdx,
      startSec: Math.round(sun.start_sec),
      endSec: Math.round(sun.end_sec),
      planets: sun.planets.map((p, pIdx) => {
        const planetSlice = sliceText(cleanedWords, p.start_sec, p.end_sec);
        return {
          idx: pIdx,
          startSec: Math.round(p.start_sec),
          endSec: Math.round(p.end_sec),
          text: planetSlice.text,
          moons: p.moons.map((m, mIdx) => {
            const moonSlice = sliceText(cleanedWords, m.start_sec, m.end_sec);
            return {
              idx: mIdx,
              startSec: Math.round(m.start_sec),
              endSec: Math.round(m.end_sec),
              text: moonSlice.text,
            };
          }),
        };
      }),
    })),
  };

  // ----- Pass 2: title every node -----
  const titles = await withRetry("titles", () =>
    callTitlesOnce(slicedForTitling),
  );
  await onProgress?.({ pass: "titles", percent: 100 });

  // Build a quick lookup map by path (sunIdx[.planetIdx[.moonIdx]]).
  type TitlePayload = { topic: string; preview: string };
  const titleByPath = new Map<string, TitlePayload>();
  for (const sun of titles) {
    titleByPath.set(`${sun.idx}`, {
      topic: sun.topic.trim(),
      preview: sun.preview.trim(),
    });
    for (const p of sun.planets) {
      titleByPath.set(`${sun.idx}.${p.idx}`, {
        topic: p.topic.trim(),
        preview: p.preview.trim(),
      });
      for (const m of p.moons) {
        titleByPath.set(`${sun.idx}.${p.idx}.${m.idx}`, {
          topic: m.topic.trim(),
          preview: m.preview.trim(),
        });
      }
    }
  }
  const fallback = (path: string, depth: number) => ({
    topic: depth === 0 ? `Sun ${path}` : depth === 1 ? `Planet ${path}` : `Moon ${path}`,
    preview: "",
  });

  // Stitch boundaries + titles + text into the final SegmentResult tree.
  const suns: SegmentSun[] = capped.map((sun, sunIdx) => {
    const sunTitle =
      titleByPath.get(`${sunIdx}`) ?? fallback(`${sunIdx + 1}`, 0);
    const planets: SegmentPlanet[] = sun.planets.map((p, pIdx) => {
      const planetTitle =
        titleByPath.get(`${sunIdx}.${pIdx}`) ??
        fallback(`${sunIdx + 1}.${pIdx + 1}`, 1);
      const moons: SegmentMoon[] = p.moons.map((m, mIdx) => {
        const moonTitle =
          titleByPath.get(`${sunIdx}.${pIdx}.${mIdx}`) ??
          fallback(`${sunIdx + 1}.${pIdx + 1}.${mIdx + 1}`, 2);
        const moonSlice = sliceText(cleanedWords, m.start_sec, m.end_sec);
        return {
          topic: moonTitle.topic,
          preview: moonTitle.preview,
          startSec: Math.round(m.start_sec),
          endSec: Math.round(m.end_sec),
          text: moonSlice.text,
          wordCount: moonSlice.wordCount,
        };
      });
      // Planet text: union of moons if any, else its own slice.
      let planetText: string;
      let planetWordCount: number;
      if (moons.length > 0) {
        planetText = moons.map((m) => m.text).join(" ").trim();
        planetWordCount = moons.reduce((s, m) => s + m.wordCount, 0);
      } else {
        const slice = sliceText(cleanedWords, p.start_sec, p.end_sec);
        planetText = slice.text;
        planetWordCount = slice.wordCount;
      }
      return {
        topic: planetTitle.topic,
        preview: planetTitle.preview,
        startSec: Math.round(p.start_sec),
        endSec: Math.round(p.end_sec),
        text: planetText,
        wordCount: planetWordCount,
        moons,
      };
    });
    return {
      topic: sunTitle.topic,
      preview: sunTitle.preview,
      startSec: Math.round(sun.start_sec),
      endSec: Math.round(sun.end_sec),
      planets,
    };
  });

  const totalWordCount = suns.reduce(
    (sumS, s) =>
      sumS + s.planets.reduce((sumP, p) => sumP + p.wordCount, 0),
    0,
  );

  return { suns, totalWordCount };
}
