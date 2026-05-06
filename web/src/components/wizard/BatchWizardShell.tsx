"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  FileVideo,
  ListVideo,
  Loader2,
  Play,
  Clock,
  Check,
  AlertTriangle,
} from "lucide-react";
import { useWizard } from "./WizardContext";
import { Topbar } from "./Topbar";
import { Stepper } from "./Stepper";
import { StepHeader } from "./StepHeader";
import {
  AudioSection,
  TranscriptSection,
  CleanSection,
  ChunksSection,
  ChunkRowEditable,
  type ChunkRow,
} from "./ChildInlineDetail";
import { formatBytes, formatDuration } from "@/lib/utils";

type ChildRow = {
  id: string;
  sourceName: string;
  sourceDurationSec: number | null;
  sourceSize?: number;
  status: { status: string; progress: number } | null;
};

type ParentData = {
  parent: {
    id: string;
    sourceName: string;
    sourceDurationSec: number | null;
    sourceSize?: number;
    kind: string;
    createdAt: string;
  };
  children: ChildRow[];
};

/**
 * Wizard chrome (Topbar + Stepper + Footer) for a batch / playlist parent.
 *
 * The single-job wizard runs one stage per page. For parents we keep the
 * same step model but each step page renders a LIST of children with
 * that step's content (audio players, transcript text, cleanup stats,
 * chunks). Step navigation is purely visual — the actual processing is
 * driven by the per-child runners and the "Process all" CTA.
 */
