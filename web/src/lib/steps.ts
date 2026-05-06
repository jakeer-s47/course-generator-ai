// Canonical status values and step mapping. There's one `job_status` row per
// video; its `status` field is one of STATUS_VALUES and its `progress` is
// 0-100 within the current step. `progress === 100` means the step is done
// and the next one is about to start (or already has).

export const STATUS_VALUES = [
  "downloading", // step 1 — yt-dlp pulling audio from a URL (URL jobs only)
  "audio",      // step 2 — extracting audio
  "transcript", // step 3 — whisper
  "clean",      // step 4 — gpt-4o cleanup
  "split",      // step 5 — gpt-4o segmentation
  "render",     // step 6 — heygen avatar render
  "done",       // all 6 complete
  "failed",     // something went wrong on the current step
] as const;

export type JobStatusValue = (typeof STATUS_VALUES)[number];

// Visible step number in the wizard. URL jobs start at step 1 while their
// audio is being pulled; everyone else starts at 2.
export const STATUS_TO_STEP: Record<JobStatusValue, 1 | 2 | 3 | 4 | 5 | 6> = {
  downloading: 1,
  audio: 2,
  transcript: 3,
  clean: 4,
  split: 5,
  render: 6,
  done: 6, // terminal — keep user on step 6
  failed: 2, // best-effort; the actual failed stage is recoverable from job context
};

export const STEP_LABELS: Record<JobStatusValue, string> = {
  downloading: "Downloading",
  audio: "Extract audio",
  transcript: "Transcribe",
  clean: "Clean",
  split: "Split",
  render: "Render",
  done: "Done",
  failed: "Failed",
};

/** The next status after the current one completes. */
export function nextStatus(current: JobStatusValue): JobStatusValue {
  // URL jobs skip the "audio" stage because yt-dlp produces audio directly.
  if (current === "downloading") return "transcript";
  const order: JobStatusValue[] = [
    "audio",
    "transcript",
    "clean",
    "split",
    "render",
    "done",
  ];
  const i = order.indexOf(current);
  if (i < 0 || i === order.length - 1) return "done";
  return order[i + 1];
}

/** Step number (1..6) the wizard should open for a job with this status. */
export function stepForStatus(status: string): 1 | 2 | 3 | 4 | 5 | 6 {
  if (!status) return 2;
  return (STATUS_TO_STEP[status as JobStatusValue] ?? 2) as
    | 1
    | 2
    | 3
    | 4
    | 5
    | 6;
}
