import { PrismaClient } from "@prisma/client";
import fs from "node:fs/promises";
import path from "node:path";

// Compares LLM-produced topic chunks against the cleaned transcript
// they were derived from, to surface objective accuracy issues:
//
//   1. COVERAGE        — do chunks span the full audio timeline?
//                        first.start_sec === 0 and last.end_sec ≈ total duration
//   2. CONTIGUITY      — are boundaries gap-free? chunk[i].end == chunk[i+1].start
//   3. WORD ACCOUNTING — does sum(chunks.word_count) match the cleaned word total?
//   4. TEXT/TIME ALIGN — for each chunk, do the words inside its [start,end]
//                        window in cleaned_words.json actually match chunk.text?
//
// Run from project root:
//   cd web && npx tsx scripts/test-chunk-accuracy.ts [jobId?]
//
// Without args, runs on the most-recently-completed segmentation run.

type WordEntry = { word: string; start: number; end: number };

const prisma = new PrismaClient();
const STORAGE_DIR = process.env.STORAGE_DIR ?? "./uploads";

function abs(rel: string): string {
  return path.resolve(STORAGE_DIR, rel);
}

function pct(num: number, den: number): string {
  if (den === 0) return "n/a";
  return ((num / den) * 100).toFixed(2) + "%";
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function ok(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function warn(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
function bad(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

async function pickRun(jobIdArg?: string) {
  if (jobIdArg) {
    const run = await prisma.segmentRun.findFirst({
      where: { jobId: jobIdArg, status: "ready" },
      include: {
        chunks: { orderBy: { idx: "asc" } },
        job: true,
      },
      orderBy: { readyAt: "desc" },
    });
    if (!run) throw new Error(`No ready SegmentRun for job ${jobIdArg}`);
    return run;
  }
  const run = await prisma.segmentRun.findFirst({
    where: { status: "ready" },
    include: {
      chunks: { orderBy: { idx: "asc" } },
      job: true,
    },
    orderBy: { readyAt: "desc" },
  });
  if (!run) throw new Error("No ready SegmentRun anywhere in DB");
  return run;
}

async function loadCleanedWords(
  jobId: string,
  cleanLevel: string,
): Promise<{ words: WordEntry[]; durationSec?: number }> {
  const cleaned = await prisma.cleanedTranscript.findUnique({
    where: { jobId_cleanLevel: { jobId, cleanLevel } },
    select: { cleanedWordsKey: true },
  });
  if (!cleaned?.cleanedWordsKey) {
    throw new Error(
      `No cleaned_words.json for job=${jobId} level=${cleanLevel}`,
    );
  }
  const raw = await fs.readFile(abs(cleaned.cleanedWordsKey), "utf8");
  return JSON.parse(raw);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Jaccard similarity on the multiset of normalized tokens. Robust to
// punctuation drift between cleaned_words.json (raw) and chunk.text
// (which strips spaces before punctuation).
function jaccard(a: string, b: string): number {
  const ta = normalize(a).split(" ").filter(Boolean);
  const tb = normalize(b).split(" ").filter(Boolean);
  if (ta.length === 0 && tb.length === 0) return 1;
  const setA = new Map<string, number>();
  for (const t of ta) setA.set(t, (setA.get(t) ?? 0) + 1);
  const setB = new Map<string, number>();
  for (const t of tb) setB.set(t, (setB.get(t) ?? 0) + 1);
  let inter = 0;
  for (const [t, n] of setA) {
    inter += Math.min(n, setB.get(t) ?? 0);
  }
  const union = ta.length + tb.length - inter;
  return union === 0 ? 1 : inter / union;
}

async function main() {
  const jobIdArg = process.argv[2];
  const run = await pickRun(jobIdArg);

  console.log(bold("\n══════════ Chunk accuracy report ══════════\n"));
  console.log(
    `${dim("Job:        ")} ${run.job.sourceName}  (${run.job.id})`,
  );
  console.log(
    `${dim("Run:        ")} clean=${run.cleanLevel}  target=${run.targetMin}min  status=${run.status}`,
  );
  console.log(
    `${dim("Chunks:     ")} ${run.chunks.length}  (run.chunkCount=${run.chunkCount})`,
  );
  console.log(
    `${dim("Duration:   ")} job.sourceDurationSec=${run.job.sourceDurationSec}s\n`,
  );

  // --------- Load the cleaned words this run was derived from ---------
  const cleaned = await loadCleanedWords(run.jobId, run.cleanLevel);
  const cleanedWordCount = cleaned.words.length;
  const cleanedDuration =
    cleaned.durationSec ??
    (cleaned.words.length > 0
      ? cleaned.words[cleaned.words.length - 1].end
      : 0);

  console.log(
    `${dim("Cleaned src:")} ${cleanedWordCount} words, last word @ ${fmt(cleanedDuration)}\n`,
  );

  // ────── Test 1: Coverage ──────
  console.log(bold("Test 1 — Timeline coverage"));
  const first = run.chunks[0];
  const last = run.chunks[run.chunks.length - 1];
  if (!first || !last) {
    console.log(bad("  ✗ No chunks to evaluate."));
    process.exit(1);
  }

  const startOk = first.startSec === 0;
  const endDelta = Math.abs(last.endSec - cleanedDuration);
  const endOk = endDelta <= 5; // 5 second tolerance for rounding

  console.log(
    `  ${startOk ? ok("✓") : bad("✗")} first chunk starts at 0s ${dim("(actual: " + first.startSec + "s)")}`,
  );
  console.log(
    `  ${endOk ? ok("✓") : warn("⚠")} last chunk ends near cleaned duration ${dim("(actual end: " + last.endSec + "s, cleaned end: " + Math.round(cleanedDuration) + "s, delta: " + endDelta.toFixed(1) + "s)")}`,
  );

  // ────── Test 2: Contiguity ──────
  console.log(bold("\nTest 2 — Boundary contiguity (no gaps / overlaps)"));
  let gaps = 0;
  let overlaps = 0;
  for (let i = 0; i < run.chunks.length - 1; i++) {
    const cur = run.chunks[i];
    const next = run.chunks[i + 1];
    if (next.startSec > cur.endSec) gaps++;
    if (next.startSec < cur.endSec) overlaps++;
  }
  console.log(
    `  ${gaps === 0 ? ok("✓") : bad("✗")} no gaps  ${dim("(" + gaps + " gap" + (gaps === 1 ? "" : "s") + ")")}`,
  );
  console.log(
    `  ${overlaps === 0 ? ok("✓") : bad("✗")} no overlaps  ${dim("(" + overlaps + " overlap" + (overlaps === 1 ? "" : "s") + ")")}`,
  );

  // ────── Test 3: Word accounting ──────
  console.log(bold("\nTest 3 — Word accounting"));
  const sumChunkWords = run.chunks.reduce((s, c) => s + c.wordCount, 0);
  const totalWordDelta = Math.abs(sumChunkWords - cleanedWordCount);
  const lostFraction = totalWordDelta / Math.max(1, cleanedWordCount);
  console.log(
    `  ${dim("sum(chunks.wordCount)  =")} ${sumChunkWords}`,
  );
  console.log(
    `  ${dim("cleaned word total     =")} ${cleanedWordCount}`,
  );
  const wordOk = lostFraction <= 0.005; // 0.5% tolerance
  console.log(
    `  ${wordOk ? ok("✓") : warn("⚠")} delta ${totalWordDelta} (${pct(totalWordDelta, cleanedWordCount)})`,
  );

  // ────── Test 4: Per-chunk text/time alignment ──────
  console.log(bold("\nTest 4 — Per-chunk text/time alignment (Jaccard)"));
  console.log(
    dim(
      "  Reslices each chunk's text from cleaned_words[start..end] and\n" +
        "  compares with chunk.text. Jaccard ≥ 0.9 = aligned, ≥ 0.7 = drift,\n" +
        "  < 0.7 = serious mismatch (content moved to wrong chunk).\n",
    ),
  );

  let perfectAligned = 0;
  let drifting = 0;
  let mismatched = 0;
  const reportRows: string[] = [];

  for (const c of run.chunks) {
    // Re-slice using same logic as attachTextSlices in segmenter.ts —
    // a word "belongs to" a chunk if its `start` falls in [start, end).
    const inWindow = cleaned.words.filter(
      (w) => w.start >= c.startSec && w.start < c.endSec,
    );
    const reslicedText = inWindow.map((w) => w.word.trim()).join(" ");
    const score = jaccard(reslicedText, c.text ?? "");

    let symbol: string;
    let color: (s: string) => string;
    if (score >= 0.9) {
      perfectAligned++;
      symbol = "✓";
      color = ok;
    } else if (score >= 0.7) {
      drifting++;
      symbol = "⚠";
      color = warn;
    } else {
      mismatched++;
      symbol = "✗";
      color = bad;
    }

    reportRows.push(
      `  ${color(symbol)} #${String(c.idx + 1).padStart(2, "0")} ${dim(`${fmt(c.startSec)}–${fmt(c.endSec)}`)}  ${color("J=" + score.toFixed(3))}  ${dim("(stored=" + c.wordCount + "w, resliced=" + inWindow.length + "w)")}  ${c.topic.slice(0, 50)}`,
    );
  }
  for (const r of reportRows) console.log(r);

  // ────── Summary ──────
  console.log(bold("\n══════════ Summary ══════════"));
  const issues: string[] = [];
  if (!startOk) issues.push("first chunk doesn't start at 0s");
  if (!endOk) issues.push(`last chunk ends ${endDelta.toFixed(1)}s away from cleaned duration`);
  if (gaps > 0) issues.push(`${gaps} gap${gaps === 1 ? "" : "s"} in timeline`);
  if (overlaps > 0) issues.push(`${overlaps} overlap${overlaps === 1 ? "" : "s"}`);
  if (!wordOk) issues.push(`${pct(totalWordDelta, cleanedWordCount)} word loss vs cleaned source`);
  if (mismatched > 0) issues.push(`${mismatched} chunk${mismatched === 1 ? " has" : "s have"} text/time mismatch (Jaccard < 0.7)`);

  console.log(
    `Aligned:    ${ok(String(perfectAligned))}  /  Drifting: ${drifting > 0 ? warn(String(drifting)) : drifting}  /  Mismatched: ${mismatched > 0 ? bad(String(mismatched)) : mismatched}  (out of ${run.chunks.length})`,
  );
  console.log(`Word loss:  ${pct(totalWordDelta, cleanedWordCount)} (${totalWordDelta} of ${cleanedWordCount})`);
  console.log(`Coverage:   ${run.chunks.length === 0 ? "—" : `${first.startSec}s → ${last.endSec}s of ${Math.round(cleanedDuration)}s cleaned timeline`}`);

  if (issues.length === 0) {
    console.log(ok(bold("\n✓ All checks passed.\n")));
  } else {
    console.log(warn(bold("\nIssues:")));
    for (const i of issues) console.log(`  • ${i}`);
    console.log("");
  }
}

main()
  .then(() => prisma.$disconnect().then(() => process.exit(0)))
  .catch((err) => {
    console.error(err);
    prisma.$disconnect().then(() => process.exit(1));
  });
