"use client";

import { motion } from "motion/react";
import type { StepId } from "./WizardContext";

const STEP_GRADIENTS: Record<StepId, string> = {
  1: "from-indigo-500 to-blue-500",
  2: "from-blue-500 to-cyan-500",
  3: "from-violet-500 to-purple-500",
  4: "from-fuchsia-500 to-pink-500",
  5: "from-rose-500 to-orange-500",
  6: "from-emerald-500 to-teal-500",
};

export function StepHeader({
  step,
  title,
  description,
  actions,
}: {
  step: StepId;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  const gradient = STEP_GRADIENTS[step];

  return (
    <header className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex items-start gap-4 min-w-0">
        <motion.span
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 18 }}
          className={`flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${gradient} text-white text-[18px] font-semibold nums shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_6px_18px_-6px_rgba(15,23,42,0.3)] shrink-0`}
        >
          {String(step).padStart(2, "0")}
        </motion.span>
        <div className="flex flex-col gap-1.5 min-w-0">
          <h2 className="text-[36px] font-semibold tracking-tight text-slate-900 leading-tight">
            {title}
          </h2>
          <p className="text-[17px] text-slate-500 leading-relaxed">
            {description}
          </p>
        </div>
      </div>
      {actions}
    </header>
  );
}

export function SectionLabel({
  icon,
  children,
  tone = "indigo",
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  tone?: "indigo" | "emerald" | "fuchsia" | "amber" | "violet";
}) {
  const tones: Record<string, string> = {
    indigo: "text-indigo-700 bg-gradient-to-br from-indigo-50 to-blue-50 border-indigo-100/70",
    emerald: "text-emerald-700 bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-100/70",
    fuchsia: "text-fuchsia-700 bg-gradient-to-br from-fuchsia-50 to-pink-50 border-fuchsia-100/70",
    amber: "text-amber-700 bg-gradient-to-br from-amber-50 to-orange-50 border-amber-100/70",
    violet: "text-violet-700 bg-gradient-to-br from-violet-50 to-purple-50 border-violet-100/70",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[12.5px] font-semibold uppercase tracking-wide ${tones[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}
