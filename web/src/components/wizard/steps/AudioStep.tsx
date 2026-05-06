"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  Play,
  Pause,
  Volume2,
  Check,
  Loader2,
  AudioLines,
  Gauge,
  Headphones,
  FileAudio2,
  HardDrive,
  FileVideo,
  Clock,
  Globe,
  Users,
  Activity,
  Target,
  ArrowLeft,
  AlertTriangle,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { useWizard } from "../WizardContext";
import { formatDuration, formatBytes, generateWaveform } from "@/lib/utils";
import { StepHeader } from "../StepHeader";
import { useToast } from "@/components/ui/Toast";

// ---------------------------------------------------------------------------
// Shared audio-playback hook: manages the <audio> element, decodes FFT via a
// WebAudio AnalyserNode, and exposes the 5-band frequency snapshot so both
// the waveform player and the FrequencyBands card can read the same stream.
// ---------------------------------------------------------------------------

type Playback = {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  playing: boolean;
  currentTime: number;
  muted: boolean;
  freqBands: number[]; // 5 values, 0..1
  toggle: () => Promise<void>;
  seek: (frac: number) => void;
  toggleMute: () => void;
  handlers: {
    onPlay: () => void;
    onPause: () => void;
    onEnded: () => void;
    onTimeUpdate: (e: React.SyntheticEvent<HTMLAudioElement>) => void;
    onVolumeChange: (e: React.SyntheticEvent<HTMLAudioElement>) => void;
  };
};

function useAudioPlayback(durationSec: number): Playback {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [freqBands, setFreqBands] = useState<number[]>([0, 0, 0, 0, 0]);

  // Initialize WebAudio pipeline (once per audio element). Can only be called
  // after a user gesture — we do it from `toggle()` which is a click handler.
  const ensureAnalyser = useCallback(() => {
    if (ctxRef.current) return;
    const el = audioRef.current;
    if (!el) return;
    try {
      const AC: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      ctxRef.current = ctx;
      analyserRef.current = analyser;
      // Explicit ArrayBuffer backing so the ByteArray type is a strict
      // Uint8Array<ArrayBuffer> (what getByteFrequencyData expects).
      bufRef.current = new Uint8Array(
        new ArrayBuffer(analyser.frequencyBinCount),
      );
    } catch (err) {
      console.warn("[audio analyser] init failed:", err);
    }
  }, []);

  // FFT sampling loop while playing. Maps 128 bins → 5 bands.
  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    ensureAnalyser();
    const analyser = analyserRef.current;
    const buf = bufRef.current;
    if (!analyser || !buf) return;

    const tick = () => {
      analyser.getByteFrequencyData(buf);
      const avg = (a: number, b: number) => {
        let s = 0;
        for (let i = a; i < b; i++) s += buf[i];
        return s / (b - a) / 255;
      };
      // 256-bin FFT @ 48 kHz → each bin ≈ 187 Hz.
      // Slicing roughly matches Sub/Low/Mid/High/Air boundaries.
      setFreqBands([
        avg(0, 2),    // Sub: ~0-375 Hz
        avg(2, 6),    // Low: ~375 Hz-1.1 kHz
        avg(6, 22),   // Mid: ~1.1-4.1 kHz
        avg(22, 56),  // High: ~4.1-10.5 kHz
        avg(56, 128), // Air: ~10.5-24 kHz
      ]);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, ensureAnalyser]);

  // Decay freq bars when paused so they gracefully fall to 0 instead of
  // freezing at their last value.
  useEffect(() => {
    if (playing) return;
    const id = window.setInterval(() => {
      setFreqBands((prev) => {
        const next = prev.map((v) => v * 0.88);
        return next.every((v) => v < 0.005) ? [0, 0, 0, 0, 0] : next;
      });
    }, 60);
    return () => window.clearInterval(id);
  }, [playing]);

  const toggle = useCallback(async () => {
    const el = audioRef.current;
    if (!el) return;
    ensureAnalyser();
    const ctx = ctxRef.current;
    if (ctx && ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (err) {
        console.warn("[audio ctx] resume failed:", err);
      }
    }
    try {
      if (el.paused) await el.play();
      else el.pause();
    } catch (err) {
      console.error("[audio play]", err);
    }
  }, [ensureAnalyser]);

  const seek = useCallback(
    (frac: number) => {
      const el = audioRef.current;
      if (!el || durationSec <= 0) return;
      el.currentTime = Math.max(0, Math.min(1, frac)) * durationSec;
    },
    [durationSec],
  );

  const toggleMute = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  }, []);

  const handlers = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: (e: React.SyntheticEvent<HTMLAudioElement>) =>
      setCurrentTime(e.currentTarget.currentTime),
    onVolumeChange: (e: React.SyntheticEvent<HTMLAudioElement>) =>
      setMuted(e.currentTarget.muted),
  };

  return {
    audioRef,
    playing,
    currentTime,
    muted,
    freqBands,
    toggle,
    seek,
    toggleMute,
    handlers,
  };
}

