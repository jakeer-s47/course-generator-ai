"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  RefreshCw,
  Sparkles,
  FileText,
  Wand2,
  Check,
  Leaf,
  Scale,
  Flame,
  Loader2,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Languages,
  Clock,
  ChevronDown,
  ChevronUp,
  Tag,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useWizard, type CleanLevel } from "../WizardContext";
import { StepHeader } from "../StepHeader";
import { useToast } from "@/components/ui/Toast";
import { formatDuration } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Backend row shapes
// ---------------------------------------------------------------------------

type TranscriptRow = {
  id: string;
  status: "pending" | "transcribing" | "ready" | "failed";
  language: string | null;
  wordCount: number | null;
  durationSec: number | null;
  rawText: string | null;
};

type CleanedRow = {
  id: string;
  jobId: string;
  status: "pending" | "cleaning" | "ready" | "failed";
  progress: number;
  cleanLevel: CleanLevel;
  cleanedText: string | null;
  cleanedWordsKey: string | null;
  removedJsonKey: string | null;
  originalWords: number | null;
  cleanedWords: number | null;
  removedSegments: number | null;
  removedDurSec: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  readyAt: string | null;
};

type WordEntry = { word: string; start: number; end: number };

type RemovedSegment = {
  start_sec: number;
  end_sec: number;
  category:
    | "filler"
    | "admin"
    | "tangent"
    | "recap"
    | "redundant"
    | "falsestart";
  reason: string;
};

type RemovedFile = {
  level: CleanLevel;
  segments: RemovedSegment[];
};

type WordsFile = {
  words: WordEntry[];
};

// ---------------------------------------------------------------------------

const LEVEL_META: Record<
  CleanLevel,
  {
    label: string;
    caption: string;
    icon: LucideIcon;
    from: string;
    to: string;
    softFrom: string;
    softTo: string;
  }
> = {
  light: {
    label: "Light",
    caption: "Filler + false-starts only",
    icon: Leaf,
    from: "from-emerald-500",
    to: "to-teal-500",
    softFrom: "from-emerald-50",
    softTo: "to-teal-50",
  },
  standard: {
    label: "Standard",
    caption: "Balanced — recommended",
    icon: Scale,
    from: "from-indigo-500",
    to: "to-fuchsia-500",
    softFrom: "from-indigo-50",
    softTo: "to-fuchsia-50",
  },
  aggressive: {
    label: "Aggressive",
    caption: "Strict — topic only",
    icon: Flame,
    from: "from-rose-500",
    to: "to-orange-500",
    softFrom: "from-rose-50",
    softTo: "to-orange-50",
  },
};

const CATEGORY_TONE: Record<
  RemovedSegment["category"],
  { label: string; tone: string }
> = {
  filler: { label: "Filler", tone: "bg-amber-50 text-amber-700 border-amber-100" },
  falsestart: {
    label: "False start",
    tone: "bg-orange-50 text-orange-700 border-orange-100",
  },
  admin: { label: "Admin", tone: "bg-slate-50 text-slate-700 border-slate-200" },
  tangent: { label: "Tangent", tone: "bg-cyan-50 text-cyan-700 border-cyan-100" },
  recap: { label: "Recap", tone: "bg-violet-50 text-violet-700 border-violet-100" },
  redundant: {
    label: "Redundant",
    tone: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-100",
  },
};

// ---------------------------------------------------------------------------

type CleanedByLevel = Record<CleanLevel, CleanedRow | null>;
type RemovedByLevel = Record<CleanLevel, RemovedSegment[] | null>;

const EMPTY_BY_LEVEL: CleanedByLevel = {
  light: null,
  standard: null,
  aggressive: null,
};
const EMPTY_REMOVED: RemovedByLevel = {
  light: null,
  standard: null,
  aggressive: null,
};

