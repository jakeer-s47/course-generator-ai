"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  motion,
  useInView,
  useScroll,
  useSpring,
  useTransform,
  AnimatePresence,
  useReducedMotion,
  type Variants,
} from "motion/react";
import {
  AudioWaveform,
  ArrowRight,
  FileVideo,
  AudioLines,
  Sparkles,
  Scissors,
  Clapperboard,
  UploadCloud,
  Check,
  Clock,
  Play,
  Zap,
  Quote,
  Star,
  TrendingUp,
  Users,
  BarChart3,
  Languages,
  GraduationCap,
  X,
} from "lucide-react";
import { RecentJobs } from "@/components/landing/RecentJobs";

export default function LandingPage() {
  return (
    <div className="flex flex-col">
      <LandingNav />
      <ScrollProgress />

      <main className="flex-1">
        <Hero />
        <RecentJobs />
        <StatsStrip />
        <UniversitiesStrip />
        <PipelineViz />
        <BeforeAfter />
        <Features />
        <HowItWorks />
        <Testimonial />
        <FinalCTA />
      </main>

      <LandingFooter />
    </div>
  );
}

/* ================================================================== */
/* Motion helpers                                                      */
/* ================================================================== */

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] },
  },
};

const staggerParent: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08, delayChildren: 0.05 },
  },
};

/* ================================================================== */
/* Scroll progress                                                     */
/* ================================================================== */

function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 120,
    damping: 25,
    restDelta: 0.001,
  });
  return (
    <motion.div
      style={{ scaleX }}
      className="fixed top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-indigo-600 via-fuchsia-500 to-emerald-500 origin-left z-40"
    />
  );
}

/* ================================================================== */
/* Nav                                                                 */
/* ================================================================== */