// ---------------------------------------------------------------------------
// Types matching the backend (src/app/api/jobs/[id]/{route.ts, audio/route.ts})
// ---------------------------------------------------------------------------

type JobRow = {
  id: string;
  kind: string;
  sourceName: string;
  sourceSize: number; // bigint serialized to number
  sourceType: string;
  sourceDurationSec: number | null;
  status: { status: string; progress: number } | null;
};

type AudioRow = {
  id: string;
  jobId: string;
  storageKey: string;
  sizeBytes: number | null;
  durationSec: number | null;
  sampleRateHz: number | null;
  channels: number | null;
  codec: string | null;
  bitrateKbps: number | null;
  status: "pending" | "extracting" | "ready" | "failed";
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  readyAt: string | null;
};

// ---------------------------------------------------------------------------

export function AudioStep() {
  const { jobId, update } = useWizard();
  const toast = useToast();

  const [job, setJob] = useState<JobRow | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const [audio, setAudio] = useState<AudioRow | null>(null);
  const [extractRequested, setExtractRequested] = useState(false);

  // Shared playback state so both the waveform panel and frequency bands
  // read the same audio element / FFT stream.
  const playback = useAudioPlayback(audio?.durationSec ?? 0);

  // Fetch the Job on mount (and whenever jobId changes)
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    fetch(`/api/jobs/${jobId}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<JobRow>;
      })
      .then((data) => {
        if (!cancelled) setJob(data);
      })
      .catch((e) => {
        if (!cancelled) setJobError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Check whether an Audio row already exists (in case user comes back to step 2)
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/audio`).then(async (r) => {
      if (r.status === 404) return; // no extraction started yet
      if (!r.ok) return;
      const data = (await r.json()) as AudioRow;
      if (!cancelled) {
        setAudio(data);
        if (data.status === "extracting") setExtractRequested(true);
        if (data.status === "ready") update({ audioReady: true });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Poll the audio endpoint while extraction is in progress
  useEffect(() => {
    if (!jobId) return;
    if (!extractRequested) return;
    if (audio?.status === "ready" || audio?.status === "failed") return;

    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}/audio`);
        if (!r.ok) return;
        const data = (await r.json()) as AudioRow;
        if (cancelled) return;
        setAudio(data);
        if (data.status === "ready") {
          update({ audioReady: true, audioProgress: 100 });
          toast.success("Extraction complete", "Audio is ready for transcription");
        } else if (data.status === "failed") {
          toast.error(
            "Extraction failed",
            data.errorMessage ?? "Unknown ffmpeg error",
          );
        } else {
          update({ audioProgress: data.progress });
        }
      } catch {
        // transient network errors ignored; next tick will retry
      }
    };
    void tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, extractRequested, audio?.status]);

  const startExtraction = useCallback(async () => {
    if (!jobId) return;
    setExtractRequested(true);
    update({ audioProgress: 0, audioReady: false });
    try {
      const r = await fetch(`/api/jobs/${jobId}/extract`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      const data = (await r.json()) as AudioRow;
      setAudio(data);
      toast.info(
        "Extraction started",
        "ffmpeg is stripping the audio track…",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Couldn't start extraction", message);
      setExtractRequested(false);
    }
  }, [jobId, update, toast]);

  // --- No job: empty state ---
  if (!jobId) {
    return (
      <div className="max-w-xl mx-auto w-full text-center py-10 flex flex-col gap-4 items-center animate-reveal">
        <span className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-50 text-slate-400 border border-slate-200">
          <FileVideo size={24} strokeWidth={1.8} />
        </span>
        <h2 className="text-[24px] font-semibold text-slate-900">
          Upload a file first
        </h2>
        <p className="text-[14.5px] text-slate-500 max-w-md">
          Step 2 reads the video you uploaded in Step 1. Head back and pick a file.
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

  // --- Loading the job ---
  if (!job && !jobError) {
    return (
      <div className="max-w-3xl mx-auto w-full flex items-center justify-center py-20">
        <span className="inline-flex items-center gap-2.5 text-slate-500 text-[15px]">
          <Loader2 size={17} strokeWidth={2} className="animate-spin-slow" />
          Loading job details…
        </span>
      </div>
    );
  }

  if (jobError || !job) {
    return (
      <div className="max-w-xl mx-auto w-full text-center py-10">
        <p className="text-[15px] text-rose-700 font-medium">
          Couldn&rsquo;t load the job: {jobError ?? "unknown error"}
        </p>
      </div>
    );
  }

  const isExtracting = audio?.status === "extracting";
  const isReady = audio?.status === "ready";
  const isFailed = audio?.status === "failed";
  const progress = audio?.progress ?? 0;
  // URL-ingestion jobs (and their playlist children) skip Step 2 entirely —
  // yt-dlp produces audio.mp3 directly and runDownload inserts the Audio row
  // as `ready`. Don't offer the Extract CTA, don't surface failures from a
  // step the user never invoked.
  const isUrlJob = job.kind === "url" || job.kind === "playlist_video";

  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col gap-7 animate-reveal">
      <StepHeader
        step={2}
        title="Extract audio"
        description="Strip the audio track from your source video. Step 3 needs audio — not video — as input."
      />

      {/* 1. Source video card */}
      <SourceVideoCard job={job} />

      {/* 2. Extract CTA (before any extraction attempt) — never shown for
          URL jobs since yt-dlp already produced the audio. */}
      {!audio && !extractRequested && !isUrlJob && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-indigo-50/60 via-white to-cyan-50/50 p-6 flex items-center gap-5 flex-wrap"
        >
          <div
            aria-hidden
            className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-indigo-500/10 to-cyan-500/10 blur-3xl"
          />
          <div className="relative flex-1 min-w-[220px]">
            <p className="text-[17px] font-semibold text-slate-900 leading-snug">
              Ready to extract audio
            </p>
            <p className="text-[13.5px] text-slate-500 mt-1 leading-relaxed">
              We&rsquo;ll produce a 48 kHz mono MP3 next to your source file and
              save a row in the <span className="font-mono">audios</span> table.
            </p>
          </div>
          <motion.button
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={startExtraction}
            className="relative inline-flex items-center gap-2 px-5 py-3 rounded-lg text-[15px] font-medium text-white bg-gradient-to-br from-indigo-600 via-indigo-600 to-cyan-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(99,102,241,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(99,102,241,0.6)] transition-shadow"
          >
            <Sparkles size={14} strokeWidth={2} />
            Extract audio
            <ArrowRight size={14} strokeWidth={2.2} />
          </motion.button>
        </motion.div>
      )}

      {/* 3. Progress panel (extracting or ready or failed) */}
      {audio && (isExtracting || isReady) && (
        <ProgressPanel progress={progress} ready={isReady} />
      )}

      {/* 4. Failure state */}
      {isFailed && (
        <FailurePanel
          message={audio.errorMessage ?? "ffmpeg exited with an error"}
          onRetry={startExtraction}
        />
      )}

      {/* Hidden <audio> element — the single source of truth for playback.
          Both the WaveformPanel and FrequencyBands read via the `playback`
          object returned from useAudioPlayback. */}
      {isReady && jobId && (
        <audio
          ref={playback.audioRef}
          src={`/api/jobs/${jobId}/audio/file`}
          preload="metadata"
          crossOrigin="anonymous"
          {...playback.handlers}
        />
      )}

      {/* 5. Real results — waveform, frequency bands, analysis, output cells */}
      {isReady && (
        <>
          <WaveformPanel
            fileName={job.sourceName}
            seed={job.sourceSize + job.sourceName.length}
            durationSec={audio.durationSec ?? 0}
            playback={playback}
          />
          <FrequencyBands ready={isReady} playback={playback} />
          <AudioAnalysis ready={isReady} />
          <OutputAudioCells audio={audio} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source video card — shows what came out of Step 1
// ---------------------------------------------------------------------------

function SourceVideoCard({ job }: { job: JobRow }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-5"
    >
      <div
        aria-hidden
        className="absolute -right-10 -top-10 w-32 h-32 rounded-full bg-gradient-to-br from-indigo-500/8 to-fuchsia-500/8 blur-2xl"
      />
      <div className="relative flex items-start gap-4">
        <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-fuchsia-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(99,102,241,0.4)]">
          <FileVideo size={22} strokeWidth={1.8} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[11.5px] text-slate-500 uppercase tracking-wide font-semibold mb-0.5">
            Source video
          </p>
          <p className="text-[17px] font-semibold text-slate-900 break-all leading-snug">
            {job.sourceName}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <MiniMeta
              icon={<Clock size={12} strokeWidth={2} />}
              label="Duration"
              value={
                job.sourceDurationSec
                  ? formatDuration(job.sourceDurationSec)
                  : "—"
              }
            />
            <MiniMeta
              icon={<HardDrive size={12} strokeWidth={2} />}
              label="Size"
              value={formatBytes(job.sourceSize)}
            />
            <MiniMeta
              icon={<FileAudio2 size={12} strokeWidth={2} />}
              label="Format"
              value={job.sourceType.split("/")[1]?.toUpperCase() || "VIDEO"}
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
}: {
  progress: number;
  ready: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-indigo-50/40 via-white to-cyan-50/30 shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-6"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-indigo-500/10 to-cyan-500/10 blur-3xl"
      />
      <div className="relative flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span
            className={`flex items-center justify-center w-10 h-10 rounded-xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] ${
              ready
                ? "bg-gradient-to-br from-emerald-500 to-teal-600"
                : "bg-gradient-to-br from-indigo-500 via-indigo-600 to-cyan-500"
            }`}
          >
            {ready ? (
              <Check size={17} strokeWidth={2.4} />
            ) : (
              <Loader2
                size={17}
                strokeWidth={2}
                className="animate-spin-slow"
              />
            )}
          </span>
          <div>
            <p className="text-[15.5px] text-slate-900 font-semibold leading-tight">
              {ready ? "Extraction complete" : "Running ffmpeg…"}
            </p>
            <p className="text-[13.5px] text-slate-500 leading-tight mt-0.5">
              {ready
                ? "Audio ready — Next is unlocked"
                : "Decoding stream, encoding to 48 kHz mono MP3"}
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
// Failure panel
// ---------------------------------------------------------------------------

function FailurePanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50/80 to-red-50/60 p-5 flex items-start gap-4"
    >
      <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-red-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
        <AlertTriangle size={17} strokeWidth={2} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[15.5px] font-semibold text-rose-900 leading-snug">
          Extraction failed
        </p>
        <p className="text-[13.5px] text-rose-700 mt-1 leading-snug break-all">
          {message}
        </p>
      </div>
      <motion.button
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.97 }}
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[14px] font-medium text-white bg-gradient-to-br from-rose-500 to-red-500 shadow-sm"
      >
        Retry
      </motion.button>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Waveform (real audio, seeded from job id so it's stable per-job)
// ---------------------------------------------------------------------------

const WAVE_BAR_COUNT = 72;

function WaveformPanel({
  fileName,
  seed,
  durationSec,
  playback,
}: {
  fileName: string;
  seed: number;
  durationSec: number;
  playback: Playback;
}) {
  const { playing, currentTime, muted, toggle, seek, toggleMute, freqBands } =
    playback;
  const bars = useMemoWave(seed);
  const progressFrac = durationSec > 0 ? currentTime / durationSec : 0;
  const waveRef = useRef<HTMLDivElement | null>(null);

  // While playing, the "energy" pushes through the bars near the playhead.
  const energy = freqBands.reduce((a, b) => a + b, 0) / 5;

  function seekFromPointer(e: React.PointerEvent<HTMLDivElement>) {
    const rect = waveRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = (e.clientX - rect.left) / rect.width;
    seek(frac);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)]"
    >
      {/* Header — filename + duration + state pill */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
        <span className="flex items-center gap-2.5 text-[14.5px] text-slate-700 font-medium min-w-0">
          <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 via-indigo-600 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] shrink-0">
            <AudioLines size={14} strokeWidth={2} />
          </span>
          <span className="truncate" title={fileName}>
            {fileName}
          </span>
        </span>
        <span
          className={`inline-flex items-center gap-1.5 shrink-0 text-[11.5px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full border ${
            playing
              ? "bg-indigo-50 text-indigo-700 border-indigo-100"
              : "bg-slate-50 text-slate-600 border-slate-200"
          }`}
        >
          {playing ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 animate-blink" />
              Playing
            </>
          ) : (
            "Paused"
          )}
        </span>
      </div>

      {/* Bar-style waveform. Each bar's height is seeded so it's stable per
          job, with a real-time lift near the playhead while audio plays. */}
      <div className="relative px-5 pt-8 pb-6 bg-gradient-to-b from-white via-white to-slate-50/50">
        <div
          ref={waveRef}
          role="slider"
          aria-label="Seek audio"
          aria-valuenow={Math.round(progressFrac * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          onPointerDown={seekFromPointer}
          className="relative h-[140px] flex items-center gap-[3px] cursor-pointer group select-none"
        >
          {bars.map((v, i) => {
            const frac = i / (bars.length - 1);
            const past = frac <= progressFrac;
            // Extra height bump within ~3 bars of the playhead, scaled by energy.
            const dist = Math.abs(frac - progressFrac) * bars.length;
            const lift = playing && dist < 3 ? (1 - dist / 3) * energy * 30 : 0;
            const height = Math.min(
              100,
              Math.max(8, Math.abs(v) * 100 + lift),
            );
            return (
              <div
                key={i}
                className={`flex-1 min-w-0 rounded-full transition-[background-color,height] duration-150 ${
                  past
                    ? "bg-gradient-to-t from-indigo-500 via-indigo-500 to-fuchsia-500 shadow-[0_0_8px_rgba(99,102,241,0.35)]"
                    : "bg-slate-300 group-hover:bg-slate-400"
                }`}
                style={{ height: `${height}%` }}
              />
            );
          })}

          {/* Playhead line */}
          <motion.div
            aria-hidden
            className="absolute top-0 bottom-0 w-[2px] rounded-full bg-gradient-to-b from-indigo-600 via-fuchsia-500 to-indigo-600 pointer-events-none shadow-[0_0_12px_rgba(217,70,239,0.6)]"
            style={{ left: `${progressFrac * 100}%` }}
            transition={{ duration: 0.12 }}
          />

          {/* Time tooltip on hover */}
          <span
            aria-hidden
            className="absolute -top-1 -translate-x-1/2 px-2 py-0.5 rounded-md text-[11px] font-mono nums text-white bg-slate-900 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
            style={{ left: `${progressFrac * 100}%` }}
          >
            {formatDuration(Math.floor(currentTime))}
          </span>
        </div>

        {/* Time rail */}
        <div className="mt-3 flex items-center justify-between text-[11.5px] font-mono text-slate-400">
          <span className="nums">00:00</span>
          <span className="nums text-slate-600 font-semibold">
            {formatDuration(Math.floor(currentTime))}
            <span className="text-slate-300 mx-1">/</span>
            {formatDuration(durationSec)}
          </span>
          <span className="nums">{formatDuration(durationSec)}</span>
        </div>
      </div>

      {/* Transport controls — floating card-within-card */}
      <div className="px-5 py-3 border-t border-slate-200 bg-slate-50/40 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SkipButton direction="back" onClick={() => seek(Math.max(0, (currentTime - 10) / (durationSec || 1)))} />
          <motion.button
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            type="button"
            onClick={toggle}
            className="flex items-center justify-center w-12 h-12 rounded-full shrink-0 bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white hover:from-indigo-600 hover:via-indigo-600 hover:to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),_0_6px_16px_-4px_rgba(15,23,42,0.4)] transition-colors"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause size={18} strokeWidth={0} fill="currentColor" />
            ) : (
              <Play
                size={18}
                strokeWidth={0}
                fill="currentColor"
                className="ml-0.5"
              />
            )}
          </motion.button>
          <SkipButton direction="forward" onClick={() => seek(Math.min(1, (currentTime + 10) / (durationSec || 1)))} />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleMute}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-white transition-colors"
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Unmute" : "Mute"}
          >
            <Volume2
              size={16}
              strokeWidth={1.8}
              className={muted ? "opacity-40" : ""}
            />
          </button>
          <span
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-100 text-slate-600 text-[11.5px] font-mono"
            title="Keyboard: space to play/pause, ← → to seek ±10s"
          >
            <span className="hidden sm:inline">Space · ← →</span>
          </span>
        </div>
      </div>
    </motion.div>
  );
}

// Memoize the waveform bar heights by seed so they're stable across renders.
function useMemoWave(seed: number) {
  return useRef(generateWaveform(seed, WAVE_BAR_COUNT, 1)).current;
}

function SkipButton({
  direction,
  onClick,
}: {
  direction: "back" | "forward";
  onClick: () => void;
}) {
  return (
    <motion.button
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.92 }}
      type="button"
      onClick={onClick}
      className="flex items-center justify-center w-9 h-9 rounded-full bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:border-slate-300 transition-colors"
      aria-label={direction === "back" ? "Back 10 seconds" : "Forward 10 seconds"}
      title={direction === "back" ? "Back 10s" : "Forward 10s"}
    >
      <span className="text-[10px] font-mono font-semibold nums">
        {direction === "back" ? "−10" : "+10"}
      </span>
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// Frequency bands (unchanged visual; still a seeded artifact for the demo)
// ---------------------------------------------------------------------------

const BAND_DEFS = [
  { label: "Sub",  range: "20-60 Hz",     from: "from-indigo-500",  to: "to-blue-500",   idle: 0.22 },
  { label: "Low",  range: "60-250 Hz",    from: "from-violet-500",  to: "to-purple-500", idle: 0.46 },
  { label: "Mid",  range: "250 Hz-2 kHz", from: "from-fuchsia-500", to: "to-pink-500",   idle: 0.80 },
  { label: "High", range: "2-8 kHz",      from: "from-rose-500",    to: "to-orange-500", idle: 0.50 },
  { label: "Air",  range: "8-20 kHz",     from: "from-amber-500",   to: "to-yellow-500", idle: 0.18 },
];

function FrequencyBands({
  ready,
  playback,
}: {
  ready: boolean;
  playback: Playback;
}) {
  const { freqBands, playing } = playback;

  // Tracked peak-hold per band (slowly falls when audio dips).
  const [peaks, setPeaks] = useState<number[]>([0, 0, 0, 0, 0]);
  useEffect(() => {
    const id = window.setInterval(() => {
      setPeaks((prev) =>
        prev.map((p, i) => {
          const current = freqBands[i] ?? 0;
          return current > p ? current : Math.max(0, p - 0.015);
        }),
      );
    }, 50);
    return () => window.clearInterval(id);
  }, [freqBands]);

  // While audio hasn't played yet, show an "at-rest" preview so the card
  // isn't empty. The moment the user plays, we switch to live FFT values.
  const hasSignal = freqBands.some((v) => v > 0.005);
  const displayValues = hasSignal
    ? freqBands
    : BAND_DEFS.map((b) => (ready ? b.idle : 0));

  const dominantBandIdx = displayValues.reduce(
    (maxI, v, i, arr) => (v > arr[maxI] ? i : maxI),
    0,
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.25 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)]"
    >
      <div
        aria-hidden
        className="absolute -right-14 -top-14 w-40 h-40 rounded-full bg-gradient-to-br from-fuchsia-500/10 to-pink-500/10 blur-3xl pointer-events-none"
      />

      {/* Header */}
      {/* <div className="relative flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
        <span className="flex items-center gap-2.5 text-[14.5px] text-slate-700 font-medium">
          <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-fuchsia-500 to-pink-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
            <Activity size={14} strokeWidth={2} />
          </span>
          Frequency balance
        </span>
        <span
          className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full border ${
            playing
              ? "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-100"
              : hasSignal
                ? "bg-slate-50 text-slate-600 border-slate-200"
                : "bg-slate-50 text-slate-500 border-slate-200"
          }`}
        >
          {playing ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-600 animate-blink" />
              Live FFT
            </>
          ) : hasSignal ? (
            "Paused"
          ) : (
            "Snapshot"
          )}
        </span>
      </div> */}

      {/* <div className="relative p-5 bg-gradient-to-b from-white via-white to-slate-50/30">

        <div className="grid grid-cols-5 gap-3 h-44 items-end">
          {BAND_DEFS.map((b, i) => {
            const value = displayValues[i];
            const pct = Math.min(100, Math.max(4, value * 100));
            const peakPct = Math.min(100, Math.max(0, (peaks[i] ?? 0) * 100));
            const isDominant = i === dominantBandIdx && value > 0.05;
            return (
              <div key={b.label} className="flex flex-col items-center gap-2">
                <div className="w-full h-full flex flex-col justify-end relative">
                  <div
                    aria-hidden
                    className="absolute inset-0 flex flex-col justify-between pointer-events-none"
                  >
                    {[0, 1, 2, 3, 4].map((n) => (
                      <div key={n} className="h-px bg-slate-100" />
                    ))}
                  </div>

                  <motion.div
                    animate={{ height: `${pct}%` }}
                    transition={{
                      duration: playing ? 0.08 : 0.45,
                      ease: playing
                        ? "linear"
                        : ([0.22, 1, 0.36, 1] as [number, number, number, number]),
                    }}
                    className={`relative w-full rounded-md bg-gradient-to-t ${b.from} ${b.to} shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]`}
                  >
                    <span
                      className={`absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-mono nums font-semibold whitespace-nowrap transition-opacity ${
                        isDominant
                          ? "opacity-100 text-fuchsia-700"
                          : "opacity-0 group-hover:opacity-100 text-slate-600"
                      }`}
                    >
                      {Math.round(pct)}%
                    </span>
                  </motion.div>

                  <motion.div
                    aria-hidden
                    animate={{ bottom: `${peakPct}%` }}
                    transition={{ duration: 0.2 }}
                    className="absolute left-0 right-0 h-[2px] bg-white/80 shadow-[0_0_4px_rgba(15,23,42,0.3)] pointer-events-none rounded-full"
                  />
                </div>

                <div className="text-center">
                  <p
                    className={`text-[11.5px] font-semibold ${
                      isDominant ? "text-fuchsia-700" : "text-slate-800"
                    }`}
                  >
                    {b.label}
                  </p>
                  <p className="text-[9.5px] text-slate-400 font-mono">
                    {b.range}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-5 grid grid-cols-3 gap-px rounded-lg border border-slate-200 overflow-hidden">
          <MetricCell
            label="Dominant"
            value={BAND_DEFS[dominantBandIdx].label}
            hint={BAND_DEFS[dominantBandIdx].range}
          />
          <MetricCell
            label="Average"
            value={`${Math.round(
              (displayValues.reduce((a, b) => a + b, 0) / displayValues.length) *
                100,
            )}%`}
            hint={playing ? "rolling (live)" : "instantaneous"}
          />
          <MetricCell
            label="Peak"
            value={`${Math.round(Math.max(...peaks) * 100)}%`}
            hint={playing ? "held 2s" : "held"}
          />
        </div>
      </div> */}
    </motion.div>
  );
}

function MetricCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="bg-gradient-to-br from-slate-50/70 to-white px-3 py-2.5">
      <p className="text-[10.5px] text-slate-500 font-semibold uppercase tracking-wide mb-0.5">
        {label}
      </p>
      <p className="text-[15px] font-semibold text-slate-900 leading-tight">
        {value}
      </p>
      <p className="text-[10px] text-slate-400 leading-tight mt-0.5">{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audio analysis
// ---------------------------------------------------------------------------

function AudioAnalysis({ ready }: { ready: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.35 }}
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
    >
      <QualityScoreCard ready={ready} />
      <AnalysisCard
        icon={<Globe size={14} strokeWidth={2} />}
        label="Language"
        value="English"
        hint="98% confidence"
        from="from-indigo-500"
        to="to-blue-500"
        softFrom="from-indigo-50"
        softTo="to-blue-50"
      />
      <AnalysisCard
        icon={<Users size={14} strokeWidth={2} />}
        label="Speakers"
        value="1 voice"
        hint="instructor only"
        from="from-violet-500"
        to="to-purple-500"
        softFrom="from-violet-50"
        softTo="to-purple-50"
      />
      <AnalysisCard
        icon={<Target size={14} strokeWidth={2} />}
        label="Noise floor"
        value="Low"
        hint="-52 dB"
        from="from-emerald-500"
        to="to-teal-500"
        softFrom="from-emerald-50"
        softTo="to-teal-50"
        accent
      />
    </motion.div>
  );
}

