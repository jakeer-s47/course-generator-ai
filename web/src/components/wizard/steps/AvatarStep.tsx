"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Play,
  Download,
  Loader2,
  Check,
  ChevronDown,
  User,
  Clock,
  Sparkles,
  Mic,
} from "lucide-react";
import { useWizard } from "../WizardContext";
import { formatDuration } from "@/lib/utils";
import { StepHeader } from "../StepHeader";
import {
  VideoPreviewModal,
  type VideoPreviewData,
} from "@/components/ui/VideoPreviewModal";
import { useToast } from "@/components/ui/Toast";

const AVATARS = [
  { id: "atlas-04",  name: "Atlas",   style: "Neutral professor",     tone: "Warm",       hue: 220 },
  { id: "nova-02",   name: "Nova",    style: "Upbeat presenter",      tone: "Energetic",  hue: 15  },
  { id: "sage-07",   name: "Sage",    style: "Calm scholar",          tone: "Calm",       hue: 160 },
  { id: "kai-01",    name: "Kai",     style: "Modern instructor",     tone: "Clear",      hue: 280 },
  { id: "juno-03",   name: "Juno",    style: "Documentary narrator",  tone: "Deep",       hue: 45  },
  { id: "river-05",  name: "River",   style: "Conversational tutor",  tone: "Friendly",   hue: 190 },
];

const VOICES = [
  { id: "atlas-04",   label: "Atlas · English (US)" },
  { id: "atlas-uk",   label: "Atlas · English (UK)" },
  { id: "nova-02",    label: "Nova · English (US)" },
  { id: "sage-07",    label: "Sage · English (US)" },
  { id: "kai-01",     label: "Kai · English (US)" },
  { id: "juno-03",    label: "Juno · English (US)" },
];