function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 16);
    h();
    window.addEventListener("scroll", h, { passive: true });
    return () => window.removeEventListener("scroll", h);
  }, []);

  return (
    <motion.header
      initial={{ y: -60, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className={`sticky top-0 z-30 border-b backdrop-blur-xl transition-colors ${
        scrolled
          ? "bg-white/85 border-slate-200 shadow-[0_1px_2px_rgba(9,9,11,0.04)]"
          : "bg-slate-50/60 border-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto h-[68px] px-6 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 group">
          <motion.span
            whileHover={{ rotate: 6, scale: 1.06 }}
            transition={{ type: "spring", stiffness: 400, damping: 14 }}
            className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]"
          >
            <AudioWaveform size={19} strokeWidth={2} />
            <span className="absolute -inset-0.5 rounded-[13px] bg-gradient-to-br from-indigo-500/30 to-fuchsia-500/20 blur-md opacity-0 group-hover:opacity-100 transition-opacity -z-10" />
          </motion.span>
          <span className="flex items-baseline gap-2">
            <span className="text-[22px] font-semibold tracking-tight text-slate-900">
              Course Generator AI
            </span>
            <span className="text-[13.5px] font-medium px-2 py-0.5 rounded-md bg-gradient-to-br from-indigo-50 to-fuchsia-50 text-indigo-700 border border-indigo-100/70">
              Beta
            </span>
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-1">
          {[
            { href: "#how", label: "How it works" },
            { href: "#features", label: "Features" },
            { href: "#testimonial", label: "Stories" },
          ].map((n) => (
            <a
              key={n.href}
              href={n.href}
              className="px-4 py-2 text-[16.5px] text-slate-600 hover:text-slate-900 rounded-md hover:bg-slate-100 transition-colors"
            >
              {n.label}
            </a>
          ))}
        </nav>

        <Link href="/new">
          <motion.span
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 18 }}
            className="relative inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[16.5px] font-medium text-white bg-gradient-to-br from-indigo-600 to-indigo-700 shadow-[0_1px_2px_rgba(79,70,229,0.3),_inset_0_1px_0_rgba(255,255,255,0.14)] hover:shadow-[0_6px_20px_rgba(79,70,229,0.4),_inset_0_1px_0_rgba(255,255,255,0.14)]"
          >
            Start processing
            <ArrowRight size={16} strokeWidth={2.2} />
          </motion.span>
        </Link>
      </div>
    </motion.header>
  );
}

/* ================================================================== */
/* Hero                                                                */
/* ================================================================== */

function Hero() {
  const { scrollY } = useScroll();
  const heroY = useTransform(scrollY, [0, 400], [0, -60]);
  const heroOpacity = useTransform(scrollY, [0, 400], [1, 0.3]);

  return (
    <section className="relative overflow-hidden">
      {/* Mesh gradient backdrop */}
      <motion.div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        animate={{
          background: [
            "radial-gradient(40% 40% at 78% 12%, rgba(99,102,241,0.22) 0%, transparent 60%), radial-gradient(35% 35% at 12% 24%, rgba(16,185,129,0.14) 0%, transparent 60%), radial-gradient(45% 45% at 50% 100%, rgba(217,70,239,0.10) 0%, transparent 70%)",
            "radial-gradient(40% 40% at 22% 18%, rgba(99,102,241,0.22) 0%, transparent 60%), radial-gradient(35% 35% at 82% 36%, rgba(16,185,129,0.14) 0%, transparent 60%), radial-gradient(45% 45% at 50% 100%, rgba(217,70,239,0.12) 0%, transparent 70%)",
            "radial-gradient(40% 40% at 78% 12%, rgba(99,102,241,0.22) 0%, transparent 60%), radial-gradient(35% 35% at 12% 24%, rgba(16,185,129,0.14) 0%, transparent 60%), radial-gradient(45% 45% at 50% 100%, rgba(217,70,239,0.10) 0%, transparent 70%)",
          ],
        }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* Dot grid texture */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.5] pointer-events-none"
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

      <div className="relative max-w-6xl mx-auto px-6 pt-20 md:pt-28 pb-16 md:pb-20">
        <motion.div
          style={{ y: heroY, opacity: heroOpacity }}
          variants={staggerParent}
          initial="hidden"
          animate="visible"
          className="flex flex-col items-center text-center gap-7 max-w-3xl mx-auto"
        >
          <motion.span
            variants={fadeUp}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/80 backdrop-blur text-indigo-700 text-[15px] font-medium border border-indigo-200/70 shadow-[0_1px_2px_rgba(99,102,241,0.10)]"
          >
            <motion.span
              animate={{ rotate: [0, 15, 0, -15, 0] }}
              transition={{ duration: 2.5, repeat: Infinity, repeatDelay: 3 }}
            >
              <Sparkles size={13} strokeWidth={2} />
            </motion.span>
            Turn long recordings into short, focused videos
          </motion.span>

          <motion.h1
            variants={fadeUp}
            className="text-[48px] sm:text-[64px] md:text-[80px] font-semibold leading-[1.02] tracking-[-0.035em] text-slate-900"
          >
            Long lectures,{" "}
            <span className="bg-gradient-to-br from-indigo-600 via-fuchsia-500 to-emerald-500 bg-clip-text text-transparent">
              distilled.
            </span>
          </motion.h1>

          <motion.p
            variants={fadeUp}
            className="text-[20px] md:text-[22px] leading-relaxed text-slate-600 max-w-[58ch]"
          >
            Upload one long recording. Get back a clean transcript, 20-minute
            topic-focused clips, and avatar-narrated videos ready to share with
            your students.
          </motion.p>

          <motion.div
            variants={fadeUp}
            className="flex flex-wrap items-center justify-center gap-3 pt-2"
          >
            <Link href="/new">
              <motion.span
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
                transition={{ type: "spring", stiffness: 400, damping: 18 }}
                className="relative inline-flex items-center gap-2 px-6 py-3.5 rounded-lg text-[17.5px] font-medium text-white bg-gradient-to-br from-indigo-600 to-indigo-700 shadow-[0_1px_2px_rgba(79,70,229,0.3),_inset_0_1px_0_rgba(255,255,255,0.15),_0_12px_32px_-12px_rgba(79,70,229,0.5)] hover:shadow-[0_1px_2px_rgba(79,70,229,0.3),_inset_0_1px_0_rgba(255,255,255,0.15),_0_18px_40px_-12px_rgba(79,70,229,0.6)]"
              >
                Start a new job
                <motion.span
                  animate={{ x: [0, 4, 0] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                >
                  <ArrowRight size={17} strokeWidth={2.2} />
                </motion.span>
              </motion.span>
            </Link>
            <motion.a
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.97 }}
              href="#how"
              className="inline-flex items-center gap-2 px-6 py-3.5 rounded-lg text-[17.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors shadow-sm"
            >
              See how it works
            </motion.a>
          </motion.div>

          <motion.div
            variants={fadeUp}
            className="flex items-center gap-5 pt-3 text-[15.5px] text-slate-500 flex-wrap justify-center"
          >
            {[
              "No signup required",
              "MP4, MKV, MOV, WAV, MP3",
              "1080p avatar output",
            ].map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <Check size={15} strokeWidth={2.5} className="text-emerald-600" />
                {t}
              </span>
            ))}
          </motion.div>
        </motion.div>

        {/* Preview card */}
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="mt-16 mx-auto max-w-[1040px] relative"
        >
          {/* Floating decorative chips */}
          <motion.div
            initial={{ opacity: 0, x: -40, rotate: -12 }}
            animate={{ opacity: 1, x: 0, rotate: -8 }}
            transition={{ duration: 1, delay: 0.9, ease: [0.22, 1, 0.36, 1] }}
            className="absolute -left-6 -top-4 md:-left-12 md:-top-6 hidden md:flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-indigo-100 shadow-[0_8px_28px_-8px_rgba(79,70,229,0.25)] rotate-[-8deg] z-10"
          >
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white">
              <AudioLines size={13} strokeWidth={2} />
            </span>
            <span className="text-[13px] font-medium text-slate-700 nums">
              Transcribed · 72%
            </span>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, x: 40, rotate: 12 }}
            animate={{ opacity: 1, x: 0, rotate: 8 }}
            transition={{ duration: 1, delay: 1.1, ease: [0.22, 1, 0.36, 1] }}
            className="absolute -right-6 -bottom-4 md:-right-10 md:-bottom-8 hidden md:flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-emerald-100 shadow-[0_8px_28px_-8px_rgba(16,185,129,0.3)] rotate-[8deg] z-10"
          >
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white">
              <Check size={13} strokeWidth={2.5} />
            </span>
            <span className="text-[13px] font-medium text-slate-700">
              4 avatars ready
            </span>
          </motion.div>

          <div className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.05),_0_24px_56px_-24px_rgba(9,9,11,0.22),_0_0_0_1px_rgba(15,23,42,0.04)] overflow-hidden">
            <div className="flex items-center gap-3 px-5 h-11 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
              <span className="flex gap-1.5">
                <span className="w-3 h-3 rounded-full bg-slate-200" />
                <span className="w-3 h-3 rounded-full bg-slate-200" />
                <span className="w-3 h-3 rounded-full bg-slate-200" />
              </span>
              <span className="text-[14.5px] font-mono text-slate-500">
                chapter-ai.app / new
              </span>
              <motion.span
                animate={{ opacity: [1, 0.35, 1] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                className="ml-auto text-[13.5px] font-medium text-indigo-700 bg-gradient-to-br from-indigo-50 to-fuchsia-50 px-2 py-0.5 rounded-md border border-indigo-100/70"
              >
                Step 3 of 6
              </motion.span>
            </div>
            <PreviewBody />
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function PreviewBody() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-20% 0px" });
  const transcriptLines = [
    { time: "00:01:10", text: "Notice I'm using δ, not d — because Q and W are path-dependent." },
    { time: "00:01:20", text: "This distinction matters. A lot of textbook problems will trip you up." },
    { time: "00:01:37", text: "Alright. So today, we're going to reformulate U using enthalpy H." },
    { time: "00:01:44", text: "H ≡ U + PV. It's a convenience definition, but wildly useful." },
  ];

  return (
    <div
      ref={ref}
      className="p-8 md:p-10 grid grid-cols-1 md:grid-cols-[1fr_280px] gap-8"
    >
      <div className="flex flex-col gap-5">
        <div>
          <p className="text-[14.5px] text-slate-500 mb-1">Currently</p>
          <h3 className="text-[24px] font-semibold tracking-tight text-slate-900">
            Transcribing
          </h3>
          <p className="text-[16px] text-slate-500 mt-1">
            Speech to text with word-level timecodes
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-gradient-to-b from-slate-50/60 to-white p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
          <motion.div
            className="space-y-2.5 font-mono text-[15px]"
            variants={staggerParent}
            initial="hidden"
            animate={inView ? "visible" : "hidden"}
          >
            {transcriptLines.map((l) => (
              <motion.div key={l.time} variants={fadeUp} className="flex gap-3">
                <span className="text-indigo-600 shrink-0 font-semibold">
                  {l.time}
                </span>
                <span className="text-slate-700">{l.text}</span>
              </motion.div>
            ))}
          </motion.div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2 text-[14.5px] text-slate-600">
            <span>Progress</span>
            <span className="font-semibold text-slate-900 nums">72%</span>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={inView ? { width: "72%" } : { width: 0 }}
              transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
              className="h-full bg-gradient-to-r from-indigo-500 via-fuchsia-500 to-indigo-600 rounded-full shadow-[0_0_14px_rgba(99,102,241,0.55)]"
            />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-indigo-50/50 via-white to-fuchsia-50/30 p-5 flex flex-col gap-4 relative overflow-hidden">
        <div
          aria-hidden
          className="absolute -right-8 -top-8 w-24 h-24 rounded-full bg-gradient-to-br from-indigo-500/10 to-fuchsia-500/10 blur-xl"
        />
        <p className="relative text-[14.5px] text-slate-500">This run</p>
        <div className="relative">
          <div className="text-[40px] font-semibold nums leading-none text-slate-900">
            6
          </div>
          <p className="text-[15.5px] text-slate-500 mt-1.5">
            topic chunks planned
          </p>
        </div>
        <div className="relative">
          <div className="text-[30px] font-semibold nums leading-none bg-gradient-to-br from-indigo-600 to-fuchsia-600 bg-clip-text text-transparent">
            23.4%
          </div>
          <p className="text-[15.5px] text-slate-500 mt-1.5">filler to remove</p>
        </div>
        <div className="relative border-t border-slate-200 pt-4 flex items-center gap-2 text-[15.5px] text-slate-600">
          <Play size={13} strokeWidth={2.5} fill="currentColor" />
          4 avatars queued
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Stats strip — bento-ish with colored gradients + sparklines         */
/* ================================================================== */

function StatsStrip() {
  const stats = [
    {
      icon: Clock,
      value: 4200,
      suffix: " h",
      label: "of lecture time processed",
      from: "from-indigo-500",
      to: "to-blue-500",
      softFrom: "from-indigo-50",
      softTo: "to-blue-50",
      trend: [3, 4, 5, 6, 5, 7, 8, 7, 9, 10, 12, 14],
    },
    {
      icon: Users,
      value: 1284,
      suffix: "",
      label: "educators on the waitlist",
      from: "from-emerald-500",
      to: "to-teal-500",
      softFrom: "from-emerald-50",
      softTo: "to-teal-50",
      trend: [2, 3, 3, 4, 5, 6, 7, 9, 10, 11, 13, 15],
    },
    {
      icon: BarChart3,
      value: 23.4,
      suffix: "%",
      label: "filler removed on average",
      decimals: 1,
      from: "from-fuchsia-500",
      to: "to-rose-500",
      softFrom: "from-fuchsia-50",
      softTo: "to-rose-50",
      trend: [10, 9, 11, 10, 12, 11, 13, 12, 14, 13, 15, 14],
    },
    {
      icon: TrendingUp,
      value: 96,
      suffix: "%",
      label: "topic boundaries accepted",
      from: "from-amber-500",
      to: "to-orange-500",
      softFrom: "from-amber-50",
      softTo: "to-orange-50",
      trend: [6, 7, 8, 7, 9, 10, 11, 10, 12, 13, 14, 15],
    },
  ];

  return (
    <section className="border-y border-slate-200 bg-white relative overflow-hidden">
      <div className="max-w-6xl mx-auto px-6 py-16 md:py-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"
        >
          {stats.map((s, i) => (
            <StatItem key={s.label} {...s} delay={i * 0.08} />
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function StatItem({
  icon: Icon,
  value,
  suffix,
  label,
  decimals = 0,
  delay = 0,
  from,
  to,
  softFrom,
  softTo,
  trend,
}: {
  icon: typeof Clock;
  value: number;
  suffix: string;
  label: string;
  decimals?: number;
  delay?: number;
  from: string;
  to: string;
  softFrom: string;
  softTo: string;
  trend: number[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-20% 0px" });
  const [display, setDisplay] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setDisplay(value);
      return;
    }
    const startTime = performance.now() + delay * 1000;
    const duration = 1400;
    let raf = 0;
    function tick(now: number) {
      const elapsed = Math.max(0, now - startTime);
      const t = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value, delay, reduce]);

  const formatted =
    decimals > 0
      ? display.toFixed(decimals)
      : Math.round(display).toLocaleString();

  // Build sparkline path
  const w = 100;
  const h = 36;
  const max = Math.max(...trend);
  const step = w / (trend.length - 1);
  const path = trend
    .map((v, i) => {
      const x = (i * step).toFixed(2);
      const y = (h - (v / max) * h * 0.9 - 2).toFixed(2);
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  return (
    <motion.div
      ref={ref}
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
      className={`group relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br ${softFrom} via-white ${softTo} p-5 shadow-[0_1px_2px_rgba(9,9,11,0.04)] hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_16px_40px_-16px_rgba(15,23,42,0.2)] transition-shadow`}
    >
      {/* Corner glow */}
      <div
        aria-hidden
        className={`absolute -right-10 -top-10 w-28 h-28 rounded-full bg-gradient-to-br ${from} ${to} opacity-20 blur-2xl`}
      />

      <div className="relative flex items-start justify-between mb-4">
        <span
          className={`flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
        >
          <Icon size={19} strokeWidth={2} />
        </span>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="w-20 h-9 opacity-80"
          aria-hidden
        >
          <defs>
            <linearGradient id={`grad-${label}`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.1" />
              <stop offset="100%" stopColor="currentColor" />
            </linearGradient>
          </defs>
          <path
            d={path}
            fill="none"
            stroke={`url(#grad-${label})`}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className={
              from.includes("indigo")
                ? "text-indigo-500"
                : from.includes("emerald")
                  ? "text-emerald-500"
                  : from.includes("fuchsia")
                    ? "text-fuchsia-500"
                    : "text-amber-500"
            }
          />
        </svg>
      </div>

      <div className="relative flex items-baseline gap-1">
        <span className="text-[36px] md:text-[40px] font-semibold nums leading-none tracking-tight text-slate-900">
          {formatted}
        </span>
        <span className="text-[20px] font-semibold text-slate-900">
          {suffix}
        </span>
      </div>
      <p className="relative text-[15px] text-slate-600 leading-relaxed mt-2.5">
        {label}
      </p>
    </motion.div>
  );
}

/* ================================================================== */
/* Universities strip — "trusted by" social proof                      */
/* ================================================================== */

function UniversitiesStrip() {
  const unis = [
    { name: "Stanford",   acronym: "Stanford",  hue: 0   },
    { name: "MIT",        acronym: "MIT",       hue: 220 },
    { name: "Caltech",    acronym: "Caltech",   hue: 40  },
    { name: "UC Berkeley", acronym: "Berkeley", hue: 45  },
    { name: "Oxford",     acronym: "Oxford",    hue: 230 },
    { name: "ETH Zurich", acronym: "ETH",       hue: 355 },
    { name: "NUS",        acronym: "NUS",       hue: 340 },
    { name: "IIT Bombay", acronym: "IITB",      hue: 210 },
  ];
  return (
    <section className="border-b border-slate-200 bg-white">
      <div className="max-w-6xl mx-auto px-6 py-12 md:py-14">
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5 }}
          className="text-center text-[13px] font-semibold uppercase tracking-[0.15em] text-slate-500 flex items-center justify-center gap-2 mb-7"
        >
          <GraduationCap size={14} strokeWidth={2} />
          Trusted by educators at
        </motion.p>
        <motion.div
          variants={staggerParent}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4 items-center"
        >
          {unis.map((u) => (
            <motion.div
              key={u.name}
              variants={fadeUp}
              whileHover={{ y: -3, scale: 1.04 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
              className="flex flex-col items-center gap-2 group"
              title={u.name}
            >
              <span
                className="flex items-center justify-center w-12 h-12 rounded-xl text-white text-[13.5px] font-semibold tracking-tight shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_2px_8px_-2px_rgba(15,23,42,0.2)] opacity-80 group-hover:opacity-100 transition-opacity"
                style={{
                  backgroundImage: `linear-gradient(135deg, hsl(${u.hue} 40% 30%), hsl(${(u.hue + 30) % 360} 45% 18%))`,
                }}
              >
                {u.acronym.slice(0, 4)}
              </span>
              <span className="text-[12.5px] text-slate-500 font-medium group-hover:text-slate-900 transition-colors text-center truncate max-w-full">
                {u.name}
              </span>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ================================================================== */
/* Before / after — side-by-side comparison                            */
/* ================================================================== */

function BeforeAfter() {
  return (
    <section className="border-b border-slate-200 bg-white">
      <div className="max-w-6xl mx-auto px-6 py-20 md:py-24">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12 max-w-2xl mx-auto"
        >
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-br from-indigo-50 to-fuchsia-50 border border-indigo-100/70 text-indigo-700 text-[13.5px] font-semibold uppercase tracking-wide">
            <Sparkles size={12} strokeWidth={2.2} />
            Before / after
          </span>
          <h2 className="text-[36px] md:text-[44px] font-semibold leading-[1.05] tracking-[-0.03em] text-slate-900 mt-3">
            One long recording.{" "}
            <span className="text-slate-500">Six focused clips.</span>
          </h2>
          <p className="text-[17px] text-slate-600 leading-relaxed mt-3">
            The same lecture, rebuilt for how people actually watch educational
            content.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* BEFORE */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.6 }}
            className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50/60 via-white to-slate-50/40 p-6 shadow-[0_1px_2px_rgba(9,9,11,0.04)]"
          >
            <div className="flex items-center justify-between mb-5">
              <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 text-[12.5px] font-semibold uppercase tracking-wide">
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-300 text-slate-700">
                  <X size={11} strokeWidth={2.4} />
                </span>
                Before
              </span>
              <span className="text-[12px] font-mono text-slate-400">
                Original lecture
              </span>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-900 aspect-video relative overflow-hidden mb-4">
              <div
                aria-hidden
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(135deg, #1e293b, #0f172a)",
                }}
              />
              <div
                aria-hidden
                className="absolute inset-0 opacity-40"
                style={{
                  backgroundImage:
                    "radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)",
                  backgroundSize: "20px 20px",
                }}
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="flex items-center justify-center w-14 h-14 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white">
                  <Play size={18} strokeWidth={0} fill="currentColor" className="ml-0.5" />
                </span>
              </div>
              <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/60 to-transparent">
                <div className="flex items-center gap-2 text-white/80 text-[11.5px] font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                  00:00:00 / 05:42:18
                </div>
                <div className="mt-1.5 h-1 bg-white/15 rounded-full overflow-hidden">
                  <div className="h-full w-0 bg-white/50" />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <BAStat label="Length" value="5h 42m" tone="neutral" />
              <BAStat label="Filler" value="23.4%" tone="negative" />
              <BAStat label="Topics" value="Mixed" tone="neutral" />
            </div>
            <ul className="text-[13.5px] text-slate-600 space-y-1.5">
              <li className="flex items-start gap-2">
                <X size={13} strokeWidth={2.4} className="text-rose-500 mt-0.5 shrink-0" />
                Admin chatter and off-topic tangents mixed in
              </li>
              <li className="flex items-start gap-2">
                <X size={13} strokeWidth={2.4} className="text-rose-500 mt-0.5 shrink-0" />
                Students have to scrub to find their topic
              </li>
              <li className="flex items-start gap-2">
                <X size={13} strokeWidth={2.4} className="text-rose-500 mt-0.5 shrink-0" />
                Hard to share specific moments
              </li>
            </ul>
          </motion.div>

          {/* AFTER */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.6, delay: 0.15 }}
            className="relative overflow-hidden rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50/60 via-white to-emerald-50/40 p-6 shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_20px_48px_-20px_rgba(99,102,241,0.3)]"
          >
            <div
              aria-hidden
              className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-indigo-500/15 via-fuchsia-500/10 to-emerald-500/15 blur-3xl"
            />
            <div className="relative flex items-center justify-between mb-5">
              <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-gradient-to-br from-emerald-50 to-teal-50 text-emerald-700 border border-emerald-100 text-[12.5px] font-semibold uppercase tracking-wide">
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                  <Check size={11} strokeWidth={2.8} />
                </span>
                After
              </span>
              <span className="text-[12px] font-mono text-slate-500">
                6 × 20-min clips
              </span>
            </div>

            {/* Grid of 6 mini video tiles */}
            <div className="relative grid grid-cols-3 gap-2 mb-4">
              {[
                { hue: 220, label: "01 · Recap" },
                { hue: 260, label: "02 · Enthalpy" },
                { hue: 300, label: "03 · Mayer" },
                { hue: 340, label: "04 · 2nd law" },
                { hue: 20,  label: "05 · Reversible" },
                { hue: 160, label: "06 · Closing" },
              ].map((t, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, scale: 0.95 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{
                    duration: 0.4,
                    delay: 0.2 + i * 0.08,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="rounded-lg aspect-video relative overflow-hidden border border-white/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_2px_8px_-2px_rgba(15,23,42,0.2)]"
                  style={{
                    backgroundImage: `linear-gradient(135deg, hsl(${t.hue} 65% 40%), hsl(${(t.hue + 30) % 360} 70% 22%))`,
                  }}
                >
                  <div
                    aria-hidden
                    className="absolute inset-0 opacity-30"
                    style={{
                      background:
                        "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.55), transparent 50%)",
                    }}
                  />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="flex items-center justify-center w-7 h-7 rounded-full bg-white/25 backdrop-blur-sm text-white">
                      <Play size={10} strokeWidth={0} fill="currentColor" className="ml-0.5" />
                    </span>
                  </div>
                  <div className="absolute left-1.5 bottom-1 right-1.5 text-[9.5px] font-mono text-white/85 font-semibold truncate">
                    {t.label}
                  </div>
                </motion.div>
              ))}
            </div>

            <div className="relative grid grid-cols-3 gap-3 mb-4">
              <BAStat label="Each" value="~19 min" tone="positive" />
              <BAStat label="Filler" value="0%" tone="positive" />
              <BAStat label="Topics" value="6 focused" tone="positive" />
            </div>
            <ul className="relative text-[13.5px] text-slate-700 space-y-1.5">
              <li className="flex items-start gap-2">
                <Check size={13} strokeWidth={2.6} className="text-emerald-600 mt-0.5 shrink-0" />
                Every chunk stays on topic end-to-end
              </li>
              <li className="flex items-start gap-2">
                <Check size={13} strokeWidth={2.6} className="text-emerald-600 mt-0.5 shrink-0" />
                Students watch the part they need
              </li>
              <li className="flex items-start gap-2">
                <Check size={13} strokeWidth={2.6} className="text-emerald-600 mt-0.5 shrink-0" />
                Each clip is individually shareable
              </li>
            </ul>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function BAStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "positive" | "negative" | "neutral";
}) {
  const valueCls =
    tone === "positive"
      ? "text-emerald-700"
      : tone === "negative"
        ? "text-rose-700"
        : "text-slate-900";
  const bgCls =
    tone === "positive"
      ? "bg-gradient-to-br from-emerald-50 to-teal-50/60 border-emerald-100/70"
      : tone === "negative"
        ? "bg-gradient-to-br from-rose-50 to-red-50/60 border-rose-100/70"
        : "bg-white border-slate-200";
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${bgCls}`}
    >
      <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wide">
        {label}
      </p>
      <p className={`text-[15px] font-semibold nums mt-0.5 ${valueCls}`}>
        {value}
      </p>
    </div>
  );
}

/* ================================================================== */
/* Pipeline viz — rainbow nodes + time labels + gradient path          */
/* ================================================================== */

function PipelineViz() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: false, margin: "-30% 0px" });

  const nodes = [
    { label: "Upload",     time: "< 1 min", icon: UploadCloud,  from: "from-indigo-500",  to: "to-blue-500"    },
    { label: "Audio",      time: "~2 min",  icon: FileVideo,    from: "from-blue-500",    to: "to-cyan-500"    },
    { label: "Transcript", time: "~8 min",  icon: AudioLines,   from: "from-violet-500",  to: "to-purple-500"  },
    { label: "Clean",      time: "~3 min",  icon: Sparkles,     from: "from-fuchsia-500", to: "to-pink-500"    },
    { label: "Split",      time: "~1 min",  icon: Scissors,     from: "from-rose-500",    to: "to-orange-500"  },
    { label: "Render",     time: "~14 min", icon: Clapperboard, from: "from-emerald-500", to: "to-teal-500"    },
  ];

  return (
    <section className="border-b border-slate-200 bg-slate-50/60 relative overflow-hidden">
      {/* Soft gradient wash */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-60"
        style={{
          background:
            "radial-gradient(50% 60% at 50% 0%, rgba(99,102,241,0.08) 0%, transparent 60%)",
        }}
      />
      <div ref={ref} className="relative max-w-6xl mx-auto px-6 py-20 md:py-24">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-14 max-w-2xl mx-auto"
        >
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-br from-indigo-50 to-fuchsia-50 border border-indigo-100/70 text-indigo-700 text-[13.5px] font-semibold uppercase tracking-wide">
            <Zap size={12} strokeWidth={2.2} />
            Pipeline
          </span>
          <h2 className="text-[36px] md:text-[44px] font-semibold leading-[1.05] tracking-[-0.03em] text-slate-900 mt-3">
            Watch one recording flow through six stages.
          </h2>
        </motion.div>

        <div className="relative">
          {/* Gradient connecting path — desktop */}
          <svg
            className="absolute top-8 left-0 right-0 w-full h-0.5 hidden md:block"
            viewBox="0 0 100 1"
            preserveAspectRatio="none"
            aria-hidden
          >
            <defs>
              <linearGradient id="pipe-grad" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="#6366f1" />
                <stop offset="25%" stopColor="#8b5cf6" />
                <stop offset="50%" stopColor="#d946ef" />
                <stop offset="75%" stopColor="#f43f5e" />
                <stop offset="100%" stopColor="#10b981" />
              </linearGradient>
            </defs>
            <line x1="3" x2="97" y1="0.5" y2="0.5" stroke="url(#pipe-grad)" strokeWidth="0.08" />
          </svg>

          {/* Traveling dot with glow trail */}
          {inView && (
            <motion.div
              aria-hidden
              className="absolute top-[26px] w-5 h-5 hidden md:block"
              animate={{
                left: ["2%", "98%"],
                opacity: [0, 1, 1, 1, 0],
              }}
              transition={{
                duration: 4.5,
                repeat: Infinity,
                ease: "linear",
                times: [0, 0.05, 0.5, 0.95, 1],
              }}
            >
              <span className="block w-5 h-5 rounded-full bg-gradient-to-br from-white to-indigo-300 shadow-[0_0_20px_6px_rgba(99,102,241,0.8),_0_0_40px_12px_rgba(217,70,239,0.5)]" />
            </motion.div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-6 gap-6 md:gap-4 relative">
            {nodes.map((n, i) => (
              <PipelineNode key={n.label} {...n} index={i} inView={inView} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function PipelineNode({
  label,
  time,
  icon: Icon,
  from,
  to,
  index,
  inView,
}: {
  label: string;
  time: string;
  icon: typeof Clock;
  from: string;
  to: string;
  index: number;
  inView: boolean;
}) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!inView) return;
    const cycleMs = 4500;
    const phase = (index / 6) * cycleMs;

    const pulse = () => {
      setActive(true);
      window.setTimeout(() => setActive(false), 500);
    };

    const first = window.setTimeout(pulse, phase);
    const repeat = window.setInterval(pulse, cycleMs);

    return () => {
      window.clearTimeout(first);
      window.clearInterval(repeat);
    };
  }, [inView, index]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, delay: index * 0.06 }}
      className="flex flex-col items-center text-center gap-3 relative"
    >
      <motion.span
        className={`flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br ${from} ${to} text-white relative z-10 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_6px_20px_-6px_rgba(15,23,42,0.3)]`}
        animate={active ? { scale: [1, 1.14, 1] } : { scale: 1 }}
        transition={{ duration: 0.5, ease: "easeInOut" }}
      >
        <Icon size={22} strokeWidth={2} />
        <AnimatePresence>
          {active && (
            <motion.span
              initial={{ opacity: 0.8, scale: 0.8 }}
              animate={{ opacity: 0, scale: 1.8 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7, ease: "easeOut" }}
              className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${from} ${to}`}
            />
          )}
        </AnimatePresence>
      </motion.span>
      <div>
        <p className="text-[13px] font-mono text-slate-400 nums leading-none mb-1">
          0{index + 1}
        </p>
        <p className="text-[16.5px] font-semibold text-slate-900 leading-tight">
          {label}
        </p>
        <p className="text-[13px] text-slate-500 nums mt-1">{time}</p>
      </div>
    </motion.div>
  );
}

