"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const sizeClass = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-2xl",
  }[size];

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-900/55 backdrop-blur-sm"
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{
              type: "spring",
              stiffness: 340,
              damping: 24,
            }}
            className={`relative w-full ${sizeClass} rounded-2xl bg-white border border-slate-200 shadow-[0_1px_2px_rgba(9,9,11,0.05),_0_40px_80px_-24px_rgba(9,9,11,0.35)] overflow-hidden`}
          >
            {(title || subtitle) && (
              <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
                <div className="flex flex-col gap-1 min-w-0">
                  {title && (
                    <h3 className="text-[17px] font-semibold text-slate-900 leading-snug">
                      {title}
                    </h3>
                  )}
                  {subtitle && (
                    <p className="text-[13.5px] text-slate-500 leading-snug">
                      {subtitle}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  title="Close"
                  className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors -mr-1 -mt-1"
                >
                  <X size={16} strokeWidth={2} />
                </button>
              </div>
            )}
            {!title && !subtitle && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close"
                className="absolute top-3 right-3 z-10 inline-flex items-center justify-center w-8 h-8 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X size={16} strokeWidth={2} />
              </button>
            )}
            <div className={title || subtitle ? "" : ""}>{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  side = "right",
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  side?: "right" | "left";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const xInitial = side === "right" ? "100%" : "-100%";
  const positionClass = side === "right" ? "right-0" : "left-0";

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            aria-hidden
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            initial={{ x: xInitial }}
            animate={{ x: 0 }}
            exit={{ x: xInitial }}
            transition={{ type: "spring", stiffness: 340, damping: 32 }}
            className={`absolute top-0 bottom-0 ${positionClass} w-full max-w-md bg-white border-l border-slate-200 shadow-[0_0_40px_rgba(9,9,11,0.15)] flex flex-col`}
          >
            <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
              <div className="flex items-start gap-3 min-w-0">
                {icon}
                <div className="flex flex-col gap-1 min-w-0">
                  {title && (
                    <h3 className="text-[17px] font-semibold text-slate-900 leading-snug">
                      {title}
                    </h3>
                  )}
                  {subtitle && (
                    <p className="text-[13.5px] text-slate-500 leading-snug">
                      {subtitle}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close"
                className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors -mr-1 -mt-1"
              >
                <X size={16} strokeWidth={2} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{children}</div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
