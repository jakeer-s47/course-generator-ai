"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  Check,
  Download,
  Play,
  Sparkles,
  RotateCcw,
  Share2,
  Clock,
  Layers,
  HardDrive,
  Zap,
  ArrowRight,
  Home,
} from "lucide-react";
import { useWizard } from "./WizardContext";
import { formatDuration, formatBytes } from "@/lib/utils";
import {
  VideoPreviewModal,
  type VideoPreviewData,
} from "@/components/ui/VideoPreviewModal";
import { ShareModal } from "@/components/ui/ShareModal";
import { useToast } from "@/components/ui/Toast";

export function CompletionScreen() {
  const { chunks, renders, reset, selectedAvatarId, jobId } = useWizard();
  const [preview, setPreview] = useState<VideoPreviewData | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const toast = useToast();

  // chunkId → renderId for ready renders, so we can build real /file URLs
  // for preview + download. Fetched once from the render endpoint.
  const [renderIdByChunk, setRenderIdByChunk] = useState<
    Record<string, string>
  >({});
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    void fetch(`/api/jobs/${jobId}/render`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { renders?: { chunkId: string; id: string; status: string }[] } | null) => {
        if (cancelled || !data?.renders) return;
        const map: Record<string, string> = {};
        for (const r of data.renders) {
          if (r.status === "ready") map[r.chunkId] = r.id;
        }
        setRenderIdByChunk(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Avatar hue mapping (parallels AvatarStep's AVATARS list)
  const avatarLookup: Record<string, { hue: number; name: string }> = {
    "atlas-04":  { hue: 220, name: "Atlas"  },
    "nova-02":   { hue: 15,  name: "Nova"   },
    "sage-07":   { hue: 160, name: "Sage"   },
    "kai-01":    { hue: 280, name: "Kai"    },
    "juno-03":   { hue: 45,  name: "Juno"   },
    "river-05":  { hue: 190, name: "River"  },
  };
  const activeAvatar = avatarLookup[selectedAvatarId] ?? {
    hue: 220,
    name: "Atlas",
  };

  // Derived stats
  const totalDurationSec = chunks.reduce(
    (acc, c) => acc + (c.endSec - c.startSec),
    0,
  );
  const readyCount = Object.values(renders).filter((r) => r.ready).length;
  const totalChunks = chunks.length || 6; // fallback for preview when skipped
  const totalSize = totalChunks * 1024 * 1024 * 48; // ~48 MB per chunk mock
  const timeSavedHours = (totalChunks * 2.5).toFixed(1); // mock "hours saved vs re-recording"

  // Mock chunks fallback for when the user freely navigates without seeding
  const displayChunks = useMemo(() => {
    if (chunks.length > 0) return chunks;
    return [
      { id: "c1", topic: "Recap: first law of thermodynamics",       startSec: 0,    endSec: 1180, wordCount: 2140, preview: "" },
      { id: "c2", topic: "Enthalpy and constant-pressure processes", startSec: 1180, endSec: 2450, wordCount: 2380, preview: "" },
      { id: "c3", topic: "Derivation of Mayer's relation",            startSec: 2450, endSec: 3680, wordCount: 2015, preview: "" },
      { id: "c4", topic: "Introduction to the second law",            startSec: 3680, endSec: 4920, wordCount: 2290, preview: "" },
      { id: "c5", topic: "Reversible vs. irreversible processes",     startSec: 4920, endSec: 6200, wordCount: 2450, preview: "" },
      { id: "c6", topic: "Closing & homework assignment",             startSec: 6200, endSec: 6920, wordCount: 1870, preview: "" },
    ];
  }, [chunks]);

  function openPreview(i: number) {
    const c = displayChunks[i];
    if (!c) return;
    const rid = renderIdByChunk[c.id];
    const videoUrl =
      rid && jobId ? `/api/jobs/${jobId}/render/${rid}/file` : undefined;
    setPreview({
      index: i + 1,
      topic: c.topic,
      durationSec: c.endSec - c.startSec,
      avatarHue: activeAvatar.hue,
      avatarName: activeAvatar.name,
      wordCount: c.wordCount,
      videoUrl,
    });
  }

  function handleDownloadOne(i: number) {
    const c = displayChunks[i];
    if (!c) return;
    const rid = renderIdByChunk[c.id];
    if (!rid || !jobId) {
      toast.error("Not available", "This video hasn't been rendered yet");
      return;
    }
    window.open(
      `/api/jobs/${jobId}/render/${rid}/file?download=1`,
      "_blank",
      "noopener,noreferrer",
    );
    toast.download("Download started", `${c.topic} · MP4`);
  }

  function handleDownloadAll() {
    const ready = displayChunks.filter((c) => renderIdByChunk[c.id]);
    if (ready.length === 0 || !jobId) {
      toast.error("Nothing to download", "No rendered videos yet");
      return;
    }
    for (const c of ready) {
      window.open(
        `/api/jobs/${jobId}/render/${renderIdByChunk[c.id]}/file?download=1`,
        "_blank",
        "noopener,noreferrer",
      );
    }
    toast.download(`Downloading ${ready.length} videos`, "Tabs opening per chunk");
  }

  function handleReset() {
    toast.info("Starting over", "Fresh job, let's go");
    reset();
  }

  return (
    <div className="relative min-h-full w-full flex flex-col">
      <Confetti />

      <div className="relative flex-1 max-w-4xl mx-auto w-full px-6 py-12 md:py-16 flex flex-col items-center gap-8">
        {/* Celebration mark */}
        <motion.div
          initial={{ scale: 0, rotate: -12 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.1 }}
          className="relative"
        >
          {/* Pulsing halo */}
          <motion.span
            aria-hidden
            animate={{ scale: [1, 1.35, 1], opacity: [0.35, 0, 0.35] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut" }}
            className="absolute inset-0 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500"
          />
          <span className="relative flex items-center justify-center w-24 h-24 md:w-28 md:h-28 rounded-full bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 text-white shadow-[0_8px_40px_-4px_rgba(16,185,129,0.55),_inset_0_1px_0_rgba(255,255,255,0.25)]">
            <motion.span
              initial={{ scale: 0, rotate: -90 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{
                type: "spring",
                stiffness: 260,
                damping: 14,
                delay: 0.4,
              }}
            >
              <Check size={52} strokeWidth={3} />
            </motion.span>
          </span>
        </motion.div>

        {/* Headline */}
        <div className="flex flex-col items-center text-center gap-3.5">
          <motion.span
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.3 }}
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-100/70 text-emerald-700 text-[13px] font-semibold uppercase tracking-wide"
          >
            <Sparkles size={12} strokeWidth={2.2} />
            Render complete
          </motion.span>
          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="text-[44px] md:text-[60px] font-semibold leading-[1.02] tracking-[-0.035em] text-slate-900"
          >
            All done.{" "}
            <span className="bg-gradient-to-br from-emerald-500 via-teal-500 to-indigo-500 bg-clip-text text-transparent">
              Beautifully.
            </span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.55 }}
            className="text-[18px] md:text-[19px] text-slate-600 leading-relaxed max-w-[54ch]"
          >
            Your lecture is now{" "}
            <span className="text-slate-900 font-semibold">
              {totalChunks} polished micro-videos
            </span>
            . Download all at once, share a single one, or kick off another job.
          </motion.p>
        </div>

        {/* Primary + secondary CTAs */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.7 }}
          className="flex flex-wrap items-center justify-center gap-3"
        >
          <motion.button
            type="button"
            onClick={handleDownloadAll}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 18 }}
            title="Download all videos as a zip"
            className="inline-flex items-center gap-2 px-6 py-3.5 rounded-lg text-[16px] font-medium text-white bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(16,185,129,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(16,185,129,0.6)]"
          >
            <Download size={16} strokeWidth={2} />
            Download all ({totalChunks})
          </motion.button>
          <motion.button
            type="button"
            onClick={() => setShareOpen(true)}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            title="Share videos with a link"
            className="inline-flex items-center gap-2 px-5 py-3.5 rounded-lg text-[16px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
          >
            <Share2 size={15} strokeWidth={2} />
            Share
          </motion.button>
          <motion.button
            type="button"
            onClick={handleReset}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            title="Start a brand-new job from scratch"
            className="inline-flex items-center gap-2 px-5 py-3.5 rounded-lg text-[16px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
          >
            <RotateCcw size={15} strokeWidth={2} />
            Start new job
          </motion.button>
        </motion.div>

        {/* Summary stats */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.85 }}
          className="grid grid-cols-2 md:grid-cols-4 gap-3 w-full"
        >
          <StatTile
            icon={<Layers size={15} strokeWidth={2} />}
            label="Chunks"
            value={String(totalChunks)}
            from="from-indigo-500"
            to="to-blue-500"
            softFrom="from-indigo-50"
            softTo="to-blue-50"
          />
          <StatTile
            icon={<Clock size={15} strokeWidth={2} />}
            label="Total runtime"
            value={formatDuration(totalDurationSec || 6920)}
            from="from-violet-500"
            to="to-purple-500"
            softFrom="from-violet-50"
            softTo="to-purple-50"
          />
          <StatTile
            icon={<HardDrive size={15} strokeWidth={2} />}
            label="Output size"
            value={formatBytes(totalSize)}
            from="from-fuchsia-500"
            to="to-pink-500"
            softFrom="from-fuchsia-50"
            softTo="to-pink-50"
          />
          <StatTile
            icon={<Zap size={15} strokeWidth={2} />}
            label="Time saved"
            value={`${timeSavedHours} h`}
            accent
            from="from-emerald-500"
            to="to-teal-500"
            softFrom="from-emerald-50"
            softTo="to-teal-50"
          />
        </motion.div>

        {/* Generated videos list */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 1 }}
          className="w-full rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
            <p className="text-[15px] font-semibold text-slate-900 flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                <Sparkles size={13} strokeWidth={2} />
              </span>
              Your videos
            </p>
            <p className="text-[13.5px] text-slate-500 inline-flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100 text-[12px] font-semibold">
                <Check size={11} strokeWidth={2.8} />
                {readyCount > 0 ? `${readyCount} rendered` : "All rendered"}
              </span>
            </p>
          </div>
          <div className="divide-y divide-slate-100">
            {displayChunks.map((c, i) => (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: 1.1 + i * 0.05 }}
                className="flex items-center gap-4 px-5 py-3.5 hover:bg-slate-50/60 transition-colors group"
              >
                <span
                  className="flex items-center justify-center w-10 h-10 rounded-xl text-white text-[14px] font-semibold nums shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_2px_8px_-2px_rgba(15,23,42,0.25)]"
                  style={{
                    backgroundImage: `linear-gradient(135deg, hsl(${(i * 55) % 360} 72% 55%), hsl(${(i * 55 + 35) % 360} 72% 45%))`,
                  }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[15.5px] font-semibold text-slate-900 truncate">
                    {c.topic}
                  </p>
                  <p className="text-[13px] text-slate-500 mt-0.5 nums">
                    {formatDuration(c.endSec - c.startSec)} ·{" "}
                    {c.wordCount.toLocaleString()} words · 1080p
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <motion.button
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.92 }}
                    type="button"
                    onClick={() => openPreview(i)}
                    className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-600 hover:text-white hover:bg-gradient-to-br hover:from-indigo-500 hover:to-fuchsia-500 transition-colors"
                    aria-label="Preview video"
                    title="Preview video"
                  >
                    <Play size={14} strokeWidth={0} fill="currentColor" />
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.92 }}
                    type="button"
                    onClick={() => handleDownloadOne(i)}
                    className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-600 hover:text-white hover:bg-gradient-to-br hover:from-emerald-500 hover:to-teal-500 transition-colors"
                    aria-label="Download MP4"
                    title="Download MP4"
                  >
                    <Download size={14} strokeWidth={2} />
                  </motion.button>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Footer link */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 1.3 }}
          className="flex items-center gap-3 pt-2"
        >
          <Link
            href="/"
            className="group inline-flex items-center gap-1.5 text-[15px] text-slate-500 hover:text-slate-900 transition-colors"
          >
            <Home size={14} strokeWidth={2} />
            Back to home
            <ArrowRight
              size={13}
              strokeWidth={2}
              className="transition-transform group-hover:translate-x-0.5"
            />
          </Link>
        </motion.div>
      </div>

      <VideoPreviewModal
        open={preview !== null}
        onClose={() => setPreview(null)}
        data={preview}
      />
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Confetti — simple motion-based particle burst                       */
/* ------------------------------------------------------------------ */

