"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  Info,
  AlertTriangle,
  X,
  Loader2,
  Download,
} from "lucide-react";

type ToastTone = "success" | "info" | "warn" | "error" | "loading" | "download";

export type Toast = {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  duration?: number; // ms; 0 = sticky
};

type Ctx = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
};

const ToastCtx = createContext<Ctx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<Ctx["push"]>(
    (t) => {
      const id = t.id ?? Math.random().toString(36).slice(2, 10);
      const duration = t.duration ?? (t.tone === "loading" ? 0 : 3600);
      setToasts((prev) => [...prev.filter((x) => x.id !== id), { ...t, id }]);
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <ToastViewport />
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  const api = useMemo(
    () => ({
      success: (title: string, description?: string) =>
        ctx.push({ tone: "success", title, description }),
      info: (title: string, description?: string) =>
        ctx.push({ tone: "info", title, description }),
      warn: (title: string, description?: string) =>
        ctx.push({ tone: "warn", title, description }),
      error: (title: string, description?: string) =>
        ctx.push({ tone: "error", title, description }),
      loading: (title: string, description?: string) =>
        ctx.push({ tone: "loading", title, description, duration: 0 }),
      download: (title: string, description?: string) =>
        ctx.push({ tone: "download", title, description }),
      dismiss: ctx.dismiss,
      push: ctx.push,
    }),
    [ctx],
  );
  return api;
}

function ToastViewport() {
  const ctx = useContext(ToastCtx);
  if (!ctx) return null;
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed z-50 inset-x-0 bottom-4 px-4 flex flex-col items-center gap-2.5 sm:bottom-6 sm:right-6 sm:left-auto sm:items-end sm:max-w-sm"
    >
      <AnimatePresence initial={false}>
        {ctx.toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => ctx.dismiss(t.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}

const TONE_META: Record<
  ToastTone,
  { icon: React.ReactNode; from: string; to: string; softBorder: string; softBg: string }
> = {
  success: {
    icon: <Check size={14} strokeWidth={2.6} />,
    from: "from-emerald-500",
    to: "to-teal-500",
    softBorder: "border-emerald-100",
    softBg: "from-emerald-50/70 to-white",
  },
  info: {
    icon: <Info size={14} strokeWidth={2.4} />,
    from: "from-indigo-500",
    to: "to-blue-500",
    softBorder: "border-indigo-100",
    softBg: "from-indigo-50/70 to-white",
  },
  warn: {
    icon: <AlertTriangle size={14} strokeWidth={2.4} />,
    from: "from-amber-500",
    to: "to-orange-500",
    softBorder: "border-amber-100",
    softBg: "from-amber-50/70 to-white",
  },
  error: {
    icon: <AlertTriangle size={14} strokeWidth={2.4} />,
    from: "from-rose-500",
    to: "to-red-500",
    softBorder: "border-rose-100",
    softBg: "from-rose-50/70 to-white",
  },
  loading: {
    icon: <Loader2 size={14} strokeWidth={2.2} className="animate-spin-slow" />,
    from: "from-violet-500",
    to: "to-fuchsia-500",
    softBorder: "border-violet-100",
    softBg: "from-violet-50/70 to-white",
  },
  download: {
    icon: <Download size={14} strokeWidth={2.2} />,
    from: "from-emerald-500",
    to: "to-teal-500",
    softBorder: "border-emerald-100",
    softBg: "from-emerald-50/70 to-white",
  },
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const meta = TONE_META[toast.tone];
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.95, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 380, damping: 26 }}
      className={`pointer-events-auto w-full max-w-sm relative overflow-hidden rounded-xl border ${meta.softBorder} bg-gradient-to-br ${meta.softBg} bg-white shadow-[0_1px_2px_rgba(9,9,11,0.05),_0_12px_32px_-12px_rgba(9,9,11,0.16)] p-3.5 flex items-start gap-3`}
    >
      <span
        className={`flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br ${meta.from} ${meta.to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] shrink-0`}
      >
        {meta.icon}
      </span>
      <div className="flex-1 min-w-0 pt-0.5">
        <p className="text-[14.5px] font-semibold text-slate-900 leading-snug">
          {toast.title}
        </p>
        {toast.description && (
          <p className="text-[13px] text-slate-500 mt-0.5 leading-snug">
            {toast.description}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
        className="shrink-0 text-slate-400 hover:text-slate-700 transition-colors -mr-0.5 -mt-0.5 p-1"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </motion.div>
  );
}
