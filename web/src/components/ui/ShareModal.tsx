"use client";

import { useState } from "react";
import { motion } from "motion/react";
import {
  Copy,
  Check,
  Link2,
  Mail,
  MessageSquare,
  Send,
  Globe,
} from "lucide-react";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

const FAKE_LINK = "https://chapter-ai.app/s/9xQ2kR-thermo-04";

export function ShareModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(FAKE_LINK);
      setCopied(true);
      toast.success("Link copied", "Paste anywhere to share");
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      toast.error("Copy failed", "Copy manually from the input above");
    }
  }

  function notify(method: string) {
    toast.info(`Shared via ${method}`, "Your recipients will get a viewer link");
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
            <Link2 size={13} strokeWidth={2.2} />
          </span>
          Share your videos
        </div>
      }
      subtitle="Anyone with this link can view and download the 6 micro-lessons."
      size="md"
    >
      <div className="p-5 flex flex-col gap-4">
        {/* Copyable link */}
        <div className="relative">
          <Globe
            size={15}
            strokeWidth={2}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            type="text"
            readOnly
            value={FAKE_LINK}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full pl-10 pr-28 py-3 rounded-xl border border-slate-200 bg-slate-50/60 text-[14.5px] font-mono text-slate-700 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-colors"
          />
          <motion.button
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.96 }}
            type="button"
            onClick={handleCopy}
            className={`absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13.5px] font-medium transition-all ${
              copied
                ? "bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]"
                : "bg-gradient-to-br from-indigo-600 to-fuchsia-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_2px_8px_-2px_rgba(99,102,241,0.5)]"
            }`}
          >
            {copied ? (
              <>
                <Check size={13} strokeWidth={2.6} />
                Copied
              </>
            ) : (
              <>
                <Copy size={13} strokeWidth={2} />
                Copy
              </>
            )}
          </motion.button>
        </div>

        {/* Access note */}
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-gradient-to-br from-slate-50 to-slate-50/40 border border-slate-200">
          <span className="flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br from-emerald-500 to-teal-500 text-white shrink-0 mt-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
            <Check size={11} strokeWidth={2.8} />
          </span>
          <div>
            <p className="text-[13.5px] text-slate-700 font-medium leading-snug">
              Anyone with the link · view &amp; download
            </p>
            <p className="text-[12.5px] text-slate-500 mt-0.5 leading-snug">
              Disable sharing anytime from the job&rsquo;s settings.
            </p>
          </div>
        </div>

        {/* Share via */}
        <div>
          <p className="text-[12.5px] text-slate-500 font-semibold uppercase tracking-wide mb-2.5">
            Or share via
          </p>
          <div className="grid grid-cols-3 gap-2.5">
            <ShareChannel
              icon={<Mail size={16} strokeWidth={2} />}
              label="Email"
              onClick={() => notify("email")}
              from="from-indigo-500"
              to="to-blue-500"
              softFrom="from-indigo-50"
              softTo="to-blue-50"
            />
            <ShareChannel
              icon={<MessageSquare size={16} strokeWidth={2} />}
              label="Slack"
              onClick={() => notify("Slack")}
              from="from-fuchsia-500"
              to="to-pink-500"
              softFrom="from-fuchsia-50"
              softTo="to-pink-50"
            />
            <ShareChannel
              icon={<Send size={15} strokeWidth={2} />}
              label="X / Social"
              onClick={() => notify("X")}
              from="from-slate-700"
              to="to-slate-900"
              softFrom="from-slate-50"
              softTo="to-slate-100"
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ShareChannel({
  icon,
  label,
  onClick,
  from,
  to,
  softFrom,
  softTo,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  from: string;
  to: string;
  softFrom: string;
  softTo: string;
}) {
  return (
    <motion.button
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      type="button"
      onClick={onClick}
      className={`relative overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br ${softFrom} via-white ${softTo} p-3 flex flex-col items-center gap-2 hover:border-slate-300 hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_8px_18px_-10px_rgba(15,23,42,0.2)] transition-shadow group`}
    >
      <span
        className={`flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
      >
        {icon}
      </span>
      <span className="text-[13px] font-medium text-slate-700 group-hover:text-slate-900">
        {label}
      </span>
    </motion.button>
  );
}
