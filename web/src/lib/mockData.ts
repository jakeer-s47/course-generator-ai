import { generateWaveform } from "./utils";

export type JobStatus = "queued" | "ingest" | "transcribe" | "refine" | "segment" | "render" | "done" | "failed";

export type PipelineStageId = "ingest" | "transcribe" | "refine" | "segment" | "render";

export type PipelineStage = {
  id: PipelineStageId;
  code: string; // e.g. "01"
  label: string;
  caption: string;
  status: "pending" | "active" | "done" | "failed";
  startedAt?: string;
  endedAt?: string;
  note?: string;
};

export type Segment = {
  id: string;
  index: number;
  topic: string;
  caption: string;
  startSec: number;
  endSec: number;
  wordCount: number;
  transcript: string;
  keywords: string[];
  avatarState: "queued" | "rendering" | "ready" | "failed";
  coherence: number; // 0..1
  seed: number;
};

export type Job = {
  id: string;
  slug: string;
  channel: string; // CH.01, CH.02
  lectureTitle: string;
  instructor: string;
  course: string;
  recordedAt: string; // ISO
  durationSec: number;
  sourceType: "upload" | "url";
  sourceLabel: string;
  sourceSize?: number;
  status: JobStatus;
  progress: number; // 0..100
  languages: string[];
  junkPct: number; // how much was trimmed
  segmentCount: number;
  stages: PipelineStage[];
  segments: Segment[];
  createdAt: string;
  waveformSeed: number;
};

function mkStages(active: PipelineStageId | null, done: PipelineStageId[]): PipelineStage[] {
  const defs: Array<[PipelineStageId, string, string, string]> = [
    ["ingest",     "01", "INGEST",     "Source acquisition"],
    ["transcribe", "02", "TRANSCRIBE", "Speech → text, aligned"],
    ["refine",     "03", "REFINE",     "Strip filler, tangents"],
    ["segment",    "04", "SEGMENT",    "Topic chunking, 20m"],
    ["render",     "05", "RENDER",     "Avatar video synthesis"],
  ];
  return defs.map(([id, code, label, caption]) => {
    let status: PipelineStage["status"] = "pending";
    if (done.includes(id)) status = "done";
    if (id === active) status = "active";
    return { id, code, label, caption, status };
  });
}

function mkSegments(jobSeed: number, count: number, avatarReadyCount: number): Segment[] {
  const topics = [
    ["Thermodynamics in closed systems", "1st + 2nd law framing", ["entropy", "reversible", "heat engine"]],
    ["Equilibrium & state functions",    "Enthalpy vs. internal energy", ["enthalpy", "Gibbs", "state fn"]],
    ["Heat transfer mechanisms",         "Conduction, convection, radiation", ["Fourier", "Nusselt", "Stefan-Boltzmann"]],
    ["Phase transitions",                "Clausius–Clapeyron walk-through",   ["latent heat", "coexistence", "PT diagram"]],
    ["Statistical mechanics primer",     "Microstates → macrostates",         ["Boltzmann", "partition", "multiplicity"]],
    ["Worked problems & closeout",       "Textbook exercises 4.2, 4.7, 4.11", ["practice", "derivation", "review"]],
    ["Q&A and extensions",               "Student questions; off-topic removed", ["clarify", "extension", "closing"]],
  ];
  const result: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const t = topics[i % topics.length];
    const start = i * 20 * 60 + (i === 0 ? 0 : Math.floor(Math.random() * 60));
    const end = start + (17 + Math.floor(Math.random() * 6)) * 60;
    result.push({
      id: `seg-${jobSeed}-${i + 1}`,
      index: i + 1,
      topic: t[0] as string,
      caption: t[1] as string,
      startSec: start,
      endSec: end,
      wordCount: 2100 + Math.floor(Math.random() * 900),
      transcript:
        "The cleaned transcript preserves the instructor's flow while stripping false starts, administrative chatter, and off-topic student interjections. In this segment we formalize the definitions, walk the canonical derivation on the board, and close with two worked examples.",
      keywords: t[2] as string[],
      avatarState: i < avatarReadyCount ? "ready" : i === avatarReadyCount ? "rendering" : "queued",
      coherence: 0.72 + Math.random() * 0.22,
      seed: jobSeed * 31 + i * 7,
    });
  }
  return result;
}

