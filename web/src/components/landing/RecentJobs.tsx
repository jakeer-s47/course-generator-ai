"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  FileVideo,
  Clock,
  HardDrive,
  ArrowRight,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  AudioLines,
  FileText,
  Sparkles,
  Scissors,
  Clapperboard,
  Download,
  ListVideo,
  Check,
} from "lucide-react";
import { formatBytes, formatDuration } from "@/lib/utils";
import {
  STATUS_TO_STEP,
  STEP_LABELS,
  type JobStatusValue,
} from "@/lib/steps";

type JobStatusRow = {
  status: string;
  progress: number;
};

type JobListItem = {
  id: string;
  sourceName: string;
  sourceSize: number;
  sourceDurationSec: number | null;
  createdAt: string;
  status: JobStatusRow | null;
  // Set on standalone jobs (file/url). Group parents have kind="playlist"
  // or kind="batch"; their children (kind="*_file" / "playlist_video") are
  // filtered out of the list response.
  kind?:
    | "file"
    | "url"
    | "playlist"
    | "playlist_video"
    | "batch"
    | "batch_file";
  // Only present on group-parent jobs (playlist or batch) — aggregated by
  // GET /api/jobs. The field name is historic ("playlist") but the
  // semantics now cover any group parent.
  playlist?: {
    totalChildren: number;
    doneChildren: number;
    inProgressChildren: number;
    failedChildren: number;
  };
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
  done: CheckCircle2,
  failed: AlertTriangle,
};

function asStatus(s: string): JobStatusValue {
  return (s as JobStatusValue) in STATUS_TO_STEP
    ? (s as JobStatusValue)
    : "audio";
}

function stageMeta(job: JobListItem) {
  const statusVal = asStatus(job.status?.status ?? "audio");
  const progress = job.status?.progress ?? 0;
  const stepNum = STATUS_TO_STEP[statusVal];

  if (statusVal === "failed") {
    return {
      label: `Step ${stepNum}: ${STEP_LABELS[statusVal]}`,
      pillClass: "bg-rose-50 text-rose-700 border-rose-100",
      iconBg: "bg-gradient-to-br from-rose-500 to-red-500",
      Icon: AlertTriangle,
      resumeLabel: "Retry",
      running: false,
      progress,
    };
  }
  if (statusVal === "done") {
    return {
      label: "All done",
      pillClass: "bg-emerald-50 text-emerald-700 border-emerald-100",
      iconBg: "bg-gradient-to-br from-emerald-500 to-teal-500",
      Icon: CheckCircle2,
      resumeLabel: "View result",
      running: false,
      progress: 100,
    };
  }

  const running = progress > 0 && progress < 100;
  const Icon = running ? Loader2 : STATUS_ICONS[statusVal];
  const label = running
    ? `Step ${stepNum}: ${STEP_LABELS[statusVal]} · ${progress}%`
    : `Step ${stepNum}: ${STEP_LABELS[statusVal]} — pending`;

  return {
    label,
    pillClass: running
      ? "bg-indigo-50 text-indigo-700 border-indigo-100"
      : "bg-slate-50 text-slate-700 border-slate-200",
    iconBg: running
      ? "bg-gradient-to-br from-indigo-500 to-fuchsia-500"
      : "bg-gradient-to-br from-slate-400 to-slate-500",
    Icon,
    resumeLabel: running
      ? "Watch progress"
      : statusVal === "audio"
        ? "Extract audio"
        : `Continue to ${STEP_LABELS[statusVal]}`,
    running,
    progress,
  };
}

