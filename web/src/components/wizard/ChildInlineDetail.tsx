"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AudioLines,
  FileText,
  Sparkles,
  Scissors,
  ArrowRight,
  Loader2,
  Check,
  AlertTriangle,
  Clock,
  X,
  Maximize2,
} from "lucide-react";
import { formatBytes, formatDuration } from "@/lib/utils";

type AudioRow = {
  status: "pending" | "extracting" | "ready" | "failed";
  progress: number;
  durationSec: number | null;
  sizeBytes: number | null;
  bitrateKbps: number | null;
  errorMessage: string | null;
};

type TranscriptRow = {
  status: "pending" | "transcribing" | "ready" | "failed";
  progress: number;
  rawText: string | null;
  wordCount: number | null;
  durationSec: number | null;
  language: string | null;
  errorMessage: string | null;
};

type CleanedRow = {
  status: "pending" | "cleaning" | "ready" | "failed";
  progress: number;
  cleanLevel: string;
  cleanedText: string | null;
  originalWords: number | null;
  cleanedWords: number | null;
  removedSegments: number | null;
  removedDurSec: number | null;
  errorMessage: string | null;
};

export type ChunkRow = {
  id: string;
  idx: number;
  topic: string;
  preview: string;
  text: string | null;
  startSec: number;
  endSec: number;
  wordCount: number;
};

export type CleanLevel = "light" | "standard" | "aggressive";
const DEFAULT_LEVEL: CleanLevel = "standard";
const DEFAULT_TARGET_MIN = 20;

// Parent-status → stage-number mapping. Used by each section to decide
// whether to poll: a section's endpoint can only return non-404 once the
// cascade reaches that section's stage. Polling earlier just spams the
// server with 404s for rows that DON'T exist yet.
//
// "failed" is treated as "all stages reachable" so the user can still
// retry / see error messages from any step.
const STAGE_NUM: Record<string, number> = {
  downloading: 1,
  audio: 2,
  transcript: 3,
  clean: 4,
  split: 5,
  render: 6,
  done: 6,
  failed: 6,
};

function isStageActive(
  parentStatus: string | undefined,
  sectionStage: number,
): boolean {
  // No parent status info → fall back to polling so the section still
  // works in single-job contexts (which don't pass parentStatus).
  if (!parentStatus) return true;
  const parentNum = STAGE_NUM[parentStatus] ?? 0;
  return parentNum >= sectionStage;
}

/**
 * Inline detail panel rendered inside BatchOverview / PlaylistOverview when
 * the user expands a child row. Shows the four pipeline outputs (audio,
 * transcript, cleanup stats, chunks) inline so the user can compare across
 * children without navigating away.
 *
 * Each section fetches its own endpoint and renders one of:
 *   - "Not yet" placeholder (stage hasn't started)
 *   - in-flight indicator with current %
 *   - ready content (audio player, text excerpt, stats grid, chunk list)
 *   - failed pill with the captured error message
 *
 * Lazy: only mounts and fetches when the parent renders the panel — i.e.,
 * when the row is expanded. Polling tracks in-flight stages until they
 * land.
 */
export function ChildInlineDetail({ jobId }: { jobId: string }) {
  return (
    <div className="bg-slate-50/40 border-t border-slate-200 px-5 py-5 flex flex-col gap-4 animate-reveal">
      <AudioSection jobId={jobId} />
      <TranscriptSection jobId={jobId} />
      <CleanSection jobId={jobId} />
      <ChunksSection jobId={jobId} />
      <div className="flex justify-end pt-1">
        <Link
          href={`/new?job=${jobId}`}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-indigo-700 hover:text-indigo-900 transition-colors"
        >
          Open this video in the full wizard
          <ArrowRight size={12} strokeWidth={2.4} />
        </Link>
      </div>
    </div>
  );
}

/**
 * Generic poll-while-not-terminal hook.
 *
 * `isTerminal` is captured in a ref so its identity changing across
 * renders DOESN'T re-run the effect. Without this, each parent re-render
 * (which fires every 1500 ms when the parent polls /batch or /playlist)
 * would tear down + restart this child's polling, firing an extra
 * request per parent tick — N children × 2 polls per cycle.
 */
