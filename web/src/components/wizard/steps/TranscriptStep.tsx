"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import {
  FileText,
  Clock,
  Languages,
  Loader2,
  Check,
  Sparkles,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  FileAudio2,
  Headphones,
  Gauge,
  Activity,
} from "lucide-react";
import { useWizard } from "../WizardContext";
import { formatDuration, formatTimecode } from "@/lib/utils";
import { StepHeader } from "../StepHeader";
import { useToast } from "@/components/ui/Toast";

// ---------------------------------------------------------------------------
// Backend row shapes
// ---------------------------------------------------------------------------

type AudioRow = {
  id: string;
  durationSec: number | null;
  sizeBytes: number | null;
  sampleRateHz: number | null;
  channels: number | null;
  bitrateKbps: number | null;
  status: "pending" | "extracting" | "ready" | "failed";
  progress?: number;
};

type JobStatusRow = {
  status:
    | "downloading"
    | "audio"
    | "transcript"
    | "clean"
    | "split"
    | "render"
    | "done"
    | "failed";
  progress: number;
};

type TranscriptRow = {
  id: string;
  jobId: string;
  status: "pending" | "transcribing" | "ready" | "failed";
  progress: number;
  language: string | null;
  wordCount: number | null;
  durationSec: number | null;
  rawText: string | null;
  wordsJsonKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  readyAt: string | null;
};

type WordEntry = { word: string; start: number; end: number };
type WordsFile = {
  language: string | null;
  durationSec: number;
  words: WordEntry[];
};

// ---------------------------------------------------------------------------

type Tab = "plain" | "timestamped";

