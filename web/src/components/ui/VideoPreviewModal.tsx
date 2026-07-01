"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Play,
  Pause,
  Volume2,
  Download,
  Maximize2,
  User,
  Clock,
} from "lucide-react";
import { Modal } from "./Modal";
import { useToast } from "./Toast";
import { formatDuration } from "@/lib/utils";

export type VideoPreviewData = {
  index?: number;
  topic: string;
  durationSec: number;
  avatarHue?: number;
  avatarName?: string;
  wordCount?: number;
  /** Server-side URL for the rendered mp4 (Step 6). When set, the
   *  modal renders a real <video> element instead of the SVG mock. */
  videoUrl?: string;
};

export function VideoPreviewModal({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: VideoPreviewData | null;
}) {
  const [playing, setPlaying] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const tickRef = useRef<number | null>(null);
  const toast = useToast();

  // Reset state on open/close
  useEffect(() => {
    if (!open) {
      setPlaying(false);
      setElapsedSec(0);
    }
  }, [open]);

  // Fake playback ticker
  useEffect(() => {
    if (!open || !playing || !data) return;
    tickRef.current = window.setInterval(() => {
      setElapsedSec((prev) => {
        const next = prev + 1;
        if (next >= data.durationSec) {
          setPlaying(false);
          return data.durationSec;
        }
        return next;
      });
    }, 1000);
    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
    };
  }, [open, playing, data]);

  if (!data) return null;

  const progress = (elapsedSec / data.durationSec) * 100;
  const hue = data.avatarHue ?? 220;
  const avatarName = data.avatarName ?? "Atlas";

  function handleDownload() {
    toast.download(
      "Download started",
      `${data!.topic} · 1080p MP4`,
    );
    onClose();
  }

  // When a real videoUrl is present (Step 6 render completed), render
  // the actual mp4 instead of the SVG mock. Range-supporting backend
  // route at /api/jobs/[id]/render/[renderId]/file lets <video> scrub.
  if (data.videoUrl) {
    return (
      <Modal open={open} onClose={onClose} size="lg">
        <div className="relative aspect-video w-full bg-black overflow-hidden">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={data.videoUrl}
            controls
            autoPlay
            className="w-full h-full"
          />
        </div>
        <div className="px-6 py-4 border-t border-slate-200 bg-white">
          <p className="text-[16px] font-semibold text-slate-900">
            {data.topic}
          </p>
          <p className="text-[12.5px] text-slate-500 mt-0.5">
            {data.index ? `Chunk ${data.index} · ` : ""}
            {formatDuration(data.durationSec)}
            {data.wordCount ? ` · ${data.wordCount.toLocaleString()} words` : ""}
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} size="lg">
      {/* Video frame */}
      <div className="relative aspect-video w-full bg-slate-900 overflow-hidden">
        {/* Gradient backdrop */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `radial-gradient(circle at 30% 25%, hsla(${hue}, 80%, 65%, 0.35), transparent 55%), linear-gradient(135deg, hsl(${hue} 60% 14%), hsl(${(hue + 40) % 360} 65% 10%))`,
          }}
        />
        {/* Dot matrix texture */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-35 pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.12) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />

        {/* Abstract avatar silhouette */}
        <svg
          viewBox="0 0 100 60"
          preserveAspectRatio="xMidYMid meet"
          className="absolute inset-0 w-full h-full"
          aria-hidden
        >
          <g
            fill="none"
            stroke="rgba(255,255,255,0.75)"
            strokeWidth="0.5"
            strokeLinejoin="round"
          >
            <path d="M 20 60 C 25 42, 38 38, 50 38 C 62 38, 75 42, 80 60" />
            <rect x="46" y="30" width="8" height="10" />
            <ellipse cx="50" cy="22" rx="10" ry="12" />
          </g>
          <g fill="rgba(255,255,255,0.9)">
            <motion.circle
              animate={
                playing
                  ? { r: [0.8, 1.1, 0.8] }
                  : { r: 0.9 }
              }
              transition={{
                duration: 2.4,
                repeat: Infinity,
                ease: "easeInOut",
              }}
              cx="46"
              cy="21"
              r="0.9"
            />
            <motion.circle
              animate={
                playing
                  ? { r: [0.8, 1.1, 0.8] }
                  : { r: 0.9 }
              }
              transition={{
                duration: 2.4,
                repeat: Infinity,
                ease: "easeInOut",
                delay: 0.1,
              }}
              cx="54"
              cy="21"
              r="0.9"
            />
            <motion.ellipse
              animate={
                playing
                  ? {
                      ry: [0.4, 1.2, 0.6, 1.4, 0.4],
                      rx: [1.6, 2.4, 1.8, 2.2, 1.6],
                    }
                  : { ry: 0.6, rx: 1.8 }
              }
              transition={{
                duration: 1.8,
                repeat: Infinity,
                ease: "easeInOut",
              }}
              cx="50"
              cy="29"
              rx="1.8"
              ry="0.6"
            />
          </g>
        </svg>

        {/* HUD labels */}
        <div className="absolute top-3 left-3 right-3 flex items-start justify-between text-white/80">
          <div className="flex items-center gap-1.5 text-[11.5px] font-mono bg-black/30 backdrop-blur-sm rounded px-2 py-1">
            <User size={10} strokeWidth={2} />
            {avatarName.toUpperCase()}
          </div>
          <div className="flex items-center gap-2 text-[11.5px] font-mono">
            {playing && (
              <span className="flex items-center gap-1 bg-red-500/70 backdrop-blur-sm rounded px-2 py-1 text-white">
                <motion.span
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ duration: 1.2, repeat: Infinity }}
                  className="w-1.5 h-1.5 rounded-full bg-white"
                />
                REC
              </span>
            )}
            <span className="bg-black/30 backdrop-blur-sm rounded px-2 py-1">
              1080p · 24fps
            </span>
          </div>
        </div>

        {/* Giant play button overlay (when paused) */}
        {!playing && (
          <motion.button
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setPlaying(true)}
            type="button"
            aria-label="Play"
            className="absolute inset-0 flex items-center justify-center group"
          >
            <span className="flex items-center justify-center w-20 h-20 rounded-full bg-white/15 backdrop-blur-md border border-white/25 text-white shadow-[0_8px_32px_rgba(0,0,0,0.3)] group-hover:bg-white/25 transition-colors">
              <Play size={28} strokeWidth={0} fill="currentColor" className="ml-1" />
            </span>
          </motion.button>
        )}

        {/* Pause overlay (when playing) */}
        {playing && (
          <button
            type="button"
            onClick={() => setPlaying(false)}
            aria-label="Pause"
            className="absolute inset-0 bg-transparent"
          />
        )}

        {/* Progress + controls */}
        <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/65 to-transparent text-white">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[11.5px] font-mono nums w-14 shrink-0">
              {formatDuration(elapsedSec)}
            </span>
            <div className="flex-1 h-1 bg-white/15 rounded-full relative overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.25 }}
                className="h-full bg-gradient-to-r from-indigo-400 via-fuchsia-400 to-emerald-400 rounded-full"
              />
            </div>
            <span className="text-[11.5px] font-mono nums w-14 text-right shrink-0">
              {formatDuration(data.durationSec)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? "Pause" : "Play"}
              title={playing ? "Pause" : "Play"}
              className="flex items-center justify-center w-8 h-8 rounded-md bg-white/15 hover:bg-white/25 backdrop-blur-sm transition-colors"
            >
              {playing ? (
                <Pause size={13} strokeWidth={0} fill="currentColor" />
              ) : (
                <Play
                  size={13}
                  strokeWidth={0}
                  fill="currentColor"
                  className="ml-0.5"
                />
              )}
            </button>
            <button
              type="button"
              aria-label="Volume"
              title="Volume"
              className="flex items-center justify-center w-8 h-8 rounded-md bg-white/15 hover:bg-white/25 backdrop-blur-sm transition-colors"
            >
              <Volume2 size={13} strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label="Fullscreen"
              title="Fullscreen"
              className="ml-auto flex items-center justify-center w-8 h-8 rounded-md bg-white/15 hover:bg-white/25 backdrop-blur-sm transition-colors"
            >
              <Maximize2 size={12} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>

      {/* Meta info below */}
      <div className="p-5 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          {data.index !== undefined && (
            <p className="text-[12.5px] text-slate-500 font-mono nums mb-1">
              Segment {String(data.index).padStart(2, "0")}
            </p>
          )}
          <h4 className="text-[18px] font-semibold text-slate-900 leading-snug">
            {data.topic}
          </h4>
          <div className="flex items-center gap-3 mt-1.5 text-[13px] text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <Clock size={12} strokeWidth={2} />
              <span className="nums">{formatDuration(data.durationSec)}</span>
            </span>
            {data.wordCount !== undefined && (
              <>
                <span className="text-slate-300">·</span>
                <span className="nums">
                  {data.wordCount.toLocaleString()} words
                </span>
              </>
            )}
            <span className="text-slate-300">·</span>
            <span>English · {avatarName}</span>
          </div>
        </div>
        <motion.button
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.97 }}
          onClick={handleDownload}
          type="button"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[14.5px] font-medium text-white bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(16,185,129,0.5)]"
        >
          <Download size={14} strokeWidth={2} />
          Download MP4
        </motion.button>
      </div>
    </Modal>
  );
}
