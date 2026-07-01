"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  Scissors,
  ChevronDown,
  Pencil,
  Merge,
  SplitSquareVertical,
  Clock,
  Hash,
  Wand2,
  Check,
  Layers,
  Loader2,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Sparkles,
  FileText,
  Leaf,
  Scale,
  Flame,
  X,
  Copy,
  Sun,
  Globe,
  Moon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useWizard, type CleanLevel, type TopicChunk } from "../WizardContext";
import { formatDuration, formatTimecode } from "@/lib/utils";
import { StepHeader } from "../StepHeader";
import { useToast } from "@/components/ui/Toast";

// ---------------------------------------------------------------------------
// Backend row shapes
// ---------------------------------------------------------------------------

type CleanedRow = {
  id: string;
  cleanLevel: CleanLevel;
  status: "pending" | "cleaning" | "ready" | "failed";
  cleanedWords: number | null;
  removedSegments: number | null;
  removedDurSec: number | null;
};

type SegmentRunRow = {
  id: string;
  jobId: string;
  cleanLevel: CleanLevel;
  targetMin: number;
  status: "pending" | "segmenting" | "ready" | "failed";
  progress: number;
  chunkCount: number | null;
  totalWordCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

type EnrichmentSource = {
  url: string;
  title: string;
  snippet: string;
};

type EnrichmentStatus =
  | "pending"
  | "enriching"
  | "ready"
  | "skipped"
  | "failed";

type ChunkRow = {
  id: string;
  segmentRunId: string;
  idx: number;
  topic: string;
  preview: string;
  startSec: number;
  endSec: number;
  wordCount: number;
  text: string | null;
  // Cross-video dedup fields. Populated only for child jobs of a playlist
  // / batch parent — null for standalone single-video jobs.
  duplicateOfChunkId?: string | null;
  duplicateReason?: string | null;
  duplicateOf?: {
    id: string;
    topic: string;
    jobId: string;
    sourceName: string;
  } | null;
  // Web enrichment (Pass 4 of Step 5). When status="ready", enrichedText
  // is the polished script Step 6 will send to HeyGen. text always stays
  // populated as ground-truth fallback.
  enrichedText?: string | null;
  enrichmentSources?: EnrichmentSource[] | null;
  enrichmentStatus?: EnrichmentStatus;
  enrichmentError?: string | null;
  // Hierarchy. "sun" = navigation grouping (≈25 min), "planet" = render
  // unit (one avatar video each), "moon" = sub-section inside a planet.
  // Legacy flat chunks default to "planet" with parentChunkId = NULL —
  // the tree UI shows them as orphans under a synthetic "Ungrouped" sun.
  level?: ChunkLevel;
  parentChunkId?: string | null;
};

type ChunkLevel = "sun" | "planet" | "moon";

type JobRowMinimal = {
  cleanedVersions: CleanedRow[];
  segmentRuns: SegmentRunRow[];
};

// ---------------------------------------------------------------------------

const SOURCE_META: Record<
  CleanLevel,
  {
    label: string;
    icon: LucideIcon;
    from: string;
    to: string;
    softFrom: string;
    softTo: string;
  }
> = {
  light: {
    label: "Light",
    icon: Leaf,
    from: "from-emerald-500",
    to: "to-teal-500",
    softFrom: "from-emerald-50",
    softTo: "to-teal-50",
  },
  standard: {
    label: "Standard",
    icon: Scale,
    from: "from-indigo-500",
    to: "to-fuchsia-500",
    softFrom: "from-indigo-50",
    softTo: "to-fuchsia-50",
  },
  aggressive: {
    label: "Aggressive",
    icon: Flame,
    from: "from-rose-500",
    to: "to-orange-500",
    softFrom: "from-rose-50",
    softTo: "to-orange-50",
  },
};

// ---------------------------------------------------------------------------

export function SplitStep() {
  const { jobId, targetMinutes, update } = useWizard();
  const toast = useToast();

  const [cleanedByLevel, setCleanedByLevel] = useState<
    Record<CleanLevel, CleanedRow | null>
  >({ light: null, standard: null, aggressive: null });
  const [runs, setRuns] = useState<SegmentRunRow[]>([]);
  const [chunks, setChunks] = useState<ChunkRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmReseg, setConfirmReseg] = useState(false);
  // Which chunk's transcript is currently being edited in the modal.
  // Holds the row directly so the modal renders against a stable
  // snapshot even if the chunks array re-fetches mid-edit.
  const [editingChunk, setEditingChunk] = useState<ChunkRow | null>(null);

  // Source level the user has chosen for this Step 5 run. Independent of
  // Step 4's `cleanLevel` because the user may want to segment Standard
  // even if they're currently looking at Aggressive on Step 4.
  const [sourceLevel, setSourceLevel] = useState<CleanLevel | null>(null);

  const targetMin = Math.max(5, Math.min(60, targetMinutes || 20));

  // Initial load
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    fetch(`/api/jobs/${jobId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: JobRowMinimal | null) => {
        if (cancelled || !data) return;
        const next: Record<CleanLevel, CleanedRow | null> = {
          light: null,
          standard: null,
          aggressive: null,
        };
        for (const c of data.cleanedVersions ?? []) {
          if (
            c.cleanLevel === "light" ||
            c.cleanLevel === "standard" ||
            c.cleanLevel === "aggressive"
          ) {
            next[c.cleanLevel] = c;
          }
        }
        setCleanedByLevel(next);
        setRuns(data.segmentRuns ?? []);
        // Default sourceLevel. With Light + Standard removed from the UI,
        // there's no level picker — we always fall back to "aggressive".
        // If a ready segment run already exists at a different level
        // (e.g. from before we hid the picker), surface that one's
        // targetMin so the controls reflect what's actually saved.
        if (sourceLevel == null) {
          const readyRun = (data.segmentRuns ?? []).find(
            (r) => r.status === "ready",
          );
          if (readyRun) {
            setSourceLevel(readyRun.cleanLevel);
            update({ targetMinutes: readyRun.targetMin });
          } else {
            // Always start at aggressive — it's the only level the user
            // can produce now. If aggressive isn't ready yet, the
            // ControlsCard will let them kick off cleanup + segmentation.
            setSourceLevel("aggressive");
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const activeRun = useMemo(
    () =>
      sourceLevel
        ? runs.find(
            (r) => r.cleanLevel === sourceLevel && r.targetMin === targetMin,
          ) ?? null
        : null,
    [runs, sourceLevel, targetMin],
  );

  // Reset confirm-Re-segment whenever the active run changes
  useEffect(() => {
    setConfirmReseg(false);
  }, [activeRun?.id]);

  // Poll the active run while it's in flight
  useEffect(() => {
    if (!jobId || !sourceLevel) return;
    if (activeRun?.status !== "segmenting") return;

    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(
          `/api/jobs/${jobId}/segment?level=${sourceLevel}&targetMin=${targetMin}`,
        );
        if (!r.ok) return;
        const data = (await r.json()) as SegmentRunRow;
        if (cancelled) return;
        setRuns((prev) => {
          const i = prev.findIndex((r) => r.id === data.id);
          if (i < 0) return [...prev, data];
          const next = [...prev];
          next[i] = data;
          return next;
        });
        if (data.status === "ready") {
          toast.success(
            "Topics ready",
            `${data.chunkCount ?? 0} chunks at ${data.targetMin} min`,
          );
        } else if (data.status === "failed") {
          toast.error(
            "Segmentation failed",
            data.errorMessage ?? "Segmentation returned an error",
          );
        }
      } catch {
        // transient — retry on next tick
      }
    };
    void tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, sourceLevel, targetMin, activeRun?.status]);

  // Load chunks whenever the active run becomes ready
  useEffect(() => {
    if (!jobId || !sourceLevel) {
      setChunks([]);
      return;
    }
    if (activeRun?.status !== "ready") {
      setChunks([]);
      update({ chunks: [] });
      return;
    }
    let cancelled = false;
    fetch(
      `/api/jobs/${jobId}/chunks?level=${sourceLevel}&targetMin=${targetMin}`,
    )
      .then((r) =>
        r.ok ? (r.json() as Promise<{ chunks: ChunkRow[] }>) : null,
      )
      .then((data) => {
        if (cancelled || !data) return;
        setChunks(data.chunks);
        // Mirror into WizardContext so step 6 + canAdvance see real values.
        // Only canonical PLANETS are render units — suns are navigation
        // groupings (no text) and moons are sub-sections. Projecting a sun
        // here would surface it as a generatable row in Step 6 and a render
        // on it fails with E_NO_SCRIPT. Legacy flat chunks (level undefined)
        // are treated as planets. Duplicates are dropped to match the
        // render route's canonical-planet selection.
        const projected: TopicChunk[] = data.chunks
          .filter(
            (c) => (c.level ?? "planet") === "planet" && !c.duplicateOfChunkId,
          )
          .map((c) => {
            const narrationText = c.enrichedText ?? c.text ?? "";
            return {
              id: c.id,
              topic: c.topic,
              startSec: c.startSec,
              endSec: c.endSec,
              wordCount: c.wordCount,
              preview: c.preview,
              narrationChars: narrationText.length,
            };
          });
        update({ chunks: projected });
        if (data.chunks.length > 0 && !openId) {
          setOpenId(data.chunks[0].id);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, sourceLevel, targetMin, activeRun?.status, activeRun?.id]);

  const startSegmenting = useCallback(async () => {
    if (!jobId || !sourceLevel) return;
    // Optimistically flip the active run to segmenting so the UI shows the
    // progress panel immediately.
    const optimisticId = `optim-${sourceLevel}-${targetMin}`;
    setRuns((prev) => {
      const i = prev.findIndex(
        (r) => r.cleanLevel === sourceLevel && r.targetMin === targetMin,
      );
      const optimistic: SegmentRunRow = {
        id: optimisticId,
        jobId,
        cleanLevel: sourceLevel,
        targetMin,
        status: "segmenting",
        progress: 10,
        chunkCount: null,
        totalWordCount: null,
        errorCode: null,
        errorMessage: null,
      };
      if (i < 0) return [...prev, optimistic];
      const next = [...prev];
      next[i] = { ...next[i], ...optimistic, id: next[i].id };
      return next;
    });
    setChunks([]);
    update({ chunks: [] });
    try {
      const r = await fetch(`/api/jobs/${jobId}/segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cleanLevel: sourceLevel, targetMin }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg =
          (body as { error?: string }).error ?? `HTTP ${r.status}`;
        throw new Error(msg);
      }
      setRuns((prev) => {
        const real = body as SegmentRunRow;
        const i = prev.findIndex(
          (r) =>
            r.cleanLevel === real.cleanLevel &&
            r.targetMin === real.targetMin,
        );
        if (i < 0) return [...prev, real];
        const next = [...prev];
        next[i] = real;
        return next;
      });
      toast.info("Segmenting", `Finding topic boundaries…`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Couldn't start segmentation", message);
      // Roll back the optimistic flip
      setRuns((prev) => prev.filter((r) => r.id !== optimisticId));
    }
  }, [jobId, sourceLevel, targetMin, update, toast]);

  // ---------- chunk edit helpers (real DB calls) ----------

  // Declared BEFORE renameChunk so renameChunk's closure captures the
  // latest version. Earlier ordering caused a temporal-dead-zone hazard
  // and a stale-closure bug if sourceLevel/targetMin changed.
  const refetchChunks = useCallback(async () => {
    if (!jobId || !sourceLevel) return;
    try {
      const r = await fetch(
        `/api/jobs/${jobId}/chunks?level=${sourceLevel}&targetMin=${targetMin}`,
      );
      if (!r.ok) return;
      const data = (await r.json()) as { chunks: ChunkRow[] };
      setChunks(data.chunks);
    } catch {
      /* ignore */
    }
  }, [jobId, sourceLevel, targetMin]);

  const renameChunk = useCallback(
    async (chunkId: string, nextTopic: string) => {
      if (!jobId) return;
      const trimmed = nextTopic.trim();
      if (!trimmed) return;
      // Optimistic
      setChunks((prev) =>
        prev.map((c) => (c.id === chunkId ? { ...c, topic: trimmed } : c)),
      );
      try {
        const r = await fetch(`/api/jobs/${jobId}/chunks/${chunkId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: trimmed }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
        }
      } catch (err) {
        toast.error(
          "Rename failed",
          err instanceof Error ? err.message : String(err),
        );
        // Re-fetch to reset optimistic state
        await refetchChunks();
      }
    },
    [jobId, toast, refetchChunks],
  );

  // PATCH topic + transcript text in one go from the edit modal. Same
  // endpoint as renameChunk; the route accepts both fields and re-derives
  // wordCount from the new text on the server.
  const saveChunkEdit = useCallback(
    async (
      chunkId: string,
      nextTopic: string,
      nextText: string,
    ): Promise<boolean> => {
      if (!jobId) return false;
      const trimmedTopic = nextTopic.trim();
      if (!trimmedTopic) {
        toast.error("Topic required", "Cannot save an empty topic");
        return false;
      }
      try {
        const r = await fetch(`/api/jobs/${jobId}/chunks/${chunkId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: trimmedTopic, text: nextText }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${r.status}`,
          );
        }
        const updated = (await r.json()) as ChunkRow;
        setChunks((prev) =>
          prev.map((c) =>
            c.id === chunkId ? { ...c, ...updated } : c,
          ),
        );
        return true;
      } catch (err) {
        toast.error(
          "Save failed",
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    },
    [jobId, toast],
  );

  const mergeUp = useCallback(
    async (chunkId: string) => {
      if (!jobId) return;
      try {
        const r = await fetch(
          `/api/jobs/${jobId}/chunks/${chunkId}/merge`,
          { method: "POST" },
        );
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${r.status}`,
          );
        }
        const next = (body as { chunks: ChunkRow[] }).chunks;
        setChunks(next);
        // Update the run's chunkCount in our local state so the stat updates.
        setRuns((prev) =>
          prev.map((r) =>
            r.id === activeRun?.id ? { ...r, chunkCount: next.length } : r,
          ),
        );
      } catch (err) {
        toast.error(
          "Merge failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [jobId, activeRun?.id, toast],
  );

  const splitChunk = useCallback(
    async (chunkId: string) => {
      if (!jobId) return;
      try {
        const r = await fetch(
          `/api/jobs/${jobId}/chunks/${chunkId}/split`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}), // default to midpoint
          },
        );
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${r.status}`,
          );
        }
        const next = (body as { chunks: ChunkRow[] }).chunks;
        setChunks(next);
        setRuns((prev) =>
          prev.map((r) =>
            r.id === activeRun?.id ? { ...r, chunkCount: next.length } : r,
          ),
        );
      } catch (err) {
        toast.error(
          "Split failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [jobId, activeRun?.id, toast],
  );

  // ---------- empty / error states ----------

  if (!jobId) {
    return (
      <div className="max-w-xl mx-auto w-full text-center py-10 flex flex-col gap-4 items-center animate-reveal">
        <span className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-50 text-slate-400 border border-slate-200">
          <Scissors size={24} strokeWidth={1.8} />
        </span>
        <h2 className="text-[24px] font-semibold text-slate-900">
          Upload a file first
        </h2>
        <p className="text-[14.5px] text-slate-500 max-w-md">
          Step 5 splits the cleaned transcript into topic chunks. Head back
          to Upload to start.
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

  const anyCleaned = (
    Object.values(cleanedByLevel) as Array<CleanedRow | null>
  ).some((c) => c?.status === "ready");

  if (!anyCleaned) {
    return (
      <div className="max-w-xl mx-auto w-full text-center py-10 flex flex-col gap-4 items-center animate-reveal">
        <span className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-50 text-slate-400 border border-slate-200">
          <FileText size={24} strokeWidth={1.8} />
        </span>
        <h2 className="text-[24px] font-semibold text-slate-900">
          Clean a transcript first
        </h2>
        <p className="text-[14.5px] text-slate-500 max-w-md">
          Step 5 needs at least one cleaned version (Light, Standard, or
          Aggressive) before it can split topics.
        </p>
        <Link
          href="#"
          onClick={(e) => {
            e.preventDefault();
            update({ step: 4 });
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[14.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors shadow-sm"
        >
          <ArrowLeft size={13} strokeWidth={2} />
          Back to Clean
        </Link>
      </div>
    );
  }

  const isSegmenting = activeRun?.status === "segmenting";
  const isReady = activeRun?.status === "ready";
  const isFailed = activeRun?.status === "failed";
  const progress = activeRun?.progress ?? 0;
  const totalSec = chunks.reduce((acc, c) => acc + (c.endSec - c.startSec), 0);
  const avgSec = chunks.length === 0 ? 0 : Math.round(totalSec / chunks.length);

  const anySegmenting = runs.some((r) => r.status === "segmenting");

  return (
    <div className="max-w-5xl mx-auto w-full flex flex-col gap-7 animate-reveal">
      <StepHeader
        step={5}
        title="Split by topic"
        description="Pick a cleaned source and a target chunk size. We place boundaries on topic shifts — never mid-derivation."
      />

      {/* Source picker removed — Aggressive is the only cleanup level
          the UI exposes, so a single-card picker added no value. The
          source level defaults to "aggressive" via the auto-select
          effect below. */}

      {/* 2. Target + Auto-detect */}
      <ControlsCard
        targetMin={targetMin}
        onTargetChange={(n) => update({ targetMinutes: n })}
        sourceLevel={sourceLevel}
        anySegmenting={anySegmenting}
        chunkCount={chunks.length}
        avgSec={avgSec}
        // CTA only when we have a source + no run yet for that combo.
        showStartCta={!!sourceLevel && !activeRun}
        onStart={startSegmenting}
      />

      {/* 3. Re-segment confirm card (when a ready run exists) */}
      {isReady && activeRun && sourceLevel && (
        <ResegmentCard
          sourceLevel={sourceLevel}
          targetMin={targetMin}
          chunkCount={activeRun.chunkCount ?? chunks.length}
          confirmOpen={confirmReseg}
          onAskConfirm={() => setConfirmReseg(true)}
          onCancel={() => setConfirmReseg(false)}
          onConfirm={() => {
            setConfirmReseg(false);
            void startSegmenting();
          }}
          disabled={anySegmenting}
        />
      )}

      {/* 4. Progress panel */}
      {isSegmenting && (
        <ProgressPanel progress={progress} sourceLevel={sourceLevel} targetMin={targetMin} />
      )}

      {/* 5. Failure */}
      {isFailed && activeRun && (
        <FailurePanel
          message={activeRun.errorMessage ?? "Segmentation exited with an error"}
          code={activeRun.errorCode ?? null}
          onRetry={() => void startSegmenting()}
        />
      )}

      {/* 6. Chunks accordion */}
      {isReady && chunks.length > 0 && (
        <ChunksAccordion
          chunks={chunks}
          openId={openId}
          renaming={renaming}
          onToggleOpen={(id) => setOpenId((cur) => (cur === id ? null : id))}
          onStartRename={(id) => setRenaming(id)}
          onCommitRename={(id, value) => {
            setRenaming(null);
            void renameChunk(id, value);
          }}
          onCancelRename={() => setRenaming(null)}
          onMergeUp={(id) => void mergeUp(id)}
          onSplitChunk={(id) => void splitChunk(id)}
          onEditTranscript={(c) => setEditingChunk(c)}
        />
      )}

      {/* Transcript edit modal — opens when the user clicks "Edit
          transcript" inside the chunks accordion. Submits topic + text
          via saveChunkEdit which re-derives wordCount on the backend. */}
      {editingChunk && (
        <ChunkEditModal
          chunk={editingChunk}
          onClose={() => setEditingChunk(null)}
          onSave={async (topic, text) => {
            const ok = await saveChunkEdit(editingChunk.id, topic, text);
            if (ok) setEditingChunk(null);
          }}
        />
      )}

      {/* 7. Done banner */}
      {isReady && chunks.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="flex items-center gap-2.5 p-3 rounded-xl bg-gradient-to-br from-emerald-50/50 to-teal-50/40 border border-emerald-200/60"
        >
          <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
            <Check size={14} strokeWidth={2.5} />
          </span>
          <p className="text-[15px] text-emerald-800 font-medium flex items-center gap-2">
            <Scissors size={13} strokeWidth={2} className="text-emerald-600" />
            <span>
              <span className="font-bold">{chunks.length}</span> topic chunks
              ready for avatar rendering
            </span>
          </p>
        </motion.div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source picker
// ---------------------------------------------------------------------------

function SourcePicker({
  cleanedByLevel,
  runs,
  targetMin,
  selected,
  onSelect,
  onGoToClean,
}: {
  cleanedByLevel: Record<CleanLevel, CleanedRow | null>;
  runs: SegmentRunRow[];
  targetMin: number;
  selected: CleanLevel | null;
  onSelect: (l: CleanLevel) => void;
  onGoToClean: () => void;
}) {
  const readyCount = (
    Object.values(cleanedByLevel) as Array<CleanedRow | null>
  ).filter((c) => c?.status === "ready").length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-indigo-50/30 via-white to-fuchsia-50/20 shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-5"
    >
      <div
        aria-hidden
        className="absolute -right-20 -top-20 w-56 h-56 rounded-full bg-gradient-to-br from-indigo-500/8 to-fuchsia-500/8 blur-3xl pointer-events-none"
      />

      {/* Header */}
      <div className="relative flex items-start justify-between gap-4 flex-wrap mb-4">
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(99,102,241,0.4)]">
            <FileText size={18} strokeWidth={2} />
          </span>
          <div>
            <p className="text-[15.5px] font-semibold text-slate-900 leading-tight">
              Cleaned source
            </p>
            <p className="text-[12.5px] text-slate-500 leading-tight mt-0.5">
              Topic boundaries are placed against the cleaned transcript you
              choose. {readyCount === 3 ? "All 3 levels available." : `${readyCount} of 3 levels available.`}
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold uppercase tracking-wide bg-white border border-slate-200 text-slate-600 shadow-[0_1px_2px_rgba(9,9,11,0.03)]">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
          {selected ? (
            <>
              Using:{" "}
              <span className="capitalize text-indigo-700">{selected}</span>
            </>
          ) : (
            <span className="text-slate-500">No source picked</span>
          )}
        </span>
      </div>

      {/* Cards */}
      <div className="relative grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Light and Standard cleaning levels are hidden — Aggressive
            is the only source level the UI exposes. SOURCE_META still
            holds metadata for all three so DB rows from older runs
            don't crash type-checks, but the picker only renders
            Aggressive. */}
        {(["aggressive"] as CleanLevel[]).map((l) => {
          const cleaned = cleanedByLevel[l];
          const meta = SOURCE_META[l];
          const Icon = meta.icon;
          const ready = cleaned?.status === "ready";
          const cleaning = cleaned?.status === "cleaning";
          const failed = cleaned?.status === "failed";
          const active = selected === l;

          const matchingRun = runs.find(
            (r) => r.cleanLevel === l && r.targetMin === targetMin,
          );
          const otherRuns = runs.filter(
            (r) => r.cleanLevel === l && r.targetMin !== targetMin,
          );
          const runStatus = matchingRun?.status ?? null;

          // What the user gets if they tap this card
          const tapHint = !ready
            ? null
            : active
              ? "Selected"
              : "Tap to select";

          // Parent element switches between <button> (ready, whole card is
          // clickable) and <div> (un-ready, so the inner "Run on Step 4 →"
          // span can receive its own click — HTML5 swallows clicks on
          // descendants of disabled <button>).
          const Wrapper = ready ? motion.button : motion.div;
          const wrapperProps = ready
            ? {
                type: "button" as const,
                onClick: () => onSelect(l),
                whileHover: !active ? { y: -2 } : undefined,
                whileTap: { scale: 0.985 },
              }
            : {};

          return (
            <Wrapper
              key={l}
              {...wrapperProps}
              transition={{ type: "spring", stiffness: 320, damping: 22 }}
              className={`group relative overflow-hidden text-left rounded-xl border transition-all ${
                active
                  ? `border-indigo-500 bg-gradient-to-br ${meta.softFrom} via-white ${meta.softTo} ring-2 ring-indigo-100 shadow-[0_6px_22px_-6px_rgba(99,102,241,0.35)]`
                  : ready
                    ? "border-slate-200 bg-white hover:border-slate-300 hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_10px_24px_-12px_rgba(15,23,42,0.2)]"
                    : "border-dashed border-slate-200 bg-slate-50/40 cursor-default"
              }`}
            >
              {/* Top accent bar — only visible when active */}
              {active && (
                <span
                  aria-hidden
                  className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${meta.from} ${meta.to}`}
                />
              )}
              {/* Soft halo behind active card */}
              {active && (
                <div
                  aria-hidden
                  className={`absolute -right-12 -top-12 w-32 h-32 rounded-full bg-gradient-to-br ${meta.from} ${meta.to} opacity-15 blur-3xl pointer-events-none`}
                />
              )}

              <div className="relative p-4 pt-5">
                {/* Header row: icon + status + selected check */}
                <div className="flex items-start justify-between gap-2 mb-3">
                  <span
                    className={`flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br ${meta.from} ${meta.to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),_0_4px_14px_-4px_rgba(15,23,42,0.35)] transition-all ${
                      !ready ? "grayscale opacity-60" : ""
                    }`}
                  >
                    <Icon size={19} strokeWidth={2} />
                  </span>
                  <div className="flex items-center gap-1.5">
                    {/* Per-status pill */}
                    {ready ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-emerald-50 text-emerald-700 border-emerald-100">
                        <Check size={9} strokeWidth={2.6} />
                        Ready
                      </span>
                    ) : cleaning ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-fuchsia-50 text-fuchsia-700 border-fuchsia-100">
                        <Loader2
                          size={9}
                          strokeWidth={2.6}
                          className="animate-spin-slow"
                        />
                        Cleaning
                      </span>
                    ) : failed ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-rose-50 text-rose-700 border-rose-100">
                        Failed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-slate-100 text-slate-500 border-slate-200">
                        Not run
                      </span>
                    )}
                    {/* Selected check */}
                    <span
                      className={`flex items-center justify-center w-5 h-5 rounded-full border-2 transition-colors ${
                        active
                          ? "border-indigo-600 bg-indigo-600 text-white"
                          : ready
                            ? "border-slate-300 bg-white"
                            : "border-slate-200 bg-white opacity-50"
                      }`}
                    >
                      {active && <Check size={11} strokeWidth={3} />}
                    </span>
                  </div>
                </div>

                {/* Level + caption */}
                <p className="text-[17px] font-semibold text-slate-900 leading-tight">
                  {meta.label}
                </p>
                <p
                  className={`text-[12.5px] mt-0.5 leading-snug ${
                    ready ? "text-slate-500" : "text-slate-400"
                  }`}
                >
                  {l === "light"
                    ? "Filler + false-starts"
                    : l === "standard"
                      ? "Balanced — recommended"
                      : "Strict — topic only"}
                </p>

                {/* Stats row — three mini cells */}
                <div className="mt-3.5 grid grid-cols-3 gap-1.5">
                  <StatCell
                    label="Words"
                    value={
                      ready
                        ? (cleaned?.cleanedWords ?? 0).toLocaleString()
                        : "—"
                    }
                    dimmed={!ready}
                  />
                  <StatCell
                    label="Cuts"
                    value={
                      ready ? (cleaned?.removedSegments ?? 0).toString() : "—"
                    }
                    dimmed={!ready}
                  />
                  <StatCell
                    label="Saved"
                    value={
                      ready
                        ? formatDuration(cleaned?.removedDurSec ?? 0)
                        : "—"
                    }
                    dimmed={!ready}
                  />
                </div>

                {/* Footer: tap hint OR run hint OR go-to-step-4 */}
                <div className="mt-3 pt-3 border-t border-slate-200/70 min-h-[28px] flex items-center">
                  {ready && runStatus === "ready" ? (
                    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-emerald-700">
                      <Check size={11} strokeWidth={2.6} />
                      {matchingRun?.chunkCount ?? "?"} chunks @ {targetMin}m
                      saved
                    </span>
                  ) : ready && runStatus === "segmenting" ? (
                    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-fuchsia-700">
                      <Loader2
                        size={10}
                        strokeWidth={2.6}
                        className="animate-spin-slow"
                      />
                      Segmenting @ {targetMin}m — {matchingRun?.progress ?? 0}%
                    </span>
                  ) : ready && otherRuns.length > 0 ? (
                    <span className="text-[11.5px] text-slate-500">
                      Saved at:{" "}
                      <span className="font-medium text-slate-700 nums">
                        {otherRuns
                          .map((r) => `${r.targetMin}m`)
                          .join(", ")}
                      </span>
                    </span>
                  ) : ready ? (
                    <span
                      className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium transition-colors ${
                        active
                          ? "text-indigo-700"
                          : "text-slate-500 group-hover:text-slate-700"
                      }`}
                    >
                      {active ? (
                        <>
                          <Check size={11} strokeWidth={2.6} />
                          {tapHint}
                        </>
                      ) : (
                        <>
                          {tapHint}
                          <ArrowRight size={11} strokeWidth={2} />
                        </>
                      )}
                    </span>
                  ) : cleaning ? (
                    <span className="text-[11.5px] text-slate-400 italic">
                      Available once cleaning completes
                    </span>
                  ) : (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        onGoToClean();
                      }}
                      className="inline-flex items-center gap-1 text-[11.5px] font-medium text-indigo-600 hover:text-indigo-800 cursor-pointer"
                    >
                      Run on Step 4
                      <ArrowRight size={11} strokeWidth={2} />
                    </span>
                  )}
                </div>
              </div>
            </Wrapper>
          );
        })}
      </div>
    </motion.div>
  );
}

function StatCell({
  label,
  value,
  dimmed,
}: {
  label: string;
  value: string;
  dimmed?: boolean;
}) {
  return (
    <div
      className={`rounded-md px-2 py-1.5 border text-center transition-colors ${
        dimmed
          ? "bg-slate-50/60 border-slate-200/60"
          : "bg-white/70 border-slate-200"
      }`}
    >
      <p
        className={`text-[10.5px] uppercase tracking-wide font-semibold leading-tight ${
          dimmed ? "text-slate-400" : "text-slate-500"
        }`}
      >
        {label}
      </p>
      <p
        className={`text-[13px] font-semibold nums leading-tight mt-0.5 ${
          dimmed ? "text-slate-400" : "text-slate-900"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls card — target input + Auto-detect CTA + summary pills
// ---------------------------------------------------------------------------

function ControlsCard({
  targetMin,
  onTargetChange,
  sourceLevel,
  anySegmenting,
  chunkCount,
  avgSec,
  showStartCta,
  onStart,
}: {
  targetMin: number;
  onTargetChange: (n: number) => void;
  sourceLevel: CleanLevel | null;
  anySegmenting: boolean;
  chunkCount: number;
  avgSec: number;
  showStartCta: boolean;
  onStart: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.05 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-rose-50/40 via-white to-orange-50/30 shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-5"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-rose-500/10 to-orange-500/10 blur-3xl"
      />
      <div className="relative flex items-end gap-4 flex-wrap">
        <div className="flex flex-col gap-2">
          <label
            htmlFor="target-min"
            className="text-[13.5px] text-slate-600 font-semibold uppercase tracking-wide flex items-center gap-1.5"
          >
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br from-rose-500 to-orange-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
              <Clock size={12} strokeWidth={2} />
            </span>
            Target minutes
          </label>
          <input
            id="target-min"
            type="number"
            min={5}
            max={60}
            value={targetMin}
            onChange={(e) =>
              onTargetChange(
                Math.max(5, Math.min(60, Number(e.target.value) || 20)),
              )
            }
            className="w-28 px-3 py-2 rounded-lg border border-slate-200 bg-white text-[17px] font-semibold text-slate-900 nums focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-100 transition-colors"
          />
        </div>

        {showStartCta && (
          <motion.button
            whileHover={!anySegmenting ? { y: -1 } : undefined}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={onStart}
            disabled={anySegmenting || !sourceLevel}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[14.5px] font-medium text-white bg-gradient-to-br from-rose-500 via-rose-500 to-orange-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(244,63,94,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(244,63,94,0.6)] transition-shadow disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <Wand2 size={14} strokeWidth={2} />
            Auto-detect topics
            <ArrowRight size={14} strokeWidth={2.2} />
          </motion.button>
        )}

        <div className="ml-auto flex items-center gap-3">
          <SummaryPill
            icon={<Layers size={12} strokeWidth={2} />}
            value={chunkCount}
            label="chunks"
            from="from-indigo-500"
            to="to-fuchsia-500"
          />
          <SummaryPill
            icon={<Clock size={12} strokeWidth={2} />}
            value={formatDuration(avgSec)}
            label="avg"
            from="from-emerald-500"
            to="to-teal-500"
          />
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Re-segment card (mirrors Step 4's RecleanCard pattern)
// ---------------------------------------------------------------------------

function ResegmentCard({
  sourceLevel,
  targetMin,
  chunkCount,
  confirmOpen,
  onAskConfirm,
  onCancel,
  onConfirm,
  disabled,
}: {
  sourceLevel: CleanLevel;
  targetMin: number;
  chunkCount: number;
  confirmOpen: boolean;
  onAskConfirm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  disabled: boolean;
}) {
  const meta = SOURCE_META[sourceLevel];

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
        <span
          className={`flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${meta.from} ${meta.to} text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_12px_-4px_rgba(15,23,42,0.3)]`}
        >
          <Check size={16} strokeWidth={2.4} />
        </span>
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-2 mb-0.5">
            <p className="text-[14.5px] font-semibold text-slate-900 leading-tight">
              <span className="capitalize">{meta.label}</span> @ {targetMin} min
              ready
            </p>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-emerald-50 text-emerald-700 border-emerald-100">
              <Check size={9} strokeWidth={2.6} className="mr-0.5" />
              Saved
            </span>
          </div>
          <p className="text-[12.5px] text-slate-500 leading-tight nums">
            {chunkCount} {chunkCount === 1 ? "chunk" : "chunks"} produced ·
            change target above to compare
          </p>
        </div>

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
                ~$0.05
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
              title={`Re-run segmentation on ${sourceLevel} @ ${targetMin}m (~$0.05)`}
              className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw size={12} strokeWidth={2} />
              Re-segment
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Progress panel
// ---------------------------------------------------------------------------

function ProgressPanel({
  progress,
  sourceLevel,
  targetMin,
}: {
  progress: number;
  sourceLevel: CleanLevel | null;
  targetMin: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-rose-50/40 via-white to-orange-50/30 shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-6"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-rose-500/10 to-orange-500/10 blur-3xl"
      />
      <div className="relative flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-10 h-10 rounded-xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] bg-gradient-to-br from-rose-500 via-rose-500 to-orange-500">
            <Loader2 size={17} strokeWidth={2} className="animate-spin-slow" />
          </span>
          <div>
            <p className="text-[15.5px] text-slate-900 font-semibold leading-tight">
              Finding topic boundaries…
            </p>
            <p className="text-[13.5px] text-slate-500 leading-tight mt-0.5">
              Source: <span className="capitalize">{sourceLevel}</span> ·
              target {targetMin} min
            </p>
          </div>
        </div>
        <span className="text-[22px] font-semibold text-slate-900 nums leading-none">
          {progress}%
        </span>
      </div>
      <div className="relative h-2 bg-slate-100 rounded-full overflow-hidden">
        <motion.div
          initial={{ width: "0%" }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.3 }}
          className="h-full rounded-full shimmer-bar"
        />
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Failure panel — same pattern as Step 4
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

  const hint = isAuth
    ? "Set OPENAI_API_KEY in web/.env.local and restart the dev server."
    : isNetwork
      ? "Service was unreachable after a few retries. Usually transient — try again."
      : isResponse
        ? "Segmentation returned malformed output. Re-running usually clears it up."
        : null;

  const title = isAuth
    ? "API key missing or invalid"
    : isNetwork
      ? "Couldn't reach service"
      : isResponse
        ? "Segmentation returned bad output"
        : "Segmentation failed";

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
          whileHover={!isAuth ? { y: -1 } : undefined}
          whileTap={!isAuth ? { scale: 0.97 } : undefined}
          type="button"
          onClick={onRetry}
          disabled={isAuth}
          title={isAuth ? "Add OPENAI_API_KEY first" : "Retry segmentation (~$0.05)"}
          className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-[14px] font-medium text-white bg-gradient-to-br from-rose-600 via-rose-600 to-orange-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-3px_rgba(244,63,94,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(244,63,94,0.65)] transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw size={13} strokeWidth={2.2} />
          Retry segmentation
        </motion.button>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Chunks accordion — same look & feel as the original mock, but driven by
// real DB rows and the edit operations are real PATCH / POST calls.
// ---------------------------------------------------------------------------

// Tree-shape props passed down from the parent. Memoised at the
// ChunksAccordion entry; each PlanetRow is unaware of siblings or moons
// beyond its own subtree.
type AccordionHandlers = {
  openId: string | null;
  renaming: string | null;
  onToggleOpen: (id: string) => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, value: string) => void;
  onCancelRename: () => void;
  onMergeUp: (id: string) => void;
  onSplitChunk: (id: string) => void;
  onEditTranscript: (c: ChunkRow) => void;
};

function ChunksAccordion({
  chunks,
  openId,
  renaming,
  onToggleOpen,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onMergeUp,
  onSplitChunk,
  onEditTranscript,
}: {
  chunks: ChunkRow[];
} & AccordionHandlers) {
  // Build the tree client-side from the flat chunks array. Group by
  // parentChunkId; suns are top-level (parent = NULL AND level = "sun").
  // Legacy flat planets (parent = NULL AND level = "planet") get
  // collected under a synthetic "Ungrouped" sun so old jobs keep
  // rendering without breakage.
  const tree = useMemo(() => buildChunkTree(chunks), [chunks]);
  const handlers: AccordionHandlers = {
    openId,
    renaming,
    onToggleOpen,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onMergeUp,
    onSplitChunk,
    onEditTranscript,
  };

  // Local collapse-state for sun headers (default expanded). Independent
  // of openId which tracks per-planet expansion.
  const [collapsedSuns, setCollapsedSuns] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleSun = (id: string) =>
    setCollapsedSuns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 }}
      className="flex flex-col gap-3"
    >
      {tree.suns.map((sun, sunIdx) => {
        const collapsed = collapsedSuns.has(sun.id);
        const planetCount = sun.planets.length;
        const sunDur = sun.endSec - sun.startSec;
        const isLegacy = sun.id.startsWith("__legacy__");
        return (
          <div
            key={sun.id}
            className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] overflow-hidden"
          >
            {/* ─── Sun header ─────────────────────────────────────── */}
            <button
              type="button"
              onClick={() => toggleSun(sun.id)}
              className={`w-full flex items-center gap-4 px-5 py-3.5 text-left transition-colors ${
                isLegacy
                  ? "bg-gradient-to-r from-slate-50 via-white to-slate-50 hover:from-slate-100/70"
                  : "bg-gradient-to-r from-amber-50/60 via-orange-50/40 to-yellow-50/50 hover:from-amber-100/60 hover:to-yellow-100/60"
              }`}
            >
              <span
                className={`flex items-center justify-center w-10 h-10 rounded-xl shrink-0 ${
                  isLegacy
                    ? "bg-slate-200 text-slate-500"
                    : "bg-gradient-to-br from-amber-400 via-orange-400 to-yellow-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),_0_4px_10px_-2px_rgba(245,158,11,0.4)]"
                }`}
              >
                <Sun size={18} strokeWidth={2.4} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[10.5px] uppercase tracking-wide font-semibold text-amber-700/80">
                  {isLegacy ? "Legacy chunks" : `Core concept ${sunIdx + 1}`}
                </span>
                <span className="text-[17px] font-semibold text-slate-900 truncate block leading-snug">
                  {sun.topic}
                </span>
                {sun.preview && !isLegacy ? (
                  <span className="block text-[12.5px] text-slate-500 mt-0.5 truncate">
                    {sun.preview}
                  </span>
                ) : null}
                {isLegacy ? (
                  <span className="block text-[12px] text-slate-400 italic mt-0.5">
                    Click Re-segment to produce a hierarchical outline.
                  </span>
                ) : null}
              </span>
              <span className="hidden sm:flex items-center gap-2 text-[12.5px] text-slate-500 shrink-0">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-slate-200">
                  <Globe size={10} strokeWidth={2.2} />
                  <span className="nums font-semibold tabular-nums">
                    {planetCount}
                  </span>
                  <span>planet{planetCount === 1 ? "" : "s"}</span>
                </span>
                {sunDur > 0 ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-slate-200">
                    <Clock size={10} strokeWidth={2} />
                    <span className="nums font-medium">
                      {formatDuration(sunDur)}
                    </span>
                  </span>
                ) : null}
              </span>
              <motion.span
                animate={{ rotate: collapsed ? 0 : 180 }}
                transition={{ duration: 0.25 }}
                className="text-amber-600/70 shrink-0"
              >
                <ChevronDown size={17} strokeWidth={2.2} />
              </motion.span>
            </button>

            {/* ─── Planets under this sun ─────────────────────────── */}
            <AnimatePresence initial={false}>
              {!collapsed && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden border-t border-slate-200"
                >
                  <div className="divide-y divide-slate-200">
                    {sun.planets.map((planet, planetIdx) => (
                      <PlanetRow
                        key={planet.id}
                        planet={planet}
                        // Global colour seed so each planet still gets a
                        // distinct accent. Mix in sunIdx so colours don't
                        // repeat across suns either.
                        colorSeed={sunIdx * 7 + planetIdx}
                        handlers={handlers}
                      />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tree builder — flat chunks → { suns: [{ ..., planets: [{ ..., moons }]}] }
// ─────────────────────────────────────────────────────────────────────────

type PlanetTreeNode = ChunkRow & { moons: ChunkRow[] };
type SunTreeNode = ChunkRow & { planets: PlanetTreeNode[] };

function buildChunkTree(chunks: ChunkRow[]): { suns: SunTreeNode[] } {
  const byParent = new Map<string | "__null__", ChunkRow[]>();
  for (const c of chunks) {
    const key = c.parentChunkId ?? "__null__";
    const list = byParent.get(key);
    if (list) list.push(c);
    else byParent.set(key, [c]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.idx - b.idx);

  const tops = byParent.get("__null__") ?? [];
  const realSuns = tops.filter((c) => c.level === "sun");
  const orphanPlanets = tops.filter(
    (c) => c.level !== "sun", // legacy flat chunks: level="planet" by default
  );

  const buildPlanet = (planet: ChunkRow): PlanetTreeNode => ({
    ...planet,
    moons: byParent.get(planet.id) ?? [],
  });

  const suns: SunTreeNode[] = realSuns.map((s) => ({
    ...s,
    planets: (byParent.get(s.id) ?? [])
      .filter((c) => c.level === "planet")
      .map(buildPlanet),
  }));

  // Legacy fallback: synthesise an "Ungrouped" sun so flat-chunk jobs
  // still render in the new tree UI without an awkward empty state.
  if (orphanPlanets.length > 0) {
    const orphanStart = orphanPlanets[0]?.startSec ?? 0;
    const orphanEnd =
      orphanPlanets[orphanPlanets.length - 1]?.endSec ?? 0;
    suns.push({
      id: `__legacy__${realSuns.length}`,
      segmentRunId: orphanPlanets[0]?.segmentRunId ?? "",
      idx: realSuns.length,
      topic: "Ungrouped chunks",
      preview: "",
      startSec: orphanStart,
      endSec: orphanEnd,
      wordCount: 0,
      text: null,
      level: "sun" as const,
      parentChunkId: null,
      planets: orphanPlanets.map(buildPlanet),
    });
  }
  return { suns };
}

// ─────────────────────────────────────────────────────────────────────────
// PlanetRow — preserves the existing chunk-row look from the flat
// accordion, plus a moons strip when the planet has sub-sections.
// ─────────────────────────────────────────────────────────────────────────

function PlanetRow({
  planet: c,
  colorSeed: i,
  handlers,
}: {
  planet: PlanetTreeNode;
  colorSeed: number;
  handlers: AccordionHandlers;
}) {
  const {
    openId,
    renaming,
    onToggleOpen,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onEditTranscript,
  } = handlers;
  const open = openId === c.id;
  const duration = c.endSec - c.startSec;
  const isDuplicate = !!c.duplicateOfChunkId;
  const moons = c.moons;
  return (
        <div
          key={c.id}
          className={`transition-colors ${isDuplicate ? "bg-amber-50/30" : ""}`}
        >
            <button
              type="button"
              onClick={() => onToggleOpen(c.id)}
              className={`w-full flex items-center gap-4 px-5 py-4 transition-colors text-left ${
                open
                  ? "bg-gradient-to-r from-slate-50 via-white to-slate-50"
                  : "hover:bg-slate-50/60"
              }`}
            >
              <span
                className={`flex items-center justify-center w-9 h-9 rounded-xl text-white text-[15px] font-semibold shrink-0 nums shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_10px_-2px_rgba(15,23,42,0.3)] ${
                  isDuplicate ? "grayscale opacity-60" : ""
                }`}
                style={{
                  backgroundImage: `linear-gradient(135deg, hsl(${(i * 55) % 360} 72% 55%), hsl(${(i * 55 + 35) % 360} 72% 45%))`,
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="font-mono text-[13.5px] text-slate-500 shrink-0 tabular-nums hidden sm:inline">
                {formatTimecode(c.startSec).slice(0, 8)}
                <span className="text-slate-300 mx-1">→</span>
                {formatTimecode(c.endSec).slice(0, 8)}
              </span>
              <span className="flex-1 min-w-0">
                {renaming === c.id ? (
                  <input
                    autoFocus
                    defaultValue={c.topic}
                    onBlur={(e) => onCommitRename(c.id, e.target.value || c.topic)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        onCommitRename(
                          c.id,
                          e.currentTarget.value || c.topic,
                        );
                      } else if (e.key === "Escape") {
                        onCancelRename();
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full px-2 py-1 text-[17px] font-semibold text-slate-900 bg-white border border-indigo-500 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                ) : (
                  <span
                    className={`text-[17px] font-semibold truncate block ${
                      isDuplicate ? "text-slate-500" : "text-slate-900"
                    }`}
                  >
                    {c.topic}
                  </span>
                )}
                {isDuplicate && c.duplicateOf ? (
                  <span
                    className="mt-1 inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-700 bg-amber-100 border border-amber-200 rounded-md px-2 py-0.5 max-w-full"
                    title={c.duplicateReason ?? undefined}
                  >
                    <Copy size={11} strokeWidth={2.25} className="shrink-0" />
                    <span className="truncate">
                      Same topic as &ldquo;{c.duplicateOf.topic}&rdquo;
                      {c.duplicateOf.sourceName
                        ? ` · ${c.duplicateOf.sourceName}`
                        : ""}
                    </span>
                  </span>
                ) : null}
              </span>
              <span className="hidden md:flex items-center gap-3 text-[13.5px] text-slate-500 shrink-0">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-50 border border-slate-200">
                  <Clock size={10} strokeWidth={2} />
                  <span className="nums font-medium">
                    {formatDuration(duration)}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-50 border border-slate-200">
                  <Hash size={10} strokeWidth={2} />
                  <span className="nums font-medium">
                    {c.wordCount.toLocaleString()}
                  </span>
                </span>
                {c.enrichmentStatus === "ready" && c.enrichedText ? (
                  <span
                    title="Enriched script ready for the avatar narrator"
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gradient-to-r from-violet-50 to-fuchsia-50 border border-violet-200 text-violet-700"
                  >
                    <Sparkles size={10} strokeWidth={2.4} />
                    <span className="font-semibold">
                      Enriched
                    </span>
                  </span>
                ) : null}
              </span>
              <motion.span
                animate={{ rotate: open ? 180 : 0 }}
                transition={{ duration: 0.25 }}
                className="text-slate-400 shrink-0"
              >
                <ChevronDown size={17} strokeWidth={2} />
              </motion.span>
            </button>

            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden bg-gradient-to-b from-slate-50/80 to-white"
                >
                  <div className="px-5 pb-5 pt-2">
                    <p className="text-[16px] text-slate-600 leading-relaxed max-w-3xl mb-4 border-l-2 border-indigo-200 pl-4">
                      {c.preview}
                    </p>
                    {/* Original transcript + Enriched script (Pass 4 of
                        Step 5). Tab switcher when enrichment is ready;
                        falls through to plain transcript otherwise. */}
                    <ChunkScriptTabs chunk={c} />

                    {/* 🌙 Moons strip — sub-sections inside this planet.
                        Shown only when present (variable depth). Each
                        moon is a small chapter marker; clicking does
                        nothing yet (Step 6 will wire timestamp scrub). */}
                    {moons.length > 0 ? (
                      <div className="mb-4 max-w-3xl rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-2">
                        <p className="text-[10.5px] uppercase tracking-wide font-semibold text-slate-500 mb-1.5 flex items-center gap-1.5">
                          <Moon size={10} strokeWidth={2.4} />
                          {moons.length} sub-section
                          {moons.length === 1 ? "" : "s"}
                        </p>
                        <ul className="divide-y divide-slate-200/70">
                          {moons.map((m, mi) => (
                            <li
                              key={m.id}
                              className="flex items-center gap-3 py-1.5 text-[13px]"
                            >
                              <span className="font-mono text-[11px] text-slate-400 nums tabular-nums w-6 text-right shrink-0">
                                {String(mi + 1).padStart(2, "0")}
                              </span>
                              <span className="font-mono text-[11.5px] text-slate-400 tabular-nums shrink-0 hidden sm:inline">
                                {formatTimecode(m.startSec).slice(0, 8)}
                                <span className="text-slate-300 mx-1">→</span>
                                {formatTimecode(m.endSec).slice(0, 8)}
                              </span>
                              <span className="flex-1 min-w-0 text-slate-700 truncate">
                                {m.topic}
                              </span>
                              <span className="text-slate-500 nums tabular-nums shrink-0 text-[12px]">
                                {formatDuration(m.endSec - m.startSec)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <div className="flex items-center gap-2 flex-wrap">
                      <RowBtn
                        icon={<Pencil size={12} strokeWidth={2} />}
                        onClick={() => onStartRename(c.id)}
                        from="from-indigo-500"
                        to="to-blue-500"
                      >
                        Rename
                      </RowBtn>
                      <RowBtn
                        icon={<Pencil size={12} strokeWidth={2} />}
                        onClick={() => onEditTranscript(c)}
                        from="from-rose-500"
                        to="to-orange-500"
                      >
                        Edit transcript
                      </RowBtn>
                      {/* Merge up + Split here intentionally hidden for now.
                          Backend (POST /chunks/[id]/merge and /split) and the
                          handler props (onMergeUp / onSplitChunk) are still
                          wired so we can re-enable them later. */}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
  );
}

// ---------------------------------------------------------------------------
// Per-chunk script tabs — Original transcript vs Enriched (web-sourced).
// ---------------------------------------------------------------------------
//
// Step 5 Pass 4 enriches each canonical chunk with technical web content
// from Tavily + GPT-4o synthesis. The result is `enrichedText` — the
// polished script Step 6 sends to HeyGen. We always preserve the
// original `text` as ground truth, so the user can flip between them.
//
// Status branches:
//   ready    → tab switcher: Original / Enriched (default Enriched)
//   skipped  → small grey notice; Original transcript still shown
//   failed   → small red notice with error; Original still shown
//   pending  → just Original (enrichment hasn't run yet for this chunk)
//   enriching→ Loader2 spinner with "Enriching with web sources…"

function ChunkScriptTabs({ chunk }: { chunk: ChunkRow }) {
  const status = chunk.enrichmentStatus ?? "pending";
  const enrichedReady = status === "ready" && !!chunk.enrichedText;

  // Default tab = Enriched when ready, else Original. State key includes
  // chunk.id so flipping between rows resets the active tab cleanly.
  const [tab, setTab] = useState<"enriched" | "original">(() =>
    enrichedReady ? "enriched" : "original",
  );
  // If a chunk's enrichment finishes mid-view (e.g. polling delivers a
  // fresh row), nudge the tab over to Enriched so the user sees it.
  useEffect(() => {
    if (enrichedReady) setTab("enriched");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk.id, enrichedReady]);

  if (status === "enriching") {
    return (
      <div className="mb-4 max-w-3xl rounded-lg border border-violet-200 bg-violet-50/50 px-4 py-3 flex items-center gap-2">
        <Loader2
          size={14}
          strokeWidth={2.2}
          className="text-violet-500 animate-spin-slow shrink-0"
        />
        <p className="text-[13px] text-violet-700">
          Enriching with web sources&hellip;
        </p>
      </div>
    );
  }

  return (
    <div className="mb-4 max-w-3xl">
      {enrichedReady ? (
        <div className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-0.5 mb-2 shadow-[0_1px_2px_rgba(9,9,11,0.03)]">
          <ScriptTabBtn
            active={tab === "enriched"}
            onClick={() => setTab("enriched")}
            tone="violet"
          >
            <Sparkles
              size={11}
              strokeWidth={2.4}
              className="-mt-px"
            />
            Enriched
            {Array.isArray(chunk.enrichmentSources) &&
            chunk.enrichmentSources.length > 0 ? (
              <span
                className={`text-[10.5px] tabular-nums nums px-1.5 py-0.5 rounded ${
                  tab === "enriched"
                    ? "bg-white/15 text-white"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {chunk.enrichmentSources.length}
              </span>
            ) : null}
          </ScriptTabBtn>
          <ScriptTabBtn
            active={tab === "original"}
            onClick={() => setTab("original")}
            tone="slate"
          >
            <FileText size={11} strokeWidth={2.4} className="-mt-px" />
            Original
          </ScriptTabBtn>
        </div>
      ) : null}

      {/* Status notice for non-ready states */}
      {status === "skipped" ? (
        <div className="mb-2 rounded-md border border-slate-200 bg-slate-50/70 px-3 py-1.5 text-[12px] text-slate-500">
          Enrichment skipped
          {chunk.enrichmentError ? (
            <span className="text-slate-400"> — {chunk.enrichmentError}</span>
          ) : null}
        </div>
      ) : null}
      {status === "failed" ? (
        <div className="mb-2 rounded-md border border-rose-200 bg-rose-50/70 px-3 py-1.5 text-[12px] text-rose-700 flex items-start gap-1.5">
          <AlertTriangle size={12} strokeWidth={2.2} className="mt-[2px] shrink-0" />
          <span>
            Enrichment failed
            {chunk.enrichmentError ? (
              <span className="text-rose-600/80"> — {chunk.enrichmentError}</span>
            ) : null}
          </span>
        </div>
      ) : null}

      {/* Script body — Enriched takes precedence when active, else Original. */}
      {tab === "enriched" && enrichedReady ? (
        <div className="rounded-lg border border-violet-200 bg-gradient-to-br from-violet-50/40 via-white to-fuchsia-50/30 px-4 py-3 max-h-72 overflow-y-auto">
          <p className="text-[10.5px] uppercase tracking-wide font-semibold text-violet-600/80 mb-1.5">
            Enriched script · sent to avatar
          </p>
          <p className="text-[14px] text-slate-800 leading-relaxed whitespace-pre-wrap break-words">
            {chunk.enrichedText}
          </p>
        </div>
      ) : chunk.text ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 max-h-72 overflow-y-auto">
          <p className="text-[10.5px] uppercase tracking-wide font-semibold text-slate-400 mb-1.5">
            Original transcript
          </p>
          <p className="text-[14px] text-slate-700 leading-relaxed whitespace-pre-wrap break-words">
            {chunk.text}
          </p>
        </div>
      ) : null}

      {/* Sources panel — only for the Enriched tab */}
      {tab === "enriched" &&
      enrichedReady &&
      Array.isArray(chunk.enrichmentSources) &&
      chunk.enrichmentSources.length > 0 ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <p className="text-[10.5px] uppercase tracking-wide font-semibold text-slate-400 mb-2">
            Sources used
          </p>
          <ol className="space-y-1.5">
            {chunk.enrichmentSources.map((s, i) => (
              <li
                key={`${s.url}-${i}`}
                className="text-[13px] text-slate-700 leading-snug flex gap-2"
              >
                <span className="font-mono text-[11.5px] text-slate-400 shrink-0 mt-0.5">
                  [{i + 1}]
                </span>
                <span className="min-w-0">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-violet-700 hover:underline font-medium break-all"
                  >
                    {s.title || s.url}
                  </a>
                  <span className="block text-[11.5px] text-slate-400 truncate">
                    {hostFromUrl(s.url)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function ScriptTabBtn({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone: "violet" | "slate";
  children: React.ReactNode;
}) {
  const activeBg =
    tone === "violet"
      ? "bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white shadow-[0_1px_2px_rgba(124,58,237,0.3)]"
      : "bg-slate-900 text-white shadow-[0_1px_2px_rgba(9,9,11,0.15)]";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12.5px] font-medium transition-colors ${
        active ? activeBg : "text-slate-600 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Reusable bits
// ---------------------------------------------------------------------------

function SummaryPill({
  icon,
  value,
  label,
  from,
  to,
}: {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  from: string;
  to: string;
}) {
  return (
    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white border border-slate-200 shadow-[0_1px_2px_rgba(9,9,11,0.03)]">
      <span
        className={`flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
      >
        {icon}
      </span>
      <span className="text-[14.5px] font-semibold text-slate-900 nums">
        {value}
      </span>
      <span className="text-[13px] text-slate-500">{label}</span>
    </span>
  );
}

function RowBtn({
  icon,
  onClick,
  disabled,
  from,
  to,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  from: string;
  to: string;
  children: React.ReactNode;
}) {
  return (
    <motion.button
      whileHover={!disabled ? { y: -1 } : undefined}
      whileTap={!disabled ? { scale: 0.97 } : undefined}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[14px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-indigo-300 hover:text-slate-900 hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_1px_2px_rgba(9,9,11,0.03)]"
    >
      <span
        className={`flex items-center justify-center w-5 h-5 rounded-md bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] group-disabled:grayscale`}
      >
        {icon}
      </span>
      {children}
    </motion.button>
  );
}

/**
 * Modal that lets the user edit a chunk's topic + full transcript text.
 * Closes on backdrop click, the X button, the Cancel button, and Escape.
 * Saving sends both fields via PATCH; the route re-derives wordCount on
 * the server so we don't have to track it client-side.
 */
function ChunkEditModal({
  chunk,
  onSave,
  onClose,
}: {
  chunk: ChunkRow;
  onSave: (topic: string, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [topic, setTopic] = useState(chunk.topic);
  const [text, setText] = useState(chunk.text ?? "");
  const [saving, setSaving] = useState(false);

  // Esc closes; lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, saving]);

  async function commit() {
    if (saving) return;
    if (!topic.trim()) return;
    setSaving(true);
    try {
      await onSave(topic, text);
    } finally {
      setSaving(false);
    }
  }

  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8 bg-slate-950/40 backdrop-blur-sm animate-reveal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chunk-edit-dialog-title"
      onClick={() => !saving && onClose()}
    >
      <div
        className="relative bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-start gap-3">
          <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-rose-500 to-orange-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
            <Pencil size={15} strokeWidth={2} />
          </span>
          <div className="flex-1 min-w-0">
            <h2
              id="chunk-edit-dialog-title"
              className="text-[16px] font-semibold text-slate-900 leading-tight"
            >
              Edit chunk
            </h2>
            <p className="text-[12px] text-slate-500 mt-0.5 nums leading-tight">
              Chunk #{chunk.idx + 1} ·{" "}
              {formatDuration(chunk.endSec - chunk.startSec)} ·{" "}
              {chunk.wordCount.toLocaleString()} words → {wordCount}
            </p>
          </div>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            disabled={saving}
            aria-label="Close"
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors shrink-0 disabled:opacity-50"
          >
            <X size={16} strokeWidth={2.2} />
          </button>
        </div>

        {/* Body — topic + transcript fields */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] uppercase tracking-wide font-semibold text-slate-500">
              Topic
            </span>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={200}
              disabled={saving}
              className="text-[14.5px] text-slate-900 px-3 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 disabled:opacity-60"
            />
          </label>
          <label className="flex flex-col gap-1.5 flex-1">
            <span className="text-[11.5px] uppercase tracking-wide font-semibold text-slate-500">
              Transcript text
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={14}
              disabled={saving}
              className="text-[13.5px] text-slate-800 leading-relaxed px-3 py-2.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 font-mono resize-y min-h-[200px] disabled:opacity-60"
            />
          </label>
        </div>

        {/* Footer — Cancel + Save */}
        <div className="px-6 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => !saving && onClose()}
            disabled={saving}
            className="inline-flex items-center px-4 py-2 rounded-lg text-[14px] font-medium text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void commit()}
            disabled={saving || !topic.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[14px] font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? (
              <>
                <Loader2
                  size={13}
                  strokeWidth={2.4}
                  className="animate-spin-slow"
                />
                Saving…
              </>
            ) : (
              "Save changes"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
