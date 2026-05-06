"use client";

import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Sparkles } from "lucide-react";
import { useWizard, STEPS } from "./WizardContext";

export function WizardFooter() {
  const { step, back, advance, finish, canAdvance, finished } = useWizard();
  const currentStep = STEPS.find((s) => s.id === step)!;
  const isFirst = step === 1;
  const isLast = step === 6;

  // On the completion screen, hide the footer entirely.
  if (finished) return null;

  const nextEnabled = isLast ? true : canAdvance;
  const handleClick = isLast ? finish : advance;

  return (
    <footer className="h-[72px] shrink-0 border-t border-slate-200 bg-white/85 backdrop-blur-xl relative overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-70"
        style={{
          background:
            "radial-gradient(50% 200% at 100% 50%, rgba(99,102,241,0.07) 0%, transparent 60%)",
        }}
      />
      <div className="relative mx-auto max-w-6xl h-full px-6 flex items-center justify-between gap-4">
        <motion.button
          type="button"
          onClick={back}
          disabled={isFirst}
          whileHover={!isFirst ? { x: -2 } : undefined}
          whileTap={!isFirst ? { scale: 0.97 } : undefined}
          transition={{ type: "spring", stiffness: 400, damping: 18 }}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[15.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
        >
          <ArrowLeft size={15} strokeWidth={2} />
          Back
        </motion.button>

        <div className="hidden sm:flex flex-col items-center">
          <span className="text-[12.5px] text-slate-500 leading-none nums">
            Step {step} of 6
          </span>
          <span className="text-[14.5px] text-slate-700 font-medium mt-1 leading-none">
            {currentStep.name}
            <span className="text-slate-400 font-normal">
              {" "}
              — {currentStep.caption}
            </span>
          </span>
        </div>

        <motion.button
          type="button"
          onClick={handleClick}
          disabled={!nextEnabled}
          whileHover={nextEnabled ? { y: -1, scale: 1.01 } : undefined}
          whileTap={nextEnabled ? { scale: 0.97 } : undefined}
          transition={{ type: "spring", stiffness: 400, damping: 18 }}
          className={`relative inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[15.5px] font-medium text-white transition-all ${
            !nextEnabled
              ? "bg-slate-300 cursor-not-allowed shadow-none"
              : isLast
                ? "bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(16,185,129,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(16,185,129,0.6)]"
                : "bg-gradient-to-br from-indigo-600 via-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(99,102,241,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(99,102,241,0.6)]"
          }`}
        >
          {isLast ? (
            <>
              <Check size={15} strokeWidth={2.4} />
              Finish
              <Sparkles size={13} strokeWidth={2.2} className="text-white/90" />
            </>
          ) : (
            <>
              Next
              <motion.span
                animate={nextEnabled ? { x: [0, 3, 0] } : undefined}
                transition={{
                  duration: 1.4,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              >
                <ArrowRight size={15} strokeWidth={2} />
              </motion.span>
            </>
          )}
        </motion.button>
      </div>
    </footer>
  );
}