function relativeTime(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Minimal 5-dot bar (steps 2..6) showing which step the video is on.
function MiniStepper({ status, progress }: JobStatusRow) {
  const statusVal = asStatus(status);
  const currentStep = STATUS_TO_STEP[statusVal]; // 2..6 or 6 for done/failed
  const allDone = statusVal === "done";
  const failed = statusVal === "failed";

  return (
    <div className="flex items-center gap-1">
      {[2, 3, 4, 5, 6].map((n) => {
        const before = n < currentStep || allDone;
        const here = n === currentStep;
        const running = here && progress > 0 && progress < 100;
        const classes = failed && here
          ? "bg-rose-500"
          : before
            ? "bg-emerald-500"
            : running
              ? "bg-gradient-to-br from-indigo-500 to-fuchsia-500"
              : here
                ? "bg-indigo-200"
                : "bg-slate-200";
        return (
          <span
            key={n}
            title={`Step ${n}`}
            className={`w-5 h-1.5 rounded-full ${classes} transition-colors`}
          />
        );
      })}
    </div>
  );
}

export function RecentJobs() {
  const [jobs, setJobs] = useState<JobListItem[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/jobs");
        if (!r.ok) return;
        const data = (await r.json()) as JobListItem[];
        if (!cancelled) setJobs(data);
      } catch {
        /* silent */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    // Poll every 3s while any job is mid-progress. Two trigger conditions:
    //   - Any standalone job (file/url) with a non-terminal status row.
    //   - Any playlist parent whose children aren't all done yet —
    //     parents have no status row of their own, so we read the
    //     aggregated playlist.{totalChildren, doneChildren} payload.
    const interval = window.setInterval(() => {
      setJobs((prev) => {
        if (!prev) return prev;
        const hasInFlight = prev.some((j) => {
          // Single-job in flight
          if (
            j.status &&
            j.status.progress > 0 &&
            j.status.progress < 100 &&
            j.status.status !== "done"
          ) {
            return true;
          }
          // Group parent in flight — children still working. Same check
          // for both playlist and batch parents (they share the aggregate
          // shape on the response).
          if ((j.kind === "playlist" || j.kind === "batch") && j.playlist) {
            return j.playlist.doneChildren < j.playlist.totalChildren;
          }
          return false;
        });
        if (hasInFlight) void load();
        return prev;
      });
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (loading) return null;
  if (!jobs || jobs.length === 0) return null;

  return (
    <section className="border-b border-slate-200 bg-white">
      <div className="max-w-6xl mx-auto px-6 py-12 md:py-14">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="flex items-end justify-between gap-4 flex-wrap mb-6"
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-indigo-700 uppercase tracking-wide">
              Your recent jobs
            </span>
            <h2 className="text-[28px] md:text-[32px] font-semibold tracking-tight text-slate-900 leading-tight">
              Pick up where you left off
            </h2>
          </div>
          <Link
            href="/new"
            className="text-[14px] font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1.5 transition-colors"
          >
            Start a new job
            <ArrowRight size={13} strokeWidth={2} />
          </Link>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.06 } },
          }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
        >
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function JobCard({ job }: { job: JobListItem }) {
  // Group-parent jobs render a different card — they aggregate child
  // progress instead of showing single-stage stats.
  if (job.kind === "playlist") {
    return <PlaylistJobCard job={job} />;
  }
  if (job.kind === "batch") {
    return <BatchJobCard job={job} />;
  }
  const meta = stageMeta(job);
  const Icon = meta.Icon;

  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: { opacity: 1, y: 0 },
      }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -2 }}
      className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white hover:border-slate-300 hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_8px_24px_-12px_rgba(15,23,42,0.2)] transition-all p-5 flex flex-col gap-4"
    >
      <div
        aria-hidden
        className="absolute -right-10 -top-10 w-28 h-28 rounded-full bg-gradient-to-br from-indigo-500/8 to-fuchsia-500/8 blur-2xl pointer-events-none"
      />

      <div className="relative flex items-start gap-3">
        <span
          className={`flex items-center justify-center w-10 h-10 rounded-xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] shrink-0 ${meta.iconBg}`}
        >
          <Icon size={17} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[15.5px] font-semibold text-slate-900 truncate leading-snug">
            {job.sourceName || "Untitled"}
          </p>
          <p className="text-[12px] text-slate-500 mt-0.5">
            {relativeTime(job.createdAt)}
          </p>
        </div>
      </div>

      <div className="relative">
        <span
          className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full border ${meta.pillClass}`}
        >
          {meta.running ? (
            <Loader2 size={10} strokeWidth={2.4} className="animate-spin-slow" />
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
          )}
          {meta.label}
        </span>
      </div>

      {job.status && (
        <div className="relative">
          <MiniStepper
            status={job.status.status}
            progress={job.status.progress}
          />
        </div>
      )}

      {meta.running && (
        <div className="relative">
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <motion.div
              className="h-full shimmer-bar rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${meta.progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        </div>
      )}

      <div className="relative flex items-center gap-4 text-[12px] text-slate-500">
        {job.sourceDurationSec !== null && (
          <span className="inline-flex items-center gap-1">
            <Clock size={11} strokeWidth={2} />
            <span className="nums">{formatDuration(job.sourceDurationSec)}</span>
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <HardDrive size={11} strokeWidth={2} />
          <span className="nums">{formatBytes(job.sourceSize)}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <FileVideo size={11} strokeWidth={2} />
          #{job.id.slice(0, 8)}
        </span>
      </div>

      <div className="relative mt-auto pt-2">
        <Link
          href={`/new?job=${job.id}`}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13.5px] font-medium text-white bg-gradient-to-br from-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_2px_8px_-2px_rgba(99,102,241,0.4)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_6px_18px_-4px_rgba(99,102,241,0.6)] transition-shadow"
        >
          {meta.resumeLabel}
          <ArrowRight
            size={13}
            strokeWidth={2.2}
            className="transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      </div>
    </motion.div>
  );
}

/**
 * Recent Jobs card for a playlist parent. Aggregate progress (X of N done)
 * is computed server-side in GET /api/jobs and surfaced via job.playlist.
 */
function PlaylistJobCard({ job }: { job: JobListItem }) {
  const total = job.playlist?.totalChildren ?? 0;
  const done = job.playlist?.doneChildren ?? 0;
  const inProgress = job.playlist?.inProgressChildren ?? 0;
  const failed = job.playlist?.failedChildren ?? 0;
  const allDone = total > 0 && done === total;
  const overallPct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: { opacity: 1, y: 0 },
      }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -2 }}
      className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white hover:border-slate-300 hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_8px_24px_-12px_rgba(217,70,239,0.25)] transition-all p-5 flex flex-col gap-4"
    >
      <div
        aria-hidden
        className="absolute -right-10 -top-10 w-28 h-28 rounded-full bg-gradient-to-br from-fuchsia-500/10 to-pink-500/10 blur-2xl pointer-events-none"
      />

      <div className="relative flex items-start gap-3">
        <span
          className={`flex items-center justify-center w-10 h-10 rounded-xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] shrink-0 ${
            allDone
              ? "bg-gradient-to-br from-emerald-500 to-teal-500"
              : "bg-gradient-to-br from-fuchsia-500 to-pink-500"
          }`}
        >
          <ListVideo size={17} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-fuchsia-700 uppercase tracking-wide font-semibold mb-0.5">
            Playlist
          </p>
          <p className="text-[15.5px] font-semibold text-slate-900 truncate leading-snug">
            {job.sourceName || "Untitled playlist"}
          </p>
          <p className="text-[12px] text-slate-500 mt-0.5">
            {relativeTime(job.createdAt)}
          </p>
        </div>
      </div>

      <div className="relative flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full border ${
            allDone
              ? "bg-emerald-50 text-emerald-700 border-emerald-100"
              : "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-100"
          }`}
        >
          {allDone ? (
            <Check size={10} strokeWidth={2.6} />
          ) : (
            <Loader2 size={10} strokeWidth={2.4} className="animate-spin-slow" />
          )}
          {allDone ? "All done" : `${done} / ${total} done`}
        </span>
        {inProgress > 0 && (
          <span className="inline-flex items-center gap-1 text-[11.5px] font-medium px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100">
            {inProgress} downloading
          </span>
        )}
        {failed > 0 && (
          <span className="inline-flex items-center gap-1 text-[11.5px] font-medium px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-100">
            {failed} failed
          </span>
        )}
      </div>

      <div className="relative">
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${
              allDone
                ? "bg-gradient-to-r from-emerald-500 to-teal-500"
                : "shimmer-bar"
            }`}
            initial={{ width: 0 }}
            animate={{ width: `${overallPct}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
      </div>

      <div className="relative flex items-center gap-4 text-[12px] text-slate-500">
        {job.sourceDurationSec !== null && (
          <span className="inline-flex items-center gap-1">
            <Clock size={11} strokeWidth={2} />
            <span className="nums">{formatDuration(job.sourceDurationSec)}</span>
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <ListVideo size={11} strokeWidth={2} />
          <span className="nums">{total} videos</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <FileVideo size={11} strokeWidth={2} />
          #{job.id.slice(0, 8)}
        </span>
      </div>

      <div className="relative mt-auto pt-2">
        <Link
          href={`/new?job=${job.id}`}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13.5px] font-medium text-white bg-gradient-to-br from-fuchsia-600 to-pink-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_2px_8px_-2px_rgba(217,70,239,0.4)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_6px_18px_-4px_rgba(217,70,239,0.6)] transition-shadow"
        >
          Open playlist
          <ArrowRight
            size={13}
            strokeWidth={2.2}
            className="transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      </div>
    </motion.div>
  );
}

