"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  ListVideo,
  ArrowLeft,
  ArrowRight,
  Clock,
  Loader2,
  Check,
  AlertTriangle,
  AudioLines,
  FileText,
  Sparkles,
  Scissors,
  Clapperboard,
  Download,
  Play,
  ChevronDown,
} from "lucide-react";
import { ChildInlineDetail } from "./ChildInlineDetail";
import { formatDuration } from "@/lib/utils";
import { STATUS_TO_STEP, STEP_LABELS, type JobStatusValue } from "@/lib/steps";

type ChildRow = {
  id: string;
  sourceName: string;
  sourceDurationSec: number | null;
  status: { status: string; progress: number } | null;
};

type PlaylistData = {
  parent: {
    id: string;
    sourceName: string;
    sourceDurationSec: number | null;
    createdAt: string;
  };
  children: ChildRow[];
};

const STATUS_ICONS: Record<
  JobStatusValue,
  React.ComponentType<{ size?: number; strokeWidth?: number }>
> = {
  downloading: Download,
  audio: AudioLines,
  transcript: FileText,
  clean: Sparkles,
  split: Scissors,
  render: Clapperboard,
  done: Check,
  failed: AlertTriangle,
};

function asStatus(s: string | null | undefined): JobStatusValue {
  if (!s) return "downloading";
  return (s as JobStatusValue) in STATUS_TO_STEP
    ? (s as JobStatusValue)
    : "downloading";
}

function childMeta(child: ChildRow) {
  const statusVal = asStatus(child.status?.status);
  const progress = child.status?.progress ?? 0;

  if (statusVal === "failed") {
    return {
      label: "Failed",
      sublabel: "Click to retry",
      pill: "bg-rose-50 text-rose-700 border-rose-100",
      iconBg: "bg-gradient-to-br from-rose-500 to-orange-500",
      Icon: AlertTriangle,
      action: "Retry",
    };
  }
  if (statusVal === "done") {
    return {
      label: "All done",
      sublabel: "Avatar render complete",
      pill: "bg-emerald-50 text-emerald-700 border-emerald-100",
      iconBg: "bg-gradient-to-br from-emerald-500 to-teal-500",
      Icon: Check,
      action: "Open",
    };
  }
  const stepNum = STATUS_TO_STEP[statusVal];
  // With concurrency=1, queued playlist children sit at downloading/0
  // until their turn. The runner bumps to 1% the moment it acquires its
  // slot, but yt-dlp's first real % line takes ~5-8 s after that (manifest
  // fetch). Three visible "downloading" states:
  //   progress=0  → Waiting in queue
  //   progress=1  → Starting download (warm-up window)
  //   progress>1  → Downloading (real percent)
  const queuedForDownload = statusVal === "downloading" && progress === 0;
  const startingDownload = statusVal === "downloading" && progress === 1;
  const running = progress > 1 && progress < 100;
  if (queuedForDownload) {
    return {
      label: "Waiting in queue",
      sublabel: "Will start once the current download finishes",
      pill: "bg-slate-50 text-slate-700 border-slate-200",
      iconBg: "bg-gradient-to-br from-slate-400 to-slate-500",
      Icon: Clock,
      action: "Continue",
    };
  }
  if (startingDownload) {
    return {
      label: "Starting download…",
      sublabel: "Fetching video manifest",
      pill: "bg-indigo-50 text-indigo-700 border-indigo-100",
      iconBg: "bg-gradient-to-br from-indigo-500 to-fuchsia-500",
      Icon: Loader2,
      action: "Continue",
    };
  }
  return {
    label: running
      ? `Step ${stepNum}: ${STEP_LABELS[statusVal]} · ${progress}%`
      : `Step ${stepNum}: ${STEP_LABELS[statusVal]}`,
    sublabel: running ? "In progress…" : "Ready to continue",
    pill: running
      ? "bg-indigo-50 text-indigo-700 border-indigo-100"
      : "bg-slate-50 text-slate-700 border-slate-200",
    iconBg: running
      ? "bg-gradient-to-br from-indigo-500 to-fuchsia-500"
      : "bg-gradient-to-br from-slate-400 to-slate-500",
    Icon: running ? Loader2 : STATUS_ICONS[statusVal],
    action: "Continue",
  };
}

