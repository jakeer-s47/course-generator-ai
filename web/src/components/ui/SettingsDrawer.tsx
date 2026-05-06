"use client";

import { useState } from "react";
import { motion } from "motion/react";
import {
  Settings2,
  Globe,
  Sparkles,
  Video,
  Bell,
  Lock,
  Monitor,
  Moon,
  Sun,
  Languages,
  Check,
} from "lucide-react";
import { Drawer } from "./Modal";
import { useToast } from "./Toast";

export function SettingsDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [sttModel, setSttModel] = useState("whisper-large-v3");
  const [language, setLanguage] = useState("en");
  const [quality, setQuality] = useState<"720p" | "1080p" | "4k">("1080p");
  const [theme, setTheme] = useState<"light" | "dark" | "system">("light");
  const [notifications, setNotifications] = useState(true);
  const toast = useToast();

  function save() {
    toast.success("Settings saved", "Applies to all future jobs");
    onClose();
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon={
        <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-slate-700 via-slate-800 to-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
          <Settings2 size={18} strokeWidth={2} />
        </span>
      }
      title="Settings"
      subtitle="Configure your defaults"
    >
      <div className="flex flex-col">
        <div className="flex flex-col gap-6 p-5 flex-1">
          {/* Processing */}
          <section className="flex flex-col gap-3">
            <h4 className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
              <Sparkles size={12} strokeWidth={2.2} />
              Processing
            </h4>

            <SelectField
              icon={<Languages size={14} strokeWidth={2} />}
              label="Transcription language"
              value={language}
              onChange={setLanguage}
              options={[
                { value: "auto", label: "Auto-detect" },
                { value: "en", label: "English" },
                { value: "es", label: "Spanish" },
                { value: "hi", label: "Hindi" },
                { value: "fr", label: "French" },
                { value: "de", label: "German" },
              ]}
              from="from-indigo-500"
              to="to-blue-500"
            />

            <SelectField
              icon={<Sparkles size={14} strokeWidth={2} />}
              label="Speech-to-text model"
              value={sttModel}
              onChange={setSttModel}
              options={[
                { value: "whisper-large-v3", label: "Whisper Large v3 · highest quality" },
                { value: "whisper-medium", label: "Whisper Medium · balanced" },
                { value: "whisper-small", label: "Whisper Small · fastest" },
              ]}
              from="from-violet-500"
              to="to-purple-500"
            />
          </section>

          {/* Output */}
          <section className="flex flex-col gap-3">
            <h4 className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
              <Video size={12} strokeWidth={2.2} />
              Output
            </h4>

            <div className="flex flex-col gap-2">
              <label className="text-[13px] text-slate-600 font-medium flex items-center gap-1.5">
                <span className="flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br from-fuchsia-500 to-pink-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                  <Video size={11} strokeWidth={2} />
                </span>
                Video quality
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(["720p", "1080p", "4k"] as const).map((q) => {
                  const active = quality === q;
                  return (
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      type="button"
                      key={q}
                      onClick={() => setQuality(q)}
                      className={`rounded-lg border px-2 py-2 text-[13px] font-medium transition-all ${
                        active
                          ? "border-indigo-500 bg-indigo-50/60 text-indigo-700 ring-2 ring-indigo-100"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                      }`}
                    >
                      {q.toUpperCase()}
                    </motion.button>
                  );
                })}
              </div>
            </div>
          </section>

          {/* Appearance */}
          <section className="flex flex-col gap-3">
            <h4 className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
              <Monitor size={12} strokeWidth={2.2} />
              Appearance
            </h4>

            <div className="flex flex-col gap-2">
              <label className="text-[13px] text-slate-600 font-medium">Theme</label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { v: "light", label: "Light", icon: Sun },
                    { v: "dark", label: "Dark", icon: Moon },
                    { v: "system", label: "System", icon: Monitor },
                  ] as const
                ).map(({ v, label, icon: Icon }) => {
                  const active = theme === v;
                  return (
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      type="button"
                      key={v}
                      onClick={() => setTheme(v)}
                      className={`rounded-lg border px-2 py-2 text-[13px] font-medium flex items-center justify-center gap-1.5 transition-all ${
                        active
                          ? "border-indigo-500 bg-indigo-50/60 text-indigo-700 ring-2 ring-indigo-100"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                      }`}
                    >
                      <Icon size={13} strokeWidth={2} />
                      {label}
                    </motion.button>
                  );
                })}
              </div>
              <p className="text-[12px] text-slate-400">
                Dark theme is coming soon.
              </p>
            </div>
          </section>

          {/* Notifications */}
          <section className="flex flex-col gap-3">
            <h4 className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
              <Bell size={12} strokeWidth={2.2} />
              Notifications
            </h4>
            <ToggleRow
              icon={<Bell size={13} strokeWidth={2} />}
              title="Email me when a job finishes"
              body="You&rsquo;ll get a one-line summary + download link"
              value={notifications}
              onChange={setNotifications}
            />
          </section>

          {/* Privacy */}
          <section className="flex flex-col gap-3">
            <h4 className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
              <Lock size={12} strokeWidth={2.2} />
              Privacy
            </h4>
            <div className="p-3 rounded-xl bg-gradient-to-br from-emerald-50/60 to-teal-50/40 border border-emerald-100/60 flex items-start gap-2.5">
              <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] shrink-0 mt-0.5">
                <Check size={13} strokeWidth={2.6} />
              </span>
              <p className="text-[13px] text-slate-700 leading-snug">
                Your audio is deleted within{" "}
                <span className="font-semibold">30 days</span> of the final
                render. Transcripts + videos are kept until you delete them.
              </p>
            </div>
          </section>
        </div>

        {/* Footer — Save */}
        <div className="border-t border-slate-200 p-4 bg-gradient-to-b from-white to-slate-50/60 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[12.5px] text-slate-500">
            <Globe size={11} strokeWidth={2} />
            Applies to all future jobs
          </span>
          <motion.button
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={save}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[14px] font-medium text-white bg-gradient-to-br from-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(99,102,241,0.5)]"
          >
            <Check size={14} strokeWidth={2.4} />
            Save
          </motion.button>
        </div>
      </div>
    </Drawer>
  );
}

function SelectField({
  icon,
  label,
  value,
  onChange,
  options,
  from,
  to,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  from: string;
  to: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] text-slate-600 font-medium flex items-center gap-1.5">
        <span
          className={`flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
        >
          {icon}
        </span>
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-white text-[14px] font-medium text-slate-900 hover:border-slate-300 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleRow({
  icon,
  title,
  body,
  value,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="w-full flex items-start gap-3 p-3 rounded-xl border border-slate-200 bg-white hover:border-slate-300 transition-colors text-left"
    >
      <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] shrink-0">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[14px] font-semibold text-slate-900 leading-snug">
          {title}
        </p>
        <p className="text-[12.5px] text-slate-500 mt-0.5 leading-snug">{body}</p>
      </div>
      <span
        className={`shrink-0 inline-flex items-center w-10 h-6 rounded-full transition-colors p-0.5 ${
          value
            ? "bg-gradient-to-r from-emerald-500 to-teal-500 justify-end"
            : "bg-slate-200 justify-start"
        }`}
        aria-pressed={value}
      >
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 500, damping: 28 }}
          className="w-5 h-5 rounded-full bg-white shadow-[0_1px_2px_rgba(15,23,42,0.2)]"
        />
      </span>
    </button>
  );
}