function usePolling<T>(
  url: string,
  isTerminal: (data: T) => boolean,
  active: boolean,
): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isTerminalRef = useRef(isTerminal);
  isTerminalRef.current = isTerminal;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let interval: number | undefined;

    const tick = async () => {
      try {
        const r = await fetch(url);
        if (r.status === 404) {
          if (!cancelled) {
            setData(null);
            setError(null);
            setLoading(false);
          }
          return;
        }
        if (!r.ok) {
          if (!cancelled) {
            setError(`HTTP ${r.status}`);
            setLoading(false);
          }
          return;
        }
        const body = (await r.json()) as T;
        if (cancelled) return;
        setData(body);
        setError(null);
        setLoading(false);
        if (isTerminalRef.current(body) && interval) {
          window.clearInterval(interval);
          interval = undefined;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    };
    void tick();
    interval = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
    };
    // isTerminal is intentionally omitted — it's read via the ref so its
    // identity flipping every render doesn't trigger a poll restart.
  }, [url, active]);

  return { data, loading, error };
}

// ── Section 1 — Audio ────────────────────────────────────────────────────
export function AudioSection({
  jobId,
  parentStatus,
}: {
  jobId: string;
  parentStatus?: string;
}) {
  const isTerminal = (d: AudioRow) =>
    d.status === "ready" || d.status === "failed";
  // Stage 2 — only poll once the parent has reached audio stage or
  // beyond. Skips 404 spam during the URL "downloading" phase.
  const active = isStageActive(parentStatus, 2);
  const { data, loading } = usePolling<AudioRow>(
    `/api/jobs/${jobId}/audio`,
    isTerminal,
    active,
  );

  return (
    <DetailSection
      icon={AudioLines}
      label="Audio"
      tone="from-indigo-500 to-cyan-500"
    >
      {!active ? (
        <WaitingRow label="Waiting — Step 1 download still running" />
      ) : loading && !data ? (
        <p className="text-[12.5px] text-slate-400 italic">Checking…</p>
      ) : !data ? (
        <PlaceholderPending label="Not yet — extraction will start here" />
      ) : data.status === "failed" ? (
        <FailedRow message={data.errorMessage ?? "Extraction failed"} />
      ) : data.status === "ready" ? (
        <div className="flex flex-col gap-2">
          <audio
            controls
            preload="metadata"
            src={`/api/jobs/${jobId}/audio/file`}
            className="w-full h-9"
          />
          <p className="text-[11.5px] text-slate-500 nums">
            {formatDuration(data.durationSec ?? 0)} ·{" "}
            {data.sizeBytes ? formatBytes(Number(data.sizeBytes)) : "—"} ·{" "}
            {data.bitrateKbps ? `${data.bitrateKbps} kbps` : "—"}
          </p>
        </div>
      ) : (
        <InFlightRow
          percent={data.progress}
          label="Extracting audio"
          tone="from-indigo-500 to-cyan-500"
        />
      )}
    </DetailSection>
  );
}