export function TranscriptStep() {
  const { jobId, update } = useWizard();
  const toast = useToast();
  const search = useSearchParams();
  // If the URL carries `?job=<id>` the WizardContext is mid-hydration —
  // its `jobId` is briefly null. We don't want to flash either empty
  // state ("Upload first" or "Extract audio first") during that window.
  const urlJobId = search.get("job");

  const [audio, setAudio] = useState<AudioRow | null>(null);
  const [transcript, setTranscript] = useState<TranscriptRow | null>(null);
  // Tracks the parent Job's pipeline status. Used to render a dynamic
  // progress card when the user lands here before audio is ready (e.g.
  // they pasted a YouTube URL on Step 1 and clicked through to Step 3
  // while yt-dlp is still downloading, or before Step 2 ffmpeg has run
  // for a file upload).
  const [jobStatus, setJobStatus] = useState<JobStatusRow | null>(null);
  // Job's `kind` lets us choose the right copy ("Downloading audio…" for
  // URL/playlist_video children vs "Extracting audio…" for file uploads).
  const [jobKind, setJobKind] = useState<string | null>(null);
  const [transcribeRequested, setTranscribeRequested] = useState(false);
  const [words, setWords] = useState<WordEntry[] | null>(null);
  const [tab, setTab] = useState<Tab>("plain");
  // Flips true once the initial audio + transcript fetches resolve (or
  // we've confirmed there's no jobId at all). Empty-state branches below
  // gate on this so they don't render during the fetch window.
  const [initialLoad, setInitialLoad] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  // Initial fetches: audio row (so we can show the source-audio card) and any
  // existing transcript row.
  useEffect(() => {
    if (!jobId) {
      // No URL hydration in progress AND WizardContext has no job → there
      // genuinely isn't a job. Stop loading so the empty state can render.
      if (!urlJobId) setInitialLoad(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [audioRes, transRes, jobRes] = await Promise.all([
          fetch(`/api/jobs/${jobId}/audio`),
          fetch(`/api/jobs/${jobId}/transcript`),
          fetch(`/api/jobs/${jobId}`),
        ]);
        if (!cancelled && audioRes.ok) {
          const data = (await audioRes.json()) as AudioRow;
          setAudio(data);
        }
        if (!cancelled && transRes.ok) {
          const data = (await transRes.json()) as TranscriptRow;
          setTranscript(data);
          if (data.status === "transcribing") setTranscribeRequested(true);
          if (data.status === "ready") {
            update({
              transcriptReady: true,
              transcriptProgress: 100,
              transcript: data.rawText ?? "",
            });
          }
        }
        if (!cancelled && jobRes.ok) {
          const job = (await jobRes.json()) as {
            kind?: string;
            status?: JobStatusRow | null;
          };
          if (job.status) setJobStatus(job.status);
          if (typeof job.kind === "string") setJobKind(job.kind);
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setInitialLoad(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, urlJobId]);

  // While audio isn't ready (URL still downloading, or Step 2 ffmpeg still
  // extracting), poll the job's status row at 1500 ms so the dynamic
  // progress card below ticks. Stops once audio is ready or status is
  // terminal-failed.
  useEffect(() => {
    if (!jobId) return;
    if (audio && audio.status === "ready") return;
    if (jobStatus && jobStatus.status === "failed") return;

    let cancelled = false;
    const tick = async () => {
      try {
        const [audioRes, jobRes] = await Promise.all([
          fetch(`/api/jobs/${jobId}/audio`),
          fetch(`/api/jobs/${jobId}`),
        ]);
        if (!cancelled && audioRes.ok) {
          const data = (await audioRes.json()) as AudioRow;
          setAudio(data);
        }
        if (!cancelled && jobRes.ok) {
          const job = (await jobRes.json()) as {
            kind?: string;
            status?: JobStatusRow | null;
          };
          if (job.status) setJobStatus(job.status);
          if (typeof job.kind === "string") setJobKind(job.kind);
        }
      } catch {
        /* transient — next tick will retry */
      }
    };
    const id = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, audio?.status, jobStatus?.status]);

  // Poll the transcript endpoint while transcription is in flight.
  useEffect(() => {
    if (!jobId) return;
    if (!transcribeRequested) return;
    if (transcript?.status === "ready" || transcript?.status === "failed") return;

    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}/transcript`);
        if (!r.ok) return;
        const data = (await r.json()) as TranscriptRow;
        if (cancelled) return;
        setTranscript(data);
        if (data.status === "ready") {
          update({
            transcriptReady: true,
            transcriptProgress: 100,
            transcript: data.rawText ?? "",
          });
          toast.success(
            "Transcription complete",
            `${data.wordCount?.toLocaleString() ?? "—"} words captured`,
          );
        } else if (data.status === "failed") {
          toast.error(
            "Transcription failed",
            data.errorMessage ?? "Transcription returned an error",
          );
        } else {
          update({
            transcript: data.rawText ?? "",
            transcriptProgress: data.progress,
          });
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
  }, [jobId, transcribeRequested, transcript?.status]);

  // Once ready, lazy-fetch the word-level JSON for the Timestamped tab.
  useEffect(() => {
    if (!jobId) return;
    if (transcript?.status !== "ready") return;
    if (words) return;

    let cancelled = false;
    fetch(`/api/jobs/${jobId}/transcript/words`)
      .then((r) => (r.ok ? (r.json() as Promise<WordsFile>) : null))
      .then((data) => {
        if (!cancelled && data) setWords(data.words);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [jobId, transcript?.status, words]);

  // Auto-scroll plain transcript while text streams in.
  useEffect(() => {
    if (boxRef.current && transcript?.status === "transcribing") {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [transcript?.rawText, transcript?.status]);

  const startTranscription = useCallback(async () => {
    if (!jobId) return;
    setTranscribeRequested(true);
    update({ transcript: "", transcriptProgress: 0, transcriptReady: false });
    try {
      const r = await fetch(`/api/jobs/${jobId}/transcribe`, { method: "POST" });
      const body = (await r.json().catch(() => ({}))) as
        | TranscriptRow
        | { error?: string; code?: string };
      if (!r.ok) {
        const errMsg =
          (body as { error?: string }).error ?? `HTTP ${r.status}`;
        throw new Error(errMsg);
      }
      setTranscript(body as TranscriptRow);
      toast.info(
        "Transcription started",
        "Analysing the audio in chunks…",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Couldn't start transcription", message);
      setTranscribeRequested(false);
    }
  }, [jobId, update, toast]);

  // --- Initial load: WizardContext might still be hydrating from the URL,
  // and even with jobId set we're waiting on the audio + transcript
  // fetches. Show a neutral spinner so neither empty state below flashes.
  if (initialLoad) {
    return (
      <div className="max-w-xl mx-auto w-full flex items-center justify-center py-20">
        <span className="inline-flex items-center gap-2.5 text-slate-500 text-[15px]">
          <Loader2 size={17} strokeWidth={2} className="animate-spin-slow" />
          Loading…
        </span>
      </div>
    );
  }

  // --- No job: empty state ---
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
          Step 3 reads the audio extracted in Step 2. Head back to Upload to
          get started.
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

  // --- Audio not ready: render a dynamic progress card driven by the
  // job's pipeline status. Three sub-states matter here:
  //   1. "downloading"  — yt-dlp is pulling audio for a URL job
  //   2. "audio"        — ffmpeg is extracting audio for a file upload
  //   3. anything else  — fall back to the static "extract first" message
  if (!audio || audio.status !== "ready") {
    const status = jobStatus?.status;
    const progress = jobStatus?.progress ?? audio?.progress ?? 0;
    const isDownloading = status === "downloading";
    const isExtracting =
      status === "audio" ||
      (audio?.status === "extracting" && status !== "downloading");
    const isPreparing = isDownloading || isExtracting;

    if (isPreparing) {
      const isUrlJob =
        jobKind === "url" || jobKind === "playlist_video" || isDownloading;
      const heading = isDownloading ? "Downloading audio" : "Extracting audio";
      const subline = isDownloading
        ? "yt-dlp is pulling the audio track from the source URL. Step 3 unlocks once it lands."
        : "Step 2 is producing the 48 kHz mono mp3 we need. Step 3 unlocks once it's ready.";
      const isStarting = progress === 0 || progress === 1;

      return (
        <div className="max-w-2xl mx-auto w-full flex flex-col gap-5 animate-reveal">
          <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-violet-50/40 via-white to-fuchsia-50/30 shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-6">
            <div
              aria-hidden
              className="absolute -right-12 -top-12 w-36 h-36 rounded-full bg-gradient-to-br from-violet-500/10 to-fuchsia-500/10 blur-2xl"
            />
            <div className="relative flex items-start gap-4">
              <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500 via-purple-500 to-fuchsia-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(168,85,247,0.4)]">
                <Loader2
                  size={22}
                  strokeWidth={1.8}
                  className="animate-spin-slow"
                />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] text-violet-700 uppercase tracking-wide font-semibold mb-0.5">
                  Preparing audio
                </p>
                <p className="text-[20px] font-semibold text-slate-900 leading-tight flex items-center justify-between gap-2 flex-wrap">
                  <span>
                    {isStarting ? `${heading}…` : heading}
                  </span>
                  <span className="nums text-slate-700 text-[18px]">
                    {progress}%
                  </span>
                </p>
                <p className="text-[13.5px] text-slate-500 mt-1.5 leading-relaxed">
                  {subline}
                </p>
              </div>
            </div>
            <div className="relative mt-5 h-2 bg-slate-100 rounded-full overflow-hidden">
              <motion.div
                initial={false}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.7, ease: "linear" }}
                className="h-full shimmer-bar rounded-full"
              />
            </div>
          </div>
          <p className="text-center text-[12.5px] text-slate-400">
            {isUrlJob
              ? "You can leave this page open — we'll auto-advance once the audio is ready."
              : "Once Step 2 finishes you'll land back here automatically."}
          </p>
        </div>
      );
    }

    return (
      <div className="max-w-xl mx-auto w-full text-center py-10 flex flex-col gap-4 items-center animate-reveal">
        <span className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-50 text-slate-400 border border-slate-200">
          <FileAudio2 size={24} strokeWidth={1.8} />
        </span>
        <h2 className="text-[24px] font-semibold text-slate-900">
          Extract audio first
        </h2>
        <p className="text-[14.5px] text-slate-500 max-w-md">
          Transcription needs the extracted MP3 from Step 2 before it can run.
        </p>
        <Link
          href="#"
          onClick={(e) => {
            e.preventDefault();
            update({ step: 2 });
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[14.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors shadow-sm"
        >
          <ArrowLeft size={13} strokeWidth={2} />
          Back to Extract
        </Link>
      </div>
    );
  }

  const isTranscribing = transcript?.status === "transcribing";
  const isReady = transcript?.status === "ready";
  const isFailed = transcript?.status === "failed";
  const progress = transcript?.progress ?? 0;
  const language = transcript?.language ?? "auto";
  const rawText = transcript?.rawText ?? "";
  const wordCount = transcript?.wordCount ?? rawText.split(/\s+/).filter(Boolean).length;

  return (
    <div className="max-w-4xl mx-auto w-full flex flex-col gap-7 animate-reveal">
      <StepHeader
        step={3}
        title="Transcribe"
        description="Turn the extracted audio into text with word-level timecodes."
        actions={
          <div className="flex items-center gap-2">
            <Chip
              icon={<Sparkles size={11} strokeWidth={2} />}
              from="from-violet-500"
              to="to-purple-500"
              softFrom="from-violet-50"
              softTo="to-purple-50"
            >
              transcribe
            </Chip>
            <Chip
              icon={<Languages size={11} strokeWidth={2} />}
              from="from-indigo-500"
              to="to-blue-500"
              softFrom="from-indigo-50"
              softTo="to-blue-50"
            >
              {language === "auto" ? "Auto-detect" : language.toUpperCase()}
            </Chip>
          </div>
        }
      />

      {/* 1. Source audio card */}
      <SourceAudioCard audio={audio} />

      {/* 2. Transcribe CTA — shown until the user kicks off a run */}
      {!transcript && !transcribeRequested && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-violet-50/60 via-white to-fuchsia-50/40 p-6 flex items-center gap-5 flex-wrap"
        >
          <div
            aria-hidden
            className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-violet-500/10 to-fuchsia-500/10 blur-3xl"
          />
          <div className="relative flex-1 min-w-[220px]">
            <p className="text-[17px] font-semibold text-slate-900 leading-snug">
              Ready to transcribe
            </p>
            <p className="text-[13.5px] text-slate-500 mt-1 leading-relaxed">
              We&rsquo;ll split your audio into ~10-minute chunks, transcribe
              each one, and stitch the word-level timestamps back together.
            </p>
          </div>
          <motion.button
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={startTranscription}
            className="relative inline-flex items-center gap-2 px-5 py-3 rounded-lg text-[15px] font-medium text-white bg-gradient-to-br from-violet-600 via-purple-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(168,85,247,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(168,85,247,0.6)] transition-shadow"
          >
            <Sparkles size={14} strokeWidth={2} />
            Transcribe
            <ArrowRight size={14} strokeWidth={2.2} />
          </motion.button>
        </motion.div>
      )}

      {/* 3. Progress + transcript view */}
      {transcript && (isTranscribing || isReady) && (
        <>
          <ProgressPanel
            progress={progress}
            ready={isReady}
            wordCount={wordCount}
          />
          <TranscriptViewer
            tab={tab}
            setTab={setTab}
            rawText={rawText}
            words={words}
            ready={isReady}
            boxRef={boxRef}
          />
        </>
      )}

      {/* 4. Failure */}
      {isFailed && transcript && (
        <FailurePanel
          message={transcript.errorMessage ?? "Transcription exited with an error"}
          code={transcript.errorCode ?? null}
          onRetry={startTranscription}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source audio card — same visual language as Step 2's source-video card
// ---------------------------------------------------------------------------

function SourceAudioCard({ audio }: { audio: AudioRow }) {
  const sizeMB = audio.sizeBytes ? (audio.sizeBytes / 1024 / 1024).toFixed(1) : "—";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-5"
    >
      <div
        aria-hidden
        className="absolute -right-10 -top-10 w-32 h-32 rounded-full bg-gradient-to-br from-violet-500/8 to-fuchsia-500/8 blur-2xl"
      />
      <div className="relative flex items-start gap-4">
        <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500 via-purple-500 to-fuchsia-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(168,85,247,0.4)]">
          <Headphones size={22} strokeWidth={1.8} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[11.5px] text-slate-500 uppercase tracking-wide font-semibold mb-0.5">
            Source audio
          </p>
          <p className="text-[17px] font-semibold text-slate-900 break-all leading-snug">
            audio.mp3 · 48 kHz mono
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <MiniMeta
              icon={<Clock size={12} strokeWidth={2} />}
              label="Duration"
              value={
                audio.durationSec ? formatDuration(audio.durationSec) : "—"
              }
            />
            <MiniMeta
              icon={<Gauge size={12} strokeWidth={2} />}
              label="Bitrate"
              value={audio.bitrateKbps ? `${audio.bitrateKbps} kbps` : "—"}
            />
            <MiniMeta
              icon={<Activity size={12} strokeWidth={2} />}
              label="Size"
              value={`${sizeMB} MB`}
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
  wordCount,
}: {
  progress: number;
  ready: boolean;
  wordCount: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-violet-50/40 via-white to-fuchsia-50/30 shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-6"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-violet-500/10 to-fuchsia-500/10 blur-3xl"
      />
      <div className="relative flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span
            className={`flex items-center justify-center w-10 h-10 rounded-xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] ${
              ready
                ? "bg-gradient-to-br from-emerald-500 to-teal-600"
                : "bg-gradient-to-br from-violet-500 via-purple-500 to-fuchsia-500"
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
              {ready ? "Transcription complete" : "Transcribing…"}
            </p>
            <p className="text-[13.5px] text-slate-500 leading-tight mt-0.5">
              {ready
                ? `${wordCount.toLocaleString()} words captured — Next is unlocked`
                : "Decoding audio chunks, stitching word-level timestamps"}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[22px] font-semibold text-slate-900 nums leading-none">
            {progress}%
          </span>
          {wordCount > 0 && (
            <span className="text-[11.5px] text-slate-500 nums leading-none">
              {wordCount.toLocaleString()} words
            </span>
          )}
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
// Transcript viewer — Plain + Timestamped tabs
// ---------------------------------------------------------------------------

function TranscriptViewer({
  tab,
  setTab,
  rawText,
  words,
  ready,
  boxRef,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  rawText: string;
  words: WordEntry[] | null;
  ready: boolean;
  boxRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Group words into ~12-second segments for the Timestamped view
  const segments = words ? groupWords(words, 12) : [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 }}
      className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] overflow-hidden"
    >
      <div className="flex items-center border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
        <TabBtn active={tab === "plain"} onClick={() => setTab("plain")}>
          <FileText size={13} strokeWidth={2} />
          Plain
        </TabBtn>
        <TabBtn
          active={tab === "timestamped"}
          onClick={() => setTab("timestamped")}
        >
          <Clock size={13} strokeWidth={2} />
          Timestamped
        </TabBtn>
        <span className="ml-auto px-4 text-[13px] font-mono flex items-center gap-1.5">
          {ready ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-100 font-semibold">
              <Check size={10} strokeWidth={2.5} />
              Final
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-gradient-to-br from-violet-50 to-fuchsia-50 text-violet-700 border border-violet-100 font-semibold">
              <motion.span
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.4, repeat: Infinity }}
                className="w-1.5 h-1.5 rounded-full bg-violet-500"
              />
              Streaming
            </span>
          )}
        </span>
      </div>

      <div
        ref={boxRef}
        className="h-[360px] overflow-y-auto px-6 py-5 text-[17px] leading-[1.75] text-slate-700 bg-gradient-to-b from-white via-white to-slate-50/40"
      >
        {tab === "plain" && (
          <p className="whitespace-pre-wrap">
            {rawText}
            {!ready && <span className="caret" />}
            {!rawText && (
              <span className="text-slate-400 italic">
                Waiting for first chunk…
              </span>
            )}
          </p>
        )}

        {tab === "timestamped" && (
          <div className="flex flex-col gap-3 font-mono text-[15px]">
            {ready && segments.length > 0 ? (
              <AnimatePresence initial={false}>
                {segments.map((seg, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.25, delay: Math.min(i, 12) * 0.02 }}
                    className="flex gap-3"
                  >
                    <span className="text-violet-600 shrink-0 nums tabular-nums font-semibold">
                      {formatTimecode(seg.start).slice(0, 8)}
                    </span>
                    <span className="text-slate-700">{seg.text}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
            ) : (
              <span className="text-slate-400 italic font-sans">
                {ready
                  ? "Loading word-level timestamps…"
                  : "Timecodes appear once transcription completes."}
              </span>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// Group consecutive words into ≈ `bucketSec`-second segments, anchored on
// the first word of each bucket — gives us a natural "subtitle" cadence.
function groupWords(
  words: WordEntry[],
  bucketSec: number,
): { start: number; text: string }[] {
  if (words.length === 0) return [];
  const out: { start: number; text: string }[] = [];
  let curStart = words[0].start;
  let curWords: string[] = [];
  for (const w of words) {
    if (w.start - curStart >= bucketSec && curWords.length > 0) {
      out.push({ start: curStart, text: curWords.join(" ").trim() });
      curStart = w.start;
      curWords = [];
    }
    curWords.push(w.word.trim());
  }
  if (curWords.length > 0) {
    out.push({ start: curStart, text: curWords.join(" ").trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Failure panel
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
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50 via-white to-orange-50 p-5"
    >
      <div className="flex items-start gap-3">
        <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500 to-orange-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
          <AlertTriangle size={16} strokeWidth={2.2} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-semibold text-rose-900 leading-tight">
            {isAuth ? "API key missing or invalid" : "Transcription failed"}
          </p>
          <p className="text-[13.5px] text-rose-700/90 mt-1 break-words">
            {message}
          </p>
          {isAuth && (
            <p className="text-[13px] text-rose-700/80 mt-2">
              Add <span className="font-mono">OPENAI_API_KEY=sk-…</span> to
              <span className="font-mono"> web/.env.local</span> and restart
              the dev server.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium text-rose-700 bg-white border border-rose-200 hover:border-rose-300 hover:bg-rose-50 transition-colors"
        >
          Retry
        </button>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Decorative pieces
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

function TabBtn({
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
      className={`flex items-center gap-2 px-5 py-3 text-[15px] font-medium transition-colors relative ${
        active ? "text-slate-900" : "text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
      {active && (
        <motion.span
          layoutId="transcript-tab-underline"
          className="absolute bottom-0 left-4 right-4 h-0.5 bg-gradient-to-r from-violet-500 via-fuchsia-500 to-violet-500 rounded-t-full"
        />
      )}
    </button>
  );
}
