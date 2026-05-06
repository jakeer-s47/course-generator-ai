"use client";

import { useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import { AudioWaveform, HelpCircle, Settings2, Home } from "lucide-react";
import { useWizard } from "./WizardContext";
import { HelpDrawer } from "@/components/ui/HelpDrawer";
import { SettingsDrawer } from "@/components/ui/SettingsDrawer";

export function Topbar() {
  const { reset, step } = useWizard();
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="h-16 shrink-0 border-b border-slate-200 bg-white/85 backdrop-blur-xl relative overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-60"
        style={{
          background:
            "radial-gradient(40% 200% at 10% 50%, rgba(99,102,241,0.08) 0%, transparent 60%), radial-gradient(40% 200% at 90% 50%, rgba(217,70,239,0.06) 0%, transparent 60%)",
        }}
      />
      <div className="relative mx-auto max-w-6xl h-full px-6 flex items-center justify-between">
        <motion.button
          type="button"
          onClick={reset}
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.97 }}
          className="flex items-center gap-2.5 group"
          title="Restart the wizard"
          aria-label="Restart the wizard"
        >
          <motion.span
            whileHover={{ rotate: 8 }}
            transition={{ type: "spring", stiffness: 400, damping: 14 }}
            className="relative flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
          >
            <AudioWaveform size={18} strokeWidth={2} />
            <span className="absolute -inset-0.5 rounded-[13px] bg-gradient-to-br from-indigo-500/40 via-fuchsia-500/30 to-emerald-500/30 blur-md opacity-0 group-hover:opacity-100 transition-opacity -z-10" />
          </motion.span>
          <span className="flex items-baseline gap-2">
            <span className="text-[21px] font-semibold tracking-tight text-slate-900">
              Course Generator AI
            </span>
            <span className="text-[14px] font-medium px-1.5 py-0.5 rounded-md bg-gradient-to-br from-indigo-50 to-fuchsia-50 text-indigo-700 border border-indigo-100/70">
              Beta
            </span>
          </span>
        </motion.button>

        <div className="flex items-center gap-1">
          <span className="hidden sm:inline text-[15.5px] text-slate-500 mr-3">
            Step{" "}
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white font-semibold nums text-[12.5px] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
              {step}
            </span>
            <span className="ml-1.5">of 6</span>
          </span>
          <Link
            href="/"
            className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50/60 transition-colors"
            aria-label="Back to home"
            title="Back to home"
          >
            <Home size={17} strokeWidth={1.8} />
          </Link>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50/60 transition-colors"
            aria-label="Help & tips"
            title="Help & tips"
          >
            <HelpCircle size={17} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50/60 transition-colors"
            aria-label="Settings"
            title="Settings"
          >
            <Settings2 size={17} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </header>
  );
}