export function BatchWizardShell({
  parentId,
  kind,
}: {
  parentId: string;
  kind: "batch" | "playlist";
}) {
  const { step, furthestReached, update } = useWizard();
  const [data, setData] = useState<ParentData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cleanup level is locked to Aggressive — Light and Standard were
  // removed so users always get the strictest filtering. Kept as state
  // (not a const) so the rest of the props pipeline stays unchanged
  // and we can re-introduce a picker later without restructuring.
  const [cleanLevel] = useState<"light" | "standard" | "aggressive">(
    "aggressive",
  );
  const [targetMin, setTargetMin] = useState(20);

  // Hydrate WizardContext so the Stepper/Topbar can read consistent state.
  useEffect(() => {
    update({
      jobId: parentId,
      // Allow the user to click any step in the stepper.
      furthestReached: 5,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId]);

  // Polling: keep refreshing the children list until everyone is at
  // render/done/failed.
  useEffect(() => {
    let cancelled = false;
    const endpoint =
      kind === "batch"
        ? `/api/jobs/${parentId}/batch`
        : `/api/jobs/${parentId}/playlist`;

    const load = async () => {
      try {
        const r = await fetch(endpoint);
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        const payload = (await r.json()) as ParentData;
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const id = window.setInterval(() => {
      setData((prev) => {
        if (
          prev &&
          prev.children.some((c) => {
            const s = c.status?.status;
            return s !== "render" && s !== "done" && s !== "failed";
          })
        ) {
          void load();
        }
        return prev;
      });
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [parentId, kind]);

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <Topbar />
      <Stepper />
      <main className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="min-h-full"
          >
            <div className="max-w-4xl mx-auto w-full px-6 py-10 md:py-12 flex flex-col gap-6">
              {error && (
                <p className="text-[14px] text-rose-700">{error}</p>
              )}
              {!data && !error && (
                <div className="text-center py-12">
                  <Loader2
                    size={20}
                    strokeWidth={2}
                    className="inline animate-spin-slow text-slate-400"
                  />
                </div>
              )}
              {data && (
                <StepView step={step} parent={data.parent} kind={kind}>
                  <ChildList
                    parentId={parentId}
                    children={data.children}
                    step={step}
                    cleanLevel={cleanLevel}
                    targetMin={targetMin}
                    onTargetMinChange={setTargetMin}
                  />
                </StepView>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </main>
      <BatchFooter
        step={step}
        furthestReached={furthestReached}
        onChangeStep={(s) => update({ step: s })}
      />
    </div>
  );
}

// ── Step header / framing per step ────────────────────────────────────
function StepView({
  step,
  parent,
  kind,
  children,
}: {
  step: number;
  parent: ParentData["parent"];
  kind: "batch" | "playlist";
  children: React.ReactNode;
}) {
  if (step === 1) {
    return (
      <>
        <StepHeader
          step={1}
          title={kind === "batch" ? "Multi-file batch" : "YouTube playlist"}
          description={
            kind === "batch"
              ? "All files were uploaded together. Each one runs through the pipeline independently."
              : "All videos were pulled from a single playlist URL. Each one runs through the pipeline independently."
          }
        />
        <ParentSummaryCard parent={parent} kind={kind} />
        {children}
      </>
    );
  }
  if (step === 2) {
    return (
      <>
        <StepHeader
          step={2}
          title="Audio"
          description="Extracted 48 kHz mono mp3 for every video. Click play to scrub."
        />
        {children}
      </>
    );
  }
  if (step === 3) {
    return (
      <>
        <StepHeader
          step={3}
          title="Transcript"
          description="Word-level timestamped transcript per video. Click Process all on the next step to start downstream stages if you haven't yet."
        />
        {children}
      </>
    );
  }
  if (step === 4) {
    return (
      <>
        <StepHeader
          step={4}
          title="Cleanup"
          description="Filler / admin / tangents flagged for removal at the Standard level. Open any video in the full wizard to compare other levels."
        />
        {children}
      </>
    );
  }
  if (step === 5) {
    return (
      <>
        <StepHeader
          step={5}
          title="Topic chunks"
          description="Each video split into ~20-min chunks at real topic boundaries. Open in full wizard to override the target length."
        />
        {children}
      </>
    );
  }
  return (
    <>
      <StepHeader
        step={6}
        title="Avatar render"
        description="Coming soon — HeyGen integration not yet built."
      />
      <p className="text-[14px] text-slate-500 italic">
        Render is the final step and ships once the avatar pipeline is live.
      </p>
    </>
  );
}

function ParentSummaryCard({
  parent,
  kind,
}: {
  parent: ParentData["parent"];
  kind: "batch" | "playlist";
}) {
  const Icon = kind === "batch" ? FileVideo : ListVideo;
  const totalSize = parent.sourceSize ? formatBytes(Number(parent.sourceSize)) : null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-indigo-50/40 via-white to-fuchsia-50/30 p-5 flex items-start gap-4 flex-wrap">
      <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-fuchsia-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
        <Icon size={22} strokeWidth={1.8} />
      </span>
      <div className="flex-1 min-w-[200px]">
        <p className="text-[12px] text-indigo-700 uppercase tracking-wide font-semibold mb-0.5">
          {kind === "batch" ? "Multi-file batch" : "Playlist"}
        </p>
        <h2 className="text-[20px] font-semibold tracking-tight text-slate-900 leading-tight break-words">
          {parent.sourceName}
        </h2>
        <p className="text-[13px] text-slate-500 mt-1 nums leading-tight">
          {parent.sourceDurationSec
            ? `${formatDuration(parent.sourceDurationSec)} total`
            : ""}
          {totalSize ? ` · ${totalSize}` : ""}
        </p>
      </div>
    </div>
  );
}

// ── Children list — renders one row per child, with the step's
//    content inline below each child header. ────────────────────────────
function ChildList({
  parentId,
  children,
  step,
  cleanLevel,
  targetMin,
  onTargetMinChange,
}: {
  parentId: string;
  children: ChildRow[];
  step: number;
  cleanLevel: "light" | "standard" | "aggressive";
  targetMin: number;
  onTargetMinChange: (n: number) => void;
}) {
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);

  const pending = useMemo(
    () =>
      children.filter((c) => {
        const s = c.status?.status;
        return s !== "render" && s !== "done" && s !== "failed";
      }),
    [children],
  );

  async function startProcessAll() {
    if (processing) return;
    setProcessing(true);
    setProcessError(null);
    try {
      const r = await fetch(`/api/jobs/${parentId}/process-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cleanLevel, targetMin }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : String(err));
      setProcessing(false);
    }
  }

  // Step 1 doesn't need a "Process all" CTA — it's the upload summary.
  // Steps 2-5 show the per-child content. Step 6 is just a placeholder.
  if (step === 6) return null;

  return (
    <div className="flex flex-col gap-4">
      {/* Step 5 — target chunk length */}
      {step === 5 && (
        <SelectorRow
          title="Target chunk length"
          help="Each video is split into chunks no longer than this. Cleanup level above is also locked in here so the chunks come from the right cleaned source."
        >
          {[5, 10, 15, 20, 25, 30].map((n) => (
            <SelectorButton
              key={n}
              active={n === targetMin}
              onClick={() => onTargetMinChange(n)}
            >
              {n} min
            </SelectorButton>
          ))}
        </SelectorRow>
      )}

      {/* Process-all CTA — only visible on steps 3-5. Step 2's audio
          extraction runs automatically the moment children are created
          (ffmpeg semaphore serializes), so there's nothing to opt into
          there. The cascade meaningfully starts at transcribe → clean →
          split, hence step 3 is where the button first becomes useful. */}
      {step >= 3 && step <= 5 && pending.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-indigo-50/60 via-white to-fuchsia-50/40 p-4 flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <p className="text-[14px] font-semibold text-slate-900 leading-tight">
              Run the pipeline for everyone
            </p>
            <p className="text-[12px] text-slate-500 mt-0.5 leading-snug">
              Transcribe → cleanup → split for all {pending.length} pending
              video{pending.length === 1 ? "" : "s"}. Items run one at a time.
            </p>
            {processError && (
              <p className="mt-1 text-[12px] text-rose-700">{processError}</p>
            )}
          </div>
          <motion.button
            whileHover={!processing ? { y: -1 } : undefined}
            whileTap={!processing ? { scale: 0.97 } : undefined}
            type="button"
            onClick={startProcessAll}
            disabled={processing}
            className="relative inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13.5px] font-medium text-white bg-gradient-to-br from-indigo-600 via-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(99,102,241,0.5)] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {processing ? (
              <>
                <Loader2
                  size={12}
                  strokeWidth={2.4}
                  className="animate-spin-slow"
                />
                Started
              </>
            ) : (
              <>
                <Play size={12} strokeWidth={2.4} />
                Process all {pending.length}
              </>
            )}
          </motion.button>
        </div>
      )}

      {/* Step 5 — unified deduplicated chunks view across all children.
          Each topic is shown only once (first child to produce it wins),
          with an Edit button on each row that lets the user rewrite the
          topic + transcript text and save back to the originating
          child's chunk row. */}
      {step === 5 ? (
        <UnifiedChunksView
          children={children}
          cleanLevel={cleanLevel}
          targetMin={targetMin}
        />
      ) : (
        /* Per-child rows for steps 1-4 + 6 */
        <div className="flex flex-col gap-3">
          {children.map((c, i) => (
            <ChildRow
              key={c.id}
              child={c}
              index={i}
              step={step}
              cleanLevel={cleanLevel}
              targetMin={targetMin}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Unified deduped chunks for Step 5 ──────────────────────────────────
//
// Fetches each child's chunks in parallel and merges them into one flat
// list. When two children produce a chunk with the same topic (case-
// insensitive, whitespace-trimmed), only the first occurrence in
// playlist / batch order is kept. That removes the most common form of
// duplication a multi-video upload tends to produce.
//
// Each row is a `ChunkRowEditable` from ChildInlineDetail — same
// expand/edit UX you'd get inside a single child, but the underlying
// PATCH targets the appropriate child job's chunk endpoint via the
// jobId passed alongside.

type ChunkWithSource = ChunkRow & { jobId: string; sourceName: string };

function UnifiedChunksView({
  children,
  cleanLevel,
  targetMin,
}: {
  children: ChildRow[];
  cleanLevel: "light" | "standard" | "aggressive";
  targetMin: number;
}) {
  const [byChild, setByChild] = useState<
    Record<string, ChunkRow[] | "loading" | "none">
  >({});

  // One fetch per child, polled until status flips terminal. Polling is
  // cheap because most children's chunks endpoints return 404 until split
  // completes, after which they're cached and we stop polling.
  useEffect(() => {
    let cancelled = false;
    const intervals: number[] = [];

    for (const c of children) {
      const tick = async () => {
        try {
          const r = await fetch(
            `/api/jobs/${c.id}/chunks?level=${cleanLevel}&targetMin=${targetMin}`,
          );
          if (cancelled) return;
          if (r.status === 404) {
            setByChild((prev) =>
              prev[c.id] === undefined ? { ...prev, [c.id]: "none" } : prev,
            );
            return;
          }
          if (!r.ok) return;
          const body = (await r.json()) as {
            run: { status: string };
            chunks: ChunkRow[];
          };
          if (cancelled) return;
          setByChild((prev) => ({ ...prev, [c.id]: body.chunks }));
        } catch {
          /* transient — next tick retries */
        }
      };
      // Initial mark + first fetch.
      setByChild((prev) =>
        prev[c.id] === undefined ? { ...prev, [c.id]: "loading" } : prev,
      );
      void tick();
      // Poll every 2 s — chunks rarely change post-split, so the cost
      // is bounded.
      intervals.push(window.setInterval(tick, 2000));
    }
    return () => {
      cancelled = true;
      for (const id of intervals) window.clearInterval(id);
    };
  }, [children, cleanLevel, targetMin]);

  // Flatten + dedupe in playlist / batch order.
  const { unique, hiddenCount, totalCount } = useMemo(() => {
    const seen = new Map<string, ChunkWithSource>();
    let total = 0;
    for (const child of children) {
      const list = byChild[child.id];
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        total += 1;
        const key = c.topic.trim().toLowerCase();
        if (!key) continue;
        if (!seen.has(key)) {
          seen.set(key, {
            ...c,
            jobId: child.id,
            sourceName: child.sourceName,
          });
        }
      }
    }
    const uniqueArr = Array.from(seen.values());
    return {
      unique: uniqueArr,
      hiddenCount: total - uniqueArr.length,
      totalCount: total,
    };
  }, [children, byChild]);

  const stillLoading = children.some(
    (c) => byChild[c.id] === "loading" || byChild[c.id] === undefined,
  );
  const totalDur = unique.reduce(
    (sum, c) => sum + (c.endSec - c.startSec),
    0,
  );

  if (totalCount === 0 && stillLoading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-5 py-6 text-center">
        <Loader2
          size={18}
          strokeWidth={2}
          className="inline animate-spin-slow text-slate-400"
        />
        <p className="text-[13px] text-slate-500 mt-2">
          Waiting for chunks from {children.length} videos…
        </p>
      </div>
    );
  }
  if (totalCount === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-5 py-6 text-center">
        <p className="text-[13px] text-slate-400 italic">
          No chunks yet. Click <strong>Process all</strong> on Step 3 to
          run the cascade.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Summary header */}
      <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-rose-50/40 via-white to-orange-50/30 p-4 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <p className="text-[14px] font-semibold text-slate-900 leading-tight">
            {unique.length} unique topic{unique.length === 1 ? "" : "s"}{" "}
            across {children.length} videos
          </p>
          <p className="text-[12px] text-slate-500 mt-0.5 leading-snug">
            {totalDur > 0 ? `${formatDuration(totalDur)} of content · ` : ""}
            {hiddenCount > 0 ? (
              <>
                <span className="font-medium text-slate-700 nums">
                  {hiddenCount}
                </span>{" "}
                duplicate{hiddenCount === 1 ? "" : "s"} hidden (kept first
                occurrence)
              </>
            ) : (
              "no duplicates"
            )}
          </p>
        </div>
        {stillLoading && (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-slate-500">
            <Loader2 size={11} strokeWidth={2.4} className="animate-spin-slow" />
            still loading some videos
          </span>
        )}
      </div>

      {/* Flat deduped list */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
        {unique.map((c, i) => (
          <ChunkRowWithSource
            key={`${c.jobId}::${c.id}`}
            chunk={c}
            sourceName={c.sourceName}
            displayIndex={i}
          />
        ))}
      </div>
    </div>
  );
}

function ChunkRowWithSource({
  chunk,
  sourceName,
  displayIndex,
}: {
  chunk: ChunkWithSource;
  sourceName: string;
  displayIndex: number;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ChunkRow>(chunk);
  // Keep `current` in sync if the upstream chunk prop updates (e.g.
  // poll arrived with new data for the underlying row).
  useEffect(() => {
    setCurrent(chunk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk.id, chunk.topic, chunk.text]);

  return (
    <div className="px-1">
      {/* Source-video tag — small grey label above the chunk header */}
      {open && (
        <p className="px-3 pt-2 text-[10.5px] uppercase tracking-wide font-semibold text-slate-400">
          From: <span className="text-slate-600 normal-case font-medium">{sourceName}</span>
        </p>
      )}
      <ChunkRowEditable
        jobId={chunk.jobId}
        chunk={{ ...current, idx: displayIndex }}
        isOpen={open}
        onToggle={() => setOpen((c) => !c)}
        onSaved={(updated) => setCurrent((prev) => ({ ...prev, ...updated }))}
      />
    </div>
  );
}

function ChildRow({
  child,
  index,
  step,
  cleanLevel,
  targetMin,
}: {
  child: ChildRow;
  index: number;
  step: number;
  cleanLevel: "light" | "standard" | "aggressive";
  targetMin: number;
}) {
  const status = child.status?.status ?? "audio";
  const progress = child.status?.progress ?? 0;
  const isActiveOnThisStep = isActiveForStep(status, progress, step);

  return (
    <div
      className={`rounded-xl border bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] overflow-hidden transition-colors ${
        isActiveOnThisStep
          ? "border-indigo-300 ring-1 ring-indigo-100"
          : "border-slate-200"
      }`}
    >
      {/* Header row — index + title + duration + status pill */}
      <div className="px-5 py-3.5 flex items-center gap-4 border-b border-slate-100">
        <span className="font-mono text-[12.5px] text-slate-400 nums tabular-nums shrink-0 w-7 text-right">
          {String(index + 1).padStart(2, "0")}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[14.5px] font-semibold text-slate-900 truncate leading-snug">
            {child.sourceName}
          </p>
          <p className="text-[12px] text-slate-500 mt-0.5 leading-tight">
            {child.sourceDurationSec
              ? formatDuration(child.sourceDurationSec)
              : ""}
          </p>
        </div>
        <ChildStatusPill status={status} progress={progress} step={step} />
      </div>

      {/* Body — the relevant section for the active step */}
      <div className="p-4">
        {step === 1 && <Step1Body child={child} />}
        {step === 2 && (
          <AudioSection
            jobId={child.id}
            parentStatus={child.status?.status}
          />
        )}
        {step === 3 && (
          <TranscriptSection
            jobId={child.id}
            sourceName={child.sourceName}
            parentStatus={child.status?.status}
          />
        )}
        {step === 4 && (
          <CleanSection
            jobId={child.id}
            sourceName={child.sourceName}
            parentStatus={child.status?.status}
            level={cleanLevel}
          />
        )}
        {step === 5 && (
          <ChunksSection
            jobId={child.id}
            parentStatus={child.status?.status}
            level={cleanLevel}
            targetMin={targetMin}
          />
        )}
      </div>
    </div>
  );
}

function Step1Body({ child }: { child: ChildRow }) {
  return (
    <p className="text-[12.5px] text-slate-500">
      Uploaded ·{" "}
      {child.sourceDurationSec
        ? formatDuration(child.sourceDurationSec)
        : "duration unknown"}
      {child.sourceSize ? ` · ${formatBytes(Number(child.sourceSize))}` : ""}
    </p>
  );
}

// ── Footer with Back/Next buttons ──────────────────────────────────────
function BatchFooter({
  step,
  furthestReached,
  onChangeStep,
}: {
  step: number;
  furthestReached: number;
  onChangeStep: (s: 1 | 2 | 3 | 4 | 5 | 6) => void;
}) {
  const canBack = step > 1;
  const canNext = step < furthestReached;
  return (
    <div className="h-16 shrink-0 bg-white border-t border-slate-200">
      <div className="mx-auto max-w-6xl h-full px-6 flex items-center justify-between">
        <button
          type="button"
          onClick={() =>
            canBack && onChangeStep((step - 1) as 1 | 2 | 3 | 4 | 5 | 6)
          }
          disabled={!canBack}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-[14px] font-medium text-slate-700 hover:text-slate-900 disabled:text-slate-300 disabled:cursor-not-allowed"
        >
          <ArrowLeft size={14} strokeWidth={2.2} />
          Back
        </button>
        <button
          type="button"
          onClick={() =>
            canNext && onChangeStep((step + 1) as 1 | 2 | 3 | 4 | 5 | 6)
          }
          disabled={!canNext}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[14px] font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
        >
          Next
          <ArrowRight size={14} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}

// ── Per-child status pill ──────────────────────────────────────────────
// The job_status row tracks the cascade's current stage. We translate
// (status, progress, currentStep) into a clear pill so the user can see
// at a glance which video is being worked on RIGHT NOW. The active video
// also gets a subtle indigo border on the row container.

const STATUS_TO_NUM: Record<string, number> = {
  downloading: 1,
  audio: 2,
  transcript: 3,
  clean: 4,
  split: 5,
  render: 6,
  done: 6,
  failed: -1,
};

function isActiveForStep(
  status: string,
  progress: number,
  step: number,
): boolean {
  // "Active for this step" means: the cascade is currently working on
  // this stage AND progress > 0 (semaphore acquired, work has started).
  // Queued children sit at progress=0 and aren't visually highlighted.
  if (STATUS_TO_NUM[status] !== step) return false;
  return progress > 0 && progress < 100;
}

function ChildStatusPill({
  status,
  progress,
  step,
}: {
  status: string;
  progress: number;
  step: number;
}) {
  const childStep = STATUS_TO_NUM[status] ?? 2;

  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide border bg-rose-50 text-rose-700 border-rose-200 shrink-0">
        <AlertTriangle size={10} strokeWidth={2.6} />
        Failed
      </span>
    );
  }
  if (status === "done" || status === "render") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide border bg-emerald-50 text-emerald-700 border-emerald-200 shrink-0">
        <Check size={10} strokeWidth={2.6} />
        Done
      </span>
    );
  }

  // Past the current step on the cascade — this child has already
  // finished what the user is looking at.
  if (childStep > step) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide border bg-emerald-50 text-emerald-700 border-emerald-200 shrink-0">
        <Check size={10} strokeWidth={2.6} />
        Step {step} done
      </span>
    );
  }

  // Behind the current step — this child hasn't reached it yet.
  if (childStep < step) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide border bg-slate-50 text-slate-600 border-slate-200 shrink-0">
        <Clock size={10} strokeWidth={2.4} />
        Waiting · Step {childStep}
      </span>
    );
  }

  // Right on the current step. Either queued or running.
  if (progress === 0) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide border bg-slate-50 text-slate-600 border-slate-200 shrink-0">
        <Clock size={10} strokeWidth={2.4} />
        Queued
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide border bg-indigo-50 text-indigo-700 border-indigo-200 shrink-0 nums tabular-nums">
      <Loader2 size={10} strokeWidth={2.6} className="animate-spin-slow" />
      {LABELS[step] ?? "Working"} · {progress}%
    </span>
  );
}

const LABELS: Record<number, string> = {
  1: "Downloading",
  2: "Extracting",
  3: "Transcribing",
  4: "Cleaning",
  5: "Splitting",
  6: "Rendering",
};

// ── Step 4 / Step 5 selector helpers ──────────────────────────────────
function SelectorRow({
  title,
  help,
  children,
}: {
  title: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col gap-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        <p className="text-[13px] font-semibold text-slate-900">{title}</p>
        <p className="text-[12px] text-slate-500 leading-snug">{help}</p>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">{children}</div>
    </div>
  );
}

function SelectorButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-[12.5px] font-medium border transition-colors ${
        active
          ? "border-indigo-500 bg-indigo-50 text-indigo-700"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}
