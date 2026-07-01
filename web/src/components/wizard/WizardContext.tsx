"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";

export type StepId = 1 | 2 | 3 | 4 | 5 | 6;

export const STEPS: Array<{
  id: StepId;
  name: string;
  caption: string;
}> = [
  { id: 1, name: "Upload",     caption: "Choose source" },
  { id: 2, name: "Audio",      caption: "Extract track" },
  { id: 3, name: "Transcript", caption: "Speech to text" },
  { id: 4, name: "Clean",      caption: "Remove filler" },
  { id: 5, name: "Split",      caption: "Topic chunks" },
  { id: 6, name: "Avatar",     caption: "Render video" },
];

export type CleanLevel = "light" | "standard" | "aggressive";

export type TopicChunk = {
  id: string;
  topic: string;
  startSec: number;
  endSec: number;
  wordCount: number;
  preview: string;
  // Character count of the narration script HeyGen will see (enrichedText
  // when present, otherwise the cleaned text). Drives the per-chunk char
  // chip in Step 6 and the parts-count estimate (chars / cap rounded up).
  narrationChars?: number;
};

export type AvatarOption = {
  id: string;
  name: string;
  style: string;
  tone: string;
};

export type RenderState = {
  progress: number; // 0..100
  ready: boolean;
};

export type WizardState = {
  step: StepId;
  furthestReached: StepId;
  finished: boolean;

  // Backend-job linkage (populated once Step 1 completes a real upload)
  jobId: string | null;

  // Step 1
  // `kind` distinguishes the two ingestion modes — file upload vs URL paste.
  // For URL jobs, `name` initially holds the URL and is replaced with the
  // resolved title once yt-dlp's metadata probe completes.
  file: {
    name: string;
    size: number;
    type: string;
    durationSec: number;
    kind?: "file" | "url";
    sourceUrl?: string;
  } | null;
  uploadProgress: number; // 0-100, meaningful only while the real upload is in flight
  uploadError: string | null;
  // URL-ingestion flow only — true once the yt-dlp download completes.
  // Step 1's canAdvance reads this for URL jobs.
  urlDownloadDone: boolean;

  // Step 2
  audioProgress: number;
  audioReady: boolean;

  // Step 3
  transcript: string;
  transcriptProgress: number;
  transcriptReady: boolean;

  // Step 4
  cleanLevel: CleanLevel;
  cleanedReady: boolean;

  // Step 5
  targetMinutes: number;
  chunks: TopicChunk[];

  // Step 6
  // Render style — three modes the user picks BEFORE generating:
  //   "instructor"  — talking-head AI avatar built from an uploaded
  //                   instructor photo. Requires instructorPhotoKey.
  //   "animated"    — cartoon/illustrated explainer. No photo input.
  //   "whiteboard"  — voiceover narrating an animated whiteboard /
  //                   blackboard. No photo input.
  renderStyle: "instructor" | "animated" | "whiteboard";
  // Server-side storage key for the uploaded instructor photo when
  // renderStyle === "instructor". Null otherwise. Populated by the
  // upload route (POST /api/jobs/[id]/instructor-photo).
  instructorPhotoKey: string | null;
  // Client-side blob URL for instant preview after upload (revoked on
  // unmount). Server-side path persists in instructorPhotoKey.
  instructorPhotoPreviewUrl: string | null;

  selectedAvatarId: string;
  // HeyGen voice_id chosen at Step 6 (null = use server default voice).
  selectedVoiceId: string | null;
  // UI-only filter for the voice picker dropdown.
  voiceGenderFilter: "all" | "male" | "female";
  // Voice playback speed (0.5..2.0). 1.0 = natural. Persisted on Job.
  voiceSpeed: number;
  renders: Record<string, RenderState>;
};

type Ctx = WizardState & {
  setStep: (s: StepId) => void;
  advance: () => void;
  back: () => void;
  canAdvance: boolean;
  update: (patch: Partial<WizardState>) => void;
  updateRender: (chunkId: string, patch: Partial<RenderState>) => void;
  reset: () => void;
  finish: () => void;
};

const initial: WizardState = {
  step: 1,
  furthestReached: 1,
  finished: false,
  jobId: null,
  file: null,
  uploadProgress: 0,
  uploadError: null,
  urlDownloadDone: false,
  audioProgress: 0,
  audioReady: false,
  transcript: "",
  transcriptProgress: 0,
  transcriptReady: false,
  cleanLevel: "aggressive",
  cleanedReady: false,
  targetMinutes: 20,
  chunks: [],
  renderStyle: "instructor",
  instructorPhotoKey: null,
  instructorPhotoPreviewUrl: null,
  selectedAvatarId: "",
  selectedVoiceId: null,
  voiceGenderFilter: "all",
  voiceSpeed: 1.0,
  renders: {},
};

const WizardCtx = createContext<Ctx | null>(null);

export function WizardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WizardState>(initial);

  const update = useCallback((patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateRender = useCallback(
    (chunkId: string, patch: Partial<RenderState>) => {
      setState((prev) => ({
        ...prev,
        renders: {
          ...prev.renders,
          [chunkId]: { ...(prev.renders[chunkId] ?? { progress: 0, ready: false }), ...patch },
        },
      }));
    },
    [],
  );

  // Gate Next on each step's real completion state.
  // Step 1 requires a jobId (real upload complete, not just a file picked).
  const canAdvance = useMemo(() => {
    switch (state.step) {
      case 1:
        // File jobs: just need a jobId. URL jobs additionally need the
        // background yt-dlp task to have finished downloading the audio.
        if (state.file?.kind === "url") {
          return state.jobId !== null && state.urlDownloadDone;
        }
        return state.jobId !== null && state.uploadError === null;
      case 2: return state.audioReady;
      case 3: return state.transcriptReady;
      case 4: return state.cleanedReady;
      case 5: return state.chunks.length > 0;
      case 6: return false;
      default: return false;
    }
  }, [state]);

  const setStep = useCallback((s: StepId) => {
    setState((prev) => {
      if (s > prev.furthestReached) return prev;
      return { ...prev, step: s };
    });
  }, []);

  const advance = useCallback(() => {
    setState((prev) => {
      if (prev.step >= 6) return prev;
      const next = (prev.step + 1) as StepId;
      return {
        ...prev,
        step: next,
        furthestReached: Math.max(prev.furthestReached, next) as StepId,
      };
    });
  }, []);

  const back = useCallback(() => {
    setState((prev) => {
      if (prev.step <= 1) return prev;
      return { ...prev, step: (prev.step - 1) as StepId };
    });
  }, []);

  const reset = useCallback(() => setState(initial), []);

  const finish = useCallback(() => {
    setState((prev) => ({ ...prev, finished: true }));
  }, []);

  const value = useMemo<Ctx>(
    () => ({ ...state, setStep, advance, back, canAdvance, update, updateRender, reset, finish }),
    [state, setStep, advance, back, canAdvance, update, updateRender, reset, finish],
  );

  return <WizardCtx.Provider value={value}>{children}</WizardCtx.Provider>;
}

export function useWizard() {
  const ctx = useContext(WizardCtx);
  if (!ctx) throw new Error("useWizard must be used within WizardProvider");
  return ctx;
}