/**
 * Recent Jobs card for a multi-file batch parent. Same aggregate-progress
 * shape as `PlaylistJobCard` (X of N done) but with the file-batch icon
 * and the indigo→fuchsia palette to distinguish from playlist parents.
 */
function BatchJobCard({ job }: { job: JobListItem }) {
  const total = job.playlist?.totalChildren ?? 0;
  const done = job.playlist?.doneChildren ?? 0;
  const inProgress = job.playlist?.inProgressChildren ?? 0;
  const failed = job.playlist?.failedChildren ?? 0;
  const allDone = total > 0 && done === total;
  const overallPct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: { opacity: 1, y: 0 },
      }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -2 }}
      className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white hover:border-slate-300 hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_8px_24px_-12px_rgba(99,102,241,0.25)] transition-all p-5 flex flex-col gap-4"
    >
      <div
        aria-hidden
        className="absolute -right-10 -top-10 w-28 h-28 rounded-full bg-gradient-to-br from-indigo-500/10 to-fuchsia-500/10 blur-2xl pointer-events-none"
      />

      <div className="relative flex items-start gap-3">
        <span
          className={`flex items-center justify-center w-10 h-10 rounded-xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] shrink-0 ${
            allDone
              ? "bg-gradient-to-br from-emerald-500 to-teal-500"
              : "bg-gradient-to-br from-indigo-500 to-fuchsia-500"
          }`}
        >
          <FileVideo size={17} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-indigo-700 uppercase tracking-wide font-semibold mb-0.5">
            Multi-file batch
          </p>
          <p className="text-[15.5px] font-semibold text-slate-900 truncate leading-snug">
            {job.sourceName || "Untitled batch"}
          </p>
          <p className="text-[12px] text-slate-500 mt-0.5">
            {relativeTime(job.createdAt)}
          </p>
        </div>
      </div>

      <div className="relative flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full border ${
            allDone
              ? "bg-emerald-50 text-emerald-700 border-emerald-100"
              : "bg-indigo-50 text-indigo-700 border-indigo-100"
          }`}
        >
          {allDone ? (
            <Check size={10} strokeWidth={2.6} />
          ) : (
            <Loader2 size={10} strokeWidth={2.4} className="animate-spin-slow" />
          )}
          {allDone ? "All done" : `${done} / ${total} done`}
        </span>
        {inProgress > 0 && (
          <span className="inline-flex items-center gap-1 text-[11.5px] font-medium px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100">
            {inProgress} extracting
          </span>
        )}
        {failed > 0 && (
          <span className="inline-flex items-center gap-1 text-[11.5px] font-medium px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-100">
            {failed} failed
          </span>
        )}
      </div>

      <div className="relative">
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${
              allDone
                ? "bg-gradient-to-r from-emerald-500 to-teal-500"
                : "shimmer-bar"
            }`}
            initial={{ width: 0 }}
            animate={{ width: `${overallPct}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
      </div>

      <div className="relative flex items-center gap-4 text-[12px] text-slate-500">
        {job.sourceDurationSec !== null && (
          <span className="inline-flex items-center gap-1">
            <Clock size={11} strokeWidth={2} />
            <span className="nums">{formatDuration(job.sourceDurationSec)}</span>
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <FileVideo size={11} strokeWidth={2} />
          <span className="nums">{total} files</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <HardDrive size={11} strokeWidth={2} />
          <span className="nums">{formatBytes(job.sourceSize)}</span>
        </span>
      </div>

      <div className="relative mt-auto pt-2">
        <Link
          href={`/new?job=${job.id}`}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13.5px] font-medium text-white bg-gradient-to-br from-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_2px_8px_-2px_rgba(99,102,241,0.4)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_6px_18px_-4px_rgba(99,102,241,0.6)] transition-shadow"
        >
          Open batch
          <ArrowRight
            size={13}
            strokeWidth={2.2}
            className="transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      </div>
    </motion.div>
  );
}
