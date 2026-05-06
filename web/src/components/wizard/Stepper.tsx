"use client";

import { Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useWizard, STEPS } from "./WizardContext";

export function Stepper() {
  const { step, furthestReached, setStep } = useWizard();

  return (
    <div className="h-20 shrink-0 bg-white border-b border-slate-200">
      <div className="mx-auto max-w-6xl h-full px-6 flex items-center">
        <ol className="flex items-center w-full">
          {STEPS.map((s, i) => {
            const isDone = s.id < step;
            const isCurrent = s.id === step;
            const isFuture = s.id > furthestReached;
            const clickable = !isFuture;

            return (
              <li key={s.id} className="flex items-center flex-1 last:flex-none">
                <motion.button
                  type="button"
                  onClick={() => clickable && setStep(s.id)}
                  disabled={!clickable}
                  whileHover={clickable && !isCurrent ? { scale: 1.04 } : undefined}
                  whileTap={clickable ? { scale: 0.96 } : undefined}
                  transition={{ type: "spring", stiffness: 420, damping: 18 }}
                  className={`group flex items-center gap-3 min-w-0 ${
                    clickable ? "cursor-pointer" : "cursor-not-allowed"
                  }`}
                >
                  <motion.span
                    initial={false}
                    animate={{
                      backgroundColor: isDone ? "#4f46e5" : "#ffffff",
                      color: isDone ? "#ffffff" : isCurrent ? "#4f46e5" : "#94a3b8",
                      borderColor: isDone || isCurrent ? "#4f46e5" : "#e2e8f0",
                      boxShadow: isCurrent
                        ? "0 0 0 4px rgb(224 231 255)"
                        : "0 0 0 0px rgba(79,70,229,0)",
                    }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                    className="flex items-center justify-center w-8 h-8 rounded-full text-[15px] font-semibold shrink-0 border-2"
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      {isDone ? (
                        <motion.span
                          key="check"
                          initial={{ scale: 0, rotate: -90 }}
                          animate={{ scale: 1, rotate: 0 }}
                          exit={{ scale: 0, rotate: 90 }}
                          transition={{ type: "spring", stiffness: 420, damping: 18 }}
                        >
                          <Check size={14} strokeWidth={2.8} />
                        </motion.span>
                      ) : (
                        <motion.span
                          key={`n-${s.id}`}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.2 }}
                        >
                          {s.id}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </motion.span>
                  <span className="hidden md:flex flex-col items-start min-w-0">
                    <motion.span
                      animate={{
                        color: isCurrent
                          ? "#0f172a"
                          : isDone
                            ? "#334155"
                            : "#94a3b8",
                      }}
                      transition={{ duration: 0.3 }}
                      className="text-[16px] font-medium leading-none"
                    >
                      {s.name}
                    </motion.span>
                    <span className="text-[14px] text-slate-500 mt-1 leading-none">
                      {s.caption}
                    </span>
                  </span>
                </motion.button>

                {i < STEPS.length - 1 && (
                  <span
                    className="flex-1 h-px mx-4 bg-slate-200 relative overflow-hidden"
                    aria-hidden
                  >
                    <motion.span
                      className="absolute inset-y-0 left-0 bg-indigo-600"
                      initial={false}
                      animate={{ width: isDone ? "100%" : "0%" }}
                      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