// ── Section 2 — Transcript ──────────────────────────────────────────────
export function TranscriptSection({
  jobId,
  sourceName,
  parentStatus,
}: {
  jobId: string;
  sourceName?: string;
  parentStatus?: string;
}) {
  const isTerminal = (d: TranscriptRow) =>
    d.status === "ready" || d.status === "failed";
  // Stage 3 — only poll once the cascade has reached the transcript
  // stage. While the child is still extracting / downloading there's
  // no transcript row to find; the parent's polling will tell us when
  // it transitions and `active` flips to true.
  const active = isStageActive(parentStatus, 3);
  const { data, loading } = usePolling<TranscriptRow>(
    `/api/jobs/${jobId}/transcript`,
    isTerminal,
    active,
  );
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <DetailSection
      icon={FileText}
      label="Transcript"
      tone="from-violet-500 to-purple-500"
    >
      {!active ? (
        <WaitingRow
          label={
            parentStatus === "downloading"
              ? "Waiting — Step 1 download still running"
              : "Waiting — Step 2 audio extract still running"
          }
        />
      ) : loading && !data ? (
        <p className="text-[12.5px] text-slate-400 italic">Checking…</p>
      ) : !data ? (
        <PlaceholderPending label="Will fill in once transcription runs" />
      ) : data.status === "failed" ? (
        <FailedRow message={data.errorMessage ?? "Transcription failed"} />
      ) : data.status === "ready" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[12.5px] text-slate-500 nums">
              {data.wordCount?.toLocaleString() ?? "—"} words ·{" "}
              {data.language ?? "—"} ·{" "}
              {formatDuration(data.durationSec ?? 0)}
            </p>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 transition-colors"
            >
              <Maximize2 size={11} strokeWidth={2.4} />
              Open transcript
            </button>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3 text-[12.5px] text-slate-700 leading-relaxed line-clamp-4">
            {data.rawText?.slice(0, 600) ?? ""}
            {data.rawText && data.rawText.length > 600 ? "…" : ""}
          </div>
          {dialogOpen && (
            <TextDialog
              title={sourceName ?? "Transcript"}
              subtitle={`${data.wordCount?.toLocaleString() ?? "—"} words${
                data.language ? ` · ${data.language}` : ""
              }${
                data.durationSec != null
                  ? ` · ${formatDuration(data.durationSec)}`
                  : ""
              }`}
              icon={FileText}
              iconTone="from-violet-500 to-purple-500"
              text={data.rawText ?? ""}
              emptyMessage="Transcript is empty."
              onClose={() => setDialogOpen(false)}
            />
          )}
        </div>
      ) : (
        <InFlightRow
          percent={data.progress}
          label="Transcribing audio"
          tone="from-violet-500 to-purple-500"
        />
      )}
    </DetailSection>
  );
}

/**
 * Modal that displays a long block of text (raw or cleaned transcript).
 * Closes on backdrop click, the X button, and the Escape key. Body scroll
 * is locked while open.
 */