export const jobs: Job[] = [
  {
    id: "JOB-0042-A",
    slug: "thermo-lecture-04",
    channel: "CH.01",
    lectureTitle: "Thermodynamics — Lecture 04",
    instructor: "Prof. I. Saksena",
    course: "CHE-211 · Spring term",
    recordedAt: "2026-04-18T10:15:00Z",
    durationSec: 5 * 3600 + 42 * 60 + 18, // Intentionally long to show the value of segmentation
    sourceType: "upload",
    sourceLabel: "CHE211_lec04_raw.mp4",
    sourceSize: 1_834_000_000,
    status: "render",
    progress: 78,
    languages: ["en-US"],
    junkPct: 23.4,
    segmentCount: 7,
    stages: mkStages("render", ["ingest", "transcribe", "refine", "segment"]),
    segments: mkSegments(7, 7, 4),
    createdAt: "2026-04-22T09:12:00Z",
    waveformSeed: 42,
  },
  {
    id: "JOB-0041-K",
    slug: "linalg-lecture-09",
    channel: "CH.02",
    lectureTitle: "Linear Algebra — Eigenvectors",
    instructor: "Dr. R. Okonkwo",
    course: "MAT-221 · Spring term",
    recordedAt: "2026-04-17T14:30:00Z",
    durationSec: 4 * 3600 + 12 * 60,
    sourceType: "url",
    sourceLabel: "https://lectures.u.edu/mat221/l9",
    status: "done",
    progress: 100,
    languages: ["en-US"],
    junkPct: 19.1,
    segmentCount: 6,
    stages: mkStages(null, ["ingest", "transcribe", "refine", "segment", "render"]),
    segments: mkSegments(9, 6, 6),
    createdAt: "2026-04-21T18:41:00Z",
    waveformSeed: 17,
  },
  {
    id: "JOB-0040-C",
    slug: "algorithms-dp",
    channel: "CH.01",
    lectureTitle: "Algorithms — DP on Trees",
    instructor: "Prof. M. Alvarez",
    course: "CSE-310 · Spring term",
    recordedAt: "2026-04-15T09:00:00Z",
    durationSec: 3 * 3600 + 58 * 60,
    sourceType: "upload",
    sourceLabel: "cse310_dp_trees.mkv",
    sourceSize: 1_210_000_000,
    status: "segment",
    progress: 54,
    languages: ["en-US", "es-419"],
    junkPct: 31.8,
    segmentCount: 5,
    stages: mkStages("segment", ["ingest", "transcribe", "refine"]),
    segments: mkSegments(3, 5, 0),
    createdAt: "2026-04-22T07:03:00Z",
    waveformSeed: 91,
  },
  {
    id: "JOB-0039-B",
    slug: "organic-chem-05",
    channel: "CH.03",
    lectureTitle: "Organic Chemistry — Carbonyls",
    instructor: "Dr. L. Nakamura",
    course: "CHM-201 · Spring term",
    recordedAt: "2026-04-14T11:00:00Z",
    durationSec: 4 * 3600 + 33 * 60,
    sourceType: "upload",
    sourceLabel: "chm201_carbonyls.mp4",
    sourceSize: 1_502_000_000,
    status: "done",
    progress: 100,
    languages: ["en-US"],
    junkPct: 14.7,
    segmentCount: 6,
    stages: mkStages(null, ["ingest", "transcribe", "refine", "segment", "render"]),
    segments: mkSegments(19, 6, 6),
    createdAt: "2026-04-20T16:22:00Z",
    waveformSeed: 55,
  },
  {
    id: "JOB-0038-Z",
    slug: "econ-micro-12",
    channel: "CH.02",
    lectureTitle: "Microeconomics — Game Theory",
    instructor: "Prof. H. Bauer",
    course: "ECN-301 · Spring term",
    recordedAt: "2026-04-12T13:15:00Z",
    durationSec: 3 * 3600 + 21 * 60,
    sourceType: "url",
    sourceLabel: "https://lectures.u.edu/ecn301/l12",
    status: "failed",
    progress: 34,
    languages: ["en-US"],
    junkPct: 0,
    segmentCount: 0,
    stages: mkStages(null, ["ingest", "transcribe"]).map((s) =>
      s.id === "refine" ? { ...s, status: "failed" as const, note: "E-207: diarization boundary drift > 12s" } : s
    ),
    segments: [],
    createdAt: "2026-04-20T10:08:00Z",
    waveformSeed: 23,
  },
];

export function getJob(id: string): Job | undefined {
  return jobs.find((j) => j.id === id || j.slug === id);
}

export function getRecentJobs(limit = 10): Job[] {
  return [...jobs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

export { generateWaveform };