function Confetti() {
  // 48 particles with deterministic spread
  const particles = Array.from({ length: 48 }, (_, i) => {
    const angle = (i / 48) * Math.PI * 2;
    const dist = 280 + ((i * 71) % 140);
    const hue = (i * 37) % 360;
    const delay = (i * 29) % 500;
    return {
      id: i,
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist - 80,
      color: `hsl(${hue} 85% 60%)`,
      delay: delay / 1000,
      size: 5 + ((i * 13) % 6),
      rotate: ((i * 47) % 360),
    };
  });

  return (
    <div
      aria-hidden
      className="absolute inset-x-0 top-0 h-[60vh] pointer-events-none overflow-hidden"
    >
      <div className="absolute left-1/2 top-[220px]">
        {particles.map((p) => (
          <motion.span
            key={p.id}
            initial={{ x: 0, y: 0, opacity: 0, rotate: 0 }}
            animate={{
              x: p.x,
              y: p.y,
              opacity: [0, 1, 1, 0],
              rotate: p.rotate + 360,
            }}
            transition={{
              duration: 1.8,
              delay: p.delay,
              ease: [0.22, 1, 0.36, 1],
              times: [0, 0.1, 0.7, 1],
            }}
            style={{
              background: p.color,
              width: p.size,
              height: p.size,
              borderRadius: p.id % 3 === 0 ? 2 : 999,
            }}
            className="absolute"
          />
        ))}
      </div>
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  from,
  to,
  softFrom,
  softTo,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
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
        className={`absolute -right-8 -top-8 w-24 h-24 rounded-full bg-gradient-to-br ${from} ${to} opacity-15 blur-2xl`}
      />
      <div className="relative flex items-center gap-2 mb-2.5">
        <span
          className={`flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
        >
          {icon}
        </span>
        <p className="text-[13px] text-slate-600 font-medium">{label}</p>
      </div>
      <p
        className={`text-[24px] font-semibold leading-none nums ${
          accent
            ? `bg-gradient-to-br ${from} ${to} bg-clip-text text-transparent`
            : "text-slate-900"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
