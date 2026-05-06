"use client";

import {
  Lightbulb,
  Keyboard,
  Video,
  FileText,
  Scissors,
  Sparkles,
  ExternalLink,
  MessageCircle,
  HelpCircle,
} from "lucide-react";
import { Drawer } from "./Modal";

export function HelpDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon={
        <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
          <HelpCircle size={18} strokeWidth={2} />
        </span>
      }
      title="Help & tips"
      subtitle="Quick answers for using Course Generator AI"
    >
      <div className="flex flex-col gap-6 p-5">
        {/* Tips */}
        <section className="flex flex-col gap-2.5">
          <h4 className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
            <Lightbulb size={12} strokeWidth={2.2} />
            Tips
          </h4>
          <TipRow
            icon={<Video size={14} strokeWidth={2} />}
            title="Best source length"
            body="Course Generator AI works best on 1–5 hour recordings with a single speaker and minimal background noise."
            from="from-indigo-500"
            to="to-blue-500"
          />
          <TipRow
            icon={<FileText size={14} strokeWidth={2} />}
            title="Transcript review"
            body="You can edit topic titles on the Split step before rendering — useful if the auto-detected label isn't quite right."
            from="from-violet-500"
            to="to-purple-500"
          />
          <TipRow
            icon={<Scissors size={14} strokeWidth={2} />}
            title="Target chunk length"
            body="20-minute chunks are the default, but anything between 10 and 40 works well for most LMS viewing sessions."
            from="from-fuchsia-500"
            to="to-pink-500"
          />
          <TipRow
            icon={<Sparkles size={14} strokeWidth={2} />}
            title="Cleaning level"
            body="Use Aggressive only for highly conversational recordings. For technical derivations, Light or Standard preserves nuance."
            from="from-emerald-500"
            to="to-teal-500"
          />
        </section>

        {/* Keyboard shortcuts */}
        <section className="flex flex-col gap-2.5">
          <h4 className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
            <Keyboard size={12} strokeWidth={2.2} />
            Keyboard shortcuts
          </h4>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            <ShortcutRow keys={["Enter"]} label="Advance to next step" />
            <ShortcutRow keys={["Shift", "Enter"]} label="Go back a step" />
            <ShortcutRow keys={["Esc"]} label="Close modal / drawer" />
            <ShortcutRow keys={["/"]} label="Focus search (coming soon)" />
          </ul>
        </section>

        {/* Support */}
        <section className="flex flex-col gap-2.5">
          <h4 className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
            <MessageCircle size={12} strokeWidth={2.2} />
            Get help
          </h4>
          <a
            href="#"
            className="flex items-center justify-between gap-3 p-3.5 rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50/60 via-white to-slate-50/40 hover:border-indigo-300 hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_8px_18px_-10px_rgba(15,23,42,0.2)] transition-all group"
          >
            <div className="flex items-center gap-3">
              <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                <MessageCircle size={15} strokeWidth={2} />
              </span>
              <div>
                <p className="text-[14.5px] font-semibold text-slate-900">
                  Talk to us
                </p>
                <p className="text-[12.5px] text-slate-500">
                  We usually reply within a few hours
                </p>
              </div>
            </div>
            <ExternalLink
              size={14}
              strokeWidth={2}
              className="text-slate-400 group-hover:text-indigo-600 transition-colors"
            />
          </a>
        </section>
      </div>
    </Drawer>
  );
}

function TipRow({
  icon,
  title,
  body,
  from,
  to,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  from: string;
  to: string;
}) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-xl border border-slate-200 bg-white">
      <span
        className={`flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] shrink-0`}
      >
        {icon}
      </span>
      <div>
        <p className="text-[14.5px] font-semibold text-slate-900 leading-snug">
          {title}
        </p>
        <p className="text-[13px] text-slate-500 mt-0.5 leading-snug">{body}</p>
      </div>
    </div>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <span className="text-[14px] text-slate-700">{label}</span>
      <span className="flex items-center gap-1">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-[11px] text-slate-400">+</span>}
            <kbd className="inline-flex items-center justify-center min-w-7 h-6 px-1.5 rounded-md bg-gradient-to-b from-slate-50 to-slate-100 border border-slate-200 text-[11.5px] font-mono font-semibold text-slate-700 shadow-[inset_0_-1px_0_rgba(15,23,42,0.08)]">
              {k}
            </kbd>
          </span>
        ))}
      </span>
    </li>
  );
}