function TextDialog({
  title,
  subtitle,
  icon: Icon,
  iconTone,
  text,
  emptyMessage,
  onClose,
}: {
  title: string;
  subtitle?: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  iconTone: string;
  text: string;
  emptyMessage: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8 bg-slate-950/40 backdrop-blur-sm animate-reveal"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="text-dialog-title"
    >
      <div
        className="relative bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-start gap-3">
          <span
            className={`flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br ${iconTone} text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
          >
            <Icon size={15} strokeWidth={2} />
          </span>
          <div className="flex-1 min-w-0">
            <h2
              id="text-dialog-title"
              className="text-[16px] font-semibold text-slate-900 leading-tight truncate"
            >
              {title}
            </h2>
            {subtitle && (
              <p className="text-[12px] text-slate-500 mt-0.5 nums leading-tight">
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors shrink-0"
          >
            <X size={16} strokeWidth={2.2} />
          </button>
        </div>
        {/* Body — scrollable text */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {text ? (
            <p className="text-[14px] text-slate-700 leading-relaxed whitespace-pre-wrap break-words">
              {text}
            </p>
          ) : (
            <p className="text-[13px] text-slate-400 italic">
              {emptyMessage}
            </p>
          )}
        </div>
        {/* Footer — close button */}
        <div className="px-6 py-3 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[14px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section 3 — Cleanup ─────────────────────────────────────────────────
export function CleanSection({
  jobId,
  sourceName,
  parentStatus,
  level = DEFAULT_LEVEL,
}: {
  jobId: string;
  sourceName?: string;
  /** Child's overall job status — used to render "waiting on upstream"
   *  when the cleanup row hasn't been created yet. */
  parentStatus?: string;
  /** Which cleanup level to fetch + display. */
  level?: CleanLevel;
}) {
  const isTerminal = (d: CleanedRow) =>
    d.status === "ready" || d.status === "failed";
  // Stage 4 — only poll once the cascade has reached the clean stage.
  const active = isStageActive(parentStatus, 4);
  const { data, loading } = usePolling<CleanedRow>(
    `/api/jobs/${jobId}/clean?level=${level}`,
    isTerminal,
    active,
  );
  const [dialogOpen, setDialogOpen] = useState(false);

  // Decide what to show when no cleanup row exists yet. If the cascade is
  // running upstream (audio extracting, downloading, transcribing), show
  // a "waiting" state so the user knows it's coming.
  const upstreamLabel = (() => {
    if (parentStatus === "audio") return "Waiting — Step 2 audio extract still running";
    if (parentStatus === "downloading") return "Waiting — Step 1 download still running";
    if (parentStatus === "transcript") return "Waiting — Step 3 transcription still running";
    return null;
  })();

  return (
    <DetailSection
      icon={Sparkles}
      label="Cleanup"
      tone="from-fuchsia-500 to-pink-500"
    >
      {loading && !data ? (
        <p className="text-[12.5px] text-slate-400 italic">Checking…</p>
      ) : !data ? (
        upstreamLabel ? (
          <WaitingRow label={upstreamLabel} />
        ) : (
          <PlaceholderPending label="Cleanup hasn't run for this video yet" />
        )
      ) : data.status === "failed" ? (
        <FailedRow message={data.errorMessage ?? "Cleanup failed"} />
      ) : data.status === "ready" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium text-fuchsia-700 bg-fuchsia-50 hover:bg-fuchsia-100 border border-fuchsia-200 transition-colors"
            >
              <Maximize2 size={11} strokeWidth={2.4} />
              Open cleaned transcript
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat
              label="Words kept"
              value={
                data.cleanedWords && data.originalWords
                  ? `${data.cleanedWords.toLocaleString()} / ${data.originalWords.toLocaleString()}`
                  : "—"
              }
            />
            <Stat
              label="Removed"
              value={
                data.removedSegments != null
                  ? `${data.removedSegments} span${data.removedSegments === 1 ? "" : "s"}`
                  : "—"
              }
            />
            <Stat
              label="Saved"
              value={
                data.removedDurSec != null
                  ? formatDuration(data.removedDurSec)
                  : "—"
              }
            />
          </div>
          {dialogOpen && (
            <TextDialog
              title={sourceName ?? "Cleaned transcript"}
              subtitle={`${data.cleanedWords?.toLocaleString() ?? "—"} words kept · ${
                data.removedSegments ?? 0
              } span${data.removedSegments === 1 ? "" : "s"} removed${
                data.removedDurSec != null
                  ? ` · ${formatDuration(data.removedDurSec)} saved`
                  : ""
              } · ${level} level`}
              icon={Sparkles}
              iconTone="from-fuchsia-500 to-pink-500"
              text={data.cleanedText ?? ""}
              emptyMessage="Cleaned transcript is empty — nothing to display."
              onClose={() => setDialogOpen(false)}
            />
          )}
        </div>
      ) : (
        <InFlightRow
          percent={data.progress}
          label="Cleaning transcript"
          tone="from-fuchsia-500 to-pink-500"
        />
      )}
    </DetailSection>
  );
}

// ── Section 4 — Chunks ──────────────────────────────────────────────────
type ChunksResponse = {
  run: {
    status: string;
    progress: number;
    cleanLevel: string;
    targetMin: number;
    chunkCount: number | null;
    errorMessage: string | null;
  };
  chunks: ChunkRow[];
};

export function ChunksSection({
  jobId,
  parentStatus,
  level = DEFAULT_LEVEL,
  targetMin = DEFAULT_TARGET_MIN,
}: {
  jobId: string;
  parentStatus?: string;
  level?: CleanLevel;
  targetMin?: number;
}) {
  const isTerminal = (d: ChunksResponse) =>
    d.run.status === "ready" || d.run.status === "failed";
  // Stage 5 — only poll once the cascade has reached the split stage.
  const active = isStageActive(parentStatus, 5);
  const { data, loading } = usePolling<ChunksResponse>(
    `/api/jobs/${jobId}/chunks?level=${level}&targetMin=${targetMin}`,
    isTerminal,
    active,
  );

  const upstreamLabel = (() => {
    if (parentStatus === "audio") return "Waiting — Step 2 audio extract still running";
    if (parentStatus === "downloading") return "Waiting — Step 1 download still running";
    if (parentStatus === "transcript") return "Waiting — Step 3 transcription still running";
    if (parentStatus === "clean") return "Waiting — Step 4 cleanup still running";
    return null;
  })();

  // Map split's progress to a rough phase label so the user sees what
  // the model is actually doing. The segment runner uses 25-50% for
  // boundary detection, 50-90% for titling, 90-100% for disk write.
  const phaseLabel = (() => {
    const p = data?.run.progress ?? 0;
    if (p < 25) return "Loading cleaned transcript";
    if (p < 50) return "Finding topic boundaries (1 of 2)";
    if (p < 90) return "Titling each chunk (2 of 2)";
    return "Writing chunks";
  })();

  return (
    <DetailSection
      icon={Scissors}
      label="Chunks"
      tone="from-rose-500 to-orange-500"
    >
      {loading && !data ? (
        <p className="text-[12.5px] text-slate-400 italic">Checking…</p>
      ) : !data ? (
        upstreamLabel ? (
          <WaitingRow label={upstreamLabel} />
        ) : (
          <PlaceholderPending label="Topic split hasn't run yet" />
        )
      ) : data.run.status === "failed" ? (
        <FailedRow message={data.run.errorMessage ?? "Split failed"} />
      ) : data.run.status === "ready" ? (
        <ChunksList jobId={jobId} chunks={data.chunks} />
      ) : (
        <InFlightRow
          percent={data.run.progress}
          label={phaseLabel}
          tone="from-rose-500 to-orange-500"
        />
      )}
    </DetailSection>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────
function DetailSection({
  icon: Icon,
  label,
  tone,
  children,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span
        className={`flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br ${tone} text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
      >
        <Icon size={15} strokeWidth={2} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] uppercase tracking-wide font-semibold text-slate-500 mb-1.5">
          {label}
        </p>
        {children}
      </div>
    </div>
  );
}