/**
 * Playlist overview — rendered when /new?job=<id> resolves to a parent
 * Job (kind="playlist"). Lists children with per-step status and a
 * Continue link into each one's individual wizard.
 */
export function PlaylistOverview({ parentId }: { parentId: string }) {
  const [data, setData] = useState<PlaylistData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  // Set of expanded child IDs — multiple can be open at once for
  // side-by-side comparison.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function startProcessAll() {
    if (processing) return;
    setProcessing(true);
    setProcessError(null);
    try {
      const r = await fetch(`/api/jobs/${parentId}/process-all`, {
        method: "POST",
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

  // Initial load + 600 ms poll while any child is mid-pipeline. yt-dlp
  // emits progress every 5–10 sec for YouTube DASH (one per fragment),
  // so polling at 600 ms catches each emission within a fraction of
  // a second of when it lands in the DB.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/jobs/${parentId}/playlist`);
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        const payload = (await r.json()) as PlaylistData;
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const id = window.setInterval(() => {
      // Keep polling while ANY child is mid-pipeline. Once everyone is
      // at render/done or failed, polling stops.
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
  }, [parentId]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto w-full text-center py-16 px-6">
        <p className="text-[15px] text-rose-700 font-medium">
          Couldn&rsquo;t load this playlist: {error}
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 mt-4 text-[14px] text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft size={13} strokeWidth={2} />
          Back to home
        </Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-3xl mx-auto w-full flex items-center justify-center py-20">
        <span className="inline-flex items-center gap-2.5 text-slate-500 text-[15px]">
          <Loader2 size={17} strokeWidth={2} className="animate-spin-slow" />
          Loading playlist…
        </span>
      </div>
    );
  }

  const total = data.children.length;
  const done = data.children.filter((c) =>
    ["transcript", "clean", "split", "render", "done"].includes(
      c.status?.status ?? "",
    ),
  ).length;
  const inProgress = data.children.filter(
    (c) =>
      c.status?.status === "downloading" &&
      (c.status?.progress ?? 0) > 0 &&
      (c.status?.progress ?? 0) < 100,
  ).length;
  const totalDur = data.parent.sourceDurationSec ?? 0;
  const overallPct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <div className="max-w-4xl mx-auto w-full px-6 py-10 md:py-12 flex flex-col gap-7 animate-reveal">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="group inline-flex items-center gap-1.5 text-[13.5px] text-slate-500 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft
            size={13}
            strokeWidth={2}
            className="transition-transform group-hover:-translate-x-0.5"
          />
          Back to home
        </Link>
      </div>

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-fuchsia-50/40 via-white to-pink-50/30 shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-6"
      >
        <div
          aria-hidden
          className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-fuchsia-500/10 to-pink-500/10 blur-3xl"
        />
        <div className="relative flex items-start gap-4 flex-wrap">
          <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-fuchsia-500 via-pink-500 to-rose-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(217,70,239,0.4)]">
            <ListVideo size={22} strokeWidth={1.8} />
          </span>
          <div className="flex-1 min-w-[200px]">
            <p className="text-[12px] text-fuchsia-700 uppercase tracking-wide font-semibold mb-0.5">
              Playlist
            </p>
            <h1 className="text-[24px] font-semibold tracking-tight text-slate-900 leading-tight break-words">
              {data.parent.sourceName}
            </h1>
            <p className="text-[13.5px] text-slate-500 mt-1 nums leading-tight">
              {total} videos · {formatDuration(totalDur)} total ·{" "}
              <span className="font-semibold text-slate-700">{done}</span> done
              {inProgress > 0 && (
                <>
                  {" "}
                  · <span className="text-indigo-700">{inProgress}</span> in
                  progress
                </>
              )}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0 min-w-[140px]">
            <p className="text-[28px] font-semibold text-slate-900 nums leading-none">
              {overallPct}%
            </p>
            <p className="text-[12px] text-slate-500 leading-none">
              overall
            </p>
          </div>
        </div>
        <div className="relative mt-4 h-2 bg-slate-100 rounded-full overflow-hidden">
          <motion.div
            initial={false}
            animate={{ width: `${overallPct}%` }}
            transition={{ duration: 0.7, ease: "linear" }}
            className={`h-full rounded-full ${
              overallPct === 100
                ? "bg-gradient-to-r from-emerald-500 to-teal-500"
                : "shimmer-bar"
            }`}
          />
        </div>
      </motion.div>

      {/* Process-all CTA — visible while any child still has stages
          remaining after the URL download finishes. */}
      {(() => {
        const pending = data.children.filter((c) => {
          const s = c.status?.status ?? "downloading";
          return s !== "render" && s !== "done" && s !== "failed";
        });
        if (pending.length === 0) return null;
        return (
          <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-indigo-50/60 via-white to-fuchsia-50/40 p-5 flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-[220px]">
              <p className="text-[15px] font-semibold text-slate-900 leading-tight">
                Run the rest of the pipeline for everyone
              </p>
              <p className="text-[12.5px] text-slate-500 mt-1 leading-snug">
                Transcribe → cleanup → split into ~20-min chunks for all{" "}
                {pending.length} remaining video{pending.length === 1 ? "" : "s"}.
                You can still pick a different cleanup level or chunk length on
                each video afterwards.
              </p>
              {processError && (
                <p className="mt-2 text-[12px] text-rose-700">
                  {processError}
                </p>
              )}
            </div>
            <motion.button
              whileHover={!processing ? { y: -1 } : undefined}
              whileTap={!processing ? { scale: 0.97 } : undefined}
              type="button"
              onClick={startProcessAll}
              disabled={processing}
              className="relative inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[14px] font-medium text-white bg-gradient-to-br from-indigo-600 via-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(99,102,241,0.5)] disabled:opacity-60 disabled:cursor-not-allowed transition-shadow"
            >
              {processing ? (
                <>
                  <Loader2 size={13} strokeWidth={2.4} className="animate-spin-slow" />
                  Started — watch progress below
                </>
              ) : (
                <>
                  <Play size={13} strokeWidth={2.4} />
                  Process all {pending.length}
                  <ArrowRight size={13} strokeWidth={2.2} />
                </>
              )}
            </motion.button>
          </div>
        );
      })()}

      {/* Children list */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] divide-y divide-slate-200 overflow-hidden">
        {data.children.map((child, i) => {
          const meta = childMeta(child);
          const Icon = meta.Icon;
          const running =
            child.status?.status === "downloading" &&
            (child.status?.progress ?? 0) > 0 &&
            (child.status?.progress ?? 0) < 100;

          const isOpen = expanded.has(child.id);
          return (
            <div key={child.id}>
              <button
                type="button"
                onClick={() => toggleExpanded(child.id)}
                aria-expanded={isOpen}
                className="group w-full flex items-center gap-4 px-5 py-4 text-left hover:bg-slate-50 transition-colors"
              >
                <span className="font-mono text-[13px] text-slate-400 nums tabular-nums shrink-0 w-8 text-right">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span
                  className={`flex items-center justify-center w-10 h-10 rounded-xl text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] ${meta.iconBg}`}
                >
                  <Icon
                    size={17}
                    strokeWidth={2}
                    className={running ? "animate-spin-slow" : undefined}
                  />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[15.5px] font-semibold text-slate-900 truncate leading-snug">
                    {child.sourceName}
                  </p>
                  <p className="text-[12.5px] text-slate-500 mt-0.5 leading-tight">
                    {child.sourceDurationSec
                      ? `${formatDuration(child.sourceDurationSec)} · `
                      : ""}
                    <span
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border ${meta.pill}`}
                    >
                      {meta.label}
                    </span>
                  </p>
                </div>
                <ChevronDown
                  size={16}
                  strokeWidth={2.2}
                  className={`shrink-0 text-slate-400 group-hover:text-slate-700 transition-transform ${
                    isOpen ? "rotate-180" : ""
                  }`}
                />
              </button>
              {isOpen && <ChildInlineDetail jobId={child.id} />}
            </div>
          );
        })}
      </div>

      <p className="text-[12.5px] text-slate-400 text-center">
        Click any video to expand and inspect its audio, transcript, cleanup,
        and chunks. Use &ldquo;Open in full wizard&rdquo; to override defaults.
      </p>
    </div>
  );
}
