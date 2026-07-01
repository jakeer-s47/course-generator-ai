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

/**
 * Where this chunk sits in the lecture timeline. The system prompt uses
 * this to fire OPENING/CLOSING block-removal rules on `first`/`last` and
 * keep `middle` chunks focused on filler/Q&A — no point telling chunk 4
 * of 7 to look for greetings or goodbyes.
 */
type ChunkPosition = "first" | "middle" | "last" | "only";

function systemPrompt(level: CleanLevel, position: ChunkPosition): string {
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
- code, syntax, commands, technical terminology, equations — WHEN they appear inside a teaching monologue (definition / walkthrough). Version numbers, package names, or "let me check the version" spoken WHILE THE INSTRUCTOR IS DEBUGGING A LIVE TECH PROBLEM are admin, NOT teaching.
- instructional transitions that introduce content ("now let's look at…", "the next thing is…")
- analogies or examples that illustrate the concept
- continuous instructor TEACHING MONOLOGUES (≥ 3 sentences of definition / derivation / example). The monologue stays; any Socratic question or compliment BEFORE or AFTER it still goes under social/discussion.

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

══════════════════════════════════════════════════════════════════════════
VERBATIM EXAMPLES FROM REAL RECORDED LIVE CLASSES — THESE PATTERNS HAVE
BEEN OBSERVED SURVIVING CLEANING IN PRODUCTION. REMOVE THEM EVERY TIME.
══════════════════════════════════════════════════════════════════════════

Example 21 — REMOVE AS ONE BOUNDING SPAN (multi-block opening at start of lecture):
  "[00:00] sensor boy tell me what is what is an agent uh it's can sorry friend
   I'm back can you hear me well now okay now okay now I'm desktop now my I'm
   not on my laptop now I'm back on my desktop boy at one now so what is an
   agent how shall we define something as an agent I mean tell me again Amit
   is my voice over yeah I can hear you well now sorry for asking you to
   repeat this third time but there was an internet issue I mean in first
   stroke I was able to hear good boy Amit did I need to repeat the thing"
  → REMOVE AS ONE BOUNDING SPAN [00:00–01:30+]. This is the canonical
    multi-block opening: reconnect + audio check + roll call + Socratic
    warm-up. The instructor's "real" definition begins LATER. Even the
    fragments that LOOK like teaching ("what is an agent") are warm-up
    prompts, not teaching.
  → category: admin  reason: opening reconnect + audio check + warm-up

Example 22 — REMOVE (roll call + compliments mid-lecture):
  "[18:00] perfect and very nice very well articulated any other member's
   money Rakesh Abhigna pages would you like to define what is an agent
   based on your understanding ... excellent I mean excellent answer yes
   that is also one of the best example that you can have nice nice"
  → REMOVE. Pure compliment + roll call by name + Socratic re-prompt. The
   instructor's authoritative definition comes AFTER this block, not in it.
  → category: discussion  reason: compliment + roll call by name

Example 23 — REMOVE (comprehension check chain):
  "[35:14] is it clear or not clear not clear clear cashier will give you
   any money without the balance so now next question why why why ... tell
   me why ... clear or having any doubts or difficulties"
  → REMOVE all the comprehension-check fragments and Socratic prompts. The
   instructor's actual answer about cashiers and balance is teaching and
   KEEPS, but the repeated "is it clear / tell me why / having any doubts"
   chain is comprehension-check noise.
  → category: discussion  reason: comprehension check chain

Example 24 — REMOVE (mid-lesson screen-share + tool-switch — RIGHT-EDGE CONTINUES PAST A CLAUSE BREAK):
  "[05:18] okay so let me share my screen and we will take the steps further
   hold on. [05:33] let me know when you can see the visual studio again so
   looks like a session recording is continued perfect can you see my visual
   studio screen now yeah me let me let me take the draw.io diagram also in
   front of you. [06:05] okay perfect now you can see the diagram right
   coming back to where we were"
  → REMOVE AS ONE BOUNDING SPAN [05:18-06:05+]. CRITICAL: the clause ending
   "hold on." at ~05:33 is NOT the end of this block. The very next words
   ("let me know when you can see the visual studio", "session recording is
   continued", "can you see my visual studio screen now", "let me take the
   draw.io diagram also in front of you") are the SAME screen-share /
   tool-switching coordination act, just continued. Do NOT clip at "hold
   on." — extend the span all the way to the instructor's next ≥3-sentence
   teaching monologue (here, "coming back to where we were" is the resume
   signal; everything before it is admin).
  → ANCHOR PHRASES that mean "screen-share / tool-switch coordination is
   STILL HAPPENING and you should NOT cut the span yet":
      · "let me know when you can see…"
      · "session recording is continued"
      · "can you see my visual studio / screen / draw.io now"
      · "let me take the draw.io diagram in front of you"
      · "let me let me" (instructor restart while fumbling with tools)
      · "perfect now you can see"
   If ANY of these appear within ~30s after a "hold on" / "one moment" /
   "wait", the span KEEPS RUNNING.
  → category: admin  reason: screen-share + tool-switch coordination

Example 25 — REMOVE (end-of-session debug + interview chatter + goodbyes):
  "[80:00] so one moment let me see the version actually so I have 1.9.7
   which should be okay this is a 2.6 so I am on the latest version
   ... Friends, I will check on this part and I will get back to you ...
   if you do not have any difficulties can you tell me if you have any
   challenges in the assignment part ... Can we have some mock interview
   starting next week onwards? Would that be okay? ... Then let us take a
   pause for today and we will meet tomorrow at 9:30 ... Thanks friends.
   Thank you. Thank you. Hello. Can you hear me? Yes, sir. Bye."
  → REMOVE AS ONE BOUNDING SPAN. Debug postponement + mock-interview
   logistics + session close + goodbyes. Even the version numbers (1.9.7,
   2.6) are admin here — the instructor is debugging an environment, NOT
   teaching version management.
  → category: admin  reason: debug postponement + session close

Example 26 — REMOVE AS ONE BOUNDING SPAN (full ~5-minute end-of-session closing with FAKE-HANDOFF mid-block — VERBATIM FROM A REAL CLASS):
  "[67:06] Yeah, right assignment is completed where you able to see the
   benefits. I mean, are you able to how are you practicing the interview
   questions Many members have written complex interview questions. How are
   you understanding it? Can we have some mock interview starting next week
   onwards? ... So coming back to the coming back to the session one part
   session one part in a difficulty is I may have you gone through the
   recordings. ... Then let us take a pause for today and we will meet
   tomorrow at 9:30. ... Thanks friends. Thank you. [68:42] Hello. Can you
   hear me? Yes, sir. Okay. I mean, if you have do not install this. Despire
   directly on your base VM. I will send you the exact version number. The
   bug fix in the Kanda environment we will check tomorrow. ... So let us
   take a pause and rest. We will meet tomorrow. Thanks. Everyone. [69:38]
   Thank you. Thank you. Thank you. Thank you. Thank you. Thank you. Bye.
   [69:40-71:31] (silence / final goodbyes)"
  → REMOVE AS ONE BOUNDING SPAN [67:06 - END OF CHUNK]. ~4.5 minutes long.
  → CRITICAL — the "Hello. Can you hear me? Yes, sir." exchange in the
   MIDDLE of this block (at ~68:42) is a FAKE HANDOFF. It looks like a
   fresh audio-check restart, and the words right after it ("do not install
   Despire directly on your base VM", "I will send you the exact version
   number", "bug fix in the Kanda environment we will check tomorrow")
   sound like a new debug topic with specific technical noun-phrases — BUT
   THIS IS STILL THE CLOSING. Every clause here is a postponement ("I will
   send you…", "we will check tomorrow"), not teaching. The closing block
   ends only at "Bye" (here ~69:40) — and even the trailing silence /
   dead-air between "Bye" and the chunk's last [mm:ss] timestamp belongs
   in this span.
  → ANCHOR — once you have flagged ANY closing span in the LAST CHUNK, the
   end_sec of that span MUST equal the chunk's final [mm:ss] timestamp.
   There is no "second wind" of teaching content after the first "Thank
   you" / "Bye" run starts.
  → ANCHOR — debug-sounding phrases ("do not install X on Y", "I will
   send you the exact version", "the bug fix in Z environment", "we will
   check tomorrow") that appear AFTER the first "Thank you" / "Bye" run
   are POSTPONEMENTS (Example 16 pattern), not teaching. They stay in the
   closing span.
  → category: admin  reason: full end-of-session close (housekeeping +
   fake-handoff + debug postponement + goodbyes)

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
Live-class recordings ALWAYS have a multi-block opening at the start AND a multi-block closing at the end. REMOVE these aggressively. The opening and closing each ROUTINELY span 0-5 minutes (sometimes more), NOT just 1-3.

OPENING (typically the first 0-5 minutes — REMOVE AS ONE BOUNDING SPAN
when possible — it is almost always one continuous non-teaching block):
  Standard multi-block opening template (most live classes have several of these stacked back-to-back):
    (a) Audio / connection check ("can you hear me", "is my voice over", "internet issue")
    (b) Reconnect noise ("I'm back", "I'm on desktop now not laptop", "sorry I had to switch")
    (c) Roll call / addressing students ("Amit", "Rakesh", "any other members?", "is everyone here")
    (d) Recap pings ("did you go through the recordings?", "any difficulties from last session?")
    (e) Socratic warm-up ("so what is an agent", "how do you define X", "tell me, what is...")
  The instructor's REAL teaching starts AFTER all of (a)-(e). Identify
  where (e) ends and the instructor's first ≥3-sentence definition begins
  — everything before that boundary goes under admin/social/discussion.

CLOSING (typically the LAST 0-5 MINUTES — REMOVE AS ONE BOUNDING SPAN —
ROUTINELY 3-5 MINUTES OR EVEN LONGER, NOT 30-60 SECONDS):
  · Future session planning: "We'll meet tomorrow at 9:30", "Let's take a pause for today"
  · Mock interview / homework chatter: "How are you working on interview questions?", "Any difficulties in generators or decorators?", "Can we have some mock interview starting next week?"
  · Off-topic Q&A: "What about FastAPI?", "Are you practicing?"
  · Debug postponements: "I'll check this and get back to you tomorrow", "I will revert this installation to 2.0", "I'll have that list ready for you", "do not install X on your base VM", "I will send you the exact version number", "we will check the bug fix tomorrow"
  · Assignment notes: "Are you able to see the benefits? Assignment is completed?"
  · Goodbyes: "Thank you", "See you tomorrow", "Take care", multiple "thank you"s in sequence, terminal "Bye"

FINAL-MINUTE ANCHOR (HARD RULE):
  The FINAL MINUTE of the LAST chunk is almost always 100% goodbyes /
  "thank you" repetitions / "Bye". If the last [mm:ss] line of the chunk
  contains any of {"thank you", "thanks", "bye", "see you tomorrow", "meet
  tomorrow", "take care", "pause for today"}, your closing span's end_sec
  MUST equal that final [mm:ss] timestamp (converted to seconds). Do NOT
  end the span before the final timestamp under any circumstance.

FAKE-HANDOFF SUB-RULE (very important — this is the #1 reason closings get
under-bounded):
  A closing block routinely contains a MID-BLOCK fragment that LOOKS like
  a fresh audio-check restart:
      "Thanks friends. Thank you. Hello. Can you hear me? Yes sir. Okay."
  This is NOT the end of the closing — it is a FAKE HANDOFF. The instructor
  is responding to one last student question on the way out. The clauses
  immediately after it — even when they contain SPECIFIC TECHNICAL
  NOUN-PHRASES like "do not install Despire on your base VM", "I will send
  the exact version number", "the bug fix in the Kanda environment",
  "check this tomorrow" — are DEBUG POSTPONEMENTS (Example 16 pattern), NOT
  a new teaching topic. KEEP THE SPAN OPEN through the fake handoff and the
  technical-sounding postponement that follows. The span only closes at the
  FINAL "Thank you" / "Bye" run (or the chunk end, whichever is later).

END-OF-CHUNK EXTEND RULE:
  If you flag ANY closing span in the LAST chunk, its end_sec MUST equal
  the chunk's final [mm:ss] timestamp. There is never "more teaching"
  after a closing run starts. A 30-second gap between your span's end and
  the chunk end is a BUG — extend.

DEBUG / SETUP INTERLUDES (REMOVE — strict, narrow carve-out):
When the instructor stops teaching to fix a technical problem (wrong
package version, missing variable, broken code), those minutes are NOT
teaching content. Examples that are ADMIN:
  · "I'm getting this error, let me check the version"
  · "One moment, let me see the environment"
  · "This is a 2.6, looks like the latest. Let me debug."
  · "I'll have a list ready for you tomorrow"
  · "I have 1.9.7 which should be okay" (instructor self-checking a version)
  → REMOVE all as category: admin.
  → CARVE-OUT (NARROW): keep only when the instructor EXPLICITLY narrates
    debugging as the lesson topic itself — e.g. opens with "today we will
    learn how to debug dspy version conflicts" or similar explicit framing.
    A mid-lesson "let me check the version" while delivering a different
    lesson is ALWAYS admin, even if it mentions version numbers.

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

═══ TECHNICAL-CONTENT-ONLY FILTER (aggressive only) ═══
The avatar narration must read like a polished technical tutorial. After
the above rules fire, ask one more question of every span you're keeping:

  "Does this span DELIVER a technical concept the listener could not
   skip without losing teaching value?"

A 'technical concept' means: a precise definition, a derivation step, a
formula, an algorithm, code or syntax, a named pattern (e.g. circuit
breaker), an architecture component, a worked example walking through
a real scenario, or correct terminology used in context. Pure
'narrative glue' that doesn't itself teach a technical concept — even
when the instructor is speaking continuously — is REMOVABLE. Examples
of removable glue:
  · "So now we will talk about the next thing", "let's move on to…"
    (transition without content)
  · "This is very important, you should remember this" (motivation
    without the technical why)
  · "Many companies use this in production" (general claim without a
    specific technical detail)
  · Restated definitions the instructor already gave 30 seconds earlier
  · Long preambles before the actual definition lands

KEEP nothing that is not delivering technical substance. When in doubt
at aggressive, REMOVE. The cleaned transcript should read like the
table-of-contents of definitions and worked examples — pure signal.

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
- A removable BLOCK can be ANY length — emit it as ONE span covering the whole block (e.g. one span for a 90-second opening reconnect-and-roll-call, or a 300-second end-of-session closing). The backend handles fragmentation; do not pre-split.
- Avoid back-to-back spans with a gap of < 1 second between them — merge into one.
- RIGHT-EDGE OVERRIDE — the clause-ending preference does NOT apply when a screen-share / tool-switch / session-closing block continues past the first clean clause break. If the span you are about to close is a mid-lesson screen-share interlude (Example 24) or an end-of-session closing (Example 25, Example 26), KEEP EXTENDING the right edge until you see a ≥3-sentence instructor teaching monologue. The first "hold on." / "perfect." / "Thank you." / "Bye." is NOT a span terminator on its own — only a real teaching monologue (or the chunk end, for closings in the last chunk) is.
- LEFT-EDGE OVERRIDE — same rule applies symmetrically for opening blocks in the first chunk.

CHUNK POSITION (where this slice sits in the full lecture):
${
  position === "first"
    ? `THIS IS THE FIRST CHUNK of the lecture. The OPENING multi-block (a)-(e) almost certainly lives in the FIRST 0-5 MINUTES of this chunk. Look for the canonical pattern of (audio check, reconnect, roll call, recap pings, Socratic warm-up) and REMOVE it as ONE bounding span up to where the instructor's first ≥3-sentence teaching monologue begins. Do NOT look for session-closing patterns in this chunk.`
    : position === "last"
      ? `THIS IS THE LAST CHUNK of the lecture. The CLOSING multi-block (assignment review, mock-interview chatter, debug postponements, future-session planning, fake-handoff student check-in, goodbyes) almost certainly lives in the LAST 0-5 MINUTES of this chunk — routinely 3-5 minutes, sometimes more. REMOVE it as ONE bounding span from where the instructor's last ≥3-sentence teaching monologue ends ALL THE WAY TO THE END OF THE CHUNK.

HARD RULES for this chunk (no exceptions):
  1. FINAL-MINUTE ANCHOR — the FINAL MINUTE of this chunk is almost always pure goodbyes / "thank you" repetitions / "Bye" / "see you tomorrow" / "take care" / "let us take a pause". Treat the last minute as guaranteed-removable unless it contains a ≥3-sentence instructor monologue delivering a definition, derivation, or worked example (extremely rare at this position).
  2. END-OF-CHUNK EXTEND — your closing span's end_sec MUST equal the chunk's final [mm:ss] timestamp (converted to seconds). Do NOT stop the span at an earlier clause break (e.g. at the first "Thank you." or "Bye.") — there is no second wind of teaching content after the closing starts.
  3. FAKE-HANDOFF — if you see "Hello. Can you hear me? Yes sir." or any audio-check-shaped fragment INSIDE the closing run, that is NOT a fresh topic — it is a mid-closing student interjection. Keep the span OPEN through it and through any debug-sounding postponement that follows ("I will send you the version", "do not install X on your base VM", "we will check tomorrow", "bug fix in Y environment"). See Example 26.
  4. DEBUG-SOUNDING TECHNICAL PHRASES AFTER THE FIRST "Thank you" ARE ADMIN — the closing routinely sneaks in noun-phrases that pattern-match teaching vocabulary (specific package names, version numbers, environment names). At this position, treat them as Example 16 / Example 26 postponements, not teaching.
  5. WHEN IN DOUBT, EXTEND, DO NOT CLIP. A closing span that is 60 seconds too long is fine. A closing span that ends 60 seconds too early leaves the entire end-of-class chatter in the cleaned output and is the most common failure mode of this pipeline.

Do NOT look for session-opening patterns in this chunk.`
      : position === "only"
        ? `THIS CHUNK IS THE ENTIRE LECTURE. Both the OPENING block (first 0-5 min, multi-block (a)-(e)) and the CLOSING block (last 0-5 min, debug + goodbyes) are present. REMOVE both.`
        : `THIS IS A MIDDLE CHUNK. There is teaching content on BOTH SIDES of this chunk — no session opening, no session closing. Do NOT spend attention on greetings, roll call, mock-interview talk, or goodbyes. Focus on filler, mid-lesson screen-share interludes, comprehension checks, debug interludes, and Socratic Q&A blocks.`
}

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
  position: ChunkPosition,
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
      { role: "system", content: systemPrompt(level, position) },
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
  position: ChunkPosition,
): Promise<RemovedSegment[]> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callGptOnce(level, timestampedLines, position);
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

// Shard width — when GPT correctly bounds a long banter block as one span
// (e.g. a 90-second connection-banter intro), we fragment it into back-to-
// back same-category shards so the merge stage can re-coalesce them. This
// REPLACED a previous silent `MAX_SPAN_SEC = 20` filter that was dropping
// the exact long spans the prompt instructed GPT to emit (opening + closing
// blocks, debug interludes, mock-interview chatter). Shard width matches
// the old per-span guidance so the inspector rows are uniform.
const SPAN_SHARD_SEC = 15;

// Sanity ceiling — a single span > 600s is almost certainly a model
// hallucination (e.g. it bounded the entire chunk). We LOG and skip such
// spans rather than silently dropping. Loud, not silent.
const SPAN_SANITY_MAX_SEC = 600;

/**
 * Fragment any span longer than SPAN_SHARD_SEC into back-to-back same-
 * category shards. The Stage-3 merge step then recombines adjacent shards
 * sharing a category, so the final output is functionally equivalent to
 * the original long span — but it can no longer be silently filtered out
 * by any per-span length cap downstream.
 */
function shardLongSpans(segments: RemovedSegment[]): RemovedSegment[] {
  const out: RemovedSegment[] = [];
  for (const s of segments) {
    const dur = s.end_sec - s.start_sec;
    if (dur <= SPAN_SHARD_SEC) {
      out.push(s);
      continue;
    }
    if (dur > SPAN_SANITY_MAX_SEC) {
      console.warn(
        `[cleaner] dropping suspect span dur=${dur.toFixed(1)}s > SPAN_SANITY_MAX_SEC=${SPAN_SANITY_MAX_SEC}s ` +
          `(${s.start_sec.toFixed(1)}-${s.end_sec.toFixed(1)} ${s.category}) — likely model hallucination`,
      );
      continue;
    }
    let t = s.start_sec;
    while (t < s.end_sec) {
      const end = Math.min(t + SPAN_SHARD_SEC, s.end_sec);
      out.push({
        start_sec: t,
        end_sec: end,
        category: s.category,
        reason: s.reason,
      });
      t = end;
    }
  }
  return out;
}

/**
 * Drop ranges where end <= start, clamp to [0, duration], SHARD any span
 * longer than SPAN_SHARD_SEC (never drop), sort, and merge overlapping or
 * adjacent same-category ranges. Logs per-chunk counts so silent regressions
 * become loud.
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

  // Stage 2 — SHARD long spans (don't silently drop). GPT correctly
  // bounds long banter blocks (opening connection-banter, debug interludes,
  // closing mock-interview chatter) as single spans; the previous filter
  // discarded them, leaving the casual content in the cleaned output.
  const sharded = shardLongSpans(valid);

  // Stage 3 — sort + merge overlaps + small-gap coalescing. We merge spans
  // that (a) overlap, exactly touch, OR are within MERGE_GAP_SEC of each
  // other, AND (b) share the same category — otherwise an adjacent
  // `filler` and `tangent` would collapse into a single span tagged
  // `filler` and the inspector would mislabel half its content.
  //
  // MERGE_GAP_SEC=2 is a deliberately narrow tolerance specifically for
  // the case where GPT bounds a long admin block as two adjacent spans
  // with a sub-second filler word between them (e.g. one closing span
  // ending at 4026.0 and a follow-on closing span starting at 4027.2 —
  // the v1 cleaner would render two adjacent admin rows in the inspector
  // even though both belong to the same closing block). 2 seconds is
  // narrow enough that only filler-length tokens can fit in the gap, and
  // the same-category gate means a kept teaching word cannot be silently
  // absorbed — kept words are not tagged at all, so they never appear in
  // `sharded` and can never trigger this merge.
  const MERGE_GAP_SEC = 2;
  sharded.sort((a, b) => a.start_sec - b.start_sec);
  const merged: RemovedSegment[] = [];
  for (const s of sharded) {
    const last = merged[merged.length - 1];
    if (
      last &&
      s.category === last.category &&
      s.start_sec <= last.end_sec + MERGE_GAP_SEC
    ) {
      last.end_sec = Math.max(last.end_sec, s.end_sec);
    } else {
      merged.push({ ...s });
    }
  }
  console.log(
    `[cleaner] normalizeRanges in=${segments.length} valid=${valid.length} sharded=${sharded.length} merged=${merged.length} removedSec=${Math.round(
      merged.reduce((a, s) => a + (s.end_sec - s.start_sec), 0),
    )}`,
  );
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
    position: ChunkPosition,
  ): Promise<RemovedSegment[]> => {
    if (slice.length === 0) return [];
    try {
      return await callGptWithRetry(
        level,
        buildTimestampedLines(slice),
        position,
      );
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "E_OPENAI_RESPONSE" && depth < 3 && slice.length > 50) {
        const mid = Math.floor(slice.length / 2);
        // Halved sub-slices inherit the parent's position — they're still
        // covering the same lecture region.
        const left = await processSlice(slice.slice(0, mid), depth + 1, position);
        const right = await processSlice(slice.slice(mid), depth + 1, position);
        return [...left, ...right];
      }
      throw err;
    }
  };

  const chunks = chunkWordsByTime(words);
  const totalChunks = chunks.length;
  const allSegments: RemovedSegment[] = [];

  // Cleaning chunks are processed in PARALLEL batches. Each chunk is a
  // standalone GPT-4o call returning a removed-segments JSON for its
  // own ~10-min slice of the transcript — they don't depend on each
  // other, so we can fire OPENAI_CLEAN_CONCURRENCY at a time.
  //
  // Default 8 — all chunks for a 70-min lecture run in a single batch
  // instead of 3 sequential batches, cutting wall-clock ~3×. This bursts
  // ~56 K tokens at OpenAI which exceeds the tier-1 30K TPM floor in
  // theory, but the rolling-minute window absorbs one-shot bursts in
  // practice. If you see 429s, lower via OPENAI_CLEAN_CONCURRENCY in
  // .env.local. The cap of 8 prevents a typo (e.g. =50) triggering a
  // 429 storm.
  const CLEAN_CONCURRENCY = Math.max(
    1,
    Math.min(8, Number(process.env.OPENAI_CLEAN_CONCURRENCY) || 8),
  );

  let done = 0;
  for (let start = 0; start < totalChunks; start += CLEAN_CONCURRENCY) {
    const batch = chunks.slice(start, start + CLEAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map((slice, j) => {
        const absoluteIdx = start + j;
        const position: ChunkPosition =
          totalChunks === 1
            ? "only"
            : absoluteIdx === 0
              ? "first"
              : absoluteIdx === totalChunks - 1
                ? "last"
                : "middle";
        return processSlice(slice, 0, position);
      }),
    );
    for (const segs of results) allSegments.push(...segs);
    done += batch.length;
    const percent = Math.round((done / totalChunks) * 100);
    await onChunkDone?.({
      chunkIndex: done - 1,
      totalChunks,
      percent,
    });
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