/* ================================================================== */
/* Features — bento with visual previews                               */
/* ================================================================== */

function Features() {
  return (
    <section id="features" className="bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-20 md:py-24">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-14 max-w-2xl mx-auto"
        >
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-br from-indigo-50 to-fuchsia-50 border border-indigo-100/70 text-indigo-700 text-[13.5px] font-semibold uppercase tracking-wide">
            <Sparkles size={12} strokeWidth={2.2} />
            Features
          </span>
          <h2 className="text-[36px] md:text-[44px] font-semibold leading-[1.05] tracking-[-0.03em] text-slate-900 mt-3">
            Built for the way lectures actually happen.
          </h2>
        </motion.div>

        <motion.div
          variants={staggerParent}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          className="grid grid-cols-1 md:grid-cols-3 gap-5 auto-rows-auto"
        >
          {/* Large — Live transcription preview */}
          <motion.div
            variants={fadeUp}
            whileHover={{ y: -3 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="md:col-span-2 md:row-span-2 group relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-indigo-50/40 via-white to-fuchsia-50/40 p-7 shadow-[0_1px_2px_rgba(9,9,11,0.04)] hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_20px_48px_-20px_rgba(99,102,241,0.3)] transition-shadow"
          >
            <div
              aria-hidden
              className="absolute -right-16 -bottom-16 w-64 h-64 rounded-full bg-gradient-to-br from-indigo-500/10 to-fuchsia-500/10 blur-3xl"
            />
            <div className="relative flex flex-col gap-4 h-full">
              <div className="flex items-start justify-between">
                <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_rgba(99,102,241,0.35)]">
                  <AudioLines size={22} strokeWidth={2} />
                </span>
                <span className="text-[12.5px] font-mono text-slate-400 nums">
                  FEATURE
                </span>
              </div>
              <div>
                <p className="text-[14.5px] text-indigo-700 font-medium mb-1.5">
                  Faster
                </p>
                <h3 className="text-[26px] font-semibold tracking-tight text-slate-900 leading-snug">
                  Real-time streaming transcription
                </h3>
                <p className="text-[16.5px] text-slate-600 leading-relaxed mt-2 max-w-md">
                  Watch words arrive as they&apos;re transcribed. Word-level
                  timecodes, multi-speaker diarization, and live progress —
                  you&apos;re never stuck waiting.
                </p>
              </div>

              <MiniTranscriptPreview />
            </div>
          </motion.div>

          {/* Small — Cleaner */}
          <motion.div
            variants={fadeUp}
            whileHover={{ y: -3 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-emerald-50/50 via-white to-teal-50/30 p-6 shadow-[0_1px_2px_rgba(9,9,11,0.04)] hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_16px_40px_-16px_rgba(16,185,129,0.3)] transition-shadow"
          >
            <div className="flex flex-col gap-3.5 h-full">
              <span className="flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_rgba(16,185,129,0.3)]">
                <Sparkles size={19} strokeWidth={2} />
              </span>
              <div>
                <p className="text-[14.5px] text-emerald-700 font-medium mb-1">
                  Cleaner
                </p>
                <h3 className="text-[21px] font-semibold text-slate-900 leading-tight">
                  Filler removed
                </h3>
              </div>
              <MiniDiffPreview />
            </div>
          </motion.div>

          {/* Small — Structured */}
          <motion.div
            variants={fadeUp}
            whileHover={{ y: -3 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-fuchsia-50/40 via-white to-rose-50/30 p-6 shadow-[0_1px_2px_rgba(9,9,11,0.04)] hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_16px_40px_-16px_rgba(217,70,239,0.3)] transition-shadow"
          >
            <div className="flex flex-col gap-3.5 h-full">
              <span className="flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-fuchsia-500 to-rose-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_rgba(217,70,239,0.3)]">
                <Scissors size={19} strokeWidth={2} />
              </span>
              <div>
                <p className="text-[14.5px] text-fuchsia-700 font-medium mb-1">
                  Structured
                </p>
                <h3 className="text-[21px] font-semibold text-slate-900 leading-tight">
                  20-minute chunks
                </h3>
              </div>
              <MiniSegmentsPreview />
            </div>
          </motion.div>

          {/* Wide — Shareable */}
          <motion.div
            variants={fadeUp}
            whileHover={{ y: -3 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="md:col-span-3 group relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-amber-50/40 via-white to-orange-50/30 p-6 md:p-7 shadow-[0_1px_2px_rgba(9,9,11,0.04)] hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_16px_40px_-16px_rgba(245,158,11,0.3)] transition-shadow"
          >
            <div className="flex flex-col md:flex-row items-start md:items-center gap-6 h-full">
              <div className="flex flex-col gap-3 max-w-sm">
                <span className="flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_rgba(245,158,11,0.3)]">
                  <Clapperboard size={19} strokeWidth={2} />
                </span>
                <div>
                  <p className="text-[14.5px] text-amber-700 font-medium mb-1">
                    Shareable
                  </p>
                  <h3 className="text-[22px] font-semibold text-slate-900 leading-tight">
                    1080p avatar videos, six presenters
                  </h3>
                </div>
                <p className="text-[15.5px] text-slate-600 leading-relaxed">
                  Pick a narrator style, a voice model, and we render each
                  chunk as a standalone video.
                </p>
              </div>
              <MiniAvatarRow />
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

function MiniTranscriptPreview() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-20% 0px" });
  const lines = [
    { time: "00:01:10", text: "Notice I'm using δ, not d — Q and W are path-dependent." },
    { time: "00:01:20", text: "A lot of textbook problems will trip you up on this." },
    { time: "00:01:37", text: "Today, we're going to reformulate U using enthalpy H." },
    { time: "00:01:44", text: "H ≡ U + PV — convenience definition, wildly useful." },
  ];
  return (
    <div
      ref={ref}
      className="mt-auto rounded-xl border border-slate-200 bg-white/80 backdrop-blur overflow-hidden"
    >
      <div className="flex items-center gap-2 px-4 h-9 border-b border-slate-100 bg-slate-50/60">
        <motion.span
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ duration: 1.4, repeat: Infinity }}
          className="w-2 h-2 rounded-full bg-indigo-500"
        />
        <span className="text-[12.5px] font-mono text-slate-500">
          streaming · whisper-large-v3
        </span>
        <span className="ml-auto text-[12px] font-mono text-indigo-600 font-semibold">
          72%
        </span>
      </div>
      <motion.div
        variants={staggerParent}
        initial="hidden"
        animate={inView ? "visible" : "hidden"}
        className="px-4 py-3 space-y-2 font-mono text-[13.5px]"
      >
        {lines.map((l) => (
          <motion.div key={l.time} variants={fadeUp} className="flex gap-3">
            <span className="text-indigo-600 shrink-0 font-semibold">
              {l.time}
            </span>
            <span className="text-slate-700 truncate">{l.text}</span>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}

function MiniDiffPreview() {
  return (
    <div className="mt-auto rounded-xl border border-slate-200 bg-white/80 backdrop-blur overflow-hidden text-[13px] font-mono leading-[1.6]">
      <div className="px-3.5 py-1.5 border-b border-slate-100 bg-slate-50/60 text-[11.5px] text-slate-500 font-mono flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        before / after
      </div>
      <div className="px-3.5 py-3">
        <span className="bg-red-50 text-red-700 line-through decoration-red-400/60 px-1 rounded-sm">
          Uh, can everyone hear me at the back?
        </span>{" "}
        Alright, let&apos;s begin Lecture 4. Today we&apos;re going to pick up
        where we left off on{" "}
        <span className="bg-red-50 text-red-700 line-through decoration-red-400/60 px-1 rounded-sm">
          — uh, quick note, the midterm
        </span>
        . Recall from last time…
      </div>
    </div>
  );
}

function MiniSegmentsPreview() {
  const segments = [
    { len: 18, color: "from-indigo-400 to-indigo-500" },
    { len: 22, color: "from-violet-400 to-violet-500" },
    { len: 20, color: "from-fuchsia-400 to-fuchsia-500" },
    { len: 19, color: "from-rose-400 to-rose-500" },
    { len: 21, color: "from-orange-400 to-orange-500" },
    { len: 14, color: "from-emerald-400 to-emerald-500" },
  ];
  const total = segments.reduce((a, s) => a + s.len, 0);
  return (
    <div className="mt-auto flex flex-col gap-3">
      <div className="flex h-10 rounded-lg overflow-hidden border border-slate-200">
        {segments.map((s, i) => (
          <motion.div
            key={i}
            initial={{ width: 0 }}
            whileInView={{ width: `${(s.len / total) * 100}%` }}
            viewport={{ once: true }}
            transition={{
              duration: 0.8,
              delay: 0.1 + i * 0.08,
              ease: [0.22, 1, 0.36, 1],
            }}
            className={`h-full bg-gradient-to-br ${s.color}`}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-[12.5px] font-mono text-slate-500 nums">
        <span>00:00</span>
        <span className="text-slate-900 font-semibold">6 chunks</span>
        <span>01:54</span>
      </div>
    </div>
  );
}

function MiniAvatarRow() {
  const avatars = [
    { initial: "A", hue: 220, label: "Atlas" },
    { initial: "N", hue: 15,  label: "Nova"  },
    { initial: "S", hue: 160, label: "Sage"  },
    { initial: "K", hue: 280, label: "Kai"   },
    { initial: "J", hue: 45,  label: "Juno"  },
    { initial: "R", hue: 190, label: "River" },
  ];
  return (
    <div className="flex-1 flex flex-wrap items-center gap-3 md:gap-4">
      {avatars.map((a, i) => (
        <motion.div
          key={a.label}
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.4, delay: 0.05 + i * 0.06 }}
          whileHover={{ y: -3, scale: 1.04 }}
          className="flex flex-col items-center gap-1.5"
        >
          <span
            className="flex items-center justify-center w-14 h-14 md:w-16 md:h-16 rounded-2xl text-white text-[22px] font-semibold shadow-[0_6px_18px_-6px_rgba(15,23,42,0.3)]"
            style={{
              backgroundImage: `linear-gradient(135deg, hsl(${a.hue} 75% 52%), hsl(${(a.hue + 30) % 360} 75% 38%))`,
            }}
          >
            {a.initial}
          </span>
          <span className="text-[12px] font-medium text-slate-600">
            {a.label}
          </span>
        </motion.div>
      ))}
    </div>
  );
}

/* ================================================================== */
/* How it works — gradient numbered badges + colored top borders       */
/* ================================================================== */

function HowItWorks() {
  const steps = [
    { n: "01", title: "Upload",     desc: "Drop a video or audio file. MP4, MKV, MOV, WAV, MP3 — any duration.",        icon: UploadCloud,  from: "from-indigo-500",  to: "to-blue-500"    },
    { n: "02", title: "Audio",      desc: "We extract a clean 48 kHz mono track. The original video is released.",     icon: FileVideo,    from: "from-blue-500",    to: "to-cyan-500"    },
    { n: "03", title: "Transcript", desc: "High-accuracy speech-to-text with word-level timecodes and diarization.",    icon: AudioLines,   from: "from-violet-500",  to: "to-purple-500"  },
    { n: "04", title: "Clean",      desc: "Filler words, admin chatter, and off-topic tangents are removed.",           icon: Sparkles,     from: "from-fuchsia-500", to: "to-pink-500"    },
    { n: "05", title: "Split",      desc: "Topic-model finds natural breaks and splits into ~20-minute chunks.",         icon: Scissors,     from: "from-rose-500",    to: "to-orange-500"  },
    { n: "06", title: "Render",     desc: "Each chunk is narrated by your chosen avatar. 1080p · 24 fps.",              icon: Clapperboard, from: "from-emerald-500", to: "to-teal-500"    },
  ];

  return (
    <section
      id="how"
      className="scroll-mt-20 bg-gradient-to-b from-slate-50/50 via-white to-slate-50/50 border-b border-slate-200 relative"
    >
      <div className="max-w-6xl mx-auto px-6 py-20 md:py-24">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="flex flex-col items-center text-center gap-4 mb-14 max-w-2xl mx-auto"
        >
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-br from-indigo-50 to-fuchsia-50 border border-indigo-100/70 text-indigo-700 text-[13.5px] font-semibold uppercase tracking-wide">
            <Zap size={12} strokeWidth={2.2} />
            How it works
          </span>
          <h2 className="text-[40px] md:text-[52px] font-semibold leading-[1.05] tracking-[-0.03em] text-slate-900">
            Six steps. One wizard.
          </h2>
          <p className="text-[19px] text-slate-600 leading-relaxed">
            Every stage is visible. Watch the transcript stream in, fine-tune
            the cleanup, and choose your avatar before rendering.
          </p>
        </motion.div>

        <motion.div
          variants={staggerParent}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5"
        >
          {steps.map(({ n, title, desc, icon: Icon, from, to }) => (
            <motion.div
              key={n}
              variants={fadeUp}
              whileHover={{ y: -4 }}
              transition={{ type: "spring", stiffness: 320, damping: 20 }}
              className="group relative overflow-hidden rounded-2xl bg-white border border-slate-200 shadow-[0_1px_2px_rgba(9,9,11,0.04)] hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_16px_40px_-16px_rgba(15,23,42,0.2)] transition-shadow"
            >
              {/* Colored top strip */}
              <span
                className={`block h-1 bg-gradient-to-r ${from} ${to}`}
                aria-hidden
              />
              {/* Soft bg blob */}
              <div
                aria-hidden
                className={`absolute -right-12 -top-12 w-36 h-36 rounded-full bg-gradient-to-br ${from} ${to} opacity-10 blur-2xl`}
              />
              <div className="relative p-6 flex flex-col gap-3.5">
                <div className="flex items-start justify-between">
                  <motion.span
                    whileHover={{ rotate: 6, scale: 1.04 }}
                    transition={{ type: "spring", stiffness: 400, damping: 14 }}
                    className={`flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(15,23,42,0.25)]`}
                  >
                    <Icon size={21} strokeWidth={2} />
                  </motion.span>
                  <span
                    className={`text-[28px] font-semibold leading-none nums bg-gradient-to-br ${from} ${to} bg-clip-text text-transparent`}
                  >
                    {n}
                  </span>
                </div>
                <h3 className="text-[22px] font-semibold text-slate-900 leading-tight">
                  {title}
                </h3>
                <p className="text-[16.5px] text-slate-600 leading-relaxed">
                  {desc}
                </p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ================================================================== */
/* Testimonials — 3-up with featured middle                            */
/* ================================================================== */

function Testimonial() {
  const testimonials = [
    {
      quote:
        "Finally, I can share last year's best lectures with this year's class without re-recording. The 20-minute chunks are perfect — students actually watch them.",
      name: "Dr. R. Okonkwo",
      title: "Mathematics, City College",
      initials: "RO",
      rating: 5,
      gradient: "from-emerald-500 to-teal-500",
    },
    {
      quote:
        "I was recording the same twelve thermodynamics lectures every spring. Course Generator AI cut that to zero — my students got shorter, sharper versions of last year's recordings within a day.",
      name: "Prof. I. Saksena",
      title: "Chemical Engineering, State University",
      initials: "IS",
      rating: 5,
      gradient: "from-indigo-500 via-fuchsia-500 to-rose-500",
      featured: true,
    },
    {
      quote:
        "The transcript cleanup is so good I use it just for lecture notes now. Students get a pristine transcript alongside every video.",
      name: "Prof. M. Alvarez",
      title: "Computer Science, Tech Institute",
      initials: "MA",
      rating: 5,
      gradient: "from-fuchsia-500 to-rose-500",
    },
  ];

  return (
    <section id="testimonial" className="bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-20 md:py-24">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-14 max-w-2xl mx-auto"
        >
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-br from-indigo-50 to-fuchsia-50 border border-indigo-100/70 text-indigo-700 text-[13.5px] font-semibold uppercase tracking-wide">
            <Quote size={12} strokeWidth={2.2} />
            Stories
          </span>
          <h2 className="text-[36px] md:text-[44px] font-semibold leading-[1.05] tracking-[-0.03em] text-slate-900 mt-3">
            Educators are already saving days.
          </h2>
        </motion.div>

        <motion.div
          variants={staggerParent}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          className="grid grid-cols-1 md:grid-cols-3 gap-5 items-stretch"
        >
          {testimonials.map((t, i) => (
            <motion.blockquote
              key={t.name}
              variants={fadeUp}
              whileHover={{ y: -4 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
              className={`group relative overflow-hidden rounded-2xl border bg-white p-6 md:p-7 flex flex-col gap-5 ${
                t.featured
                  ? "md:scale-[1.02] md:-translate-y-2 border-indigo-200 shadow-[0_4px_12px_rgba(79,70,229,0.08),_0_24px_56px_-16px_rgba(79,70,229,0.25)]"
                  : "border-slate-200 shadow-[0_1px_2px_rgba(9,9,11,0.04)] hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_16px_40px_-16px_rgba(15,23,42,0.2)]"
              } transition-shadow`}
            >
              {t.featured && (
                <div
                  aria-hidden
                  className="absolute -right-20 -top-20 w-56 h-56 rounded-full bg-gradient-to-br from-indigo-500/15 via-fuchsia-500/10 to-rose-500/10 blur-3xl"
                />
              )}
              <div className="relative flex items-start justify-between">
                <span
                  className={`flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${t.gradient} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
                >
                  <Quote size={17} strokeWidth={2} />
                </span>
                <span className="flex items-center gap-0.5 text-amber-500">
                  {[...Array(t.rating)].map((_, j) => (
                    <motion.span
                      key={j}
                      initial={{ opacity: 0, scale: 0 }}
                      whileInView={{ opacity: 1, scale: 1 }}
                      viewport={{ once: true }}
                      transition={{
                        duration: 0.3,
                        delay: 0.4 + i * 0.15 + j * 0.06,
                      }}
                    >
                      <Star size={14} strokeWidth={0} fill="currentColor" />
                    </motion.span>
                  ))}
                </span>
              </div>

              <p
                className={`relative ${
                  t.featured
                    ? "text-[19px] md:text-[20px]"
                    : "text-[17px]"
                } leading-[1.45] tracking-tight text-slate-800 font-medium`}
              >
                “{t.quote}”
              </p>

              <div className="relative mt-auto flex items-center gap-3 pt-4 border-t border-slate-100">
                <span
                  className={`flex items-center justify-center w-11 h-11 rounded-full bg-gradient-to-br ${t.gradient} text-white text-[15px] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_10px_-2px_rgba(15,23,42,0.25)]`}
                >
                  {t.initials}
                </span>
                <div>
                  <p className="text-[15.5px] font-semibold text-slate-900 leading-tight">
                    {t.name}
                  </p>
                  <p className="text-[13.5px] text-slate-500 mt-0.5">
                    {t.title}
                  </p>
                </div>
              </div>
            </motion.blockquote>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ================================================================== */
/* Final CTA — cinematic gradient + floating cards                     */
/* ================================================================== */

function FinalCTA() {
  return (
    <section className="relative overflow-hidden bg-slate-950 text-white">
      {/* Mesh gradient backdrop */}
      <motion.div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-85"
        animate={{
          background: [
            "radial-gradient(40% 50% at 15% 100%, rgba(99,102,241,0.5) 0%, transparent 60%), radial-gradient(35% 40% at 80% 0%, rgba(16,185,129,0.3) 0%, transparent 60%), radial-gradient(40% 40% at 75% 80%, rgba(217,70,239,0.25) 0%, transparent 60%)",
            "radial-gradient(40% 50% at 80% 100%, rgba(99,102,241,0.5) 0%, transparent 60%), radial-gradient(35% 40% at 15% 0%, rgba(16,185,129,0.3) 0%, transparent 60%), radial-gradient(40% 40% at 30% 80%, rgba(217,70,239,0.25) 0%, transparent 60%)",
            "radial-gradient(40% 50% at 15% 100%, rgba(99,102,241,0.5) 0%, transparent 60%), radial-gradient(35% 40% at 80% 0%, rgba(16,185,129,0.3) 0%, transparent 60%), radial-gradient(40% 40% at 75% 80%, rgba(217,70,239,0.25) 0%, transparent 60%)",
          ],
        }}
        transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* Dot grid */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.3] pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      {/* Floating decorative cards */}
      <motion.div
        initial={{ opacity: 0, y: 20, rotate: -10 }}
        whileInView={{ opacity: 1, y: 0, rotate: -6 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
        className="absolute left-6 md:left-16 bottom-28 md:bottom-32 hidden sm:flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white/10 backdrop-blur-xl border border-white/15 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.4)] rotate-[-6deg]"
      >
        <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-500 text-white">
          <Check size={13} strokeWidth={2.5} />
        </span>
        <span className="text-[13px] font-medium text-white/90">
          Transcription complete
        </span>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20, rotate: 10 }}
        whileInView={{ opacity: 1, y: 0, rotate: 6 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 1, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        className="absolute right-6 md:right-16 top-28 md:top-32 hidden sm:flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white/10 backdrop-blur-xl border border-white/15 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.4)] rotate-[6deg]"
      >
        <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-400 to-fuchsia-500 text-white">
          <Languages size={13} strokeWidth={2} />
        </span>
        <span className="text-[13px] font-medium text-white/90">
          6 languages supported
        </span>
      </motion.div>

      <div className="relative max-w-6xl mx-auto px-6 py-20 md:py-32 flex flex-col items-center text-center gap-6">
        <motion.span
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5 }}
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 backdrop-blur-xl border border-white/15 text-indigo-200 text-[13.5px] font-semibold uppercase tracking-wide"
        >
          <motion.span
            animate={{ rotate: 360 }}
            transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
          >
            <Zap size={12} strokeWidth={2.2} />
          </motion.span>
          Ready when you are
        </motion.span>

        <motion.h2
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="text-[40px] md:text-[60px] font-semibold leading-[1.05] tracking-[-0.035em] max-w-3xl"
        >
          Stop re-recording lectures.{" "}
          <span className="bg-gradient-to-br from-indigo-300 via-fuchsia-300 to-emerald-300 bg-clip-text text-transparent">
            Reuse what you already have.
          </span>
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="text-[18px] md:text-[19px] text-slate-300 leading-relaxed max-w-[56ch]"
        >
          Upload a recording from last semester and get shareable,
          avatar-narrated micro-lessons in under an hour.
        </motion.p>

        <Link href="/new" className="mt-2">
          <motion.span
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, margin: "-80px" }}
            whileHover={{ y: -2, scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            transition={{ type: "spring", stiffness: 400, damping: 18 }}
            className="inline-flex items-center gap-2.5 px-7 py-4 rounded-lg text-[17px] font-medium text-slate-900 bg-white hover:bg-indigo-100 shadow-[0_4px_24px_rgba(0,0,0,0.4),_inset_0_1px_0_rgba(0,0,0,0.04)]"
          >
            Start processing a lecture
            <motion.span
              animate={{ x: [0, 4, 0] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            >
              <ArrowRight size={18} strokeWidth={2.2} />
            </motion.span>
          </motion.span>
        </Link>
      </div>
    </section>
  );
}

/* ================================================================== */
/* Footer                                                              */
/* ================================================================== */

function LandingFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-5">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white">
            <AudioWaveform size={15} strokeWidth={2} />
          </span>
          <span className="text-[16.5px] font-semibold text-slate-900">
            Course Generator AI
          </span>
          <span className="text-[14.5px] font-mono text-slate-400">v0.0.1</span>
        </div>
        <div className="flex items-center gap-6 text-[15.5px] text-slate-500">
          <Link href="/new" className="hover:text-slate-900 transition-colors">
            Start a job
          </Link>
          <a href="#how" className="hover:text-slate-900 transition-colors">
            How it works
          </a>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-blink" />
            All systems operational
          </span>
        </div>
      </div>
    </footer>
  );
}