function QualityScoreCard({ ready }: { ready: boolean }) {
  const target = 84;
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const start = Date.now();
    const duration = 1200;
    let raf = 0;
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  const r = 26;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;

  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br from-fuchsia-50 via-white to-rose-50 p-4">
      <div
        aria-hidden
        className="absolute -right-8 -top-8 w-20 h-20 rounded-full bg-gradient-to-br from-fuchsia-500/20 to-rose-500/20 blur-xl"
      />
      <div className="relative flex items-center gap-3">
        <svg width="64" height="64" viewBox="0 0 64 64">
          <circle
            cx="32"
            cy="32"
            r={r}
            fill="none"
            stroke="#f1f5f9"
            strokeWidth="5"
          />
          <circle
            cx="32"
            cy="32"
            r={r}
            fill="none"
            stroke="url(#qgrad)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            transform="rotate(-90 32 32)"
          />
          <defs>
            <linearGradient id="qgrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#d946ef" />
              <stop offset="1" stopColor="#f43f5e" />
            </linearGradient>
          </defs>
        </svg>
        <div>
          <p className="text-[11px] text-slate-500 uppercase tracking-wide font-semibold">
            Quality score
          </p>
          <p className="text-[22px] font-semibold nums bg-gradient-to-br from-fuchsia-600 to-rose-600 bg-clip-text text-transparent leading-none mt-0.5">
            {(value / 10).toFixed(1)}{" "}
            <span className="text-[13px] text-slate-400">/ 10</span>
          </p>
        </div>
      </div>
    </div>
  );
}