export function AvatarStep() {
  const { chunks, renders, selectedAvatarId, selectedVoice, update, updateRender } =
    useWizard();
  const [generating, setGenerating] = useState(false);
  const timeoutsRef = useRef<number[]>([]);
  const [preview, setPreview] = useState<VideoPreviewData | null>(null);
  const toast = useToast();

  const activeAvatar = AVATARS.find((a) => a.id === selectedAvatarId) ?? AVATARS[0];

  function openPreview(chunkIndex: number) {
    const c = chunks[chunkIndex];
    if (!c) return;
    setPreview({
      index: chunkIndex + 1,
      topic: c.topic,
      durationSec: c.endSec - c.startSec,
      avatarHue: activeAvatar.hue,
      avatarName: activeAvatar.name,
      wordCount: c.wordCount,
    });
  }

  function handleDownloadOne(chunkIndex: number) {
    const c = chunks[chunkIndex];
    if (!c) return;
    toast.download(
      "Download started",
      `${c.topic} · 1080p MP4`,
    );
  }

  function handleDownloadAll() {
    const ready = Object.values(renders).filter((r) => r.ready).length;
    toast.download(
      `Downloading ${ready} videos`,
      "Zipped and on the way",
    );
  }

  useEffect(() => {
    if (!selectedAvatarId) {
      update({ selectedAvatarId: AVATARS[0].id, selectedVoice: AVATARS[0].id });
    }
    return () => {
      timeoutsRef.current.forEach((t) => window.clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function generateAll() {
    if (chunks.length === 0) return;
    setGenerating(true);
    toast.info(
      "Rendering started",
      `${chunks.length} videos · ${activeAvatar.name}`,
    );

    timeoutsRef.current.forEach((t) => window.clearTimeout(t));
    timeoutsRef.current = [];

    chunks.forEach((c, i) => {
      const startDelay = i * 350;
      const stepMs = 150;
      const totalSteps = 12 + Math.floor(Math.random() * 5);
      for (let s = 1; s <= totalSteps; s++) {
        const t = window.setTimeout(() => {
          const progress = Math.min(100, Math.round((s / totalSteps) * 100));
          updateRender(c.id, { progress, ready: progress >= 100 });
          if (i === chunks.length - 1 && s === totalSteps) {
            setGenerating(false);
            toast.success(
              "All videos ready",
              `${chunks.length} 1080p MP4s`,
            );
          }
        }, startDelay + s * stepMs);
        timeoutsRef.current.push(t);
      }
    });
  }

  const readyCount = Object.values(renders).filter((r) => r.ready).length;
  const totalCount = chunks.length;
  const anyRendering = Object.values(renders).some(
    (r) => r.progress > 0 && !r.ready,
  );

  return (
    <div className="max-w-5xl mx-auto w-full flex flex-col gap-7 animate-reveal">
      <StepHeader
        step={6}
        title="Render avatar videos"
        description={`Pick an avatar and voice, then generate a narrated video for each of your ${totalCount} topic chunks.`}
        actions={
          <div className="flex items-center gap-2">
            {readyCount > 0 && (
              <motion.button
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.97 }}
                type="button"
                onClick={handleDownloadAll}
                disabled={readyCount === 0}
                title="Download all rendered videos as a zip"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[14.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
              >
                <Download size={14} strokeWidth={2} />
                Download all ({readyCount})
              </motion.button>
            )}
            <motion.button
              whileHover={!generating && selectedAvatarId ? { y: -1 } : undefined}
              whileTap={!generating && selectedAvatarId ? { scale: 0.97 } : undefined}
              type="button"
              onClick={generateAll}
              disabled={generating || !selectedAvatarId}
              className={`relative inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[14.5px] font-medium text-white transition-shadow ${
                generating || !selectedAvatarId
                  ? "bg-slate-300 cursor-not-allowed shadow-none"
                  : "bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-2px_rgba(16,185,129,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_8px_22px_-4px_rgba(16,185,129,0.6)]"
              }`}
            >
              {generating ? (
                <>
                  <Loader2
                    size={14}
                    strokeWidth={2}
                    className="animate-spin-slow"
                  />
                  Generating…
                </>
              ) : (
                <>
                  <Sparkles size={14} strokeWidth={2} />
                  {readyCount > 0 ? "Regenerate all" : "Generate all"}
                </>
              )}
            </motion.button>
          </div>
        }
      />

      {/* Avatar grid */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-5"
      >
        <p className="text-[13.5px] text-slate-500 font-semibold uppercase tracking-wide mb-3.5 flex items-center gap-1.5">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
            <User size={12} strokeWidth={2} />
          </span>
          Choose an avatar
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {AVATARS.map((a, i) => {
            const active = selectedAvatarId === a.id;
            return (
              <motion.button
                key={a.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: 0.05 + i * 0.05 }}
                whileHover={!active ? { y: -3 } : undefined}
                whileTap={{ scale: 0.97 }}
                type="button"
                onClick={() => update({ selectedAvatarId: a.id })}
                className={`relative group rounded-xl border p-3 flex flex-col gap-2.5 items-center text-center transition-all ${
                  active
                    ? "border-indigo-500 bg-indigo-50/50 ring-2 ring-indigo-100 shadow-[0_4px_18px_-4px_rgba(99,102,241,0.35)]"
                    : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_8px_20px_-10px_rgba(15,23,42,0.2)]"
                }`}
              >
                <span className="relative w-full aspect-square rounded-xl overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]">
                  <AvatarTile hue={a.hue} name={a.name} active={active} />
                  <AnimatePresence>
                    {active && (
                      <motion.span
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ type: "spring", stiffness: 400, damping: 18 }}
                        className="absolute top-2 right-2 w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white flex items-center justify-center shadow-[0_4px_10px_-2px_rgba(99,102,241,0.5)]"
                      >
                        <Check size={12} strokeWidth={2.8} />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
                <div className="flex flex-col gap-0.5">
                  <span
                    className={`text-[15.5px] font-semibold leading-none ${
                      active ? "text-indigo-700" : "text-slate-900"
                    }`}
                  >
                    {a.name}
                  </span>
                  <span className="text-[13px] text-slate-500 leading-tight">
                    {a.style}
                  </span>
                </div>
              </motion.button>
            );
          })}
        </div>
      </motion.div>

      {/* Voice dropdown */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.15 }}
        className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-violet-50/40 via-white to-fuchsia-50/30 shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-5"
      >
        <div
          aria-hidden
          className="absolute -right-12 -top-12 w-36 h-36 rounded-full bg-gradient-to-br from-violet-500/10 to-fuchsia-500/10 blur-3xl"
        />
        <label
          htmlFor="voice"
          className="relative text-[13.5px] text-slate-600 font-semibold uppercase tracking-wide mb-2.5 flex items-center gap-1.5"
        >
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
            <Mic size={12} strokeWidth={2} />
          </span>
          Voice model
        </label>
        <div className="relative max-w-md">
          <select
            id="voice"
            value={selectedVoice}
            onChange={(e) => update({ selectedVoice: e.target.value })}
            className="w-full appearance-none pl-4 pr-11 py-3 rounded-xl border border-slate-200 bg-white text-[16.5px] font-medium text-slate-900 hover:border-slate-300 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100 transition-colors shadow-[0_1px_2px_rgba(9,9,11,0.03)]"
          >
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size={16}
            strokeWidth={2}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
        </div>
      </motion.div>

      {/* Per-chunk progress list */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.2 }}
        className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
          <p className="text-[15px] font-semibold text-slate-900 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
              <Sparkles size={13} strokeWidth={2} />
            </span>
            Chunks to render
          </p>
          <p className="text-[14px] text-slate-600 font-medium inline-flex items-center gap-1.5">
            <span
              className={`nums font-bold text-[18px] ${
                readyCount === totalCount && totalCount > 0
                  ? "text-emerald-600"
                  : "text-slate-900"
              }`}
            >
              {readyCount}
            </span>
            <span className="text-slate-400">/</span>
            <span className="nums">{totalCount}</span>
            <span className="text-slate-500">ready</span>
          </p>
        </div>
        <div className="divide-y divide-slate-100">
          {chunks.map((c, i) => {
            const r = renders[c.id] ?? { progress: 0, ready: false };
            const isRunning = r.progress > 0 && !r.ready;
            const duration = c.endSec - c.startSec;
            return (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: 0.02 * i }}
                className="px-5 py-4 flex items-center gap-4 hover:bg-slate-50/60 transition-colors"
              >
                <span
                  className="flex items-center justify-center w-9 h-9 rounded-xl text-white text-[14px] font-semibold nums shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_2px_8px_-2px_rgba(15,23,42,0.25)]"
                  style={{
                    backgroundImage: `linear-gradient(135deg, hsl(${(i * 55) % 360} 72% 55%), hsl(${(i * 55 + 35) % 360} 72% 45%))`,
                  }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[16px] font-semibold text-slate-900 truncate">
                    {c.topic}
                  </p>
                  <p className="text-[13.5px] text-slate-500 mt-0.5 flex items-center gap-2">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} strokeWidth={2} />
                      <span className="nums">{formatDuration(duration)}</span>
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="nums">
                      {c.wordCount.toLocaleString()} words
                    </span>
                  </p>
                </div>

                <div className="hidden md:flex items-center gap-3 w-56 shrink-0">
                  <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${r.progress}%` }}
                      transition={{ duration: 0.3 }}
                      className={`h-full rounded-full ${
                        r.ready
                          ? "bg-gradient-to-r from-emerald-500 to-teal-500 shadow-[0_0_10px_rgba(16,185,129,0.4)]"
                          : "shimmer-bar"
                      }`}
                    />
                  </div>
                  <span
                    className={`text-[13px] font-mono nums w-10 text-right font-semibold ${
                      r.ready ? "text-emerald-600" : "text-slate-500"
                    }`}
                  >
                    {r.progress}%
                  </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {r.ready ? (
                    <>
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
                    </>
                  ) : isRunning ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12.5px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-100">
                      <Loader2
                        size={12}
                        strokeWidth={2.2}
                        className="animate-spin-slow"
                      />
                      Rendering
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12.5px] font-medium text-slate-500 bg-slate-50 border border-slate-200">
                      <Clock size={11} strokeWidth={2} />
                      Queued
                    </span>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>

        <AnimatePresence>
          {readyCount === totalCount && totalCount > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="px-5 py-4 bg-gradient-to-br from-emerald-50 to-teal-50/60 border-t border-emerald-200 flex items-center gap-3"
            >
              <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                <Check size={15} strokeWidth={2.5} />
              </span>
              <p className="text-[15px] text-emerald-800 font-semibold">
                All {totalCount} chunks rendered. Ready to download.
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {readyCount === 0 && !anyRendering && (
          <div className="px-5 py-10 text-center text-slate-400 text-[15px] bg-gradient-to-b from-white to-slate-50/50">
            No renders yet. Click{" "}
            <span className="text-slate-700 font-semibold">Generate all</span> to
            start.
          </div>
        )}
      </motion.div>

      <VideoPreviewModal
        open={preview !== null}
        onClose={() => setPreview(null)}
        data={preview}
      />
    </div>
  );
}

function AvatarTile({
  hue,
  name,
  active,
}: {
  hue: number;
  name: string;
  active: boolean;
}) {
  const bgFrom = `hsl(${hue} 72% ${active ? 48 : 54}%)`;
  const bgTo = `hsl(${(hue + 30) % 360} 76% ${active ? 32 : 38}%)`;
  const initial = name[0];
  return (
    <div
      className="w-full h-full flex items-center justify-center relative"
      style={{
        backgroundImage: `linear-gradient(135deg, ${bgFrom}, ${bgTo})`,
      }}
    >
      <div
        className="absolute inset-0 opacity-35 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.6), transparent 55%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-20 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at 70% 90%, rgba(0,0,0,0.4), transparent 50%)",
        }}
      />
      <span className="relative text-white text-[36px] font-semibold tracking-tight drop-shadow-[0_2px_6px_rgba(0,0,0,0.25)]">
        {initial}
      </span>
    </div>
  );
}
