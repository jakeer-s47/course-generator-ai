"use client";

import { motion } from "motion/react";
import { AlertTriangle, RefreshCw, ArrowLeft, HelpCircle } from "lucide-react";

export function ErrorState({
  title = "Something went wrong",
  description = "We hit an unexpected error while processing this step. You can retry, or go back and check your source file.",
  code,
  onRetry,
  onBack,
}: {
  title?: string;
  description?: string;
  code?: string;
  onRetry?: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="max-w-xl mx-auto w-full flex flex-col items-center text-center gap-6 py-8">
      <motion.span
        initial={{ scale: 0, rotate: -10 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 16 }}
        className="relative flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-rose-500 via-red-500 to-orange-500 text-white shadow-[0_12px_32px_-6px_rgba(244,63,94,0.5),_inset_0_1px_0_rgba(255,255,255,0.2)]"
      >
        <AlertTriangle size={26} strokeWidth={2} />
      </motion.span>
      <div className="flex flex-col items-center gap-2.5">
        <h2 className="text-[30px] font-semibold tracking-tight text-slate-900 leading-tight">
          {title}
        </h2>
        <p className="text-[16px] text-slate-500 leading-relaxed max-w-[52ch]">
          {description}
        </p>
        {code && (
          <p className="inline-flex items-center gap-1.5 mt-1 px-2.5 py-1 rounded-full bg-rose-50 border border-rose-100 text-rose-700 text-[12.5px] font-mono font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
            {code}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2.5 pt-1">
        {onRetry && (
          <motion.button
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[14.5px] font-medium text-white bg-gradient-to-br from-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(99,102,241,0.5)]"
          >
            <RefreshCw size={14} strokeWidth={2} />
            Try again
          </motion.button>
        )}
        {onBack && (
          <motion.button
            whileHover={{ x: -2 }}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[14.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
          >
            <ArrowLeft size={14} strokeWidth={2} />
            Back
          </motion.button>
        )}
      </div>
      <a
        href="#"
        className="inline-flex items-center gap-1.5 text-[13.5px] text-slate-500 hover:text-slate-900 transition-colors"
      >
        <HelpCircle size={12} strokeWidth={2} />
        Read the troubleshooting guide
      </a>
    </div>
  );
}
