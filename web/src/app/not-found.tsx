"use client";

import Link from "next/link";
import { motion } from "motion/react";
import {
  AudioWaveform,
  ArrowRight,
  Home,
  HelpCircle,
  Search,
} from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Top nav */}
      <header className="border-b border-slate-200 bg-white/85 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto h-[68px] px-6 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
              <AudioWaveform size={19} strokeWidth={2} />
            </span>
            <span className="text-[22px] font-semibold tracking-tight text-slate-900">
              Course Generator AI
            </span>
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[15px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
          >
            <Home size={14} strokeWidth={2} />
            Back home
          </Link>
        </div>
      </header>

      <main className="flex-1 relative overflow-hidden flex items-center justify-center">
        {/* Mesh gradient */}
        <motion.div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          animate={{
            background: [
              "radial-gradient(40% 40% at 80% 20%, rgba(99,102,241,0.18) 0%, transparent 60%), radial-gradient(40% 40% at 15% 75%, rgba(217,70,239,0.12) 0%, transparent 60%)",
              "radial-gradient(40% 40% at 15% 20%, rgba(99,102,241,0.18) 0%, transparent 60%), radial-gradient(40% 40% at 80% 75%, rgba(217,70,239,0.12) 0%, transparent 60%)",
              "radial-gradient(40% 40% at 80% 20%, rgba(99,102,241,0.18) 0%, transparent 60%), radial-gradient(40% 40% at 15% 75%, rgba(217,70,239,0.12) 0%, transparent 60%)",
            ],
          }}
          transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
        />
        {/* Dot grid */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-50 pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(15,23,42,0.06) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
            maskImage:
              "radial-gradient(ellipse at 50% 40%, black 30%, transparent 80%)",
            WebkitMaskImage:
              "radial-gradient(ellipse at 50% 40%, black 30%, transparent 80%)",
          }}
        />

        <div className="relative px-6 py-20 flex flex-col items-center text-center gap-6 max-w-2xl">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 18 }}
            className="relative"
          >
            <span className="text-[128px] md:text-[180px] font-semibold leading-none tracking-[-0.06em] bg-gradient-to-br from-indigo-600 via-fuchsia-500 to-emerald-500 bg-clip-text text-transparent">
              404
            </span>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="flex flex-col items-center gap-3"
          >
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-br from-indigo-50 to-fuchsia-50 border border-indigo-100/70 text-indigo-700 text-[13px] font-semibold uppercase tracking-wide">
              <Search size={12} strokeWidth={2.2} />
              Page not found
            </span>
            <h1 className="text-[34px] md:text-[44px] font-semibold leading-[1.05] tracking-[-0.03em] text-slate-900">
              This lecture got{" "}
              <span className="font-medium italic text-slate-500">lost in the noise.</span>
            </h1>
            <p className="text-[17px] text-slate-600 leading-relaxed max-w-[44ch]">
              The page you&rsquo;re looking for doesn&rsquo;t exist. Head back
              home, or jump straight into processing a new recording.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.4 }}
            className="flex flex-wrap items-center justify-center gap-3 pt-2"
          >
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-lg text-[16px] font-medium text-white bg-gradient-to-br from-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(99,102,241,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(99,102,241,0.6)] transition-shadow"
            >
              <Home size={15} strokeWidth={2} />
              Back to home
            </Link>
            <Link
              href="/new"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-lg text-[16px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
            >
              Start a new job
              <ArrowRight size={14} strokeWidth={2} />
            </Link>
          </motion.div>

          <motion.a
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.6 }}
            href="#"
            className="inline-flex items-center gap-1.5 text-[13.5px] text-slate-500 hover:text-slate-900 transition-colors pt-2"
          >
            <HelpCircle size={12} strokeWidth={2} />
            Something broken? Let us know.
          </motion.a>
        </div>
      </main>
    </div>
  );
}