function PlaceholderPending({ label }: { label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-400 italic">
      <Clock size={11} strokeWidth={2} />
      {label}
    </div>
  );
}

function InFlightRow({
  percent,
  label,
  tone = "from-indigo-500 to-fuchsia-500",
}: {
  percent: number;
  label: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[13px] text-slate-800">
        <Loader2
          size={13}
          strokeWidth={2.4}
          className="animate-spin-slow text-indigo-600"
        />
        <span className="font-semibold">{label}…</span>
        <span className="ml-auto font-mono text-[12.5px] text-slate-600 nums tabular-nums">
          {percent}%
        </span>
      </div>
      <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
        <div
          className={`h-full bg-gradient-to-r ${tone} transition-[width] duration-300`}
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
    </div>
  );
}

/**
 * "Waiting on upstream stage" indicator — shown when a stage hasn't
 * created its DB row yet but the child's overall pipeline is still in
 * progress. Pure UI — no polling.
 */
function WaitingRow({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-white/40 px-3 py-2.5 flex items-center gap-2 text-[13px] text-slate-500">
      <Clock size={12} strokeWidth={2.2} className="text-slate-400" />
      <span>{label}</span>
    </div>
  );
}

function FailedRow({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 flex items-start gap-2">
      <AlertTriangle
        size={13}
        strokeWidth={2}
        className="text-rose-600 mt-0.5 shrink-0"
      />
      <p className="text-[12px] text-rose-800 leading-snug break-words">
        {message}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
      <p className="text-[10.5px] uppercase tracking-wide font-semibold text-slate-500">
        {label}
      </p>
      <p className="text-[13px] font-medium text-slate-900 nums truncate">
        {value}
      </p>
    </div>
  );
}

// Unused imports — silence ESLint without changing the tree.
void Check;

/**
 * Scrollable list of chunks for a single video. Each row shows topic +
 * duration; clicking expands to reveal the transcript text + an Edit
 * button. Edit mode replaces the row body with two textareas (topic +
 * text); Save POSTs to PATCH /api/jobs/[id]/chunks/[chunkId] and updates
 * local state on success.
 */