export function CleanStep() {
  const { jobId, cleanLevel, update } = useWizard();
  const toast = useToast();

  const [transcript, setTranscript] = useState<TranscriptRow | null>(null);
  // One slot per level — switching cleanLevel doesn't clobber the others.
  const [cleanedByLevel, setCleanedByLevel] =
    useState<CleanedByLevel>(EMPTY_BY_LEVEL);
  const [removedByLevel, setRemovedByLevel] =
    useState<RemovedByLevel>(EMPTY_REMOVED);
  // origWords is shared across all levels (it's the source transcript).
  const [origWords, setOrigWords] = useState<WordEntry[] | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const activeCleaned = cleanedByLevel[cleanLevel];
  const activeRemoved = removedByLevel[cleanLevel];

  // Re-clean uses a 2-tap confirm so a stray click can't waste API spend.
  // We track which level is currently in "confirm" mode.
  const [confirmReclean, setConfirmReclean] = useState<CleanLevel | null>(null);
  // Reset confirm mode when the user switches levels — confirmation should
  // only apply to the level the user just clicked Re-clean on.
  useEffect(() => {
    setConfirmReclean(null);
  }, [cleanLevel]);

  // Initial load — hydrate all 3 levels at once via /api/jobs/[id]
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    fetch(`/api/jobs/${jobId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (data: {
          transcript: TranscriptRow | null;
          cleanedVersions: CleanedRow[];
        } | null) => {
          if (cancelled || !data) return;
          setTranscript(data.transcript);
          const next: CleanedByLevel = { ...EMPTY_BY_LEVEL };
          for (const row of data.cleanedVersions ?? []) {
            if (
              row.cleanLevel === "light" ||
              row.cleanLevel === "standard" ||
              row.cleanLevel === "aggressive"
            ) {
              next[row.cleanLevel] = row;
            }
          }
          setCleanedByLevel(next);
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Reflect the active level's readiness into WizardContext so Next gates
  // correctly. Runs on every level switch + every status change.
  useEffect(() => {
    update({ cleanedReady: activeCleaned?.status === "ready" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCleaned?.status, cleanLevel]);

  // Poll only when the ACTIVE level is mid-flight. Switching to another
  // level cancels this poll and (if needed) starts a new one.
  useEffect(() => {
    if (!jobId) return;
    if (activeCleaned?.status !== "cleaning") return;

    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(
          `/api/jobs/${jobId}/clean?level=${cleanLevel}`,
        );
        if (!r.ok) return;
        const data = (await r.json()) as CleanedRow;
        if (cancelled) return;
        setCleanedByLevel((prev) => ({ ...prev, [cleanLevel]: data }));
        if (data.status === "ready") {
          toast.success(
            "Cleanup complete",
            `${data.removedSegments ?? 0} segments removed at ${cleanLevel}`,
          );
        } else if (data.status === "failed") {
          toast.error(
            "Cleanup failed",
            data.errorMessage ?? "Cleanup returned an error",
          );
        }
      } catch {
        // transient — next tick will retry
      }
    };
    void tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, cleanLevel, activeCleaned?.status]);

  // Source words.json is shared across all levels — fetch once.
  useEffect(() => {
    if (!jobId || origWords || transcript?.status !== "ready") return;
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/transcript/words`)
      .then((r) => (r.ok ? (r.json() as Promise<WordsFile>) : null))
      .then((data) => {
        if (!cancelled && data) setOrigWords(data.words);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [jobId, transcript?.status, origWords]);

  // Lazy-fetch the removed-segments file for whichever level becomes ready.
  // Cached per-level so flipping back to a previously-loaded level is free.
  useEffect(() => {
    if (!jobId) return;
    if (activeCleaned?.status !== "ready") return;
    if (activeRemoved !== null) return;
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/clean/removed?level=${cleanLevel}`)
      .then((r) => (r.ok ? (r.json() as Promise<RemovedFile>) : null))
      .then((data) => {
        if (!cancelled && data) {
          setRemovedByLevel((prev) => ({
            ...prev,
            [cleanLevel]: data.segments,
          }));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [jobId, cleanLevel, activeCleaned?.status, activeCleaned?.id, activeRemoved]);

  const startCleaning = useCallback(
    async (level: CleanLevel) => {
      if (!jobId) return;
      // Optimistically mark this level's row as cleaning so the UI flips
      // straight to the progress panel without a flash of empty state.
      setCleanedByLevel((prev) => ({
        ...prev,
        [level]: prev[level]
          ? { ...prev[level]!, status: "cleaning", progress: 10 }
          : null,
      }));
      // Invalidate the cached removed segments for this level — fresh run
      // means the inspector will re-fetch when ready.
      setRemovedByLevel((prev) => ({ ...prev, [level]: null }));
      try {
        const r = await fetch(`/api/jobs/${jobId}/clean`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          const errMsg =
            (body as { error?: string }).error ?? `HTTP ${r.status}`;
          throw new Error(errMsg);
        }
        setCleanedByLevel((prev) => ({ ...prev, [level]: body as CleanedRow }));
        toast.info(
          "Cleaning started",
          `Cleaning the transcript at ${level}…`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error("Couldn't start cleaning", message);
        // Roll back the optimistic flip so the CTA shows again.
        setCleanedByLevel((prev) => {
          const cur = prev[level];
          if (!cur || cur.status !== "cleaning") return prev;
          return { ...prev, [level]: { ...cur, status: "failed" } };
        });
      }
    },
    [jobId, toast],
  );

  const setLevel = useCallback(
    (l: CleanLevel) => {
      update({ cleanLevel: l });
    },
    [update],
  );

  // --- No job ---
  if (!jobId) {
    return (
      <div className="max-w-xl mx-auto w-full text-center py-10 flex flex-col gap-4 items-center animate-reveal">
        <span className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-50 text-slate-400 border border-slate-200">
          <FileText size={24} strokeWidth={1.8} />
        </span>
        <h2 className="text-[24px] font-semibold text-slate-900">
          Upload a file first
        </h2>
        <p className="text-[14.5px] text-slate-500 max-w-md">
          Step 4 cleans the transcript produced by Step 3. Head back to Upload
          to get started.
        </p>
        <Link
          href="#"
          onClick={(e) => {
            e.preventDefault();
            update({ step: 1 });
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[14.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors shadow-sm"
        >
          <ArrowLeft size={13} strokeWidth={2} />
          Back to Upload
        </Link>
      </div>
    );
  }

  // --- Transcript not ready: send back to step 3 ---
  if (!transcript || transcript.status !== "ready") {
    return (
      <div className="max-w-xl mx-auto w-full text-center py-10 flex flex-col gap-4 items-center animate-reveal">
        <span className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-50 text-slate-400 border border-slate-200">
          <FileText size={24} strokeWidth={1.8} />
        </span>
        <h2 className="text-[24px] font-semibold text-slate-900">
          Transcribe first
        </h2>
        <p className="text-[14.5px] text-slate-500 max-w-md">
          Cleanup needs the Step 3 transcript before it can run.
        </p>
        <Link
          href="#"
          onClick={(e) => {
            e.preventDefault();
            update({ step: 3 });
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[14.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors shadow-sm"
        >
          <ArrowLeft size={13} strokeWidth={2} />
          Back to Transcribe
        </Link>
      </div>
    );
  }

  // All flags below are about the ACTIVE level only — a Standard run
  // mid-flight does not affect the Light/Aggressive panes the user sees
  // when they flip levels.
  const isCleaning = activeCleaned?.status === "cleaning";
  const isReady = activeCleaned?.status === "ready";
  const isFailed = activeCleaned?.status === "failed";
  const progress = activeCleaned?.progress ?? 0;

  // Has THIS level ever been run? Used to decide whether to show the CTA.
  // A `pending` row counts as "not run yet" — it can be left over from
  // a stale-claim recovery / manual reset. Without this, a pending row
  // would hide the CTA AND the Re-clean card, leaving the user with no
  // way to start cleaning.
  const hasActiveRow =
    activeCleaned !== null && activeCleaned.status !== "pending";

  // Are any other levels currently mid-flight? We block starting another
  // run while one is in progress so we don't double-spend on GPT-4o.
  const anyLevelCleaning = (
    Object.values(cleanedByLevel) as Array<CleanedRow | null>
  ).some((r) => r?.status === "cleaning");

  return (
    <div className="max-w-6xl mx-auto w-full flex flex-col gap-7 animate-reveal">
      <StepHeader
        step={4}
        title="Clean the transcript"
        description="We flag filler, admin chatter, and tangents — your real transcript stays word-aligned with the audio."
        actions={
          <div className="flex items-center gap-2">
            <Chip
              icon={<Sparkles size={11} strokeWidth={2} />}
              from="from-fuchsia-500"
              to="to-pink-500"
              softFrom="from-fuchsia-50"
              softTo="to-pink-50"
            >
              cleanup
            </Chip>
            <Chip
              icon={<Languages size={11} strokeWidth={2} />}
              from="from-indigo-500"
              to="to-blue-500"
              softFrom="from-indigo-50"
              softTo="to-blue-50"
            >
              {transcript.language?.toUpperCase() ?? "AUTO"}
            </Chip>
          </div>
        }
      />

      {/* 1. Source transcript card */}
      <SourceTranscriptCard transcript={transcript} />

      {/* 2. Cleaning level selector */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.05 }}
        className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-5"
      >
        <p className="text-[13.5px] text-slate-500 font-semibold uppercase tracking-wide mb-3.5 flex items-center gap-1.5">
          <Wand2 size={13} strokeWidth={2} />
          Cleaning level
        </p>
        <div className="grid grid-cols-1 gap-3">
          {/* Light and Standard cleaning levels were removed — Aggressive
              is the only level the UI exposes now. The CleanLevel type
              and backend still support all three values for backwards
              compatibility with existing DB rows; we just don't render
              picker tiles for the other two. */}
          {(["aggressive"] as CleanLevel[]).map((l) => {
            const active = cleanLevel === l;
            const meta = LEVEL_META[l];
            const Icon = meta.icon;
            const row = cleanedByLevel[l];
            // Per-level status pill: "ready" / "cleaning" / nothing yet.
            const statusPill =
              row?.status === "ready"
                ? { text: "Ready", cls: "bg-emerald-50 text-emerald-700 border-emerald-100" }
                : row?.status === "cleaning"
                  ? { text: `${row.progress}%`, cls: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-100" }
                  : row?.status === "failed"
                    ? { text: "Failed", cls: "bg-rose-50 text-rose-700 border-rose-100" }
                    : null;
            return (
              <motion.button
                key={l}
                whileHover={!active ? { y: -2 } : undefined}
                whileTap={{ scale: 0.98 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
                type="button"
                onClick={() => setLevel(l)}
                // Lock the selector only while THIS level is cleaning;
                // switching to another level is allowed otherwise.
                disabled={isCleaning && active}
                className={`relative overflow-hidden text-left rounded-xl border p-4 transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                  active
                    ? `border-indigo-500 bg-gradient-to-br ${meta.softFrom} via-white ${meta.softTo} ring-2 ring-indigo-100 shadow-[0_4px_18px_-4px_rgba(99,102,241,0.3)]`
                    : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_8px_20px_-10px_rgba(15,23,42,0.15)]"
                }`}
              >
                {active && (
                  <div
                    aria-hidden
                    className={`absolute -right-8 -top-8 w-24 h-24 rounded-full bg-gradient-to-br ${meta.from} ${meta.to} opacity-20 blur-2xl`}
                  />
                )}
                <div className="relative flex items-start justify-between mb-3">
                  <span
                    className={`flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${meta.from} ${meta.to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_12px_-4px_rgba(15,23,42,0.3)]`}
                  >
                    <Icon size={18} strokeWidth={2} />
                  </span>
                  <span
                    className={`flex items-center justify-center w-5 h-5 rounded-full border-2 ${
                      active
                        ? "border-indigo-600 bg-indigo-600"
                        : "border-slate-300"
                    }`}
                  >
                    {active && (
                      <span className="w-2 h-2 rounded-full bg-white" />
                    )}
                  </span>
                </div>
                <div className="relative flex items-center justify-between gap-2">
                  <p className="text-[17px] font-semibold text-slate-900">
                    {meta.label}
                  </p>
                  {statusPill && (
                    <span
                      className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border ${statusPill.cls}`}
                    >
                      {statusPill.text}
                    </span>
                  )}
                </div>
                <p
                  className={`relative text-[14.5px] mt-1 ${
                    active ? "text-slate-600" : "text-slate-500"
                  }`}
                >
                  {meta.caption}
                </p>
              </motion.button>
            );
          })}
        </div>
      </motion.div>

      {/* 3. CTA — only when THIS level has never been run */}
      {!hasActiveRow && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-fuchsia-50/60 via-white to-pink-50/40 p-6 flex items-center gap-5 flex-wrap"
        >
          <div
            aria-hidden
            className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-fuchsia-500/10 to-pink-500/10 blur-3xl"
          />
          <div className="relative flex-1 min-w-[220px]">
            <p className="text-[17px] font-semibold text-slate-900 leading-snug">
              Ready to clean at{" "}
              <span className="capitalize">{LEVEL_META[cleanLevel].label}</span>
            </p>
            <p className="text-[13.5px] text-slate-500 mt-1 leading-relaxed">
              We&rsquo;ll scan the transcript and flag spans to remove.
              Word-level timing stays intact for Steps 5 + 6.
            </p>
          </div>
          <motion.button
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={() => startCleaning(cleanLevel)}
            disabled={anyLevelCleaning}
            className="relative inline-flex items-center gap-2 px-5 py-3 rounded-lg text-[15px] font-medium text-white bg-gradient-to-br from-fuchsia-600 via-pink-600 to-rose-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(217,70,239,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(217,70,239,0.6)] transition-shadow disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <Sparkles size={14} strokeWidth={2} />
            Clean transcript
            <ArrowRight size={14} strokeWidth={2.2} />
          </motion.button>
        </motion.div>
      )}

      {/* 3b. Re-clean card — once the active level has a ready row.
          Two-tap confirm guards against accidental API spend. */}
      {isReady && activeCleaned && (
        <RecleanCard
          level={cleanLevel}
          row={activeCleaned}
          confirmOpen={confirmReclean === cleanLevel}
          onAskConfirm={() => setConfirmReclean(cleanLevel)}
          onCancel={() => setConfirmReclean(null)}
          onConfirm={() => {
            setConfirmReclean(null);
            void startCleaning(cleanLevel);
          }}
          disabled={anyLevelCleaning}
        />
      )}

      {/* 4. Progress panel — only while THIS level is in flight */}
      {isCleaning && (
        <ProgressPanel progress={progress} ready={false} level={cleanLevel} />
      )}

      {/* 5. Failure */}
      {isFailed && activeCleaned && (
        <FailurePanel
          message={activeCleaned.errorMessage ?? "Cleanup exited with an error"}
          code={activeCleaned.errorCode ?? null}
          onRetry={() => startCleaning(cleanLevel)}
        />
      )}

      {/* 6. Stats grid — only when the active level is ready */}
      {isReady && activeCleaned && (
        <StatsGrid
          original={activeCleaned.originalWords ?? 0}
          cleaned={activeCleaned.cleanedWords ?? 0}
          removed={activeCleaned.removedSegments ?? 0}
          removedDurSec={activeCleaned.removedDurSec ?? 0}
        />
      )}

      {/* 7. Side-by-side diff */}
      {isReady && activeCleaned && (
        <DiffView
          rawText={transcript.rawText ?? ""}
          words={origWords}
          removed={activeRemoved}
          cleanedText={activeCleaned.cleanedText ?? ""}
          ready={isReady}
        />
      )}

      {/* 8. Removed-segments inspector */}
      {isReady && activeRemoved && activeRemoved.length > 0 && (
        <RemovedInspector
          segments={activeRemoved}
          open={inspectorOpen}
          onToggle={() => setInspectorOpen((v) => !v)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source transcript card
// ---------------------------------------------------------------------------

function SourceTranscriptCard({ transcript }: { transcript: TranscriptRow }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-5"
    >
      <div
        aria-hidden
        className="absolute -right-10 -top-10 w-32 h-32 rounded-full bg-gradient-to-br from-fuchsia-500/8 to-pink-500/8 blur-2xl"
      />
      <div className="relative flex items-start gap-4">
        <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-fuchsia-500 via-pink-500 to-rose-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(217,70,239,0.4)]">
          <FileText size={22} strokeWidth={1.8} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[11.5px] text-slate-500 uppercase tracking-wide font-semibold mb-0.5">
            Source transcript
          </p>
          <p className="text-[17px] font-semibold text-slate-900 break-all leading-snug">
            From Step 3 · transcript
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <MiniMeta
              icon={<FileText size={12} strokeWidth={2} />}
              label="Words"
              value={(transcript.wordCount ?? 0).toLocaleString()}
            />
            <MiniMeta
              icon={<Clock size={12} strokeWidth={2} />}
              label="Duration"
              value={
                transcript.durationSec
                  ? formatDuration(transcript.durationSec)
                  : "—"
              }
            />
            <MiniMeta
              icon={<Languages size={12} strokeWidth={2} />}
              label="Language"
              value={transcript.language?.toUpperCase() ?? "AUTO"}
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function MiniMeta({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-400">{icon}</span>
      <div>
        <p className="text-[11px] text-slate-500 leading-tight">{label}</p>
        <p className="text-[14px] font-semibold text-slate-900 nums leading-tight">
          {value}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress panel
// ---------------------------------------------------------------------------

function ProgressPanel({
  progress,
  ready,
  level,
}: {
  progress: number;
  ready: boolean;
  level: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-fuchsia-50/40 via-white to-pink-50/30 shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-6"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-fuchsia-500/10 to-pink-500/10 blur-3xl"
      />
      <div className="relative flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span
            className={`flex items-center justify-center w-10 h-10 rounded-xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] ${
              ready
                ? "bg-gradient-to-br from-emerald-500 to-teal-600"
                : "bg-gradient-to-br from-fuchsia-500 via-pink-500 to-rose-500"
            }`}
          >
            {ready ? (
              <Check size={17} strokeWidth={2.4} />
            ) : (
              <Loader2 size={17} strokeWidth={2} className="animate-spin-slow" />
            )}
          </span>
          <div>
            <p className="text-[15.5px] text-slate-900 font-semibold leading-tight">
              {ready ? "Cleanup complete" : "Reading the transcript…"}
            </p>
            <p className="text-[13.5px] text-slate-500 leading-tight mt-0.5">
              {ready
                ? `Level: ${level} — Next is unlocked`
                : "Identifying filler, admin chatter, and tangents"}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[22px] font-semibold text-slate-900 nums leading-none">
            {progress}%
          </span>
        </div>
      </div>
      <div className="relative h-2 bg-slate-100 rounded-full overflow-hidden">
        <motion.div
          initial={{ width: "0%" }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.3 }}
          className={`h-full rounded-full ${
            ready
              ? "bg-gradient-to-r from-emerald-500 to-teal-500 shadow-[0_0_12px_rgba(16,185,129,0.45)]"
              : "shimmer-bar"
          }`}
        />
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Stats grid
// ---------------------------------------------------------------------------

function StatsGrid({
  original,
  cleaned,
  removed,
  removedDurSec,
}: {
  original: number;
  cleaned: number;
  removed: number;
  removedDurSec: number;
}) {
  const removedPct = original === 0 ? 0 : ((original - cleaned) / original) * 100;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard
        label="Original"
        value={original.toLocaleString()}
        unit="words"
        icon={<FileText size={14} strokeWidth={2} />}
        from="from-slate-500"
        to="to-slate-700"
        softFrom="from-slate-50"
        softTo="to-white"
      />
      <StatCard
        label="After cleaning"
        value={cleaned.toLocaleString()}
        unit="words"
        icon={<Sparkles size={14} strokeWidth={2} />}
        from="from-indigo-500"
        to="to-fuchsia-500"
        softFrom="from-indigo-50"
        softTo="to-fuchsia-50"
        accent
      />
      <StatCard
        label="Removed"
        value={`${removedPct.toFixed(1)}`}
        unit={`% · ${removed} spans`}
        icon={<Flame size={14} strokeWidth={2} />}
        from="from-rose-500"
        to="to-orange-500"
        softFrom="from-rose-50"
        softTo="to-orange-50"
        accent
      />
      <StatCard
        label="Time saved"
        value={formatDuration(removedDurSec)}
        unit=""
        icon={<Clock size={14} strokeWidth={2} />}
        from="from-emerald-500"
        to="to-teal-500"
        softFrom="from-emerald-50"
        softTo="to-teal-50"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  unit,
  icon,
  from,
  to,
  softFrom,
  softTo,
  accent = false,
}: {
  label: string;
  value: string;
  unit?: string;
  icon: React.ReactNode;
  from: string;
  to: string;
  softFrom: string;
  softTo: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br ${softFrom} via-white ${softTo} p-4 shadow-[0_1px_2px_rgba(9,9,11,0.04)]`}
    >
      <div
        aria-hidden
        className={`absolute -right-8 -top-8 w-20 h-20 rounded-full bg-gradient-to-br ${from} ${to} opacity-10 blur-2xl`}
      />
      <div className="relative flex items-center gap-2 mb-2.5">
        <span
          className={`flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
        >
          {icon}
        </span>
        <span className="text-[13px] text-slate-600 font-medium">{label}</span>
      </div>
      <div className="relative flex items-baseline gap-1.5">
        <span
          className={`text-[28px] font-semibold leading-none nums ${
            accent
              ? `bg-gradient-to-br ${from} ${to} bg-clip-text text-transparent`
              : "text-slate-900"
          }`}
        >
          {value}
        </span>
        {unit && (
          <span className="text-[13.5px] text-slate-500 font-medium">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff view
// ---------------------------------------------------------------------------

function isInsideAnyRange(t: number, segments: RemovedSegment[]): boolean {
  for (const s of segments) {
    if (t >= s.start_sec && t < s.end_sec) return true;
  }
  return false;
}

function DiffView({
  rawText,
  words,
  removed,
  cleanedText,
  ready,
}: {
  rawText: string;
  words: WordEntry[] | null;
  removed: RemovedSegment[] | null;
  cleanedText: string;
  ready: boolean;
}) {
  // If we have words + removed, render strikethroughs at the word level.
  // Otherwise fall back to the plain rawText string.
  const annotatedRaw = useMemo(() => {
    if (!words || !removed) return null;
    return words.map((w, i) => ({
      key: i,
      text: w.word,
      stripped: isInsideAnyRange(w.start, removed),
    }));
  }, [words, removed]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
      className="grid grid-cols-1 lg:grid-cols-2 gap-4"
    >
      <DiffPane title="Raw transcript" variant="raw">
        {annotatedRaw ? (
          annotatedRaw.map((w) => (
            <span
              key={w.key}
              className={w.stripped ? "diff-remove" : undefined}
            >
              {w.text}{" "}
            </span>
          ))
        ) : (
          <span>{rawText}</span>
        )}
      </DiffPane>
      <DiffPane
        title="Cleaned transcript"
        variant="cleaned"
        note={ready ? "Ready" : "Updating…"}
      >
        {ready ? (
          <span>{cleanedText}</span>
        ) : (
          <span className="text-slate-400 italic">Applying changes…</span>
        )}
      </DiffPane>
    </motion.div>
  );
}

function DiffPane({
  title,
  variant,
  note,
  children,
}: {
  title: string;
  variant: "raw" | "cleaned";
  note?: string;
  children: React.ReactNode;
}) {
  const isRaw = variant === "raw";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] overflow-hidden flex flex-col">
      <div
        className={`flex items-center justify-between px-5 py-3 border-b border-slate-200 ${
          isRaw
            ? "bg-gradient-to-b from-rose-50/40 to-white"
            : "bg-gradient-to-b from-indigo-50/40 to-white"
        }`}
      >
        <span className="flex items-center gap-2.5 text-[15px] font-semibold text-slate-800">
          <span
            className={`flex items-center justify-center w-7 h-7 rounded-lg text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] ${
              isRaw
                ? "bg-gradient-to-br from-slate-500 to-slate-700"
                : "bg-gradient-to-br from-indigo-500 to-fuchsia-500"
            }`}
          >
            {isRaw ? (
              <FileText size={14} strokeWidth={2} />
            ) : (
              <Sparkles size={14} strokeWidth={2} />
            )}
          </span>
          {title}
        </span>
        {note && (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-emerald-700 font-semibold px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-100">
            <Check size={11} strokeWidth={2.5} />
            {note}
          </span>
        )}
      </div>
      <div className="h-[380px] overflow-y-auto px-5 py-4 text-[16.5px] leading-[1.75] text-slate-700 bg-gradient-to-b from-white to-slate-50/40">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Removed-segments inspector
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, "0");
}
function mmss(sec: number): string {
  return `${pad2(sec / 60)}:${pad2(sec % 60)}`;
}

function RemovedInspector({
  segments,
  open,
  onToggle,
}: {
  segments: RemovedSegment[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] overflow-hidden"
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
            <Tag size={15} strokeWidth={2} />
          </span>
          <div>
            <p className="text-[15px] font-semibold text-slate-900 leading-tight">
              What was removed
            </p>
            <p className="text-[12.5px] text-slate-500 leading-tight mt-0.5">
              {segments.length} span{segments.length === 1 ? "" : "s"} flagged
              for removal
            </p>
          </div>
        </div>
        {open ? (
          <ChevronUp size={16} strokeWidth={2} className="text-slate-400" />
        ) : (
          <ChevronDown size={16} strokeWidth={2} className="text-slate-400" />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden border-t border-slate-200"
          >
            <ul className="max-h-[360px] overflow-y-auto divide-y divide-slate-100">
              {segments.map((s, i) => {
                const meta = CATEGORY_TONE[s.category];
                return (
                  <li
                    key={i}
                    className="px-5 py-3 flex items-start gap-3 hover:bg-slate-50 transition-colors"
                  >
                    <span className="font-mono text-[12.5px] text-violet-600 nums tabular-nums shrink-0 pt-0.5">
                      {mmss(s.start_sec)} → {mmss(s.end_sec)}
                    </span>
                    <span
                      className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide border ${meta.tone}`}
                    >
                      {meta.label}
                    </span>
                    <span className="flex-1 text-[13.5px] text-slate-700 leading-snug">
                      {s.reason}
                    </span>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Re-clean card — confirm-before-spend banner that replaces the bare
// "Re-clean" link button. Shows the active level's stats and a 2-tap
// confirmation flow with cost disclosure so users don't accidentally burn
// API quota on a duplicate run.
// ---------------------------------------------------------------------------

function RecleanCard({
  level,
  row,
  confirmOpen,
  onAskConfirm,
  onCancel,
  onConfirm,
  disabled,
}: {
  level: CleanLevel;
  row: CleanedRow;
  confirmOpen: boolean;
  onAskConfirm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  disabled: boolean;
}) {
  const meta = LEVEL_META[level];
  const cleanedWords = row.cleanedWords ?? 0;
  const removedSpans = row.removedSegments ?? 0;
  const removedDur = row.removedDurSec ?? 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50/40 via-white to-teal-50/30 shadow-[0_1px_2px_rgba(9,9,11,0.04)]"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-44 h-44 rounded-full bg-gradient-to-br from-emerald-500/8 to-teal-500/8 blur-3xl pointer-events-none"
      />

      <div className="relative flex items-center gap-4 flex-wrap p-4 pl-5">
        {/* Level icon + summary */}
        <span
          className={`flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${meta.from} ${meta.to} text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_12px_-4px_rgba(15,23,42,0.3)]`}
        >
          <Check size={16} strokeWidth={2.4} />
        </span>
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-2 mb-0.5">
            <p className="text-[14.5px] font-semibold text-slate-900 leading-tight capitalize">
              {meta.label} cleanup ready
            </p>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-emerald-50 text-emerald-700 border-emerald-100">
              <Check size={9} strokeWidth={2.6} className="mr-0.5" />
              Saved
            </span>
          </div>
          <p className="text-[12.5px] text-slate-500 leading-tight nums">
            {cleanedWords.toLocaleString()} words ·{" "}
            {removedSpans} {removedSpans === 1 ? "span" : "spans"} removed ·{" "}
            {formatDuration(removedDur)} time saved
          </p>
        </div>

        {/* Action area — morphs between idle and confirm */}
        <AnimatePresence mode="wait" initial={false}>
          {confirmOpen ? (
            <motion.div
              key="confirm"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="flex items-center gap-2.5 shrink-0"
            >
              <span className="hidden md:inline text-[12.5px] text-slate-500 nums">
                ~$0.07
              </span>
              <button
                type="button"
                onClick={onCancel}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <motion.button
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.97 }}
                type="button"
                onClick={onConfirm}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-medium text-white bg-gradient-to-br from-rose-500 via-rose-500 to-orange-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_3px_10px_-2px_rgba(244,63,94,0.45)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_6px_16px_-3px_rgba(244,63,94,0.6)] transition-shadow disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <RefreshCw size={12} strokeWidth={2.4} />
                Replace run
              </motion.button>
            </motion.div>
          ) : (
            <motion.button
              key="idle"
              whileHover={!disabled ? { y: -1 } : undefined}
              whileTap={{ scale: 0.97 }}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              type="button"
              onClick={onAskConfirm}
              disabled={disabled}
              title={`Re-run cleanup on the ${level} level (~$0.07)`}
              className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw size={12} strokeWidth={2} />
              Re-clean <span className="capitalize">{level}</span>
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Failure panel — surfaces GPT/network errors with a prominent retry CTA.
// ---------------------------------------------------------------------------

function FailurePanel({
  message,
  code,
  onRetry,
}: {
  message: string;
  code: string | null;
  onRetry: () => void;
}) {
  const isAuth = code === "E_OPENAI_AUTH";
  const isNetwork = code === "E_OPENAI_NETWORK";
  const isResponse = code === "E_OPENAI_RESPONSE";

  // Per-error hint above the message — gives the user a hint about the
  // likely fix rather than just dumping the raw error string.
  const hint = isAuth
    ? "Set OPENAI_API_KEY in web/.env.local and restart the dev server."
    : isNetwork
      ? "Service was unreachable after a few retries. Usually transient — try again in a moment."
      : isResponse
        ? "Cleanup returned malformed output. Re-running usually clears this up."
        : null;

  const title = isAuth
    ? "API key missing or invalid"
    : isNetwork
      ? "Couldn't reach service"
      : isResponse
        ? "Cleanup returned bad output"
        : "Cleanup failed";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50 via-white to-orange-50/60 shadow-[0_1px_2px_rgba(9,9,11,0.04)]"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-rose-500/12 to-orange-500/12 blur-3xl pointer-events-none"
      />
      <div className="relative p-5 flex items-start gap-4 flex-wrap">
        <span className="flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-rose-500 to-orange-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(244,63,94,0.45)]">
          <AlertTriangle size={18} strokeWidth={2.2} />
        </span>
        <div className="flex-1 min-w-[220px]">
          <p className="text-[15.5px] font-semibold text-rose-900 leading-tight">
            {title}
          </p>
          {hint && (
            <p className="text-[13.5px] text-rose-700/90 mt-1 leading-relaxed">
              {hint}
            </p>
          )}
          <details className="mt-2 group">
            <summary className="cursor-pointer text-[12px] text-rose-700/70 hover:text-rose-700 select-none inline-flex items-center gap-1">
              <ChevronDown
                size={11}
                strokeWidth={2.2}
                className="transition-transform group-open:rotate-180"
              />
              Show error details
            </summary>
            <p className="mt-1.5 text-[12.5px] font-mono text-rose-800/80 break-words bg-white/60 border border-rose-100 rounded-md px-2.5 py-1.5">
              {code ? <span className="text-rose-600 mr-1">{code}</span> : null}
              {message}
            </p>
          </details>
        </div>

        <motion.button
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.97 }}
          type="button"
          onClick={onRetry}
          title={isAuth ? "Retry after setting OPENAI_API_KEY and restarting" : "Retry cleanup (~$0.07)"}
          className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-[14px] font-medium text-white bg-gradient-to-br from-rose-600 via-rose-600 to-orange-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-3px_rgba(244,63,94,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(244,63,94,0.65)] transition-shadow disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-3px_rgba(244,63,94,0.5)]"
        >
          <RefreshCw size={13} strokeWidth={2.2} />
          Retry cleanup
        </motion.button>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Decorative chip (matches Step 3)
// ---------------------------------------------------------------------------

function Chip({
  icon,
  children,
  from,
  to,
  softFrom,
  softTo,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  from: string;
  to: string;
  softFrom: string;
  softTo: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gradient-to-br ${softFrom} via-white ${softTo} border border-slate-200 text-slate-700 text-[13.5px] font-medium shadow-[0_1px_2px_rgba(9,9,11,0.03)]`}
    >
      <span
        className={`flex items-center justify-center w-4 h-4 rounded-full bg-gradient-to-br ${from} ${to} text-white`}
      >
        {icon}
      </span>
      {children}
    </span>
  );
}