function AnalysisCard({
  icon,
  label,
  value,
  hint,
  from,
  to,
  softFrom,
  softTo,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  from: string;
  to: string;
  softFrom: string;
  softTo: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br ${softFrom} via-white ${softTo} p-4`}
    >
      <div
        aria-hidden
        className={`absolute -right-8 -top-8 w-20 h-20 rounded-full blur-xl bg-gradient-to-br ${from} ${to} opacity-10`}
      />
      <div className="relative flex items-center gap-2 mb-2">
        <span
          className={`flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
        >
          {icon}
        </span>
        <p className="text-[11.5px] text-slate-600 font-semibold uppercase tracking-wide">
          {label}
        </p>
      </div>
      <p
        className={`relative text-[17px] font-semibold leading-tight ${
          accent
            ? "bg-gradient-to-br from-emerald-600 to-teal-600 bg-clip-text text-transparent"
            : "text-slate-900"
        }`}
      >
        {value}
      </p>
      <p className="relative text-[12px] text-slate-500 mt-0.5">{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Output audio cells — now backed by real Audio row values
// ---------------------------------------------------------------------------

function OutputAudioCells({ audio }: { audio: AudioRow }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.5 }}
      className="flex flex-col gap-3"
    >
      <p className="text-[13.5px] text-slate-500 font-medium uppercase tracking-wide">
        Output audio
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <OutputCell
          icon={<Gauge size={14} strokeWidth={2} />}
          label="Sample rate"
          value={audio.sampleRateHz ? `${audio.sampleRateHz / 1000} kHz` : "—"}
          from="from-indigo-500"
          to="to-blue-500"
          softFrom="from-indigo-50"
          softTo="to-blue-50"
        />
        <OutputCell
          icon={<Headphones size={14} strokeWidth={2} />}
          label="Channels"
          value={
            audio.channels == null
              ? "—"
              : audio.channels === 1
                ? "Mono"
                : audio.channels === 2
                  ? "Stereo"
                  : String(audio.channels)
          }
          from="from-violet-500"
          to="to-purple-500"
          softFrom="from-violet-50"
          softTo="to-purple-50"
        />
        <OutputCell
          icon={<FileAudio2 size={14} strokeWidth={2} />}
          label="Codec"
          value={
            audio.codec
              ? `${audio.codec.toUpperCase()}${audio.bitrateKbps ? ` · ${audio.bitrateKbps}kbps` : ""}`
              : "—"
          }
          from="from-fuchsia-500"
          to="to-pink-500"
          softFrom="from-fuchsia-50"
          softTo="to-pink-50"
        />
        <OutputCell
          icon={<HardDrive size={14} strokeWidth={2} />}
          label="Size"
          value={audio.sizeBytes ? formatBytes(audio.sizeBytes) : "—"}
          from="from-emerald-500"
          to="to-teal-500"
          softFrom="from-emerald-50"
          softTo="to-teal-50"
        />
      </div>
    </motion.div>
  );
}

function OutputCell({
  icon,
  label,
  value,
  from,
  to,
  softFrom,
  softTo,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  from: string;
  to: string;
  softFrom: string;
  softTo: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br ${softFrom} via-white ${softTo} p-3.5 shadow-[0_1px_2px_rgba(9,9,11,0.03)]`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
        >
          {icon}
        </span>
        <p className="text-[12.5px] text-slate-600 font-medium">{label}</p>
      </div>
      <p className="text-[17px] font-semibold text-slate-900 nums">{value}</p>
    </div>
  );
}
