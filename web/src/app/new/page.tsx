"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  WizardProvider,
  useWizard,
  type StepId,
} from "@/components/wizard/WizardContext";
import { stepForStatus } from "@/lib/steps";
import { Topbar } from "@/components/wizard/Topbar";
import { Stepper } from "@/components/wizard/Stepper";
import { WizardFooter } from "@/components/wizard/WizardFooter";
import { CompletionScreen } from "@/components/wizard/CompletionScreen";
import { UploadStep } from "@/components/wizard/steps/UploadStep";
import { AudioStep } from "@/components/wizard/steps/AudioStep";
import { TranscriptStep } from "@/components/wizard/steps/TranscriptStep";
import { CleanStep } from "@/components/wizard/steps/CleanStep";
import { SplitStep } from "@/components/wizard/steps/SplitStep";
import { AvatarStep } from "@/components/wizard/steps/AvatarStep";
import { BatchWizardShell } from "@/components/wizard/BatchWizardShell";

export default function NewJobPage() {
  return (
    <WizardProvider>
      <Suspense fallback={null}>
        <PageRouter />
      </Suspense>
    </WizardProvider>
  );
}

/**
 * Decide between the existing wizard shell and the playlist overview
 * based on the job's `kind`. Reads `?job=<id>` from the URL and probes
 * the server before rendering. For non-URL contexts (no ?job=), or when
 * the kind is anything other than "playlist", we render the wizard.
 */
function PageRouter() {
  const search = useSearchParams();
  const id = search.get("job");
  const [kind, setKind] = useState<
    "loading" | "wizard" | "playlist" | "batch"
  >(id ? "loading" : "wizard");

  useEffect(() => {
    if (!id) {
      setKind("wizard");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/jobs/${id}`);
        if (!r.ok) {
          if (!cancelled) setKind("wizard"); // fall back to wizard on error
          return;
        }
        const job = await r.json();
        if (cancelled) return;
        if (job.kind === "playlist") setKind("playlist");
        else if (job.kind === "batch") setKind("batch");
        else setKind("wizard");
      } catch {
        if (!cancelled) setKind("wizard");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (kind === "loading") return null;
  if (kind === "playlist" && id)
    return <BatchWizardShell parentId={id} kind="playlist" />;
  if (kind === "batch" && id)
    return <BatchWizardShell parentId={id} kind="batch" />;

  return (
    <>
      <ResumeFromUrl />
      <WizardShell />
    </>
  );
}

// Resolved at call-site now via activeStepNumber(job.steps) — see below.

/**
 * If `/new?job={id}` is hit, hydrate WizardContext with that job and jump
 * to the correct step based on its current_stage.
 *
 * Resumption guard: we re-fetch whenever `id` changes (so navigating
 * between two different jobs in the same session works) and short-circuit
 * if WizardContext already holds the job we're targeting (prevents
 * re-fetching on dev-mode strict-mode double-mounts and on harmless
 * re-renders).
 */
function ResumeFromUrl() {
  const search = useSearchParams();
  const { update, jobId: loadedJobId } = useWizard();
  const id = search.get("job");

  useEffect(() => {
    if (!id) return;
    // Already loaded this job into the wizard — skip. This is what makes
    // dev-mode strict-mode double-mount safe (the previous didRun-ref
    // approach got stuck `true` after the first mount/unmount cycle and
    // skipped the actual fetch).
    if (loadedJobId === id) return;

    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/jobs/${id}`);
        if (!r.ok) return;
        const job = await r.json();
        if (cancelled) return;

        const statusValue = job.status?.status ?? "audio";
        const targetStep = stepForStatus(statusValue) as StepId;

        // If the audio stage has been passed, audioReady should be true
        // so the step-2 Next button unlocks without re-running extract.
        const audioDone = ["transcript", "clean", "split", "render", "done"]
          .includes(statusValue);

        // Three things we treat as "URL jobs" for the wizard's purposes:
        //   - kind === "url"            (single-URL ingestion)
        //   - kind === "playlist_video" (a child of a playlist parent)
        //   - source_name looks like an HTTP URL (legacy URL jobs created
        //     before the kind column existed)
        // All three need the URL-download polling + progress card flow,
        // not the file-upload XHR flow.
        const sourceLooksLikeUrl =
          typeof job.sourceName === "string" &&
          /^https?:\/\//i.test(job.sourceName);
        const isUrlJob =
          job.kind === "url" ||
          job.kind === "playlist_video" ||
          sourceLooksLikeUrl;

        const urlDownloadDone =
          isUrlJob && statusValue !== "downloading" && statusValue !== "failed";

        // IMPORTANT: set `step` and `furthestReached` in a single patch.
        // `setStep()` refuses to move past `furthestReached`, so calling it
        // right after a separate update(...) races with React's batcher and
        // silently keeps the user on step 1.
        update({
          jobId: job.id,
          file: {
            name: job.sourceName,
            size: job.sourceSize,
            type: job.sourceType,
            durationSec: job.sourceDurationSec ?? 0,
            kind: isUrlJob ? "url" : "file",
            // The actual URL is only known when source_name still holds it
            // (legacy URL jobs). For kind="url"/playlist_video, source_name
            // has been replaced by the resolved title — we don't keep the
            // URL around once download starts.
            sourceUrl: sourceLooksLikeUrl ? job.sourceName : undefined,
          },
          uploadProgress: 100,
          uploadError: null,
          urlDownloadDone,
          step: targetStep,
          furthestReached: targetStep,
          audioReady: audioDone,
        });
      } catch {
        /* silent */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, loadedJobId, update]);

  return null;
}

function WizardShell() {
  const { step, finished } = useWizard();

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <Topbar />
      {!finished && <Stepper />}
      <main className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          {finished ? (
            <motion.div
              key="complete"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="min-h-full"
            >
              <CompletionScreen />
            </motion.div>
          ) : (
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="px-6 py-10 md:py-12"
            >
              {step === 1 && <UploadStep />}
              {step === 2 && <AudioStep />}
              {step === 3 && <TranscriptStep />}
              {step === 4 && <CleanStep />}
              {step === 5 && <SplitStep />}
              {step === 6 && <AvatarStep />}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      <WizardFooter />
    </div>
  );
}