function ChunksList({
  jobId,
  chunks: initialChunks,
}: {
  jobId: string;
  chunks: ChunkRow[];
}) {
  const [chunks, setChunks] = useState(initialChunks);
  // Re-sync if the parent's polling delivers a new chunks array (e.g. on
  // first paint after a re-segment). Keys off an order-sensitive id list.
  const idsKey = useMemo(() => initialChunks.map((c) => c.id).join(","), [
    initialChunks,
  ]);
  useEffect(() => {
    setChunks(initialChunks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const [openId, setOpenId] = useState<string | null>(null);

  if (chunks.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
        <p className="text-[12.5px] text-slate-400 italic">
          No chunks produced.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100 max-h-[500px] overflow-y-auto">
      {chunks.map((c) => (
        <ChunkRowEditable
          key={c.id}
          jobId={jobId}
          chunk={c}
          isOpen={openId === c.id}
          onToggle={() => setOpenId((cur) => (cur === c.id ? null : c.id))}
          onSaved={(updated) =>
            setChunks((prev) =>
              prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)),
            )
          }
        />
      ))}
    </div>
  );
}

export function ChunkRowEditable({
  jobId,
  chunk,
  isOpen,
  onToggle,
  onSaved,
}: {
  jobId: string;
  chunk: ChunkRow;
  isOpen: boolean;
  onToggle: () => void;
  onSaved: (c: ChunkRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTopic, setDraftTopic] = useState(chunk.topic);
  const [draftText, setDraftText] = useState(chunk.text ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If the parent's polling refreshes the chunk while we're not editing,
  // reset our drafts so an edit-then-cancel still picks up the latest.
  useEffect(() => {
    if (!editing) {
      setDraftTopic(chunk.topic);
      setDraftText(chunk.text ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk.id, chunk.topic, chunk.text]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/jobs/${jobId}/chunks/${chunk.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: draftTopic, text: draftText }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      const updated = (await r.json()) as ChunkRow;
      onSaved(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-3 py-2">
      {/* Header row — always visible */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 text-left text-[12.5px] hover:bg-slate-50/50 -mx-3 px-3 py-1.5 rounded transition-colors"
      >
        <span className="font-mono text-slate-400 nums w-6 text-right shrink-0">
          {String(chunk.idx + 1).padStart(2, "0")}
        </span>
        <span className="font-medium text-slate-800 truncate flex-1">
          {chunk.topic}
        </span>
        <span className="text-slate-500 nums shrink-0 tabular-nums">
          {formatDuration(chunk.endSec - chunk.startSec)}
        </span>
        <span className="text-slate-400 shrink-0 text-[10px] uppercase tracking-wide">
          {isOpen ? "Hide" : "Open"}
        </span>
      </button>

      {/* Expanded body — transcript display or editor */}
      {isOpen && (
        <div className="mt-2 pl-9 pr-1 pb-2 flex flex-col gap-2 animate-reveal">
          {!editing ? (
            <>
              {chunk.text ? (
                <p className="text-[12.5px] text-slate-700 leading-relaxed whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded-md px-3 py-2 max-h-60 overflow-y-auto">
                  {chunk.text}
                </p>
              ) : (
                <p className="text-[12.5px] text-slate-400 italic">
                  No transcript text saved on this chunk.
                </p>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11.5px] font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 transition-colors"
                >
                  Edit topic + transcript
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] uppercase tracking-wide font-semibold text-slate-500">
                  Topic
                </span>
                <input
                  type="text"
                  value={draftTopic}
                  onChange={(e) => setDraftTopic(e.target.value)}
                  maxLength={200}
                  className="text-[13px] text-slate-900 px-2.5 py-1.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] uppercase tracking-wide font-semibold text-slate-500">
                  Transcript text
                </span>
                <textarea
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  rows={8}
                  className="text-[12.5px] text-slate-800 leading-relaxed px-2.5 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 font-mono"
                />
                <span className="text-[10.5px] text-slate-400 nums">
                  {
                    draftText
                      .split(/\s+/)
                      .filter((w) => w.length > 0).length
                  }{" "}
                  words
                </span>
              </label>
              {error && (
                <p className="text-[11.5px] text-rose-700">{error}</p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (saving) return;
                    setEditing(false);
                    setDraftTopic(chunk.topic);
                    setDraftText(chunk.text ?? "");
                    setError(null);
                  }}
                  disabled={saving}
                  className="inline-flex items-center px-2.5 py-1.5 rounded-md text-[11.5px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || draftTopic.trim().length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11.5px] font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
