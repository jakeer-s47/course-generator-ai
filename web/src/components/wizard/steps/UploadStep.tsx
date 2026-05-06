"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import {
  UploadCloud,
  FileVideo,
  X,
  Clock,
  HardDrive,
  FileType2,
  Check,
  ArrowLeft,
  Link as LinkIcon,
  Sparkles,
  Loader2,
  AlertTriangle,
  RefreshCw,
  ListVideo,
  ArrowRight,
} from "lucide-react";
import { useWizard } from "../WizardContext";
import { formatBytes, formatDuration } from "@/lib/utils";
import { StepHeader } from "../StepHeader";
import { useToast } from "@/components/ui/Toast";

type Tab = "file" | "url";

type JobPollRow = {
  id: string;
  sourceName: string;
  sourceDurationSec: number | null;
  status: { status: string; progress: number } | null;
};

type PlaylistEntryPreview = {
  id: string;
  title: string;
  durationSec: number;
  sourceUrl: string;
};

type PlaylistPreview = {
  title: string;
  totalCount: number;
  entries: PlaylistEntryPreview[];
};

// Per-file preview for the multi-file upload flow. Built client-side from
// the `File` objects after the user picks ≥ 2 files; nothing is sent to
// the server until they confirm.
type BatchEntry = {
  file: File;
  durationSec: number | null;
};

function estimateDuration(size: number): number {
  const bytesPerMinute = 6 * 1024 * 1024;
  return Math.max(60, Math.round((size / bytesPerMinute) * 60));
}

/**
 * Read the real duration of a video/audio file in the browser by loading
 * its metadata into a hidden <video> element. Resolves to seconds (rounded)
 * or null if the browser can't decode the container (e.g. some MKV codecs).
 */
function readDurationFromFile(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
      resolve(null);
      return;
    }
    const el = document.createElement("video");
    el.preload = "metadata";
    el.muted = true;
    const url = URL.createObjectURL(file);

    const cleanup = () => {
      URL.revokeObjectURL(url);
      el.src = "";
      el.removeAttribute("src");
      el.load();
    };

    el.onloadedmetadata = () => {
      const dur = el.duration;
      cleanup();
      resolve(Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null);
    };
    el.onerror = () => {
      cleanup();
      resolve(null);
    };

    el.src = url;
  });
}

export function UploadStep() {
  const { file, update, jobId, uploadProgress, uploadError } = useWizard();
  const [tab, setTab] = useState<Tab>(
    file?.kind === "url" ? "url" : "file",
  );
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [urlInput, setUrlInput] = useState(file?.sourceUrl ?? "");
  const [submittingUrl, setSubmittingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(
    file?.kind === "url" ? "downloading" : null,
  );
  const [downloadProgress, setDownloadProgress] = useState(0);
  // Playlist flow state — populated by the probe step before any DB rows
  // are created. When `playlistPreview` is non-null, the URL pane swaps
  // to a confirmation card.
  const [playlistPreview, setPlaylistPreview] =
    useState<PlaylistPreview | null>(null);
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  // Once the user confirms "Process all N", the server creates the parent
  // + N children and we swap the preview card for an inline progress card
  // (no redirect — user stays on Step 1 watching their playlist process).
  const [playlistInFlight, setPlaylistInFlight] = useState<{
    parentId: string;
    title: string;
    totalCount: number;
  } | null>(null);
  // Multi-file upload state. `batchPreview` holds the picked files until
  // the user clicks "Process all N"; `batchInFlight` flips on once we've
  // POSTed to /api/jobs and gotten a parentId back.
  const [batchPreview, setBatchPreview] = useState<BatchEntry[] | null>(null);
  const [submittingBatch, setSubmittingBatch] = useState(false);
  const [batchUploadProgress, setBatchUploadProgress] = useState(0);
  const [batchInFlight, setBatchInFlight] = useState<{
    parentId: string;
    title: string;
    totalCount: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const toast = useToast();

  // Polling for URL jobs — fetch the job row every 1500 ms while the
  // background yt-dlp task is in flight.
  useEffect(() => {
    if (!jobId || file?.kind !== "url") return;
    if (downloadStatus === "transcript" || downloadStatus === "failed") return;

    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}/download`);
        if (!r.ok) return;
        const data = (await r.json()) as JobPollRow;
        if (cancelled) return;
        const s = data.status?.status ?? null;
        const p = data.status?.progress ?? 0;
        setDownloadStatus(s);
        setDownloadProgress(p);
        // Mirror the resolved title + duration into the wizard so the
        // downstream cards show what the user is working with.
        if (data.sourceName && file && data.sourceName !== file.name) {
          update({
            file: { ...file, name: data.sourceName },
          });
        }
        if (
          data.sourceDurationSec &&
          file &&
          data.sourceDurationSec !== file.durationSec
        ) {
          update({
            file: { ...file, durationSec: data.sourceDurationSec },
          });
        }
        if (s === "transcript") {
          toast.success("Audio ready", "Skipping straight to transcript");
          // Unlock the wizard's Next button. We don't auto-advance — the
          // user is on Step 1 looking at the success card, let them click
          // through.
          update({ urlDownloadDone: true });
        } else if (s === "failed") {
          toast.error(
            "Download failed",
            "Check the URL and try again",
          );
          update({ urlDownloadDone: false });
        }
      } catch {
        // transient — next tick will retry
      }
    };
    void tick();
    // 600 ms cadence during URL download — yt-dlp emits a fresh %
    // every fragment-completion, ~5-10 s for YouTube. We sample 4-8x
    // faster than that to catch each one as soon as it lands.
    const id = window.setInterval(tick, 600);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, file?.kind, downloadStatus]);

  /**
   * Real upload: POSTs the file to /api/jobs as multipart form-data,
   * reports upload progress via XHR's upload.onprogress (fetch() can't
   * expose upload progress today).
   */
  function startRealUpload(
    f: File,
    durationSec: number | null,
  ): Promise<{ jobId: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;

      xhr.open("POST", "/api/jobs");
      xhr.responseType = "json";

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        update({ uploadProgress: pct });
      };

      xhr.onload = () => {
        xhrRef.current = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          const body = xhr.response as { id: string };
          if (body?.id) {
            update({ uploadProgress: 100, jobId: body.id, uploadError: null });
            resolve({ jobId: body.id });
          } else {
            reject(new Error("Server response missing id"));
          }
        } else {
          const msg =
            (xhr.response && typeof xhr.response === "object"
              ? (xhr.response as { error?: string }).error
              : null) ?? `Upload failed (HTTP ${xhr.status})`;
          reject(new Error(msg));
        }
      };

      xhr.onerror = () => {
        xhrRef.current = null;
        reject(new Error("Network error during upload"));
      };

      xhr.onabort = () => {
        xhrRef.current = null;
        reject(new Error("Upload cancelled"));
      };

      const form = new FormData();
      form.append("file", f, f.name);
      if (durationSec !== null) {
        form.append("durationSec", String(durationSec));
      }
      xhr.send(form);
    });
  }

  async function handleFile(f: File) {
    // 1. Instant feedback with a size-based estimate so the file card
    //    appears the moment the user drops the file.
    update({
      file: {
        name: f.name,
        size: f.size,
        type: f.type || "video/*",
        durationSec: estimateDuration(f.size),
        kind: "file",
      },
      uploadProgress: 0,
      uploadError: null,
      jobId: null,
    });

    // 2. Read the real duration in the browser (~30–100 ms for most files).
    //    When it resolves, replace the estimate so the UI shows true seconds.
    const realDuration = await readDurationFromFile(f);
    if (realDuration !== null) {
      update({
        file: {
          name: f.name,
          size: f.size,
          type: f.type || "video/*",
          durationSec: realDuration,
          kind: "file",
        },
      });
    }

    // 3. Kick off the upload, sending the real duration (or null) along.
    setUploading(true);
    const loadingId = toast.loading(
      "Uploading…",
      `${f.name} · ${formatBytes(f.size)}`,
    );
    try {
      await startRealUpload(f, realDuration);
      toast.dismiss(loadingId);
      toast.success("Upload complete", "Ready to process");
    } catch (err) {
      toast.dismiss(loadingId);
      const message = err instanceof Error ? err.message : String(err);
      update({ uploadError: message, uploadProgress: 0 });
      toast.error("Upload failed", message);
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const list = Array.from(e.dataTransfer.files ?? []);
    if (list.length === 0) return;
    if (list.length === 1) {
      void handleFile(list[0]);
    } else {
      void handleMultipleFiles(list);
    }
  }

  function onPickFile() {
    inputRef.current?.click();
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    if (list.length === 0) return;
    if (list.length === 1) {
      void handleFile(list[0]);
    } else {
      void handleMultipleFiles(list);
    }
  }

  /**
   * User picked / dropped ≥ 2 files. Build a preview card with per-file
   * metadata (no server call yet — DB rows + on-disk writes only happen
   * after the user clicks "Process all N"). Reads each file's duration in
   * the browser via a hidden <video> element, in parallel.
   */
  async function handleMultipleFiles(files: File[]) {
    // Eagerly clear any leftover single-file state so the preview card
    // takes over the panel cleanly.
    update({ file: null, jobId: null, uploadProgress: 0, uploadError: null });

    const entries: BatchEntry[] = files.map((file) => ({
      file,
      durationSec: null,
    }));
    setBatchPreview(entries);

    // Read durations in the background — replace the entries as each
    // resolves so the preview UI fills in over ~30-100 ms per file.
    const durations = await Promise.all(
      files.map((f) => readDurationFromFile(f).catch(() => null)),
    );
    setBatchPreview((prev) => {
      if (!prev) return prev;
      // Match by index since the user can't reorder during the resolve
      // window. (We could re-key by File reference, but indexing is fine.)
      return prev.map((entry, i) => ({
        ...entry,
        durationSec: durations[i] ?? null,
      }));
    });
  }

  /**
   * User clicked "Process all N" on the BatchPreviewCard. Build a single
   * multipart FormData with N files and N matching `durationSec` fields
   * (one per file, empty string for unknown), POST to /api/jobs, swap the
   * preview card for the inline progress card.
   */
  async function handleBatchConfirm() {
    if (!batchPreview || batchPreview.length === 0) return;
    setSubmittingBatch(true);
    setBatchUploadProgress(0);
    const loadingId = toast.loading(
      "Uploading…",
      `${batchPreview.length} files`,
    );

    try {
      const result = await new Promise<{ parentId: string; childCount: number }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/jobs");
          xhr.responseType = "json";

          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            setBatchUploadProgress(Math.round((e.loaded / e.total) * 100));
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              const body = xhr.response as
                | { parentId?: string; childCount?: number; error?: string }
                | null;
              if (body?.parentId && typeof body.childCount === "number") {
                resolve({
                  parentId: body.parentId,
                  childCount: body.childCount,
                });
              } else {
                reject(new Error(body?.error ?? "Server response missing parentId"));
              }
            } else {
              const msg =
                (xhr.response && typeof xhr.response === "object"
                  ? (xhr.response as { error?: string }).error
                  : null) ?? `Upload failed (HTTP ${xhr.status})`;
              reject(new Error(msg));
            }
          };
          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.onabort = () => reject(new Error("Upload cancelled"));

          const form = new FormData();
          for (const entry of batchPreview) {
            form.append("file", entry.file, entry.file.name);
            form.append(
              "durationSec",
              entry.durationSec != null ? String(entry.durationSec) : "",
            );
          }
          xhr.send(form);
        },
      );

      toast.dismiss(loadingId);
      toast.success(
        "Batch queued",
        `${result.childCount} extractions started`,
      );
      // Stay on this page — swap the preview card for the inline progress
      // card. User can either watch progress here or click "Open full
      // overview" to go to /new?job=<parentId>.
      const firstName = batchPreview[0].file.name;
      const title =
        batchPreview.length === 2
          ? `${firstName} + 1 more`
          : `${firstName} + ${batchPreview.length - 1} more`;
      setBatchPreview(null);
      setBatchInFlight({
        parentId: result.parentId,
        title,
        totalCount: result.childCount,
      });
    } catch (err) {
      toast.dismiss(loadingId);
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Couldn't start batch", message);
    } finally {
      setSubmittingBatch(false);
    }
  }

  function cancelBatchPreview() {
    setBatchPreview(null);
  }

  function dismissBatchInFlight() {
    // Important: this does NOT cancel the background extractions — the
    // batch keeps processing on the server. Dismissing just hides the
    // inline progress card. The user can still find the batch on the home
    // page or via /new?job=<parentId>.
    setBatchInFlight(null);
    toast.info(
      "Hidden",
      "The batch will keep processing — find it in Recent Jobs.",
    );
  }

  function cancelOrClear() {
    // If an upload is in flight, abort it first.
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
    }
    update({
      file: null,
      jobId: null,
      uploadProgress: 0,
      uploadError: null,
      urlDownloadDone: false,
    });
    setUrlError(null);
    setUrlInput("");
    setDownloadStatus(null);
    setDownloadProgress(0);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleUrlSubmit() {
    const url = urlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setUrlError("URL must start with http:// or https://");
      return;
    }
    setSubmittingUrl(true);
    setUrlError(null);
    const loadingId = toast.loading("Looking up link…", url);

    try {
      // Probe first — server tells us whether this is a single video or a
      // playlist. We don't create any DB rows until the user confirms.
      const r = await fetch("/api/jobs/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: url }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        kind?: "video" | "playlist";
        preview?: unknown;
        error?: string;
        code?: string;
      };
      if (!r.ok) {
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }

      if (body.kind === "playlist") {
        // Show the playlist preview card. User clicks "Process all N" to
        // commit; that calls handlePlaylistConfirm below.
        setPlaylistPreview(body.preview as PlaylistPreview);
        toast.dismiss(loadingId);
        return;
      }

      // Single-video flow — same as before. Create the Job synchronously
      // and start the background download.
      const preview = body.preview as
        | {
            title?: string;
            durationSec?: number;
            approxSizeBytes?: number | null;
          }
        | undefined;
      const title = preview?.title ?? url;
      const durationSec = preview?.durationSec ?? 0;
      const approxSize = preview?.approxSizeBytes ?? 0;

      const create = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: url }),
      });
      const created = (await create.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!create.ok || !created.id) {
        throw new Error(created.error ?? `HTTP ${create.status}`);
      }

      update({
        jobId: created.id,
        uploadError: null,
        uploadProgress: 0,
        urlDownloadDone: false,
        file: {
          name: title,
          size: approxSize ?? 0,
          type: "audio/mpeg",
          durationSec,
          kind: "url",
          sourceUrl: url,
        },
      });
      setDownloadStatus("downloading");
      setDownloadProgress(0);

      toast.dismiss(loadingId);
      toast.info(
        "Downloading audio",
        `${title.slice(0, 60)}${title.length > 60 ? "…" : ""}`,
      );
    } catch (err) {
      toast.dismiss(loadingId);
      const message = err instanceof Error ? err.message : String(err);
      setUrlError(message);
      toast.error("Couldn't fetch link", message);
    } finally {
      setSubmittingUrl(false);
    }
  }

  /**
   * User has seen the playlist preview and clicked "Process all N". Spawn
   * the parent + N children server-side, then redirect to home (Recent
   * Jobs) so the user can watch the playlist progress as a single card.
   */
  async function handlePlaylistConfirm() {
    if (!playlistPreview) return;
    const url = urlInput.trim();
    setCreatingPlaylist(true);
    const loadingId = toast.loading(
      "Creating jobs…",
      `${playlistPreview.totalCount} videos`,
    );
    try {
      const r = await fetch("/api/jobs/playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: url }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        parentId?: string;
        childCount?: number;
        skipped?: number;
        error?: string;
      };
      if (!r.ok || !body.parentId) {
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      toast.dismiss(loadingId);
      toast.success(
        "Playlist queued",
        `${body.childCount ?? 0} downloads started${
          body.skipped ? ` · ${body.skipped} skipped` : ""
        }`,
      );
      // Stay on this page — swap the preview card for the inline
      // progress card. User can either watch progress here or click
      // "Open full overview" to go to /new?job=<parentId>.
      setPlaylistPreview(null);
      setPlaylistInFlight({
        parentId: body.parentId,
        title: playlistPreview.title,
        totalCount: body.childCount ?? playlistPreview.entries.length,
      });
    } catch (err) {
      toast.dismiss(loadingId);
      const message = err instanceof Error ? err.message : String(err);
      setUrlError(message);
      toast.error("Couldn't create playlist jobs", message);
    } finally {
      setCreatingPlaylist(false);
    }
  }

  function cancelPlaylistPreview() {
    setPlaylistPreview(null);
    setUrlError(null);
  }

  function dismissPlaylistInFlight() {
    // Important: this DOES NOT cancel the background download — the
    // playlist's children keep processing on the server. Dismissing just
    // hides the inline progress card. The user can still find the
    // playlist on the home page or via /new?job=<parentId>.
    setPlaylistInFlight(null);
    setUrlInput("");
    setUrlError(null);
    toast.info(
      "Hidden",
      "The playlist will keep processing — find it in Recent Jobs.",
    );
  }

  async function retryDownload() {
    if (!jobId) return;
    setDownloadStatus("downloading");
    setDownloadProgress(0);
    try {
      const r = await fetch(`/api/jobs/${jobId}/download`, { method: "POST" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      toast.info("Retrying download", "Trying again…");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Retry failed", message);
      setDownloadStatus("failed");
    }
  }

  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col gap-7 animate-reveal">
      {/* Breadcrumb / back link */}
      <div className="flex items-center gap-3 -mb-2">
        <Link
          href="/"
          className="group inline-flex items-center gap-1.5 text-[13.5px] text-slate-500 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft
            size={13}
            strokeWidth={2}
            className="transition-transform group-hover:-translate-x-0.5"
          />
          Back to home
        </Link>
      </div>

      <StepHeader
        step={1}
        title="Upload your lecture"
        description="Drop a file or paste a YouTube/Vimeo link. We pull just the audio — no full-video download needed."
      />

      {/* Tab switcher — only shown before a job exists. Once a file or URL
          is committed, the source card takes over the panel. */}
      {!file && (
        <div className="flex items-center gap-1 p-1 bg-slate-100/80 rounded-xl w-fit">
          <button
            type="button"
            onClick={() => setTab("file")}
            className={`relative inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[14px] font-medium transition-colors ${
              tab === "file"
                ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(9,9,11,0.08)]"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <UploadCloud size={14} strokeWidth={2} />
            Upload file
          </button>
          <button
            type="button"
            onClick={() => setTab("url")}
            className={`relative inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[14px] font-medium transition-colors ${
              tab === "url"
                ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(9,9,11,0.08)]"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <LinkIcon size={14} strokeWidth={2} />
            Paste link
          </button>
        </div>
      )}

      {!file && tab === "file" && batchInFlight && (
        <BatchProgressInline
          parentId={batchInFlight.parentId}
          title={batchInFlight.title}
          totalCount={batchInFlight.totalCount}
          onDismiss={dismissBatchInFlight}
        />
      )}

      {!file && tab === "file" && !batchInFlight && batchPreview && (
        <BatchPreviewCard
          entries={batchPreview}
          submitting={submittingBatch}
          uploadProgress={batchUploadProgress}
          onConfirm={handleBatchConfirm}
          onCancel={cancelBatchPreview}
        />
      )}

      {!file && tab === "file" && !batchInFlight && !batchPreview && (
        <motion.label
          whileHover={{ scale: 1.003 }}
          transition={{ type: "spring", stiffness: 300, damping: 25 }}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDrop={onDrop}
          className={`relative overflow-hidden cursor-pointer rounded-2xl border-2 border-dashed p-10 md:p-16 flex flex-col items-center justify-center gap-4 text-center transition-all ${
            dragging
              ? "border-fuchsia-500 bg-gradient-to-br from-indigo-50/70 via-fuchsia-50/50 to-rose-50/50 shadow-[0_0_0_8px_rgba(217,70,239,0.08),_0_20px_60px_-20px_rgba(217,70,239,0.3)]"
              : "border-slate-300 bg-white hover:border-indigo-400 hover:bg-gradient-to-br hover:from-slate-50/80 hover:to-indigo-50/30"
          }`}
        >
          {/* Corner glow when dragging */}
          {dragging && (
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none opacity-60"
              style={{
                background:
                  "radial-gradient(40% 40% at 50% 0%, rgba(99,102,241,0.15) 0%, transparent 60%), radial-gradient(40% 40% at 50% 100%, rgba(217,70,239,0.15) 0%, transparent 60%)",
              }}
            />
          )}

          <input
            ref={inputRef}
            type="file"
            accept="video/*,audio/*"
            multiple
            className="hidden"
            onChange={onInputChange}
          />
          <motion.span
            animate={
              dragging
                ? { scale: 1.1, rotate: [0, -4, 4, 0] }
                : { scale: 1, rotate: 0 }
            }
            transition={{ duration: 0.6, ease: "easeInOut" }}
            className={`relative flex items-center justify-center w-20 h-20 rounded-2xl transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] ${
              dragging
                ? "bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-rose-500 text-white shadow-[0_12px_40px_-6px_rgba(217,70,239,0.6),_inset_0_1px_0_rgba(255,255,255,0.25)]"
                : "bg-gradient-to-br from-indigo-50 to-fuchsia-50 text-indigo-600 border border-indigo-100"
            }`}
          >
            <UploadCloud size={34} strokeWidth={1.8} />
          </motion.span>
          <div className="relative flex flex-col gap-2 max-w-md">
            <p className="text-[24px] font-semibold text-slate-900">
              {dragging ? "Release to upload" : "Drop a file here"}
            </p>
            <p className="text-[16.5px] text-slate-500 leading-relaxed">
              or{" "}
              <span className="text-indigo-600 font-medium underline-offset-2 hover:underline">
                browse your computer
              </span>
              . Drop one file or up to 25 to process together.
            </p>
          </div>
          <motion.button
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onPickFile();
            }}
            className="relative mt-3 inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[15.5px] font-medium text-white bg-gradient-to-br from-indigo-600 to-indigo-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(99,102,241,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(99,102,241,0.6)] transition-shadow"
          >
            <FileVideo size={15} strokeWidth={2} />
            Choose file
          </motion.button>

          {/* Accepted formats chips */}
          <div className="relative mt-4 flex items-center gap-1.5 flex-wrap justify-center">
            {["MP4", "MKV", "MOV", "WAV", "MP3"].map((fmt) => (
              <span
                key={fmt}
                className="text-[12px] font-mono font-medium px-2 py-0.5 rounded-md bg-slate-100 text-slate-600"
              >
                {fmt}
              </span>
            ))}
          </div>
        </motion.label>
      )}

      {/* URL paste pane — same panel size as the dropzone */}
      {!file && tab === "url" && playlistInFlight && (
        <PlaylistProgressInline
          parentId={playlistInFlight.parentId}
          title={playlistInFlight.title}
          totalCount={playlistInFlight.totalCount}
          onDismiss={dismissPlaylistInFlight}
        />
      )}

      {!file && tab === "url" && !playlistInFlight && playlistPreview && (
        <PlaylistPreviewCard
          preview={playlistPreview}
          submitting={creatingPlaylist}
          onConfirm={handlePlaylistConfirm}
          onCancel={cancelPlaylistPreview}
        />
      )}

      {!file && tab === "url" && !playlistInFlight && !playlistPreview && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-8 md:p-10"
        >
          <div
            aria-hidden
            className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-indigo-500/8 to-fuchsia-500/8 blur-3xl pointer-events-none"
          />
          <div className="relative flex flex-col items-center gap-5 max-w-xl mx-auto text-center">
            <span className="flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_8px_24px_-6px_rgba(99,102,241,0.5)]">
              <LinkIcon size={28} strokeWidth={1.8} />
            </span>
            <div>
              <p className="text-[20px] font-semibold text-slate-900 leading-tight">
                Paste a lecture or playlist link
              </p>
              <p className="text-[14px] text-slate-500 mt-1.5 leading-relaxed">
                Single video or whole playlist (up to 25 videos). We pull
                just the audio — works with YouTube, Vimeo, Twitch VODs,
                and direct video URLs.
              </p>
            </div>

            <div className="w-full flex flex-col gap-2">
              <div className="relative">
                <LinkIcon
                  size={15}
                  strokeWidth={2}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                />
                <input
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  spellCheck={false}
                  value={urlInput}
                  onChange={(e) => {
                    setUrlInput(e.target.value);
                    if (urlError) setUrlError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !submittingUrl && urlInput.trim()) {
                      e.preventDefault();
                      void handleUrlSubmit();
                    }
                  }}
                  placeholder="https://www.youtube.com/watch?v=..."
                  disabled={submittingUrl}
                  className={`w-full pl-10 pr-3.5 py-3 rounded-lg border bg-white text-[15px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                    urlError
                      ? "border-rose-300 focus:ring-rose-100"
                      : "border-slate-200 focus:border-indigo-500 focus:ring-indigo-100"
                  }`}
                />
              </div>
              {urlError && (
                <p className="text-[13px] text-rose-700 flex items-start gap-1.5 text-left">
                  <AlertTriangle
                    size={12}
                    strokeWidth={2.4}
                    className="mt-0.5 shrink-0"
                  />
                  <span>{urlError}</span>
                </p>
              )}
            </div>

            <motion.button
              whileHover={!submittingUrl ? { y: -1 } : undefined}
              whileTap={{ scale: 0.97 }}
              type="button"
              onClick={handleUrlSubmit}
              disabled={submittingUrl || !urlInput.trim()}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[15px] font-medium text-white bg-gradient-to-br from-indigo-600 via-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(99,102,241,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(99,102,241,0.6)] transition-shadow disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submittingUrl ? (
                <Loader2 size={15} strokeWidth={2} className="animate-spin-slow" />
              ) : (
                <Sparkles size={15} strokeWidth={2} />
              )}
              {submittingUrl ? "Looking up…" : "Fetch lecture"}
            </motion.button>

            <div className="flex items-center gap-1.5 flex-wrap justify-center">
              {["YouTube", "Vimeo", "Twitch", "Direct URL"].map((src) => (
                <span
                  key={src}
                  className="text-[12px] font-medium px-2 py-0.5 rounded-md bg-slate-100 text-slate-600"
                >
                  {src}
                </span>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      {file && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_12px_40px_-16px_rgba(99,102,241,0.2)] p-6"
        >
          <div
            aria-hidden
            className="absolute -right-12 -top-12 w-36 h-36 rounded-full bg-gradient-to-br from-indigo-500/10 to-fuchsia-500/10 blur-2xl"
          />
          <div className="relative flex items-start gap-4">
            <span className="flex items-center justify-center w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-fuchsia-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_6px_18px_-4px_rgba(99,102,241,0.5)]">
              <FileVideo size={24} strokeWidth={1.8} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-3 mb-1.5">
                <p className="text-[20px] font-semibold text-slate-900 break-all leading-snug">
                  {file.name}
                </p>
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                  type="button"
                  onClick={cancelOrClear}
                  className="text-slate-400 hover:text-red-500 transition-colors shrink-0"
                  aria-label={uploading ? "Cancel upload" : "Remove file"}
                  title={uploading ? "Cancel upload" : "Remove file"}
                >
                  <X size={18} strokeWidth={2} />
                </motion.button>
              </div>

              {/* Status line changes based on upload state */}
              {uploadError ? (
                <p className="text-[15.5px] text-rose-700 font-medium flex items-center gap-1.5 mb-5">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gradient-to-br from-rose-500 to-red-500 text-white">
                    <X size={11} strokeWidth={2.8} />
                  </span>
                  Upload failed — {uploadError}
                </p>
              ) : uploading ? (
                <div className="mb-5">
                  <p className="text-[15.5px] text-indigo-700 font-medium flex items-center justify-between gap-2 mb-2">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white">
                        <UploadCloud size={11} strokeWidth={2.4} />
                      </span>
                      Uploading…
                    </span>
                    <span className="nums text-slate-900">
                      {uploadProgress}%
                    </span>
                  </p>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full shimmer-bar rounded-full transition-[width] duration-150"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              ) : file.kind === "url" && downloadStatus === "downloading" ? (
                <div className="mb-5">
                  <p className="text-[15.5px] text-indigo-700 font-medium flex items-center justify-between gap-2 mb-2">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white">
                        <Loader2
                          size={11}
                          strokeWidth={2.4}
                          className="animate-spin-slow"
                        />
                      </span>
                      Downloading audio…
                    </span>
                    <span className="nums text-slate-900">
                      {downloadProgress}%
                    </span>
                  </p>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full shimmer-bar rounded-full"
                      initial={false}
                      animate={{ width: `${downloadProgress}%` }}
                      transition={{ duration: 0.8, ease: "linear" }}
                    />
                  </div>
                </div>
              ) : file.kind === "url" && downloadStatus === "failed" ? (
                <div className="mb-5 flex items-start justify-between gap-3">
                  <p className="text-[15.5px] text-rose-700 font-medium flex items-center gap-1.5">
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gradient-to-br from-rose-500 to-red-500 text-white">
                      <AlertTriangle size={11} strokeWidth={2.4} />
                    </span>
                    Download failed — check the URL and try again
                  </p>
                  <button
                    type="button"
                    onClick={retryDownload}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium text-rose-700 bg-white border border-rose-200 hover:border-rose-300 hover:bg-rose-50 transition-colors"
                  >
                    <RefreshCw size={12} strokeWidth={2} />
                    Retry
                  </button>
                </div>
              ) : (
                <p className="text-[15.5px] text-emerald-700 font-medium flex items-center gap-1.5 mb-5">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 text-white">
                    <Check size={11} strokeWidth={2.8} />
                  </span>
                  {file.kind === "url"
                    ? "Audio ready · skipping straight to transcript"
                    : jobId
                      ? "Uploaded · ready to process"
                      : "Ready to process"}
                  {jobId && (
                    <span className="ml-2 text-[11.5px] text-slate-400 font-mono nums">
                      #{jobId.slice(0, 8)}
                    </span>
                  )}
                </p>
              )}
              <div className="grid grid-cols-3 gap-3">
                <Meta
                  icon={<Clock size={14} strokeWidth={2} />}
                  label="Duration"
                  value={formatDuration(file.durationSec)}
                  hint="estimated"
                  from="from-indigo-500"
                  to="to-blue-500"
                  softFrom="from-indigo-50"
                  softTo="to-blue-50"
                />
                <Meta
                  icon={<HardDrive size={14} strokeWidth={2} />}
                  label="Size"
                  value={formatBytes(file.size)}
                  from="from-fuchsia-500"
                  to="to-pink-500"
                  softFrom="from-fuchsia-50"
                  softTo="to-pink-50"
                />
                <Meta
                  icon={<FileType2 size={14} strokeWidth={2} />}
                  label="Format"
                  value={file.type.split("/")[1]?.toUpperCase() || "VIDEO"}
                  from="from-emerald-500"
                  to="to-teal-500"
                  softFrom="from-emerald-50"
                  softTo="to-teal-50"
                />
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}

function Meta({
  icon,
  label,
  value,
  hint,
  from,
  to,
  softFrom,
  softTo,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  from: string;
  to: string;
  softFrom: string;
  softTo: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br ${softFrom} via-white ${softTo} p-3.5`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br ${from} ${to} text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
        >
          {icon}
        </span>
        <span className="text-[13.5px] text-slate-600 font-medium">
          {label}
        </span>
      </div>
      <span className="text-[17px] font-semibold text-slate-900 nums block">
        {value}
      </span>
      {hint && (
        <span className="text-[13px] text-slate-400 mt-0.5 block">
          {hint}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playlist preview card — shown after the probe step when the user pasted
// a YouTube/Vimeo playlist URL (vs a single video). Lists the entries
// inline and offers a single "Process all N" CTA. Confirming spawns one
// parent Job + N children server-side.
// ---------------------------------------------------------------------------

function PlaylistPreviewCard({
  preview,
  submitting,
  onConfirm,
  onCancel,
}: {
  preview: PlaylistPreview;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const totalDurationSec = preview.entries.reduce(
    (s, e) => s + (e.durationSec ?? 0),
    0,
  );
  const skipped = preview.totalCount - preview.entries.length;
  const tooLong = preview.entries.length > 25;
  // Cost estimate: Whisper $0.006/min + GPT-4o ~$0.07 per video, simple sum.
  const estCost = (
    (totalDurationSec / 60) * 0.006 +
    preview.entries.length * 0.07
  ).toFixed(2);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)]"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-fuchsia-500/8 to-pink-500/8 blur-3xl pointer-events-none"
      />

      {/* Header */}
      <div className="relative p-6 pb-4 flex items-start gap-4 flex-wrap">
        <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-fuchsia-500 via-pink-500 to-rose-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(217,70,239,0.4)]">
          <ListVideo size={22} strokeWidth={1.8} />
        </span>
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-[12px] text-fuchsia-700 uppercase tracking-wide font-semibold">
              Playlist found
            </p>
          </div>
          <p className="text-[19px] font-semibold text-slate-900 break-words leading-snug">
            {preview.title}
          </p>
          <p className="text-[13.5px] text-slate-500 nums leading-tight mt-1">
            {preview.entries.length} videos · {formatDuration(totalDurationSec)}{" "}
            total{skipped > 0 ? ` · ${skipped} unavailable skipped` : ""}
          </p>
        </div>
      </div>

      {/* Entry list */}
      <div className="relative max-h-[300px] overflow-y-auto border-y border-slate-100 bg-slate-50/40 divide-y divide-slate-100">
        {preview.entries.map((entry, i) => (
          <div
            key={entry.id}
            className="flex items-center gap-3 px-6 py-2.5 text-[14px]"
          >
            <span className="font-mono text-[12.5px] text-slate-400 nums tabular-nums shrink-0 w-8 text-right">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="flex-1 truncate text-slate-700">{entry.title}</span>
            <span className="font-mono text-[12.5px] text-slate-500 nums tabular-nums shrink-0">
              {entry.durationSec
                ? formatDuration(entry.durationSec)
                : "—"}
            </span>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="relative p-5 flex items-center gap-3 flex-wrap">
        {tooLong ? (
          <p className="flex-1 min-w-[200px] text-[13.5px] text-rose-700 font-medium flex items-start gap-1.5">
            <AlertTriangle size={14} strokeWidth={2.4} className="mt-0.5 shrink-0" />
            <span>
              Playlist too long — max 25 videos. Cancel and pick individual
              videos instead.
            </span>
          </p>
        ) : (
          <p className="flex-1 min-w-[200px] text-[13px] text-slate-500 leading-relaxed">
            This will create {preview.entries.length} jobs and process them in
            the background. Estimated cost:{" "}
            <span className="font-semibold text-slate-700 nums">~${estCost}</span>{" "}
            in API costs if you push every video through transcription.
          </p>
        )}

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[14px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <motion.button
            whileHover={!submitting && !tooLong ? { y: -1 } : undefined}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={onConfirm}
            disabled={submitting || tooLong}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-[14px] font-medium text-white bg-gradient-to-br from-fuchsia-600 via-pink-600 to-rose-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(217,70,239,0.45)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(217,70,239,0.6)] transition-shadow disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <Loader2 size={14} strokeWidth={2} className="animate-spin-slow" />
            ) : (
              <Sparkles size={14} strokeWidth={2} />
            )}
            {submitting
              ? "Creating jobs…"
              : `Process all ${preview.entries.length} →`}
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Inline playlist progress card — rendered in place of the preview card
// after the user confirms "Process all N". Polls /api/jobs/[id]/playlist
// every 600 ms while children are still working. User can navigate away
// (Recent Jobs / overview page) or dismiss this card; the playlist keeps
// processing on the server either way.
// ---------------------------------------------------------------------------

type InlineChildRow = {
  id: string;
  sourceName: string;
  sourceDurationSec: number | null;
  status: { status: string; progress: number } | null;
};

type InlinePlaylistData = {
  parent: { id: string; sourceName: string; sourceDurationSec: number | null };
  children: InlineChildRow[];
};

function PlaylistProgressInline({
  parentId,
  title,
  totalCount,
  onDismiss,
}: {
  parentId: string;
  title: string;
  totalCount: number;
  onDismiss: () => void;
}) {
  const [data, setData] = useState<InlinePlaylistData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/jobs/${parentId}/playlist`);
        if (!r.ok) return;
        const payload = (await r.json()) as InlinePlaylistData;
        if (!cancelled) setData(payload);
      } catch {
        /* ignore — next tick will retry */
      }
    };
    void load();
    const id = window.setInterval(() => {
      // Stop polling once everything has moved past the download stage.
      setData((prev) => {
        if (
          !prev ||
          prev.children.some(
            (c) => c.status?.status === "downloading",
          )
        ) {
          void load();
        }
        return prev;
      });
    }, 600);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [parentId]);

  const children = data?.children ?? [];
  const total = children.length || totalCount;
  // "Downloading" = a slot has been acquired and yt-dlp emitted its first
  // 1% bump. "Queued" = waiting for a slot; progress=0 stays at 0 until
  // it's the row's turn. We split them so the user sees exactly which
  // child is actively running (with concurrency=1, only one at a time).
  const downloadingCount = children.filter(
    (c) =>
      c.status?.status === "downloading" && (c.status?.progress ?? 0) > 0,
  ).length;
  const queuedCount = children.filter(
    (c) =>
      c.status?.status === "downloading" && (c.status?.progress ?? 0) === 0,
  ).length;
  const doneCount = children.filter((c) =>
    ["transcript", "clean", "split", "render", "done"].includes(
      c.status?.status ?? "",
    ),
  ).length;
  const failedCount = children.filter(
    (c) => c.status?.status === "failed",
  ).length;
  const overallPct = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  const allDone = total > 0 && doneCount === total;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)]"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-fuchsia-500/8 to-pink-500/8 blur-3xl pointer-events-none"
      />

      {/* Header */}
      <div className="relative p-5 flex items-start gap-4 flex-wrap">
        <span
          className={`flex items-center justify-center w-12 h-12 rounded-xl text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(217,70,239,0.4)] ${
            allDone
              ? "bg-gradient-to-br from-emerald-500 to-teal-500"
              : "bg-gradient-to-br from-fuchsia-500 via-pink-500 to-rose-500"
          }`}
        >
          {allDone ? (
            <Check size={22} strokeWidth={2.4} />
          ) : (
            <ListVideo size={22} strokeWidth={1.8} />
          )}
        </span>
        <div className="flex-1 min-w-[200px]">
          <p className="text-[12px] text-fuchsia-700 uppercase tracking-wide font-semibold mb-0.5">
            {allDone ? "Playlist ready" : "Processing playlist"}
          </p>
          <p className="text-[18px] font-semibold text-slate-900 break-words leading-snug">
            {data?.parent.sourceName ?? title}
          </p>
          <p className="text-[12.5px] text-slate-500 mt-1 nums leading-tight">
            <span className="font-semibold text-slate-700">
              {doneCount} / {total}
            </span>{" "}
            done
            {downloadingCount > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="text-indigo-700 font-medium">
                  {downloadingCount} downloading
                </span>
              </>
            )}
            {queuedCount > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="text-slate-600 font-medium">
                  {queuedCount} waiting
                </span>
              </>
            )}
            {failedCount > 0 && (
              <>
                {" "}
                · <span className="text-rose-700 font-medium">{failedCount} failed</span>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss progress card"
          title="Hide this card (the playlist keeps processing)"
          className="text-slate-400 hover:text-slate-700 transition-colors shrink-0"
        >
          <X size={18} strokeWidth={2} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="relative px-5 pb-3">
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <motion.div
            initial={false}
            animate={{ width: `${overallPct}%` }}
            transition={{ duration: 0.7, ease: "linear" }}
            className={`h-full rounded-full ${
              allDone
                ? "bg-gradient-to-r from-emerald-500 to-teal-500"
                : "shimmer-bar"
            }`}
          />
        </div>
      </div>

      {/* Compact child list */}
      <div className="relative max-h-[260px] overflow-y-auto border-t border-slate-100 bg-slate-50/40 divide-y divide-slate-100">
        {children.length === 0 ? (
          <div className="px-5 py-6 text-center text-[13px] text-slate-500 inline-flex items-center justify-center gap-2 w-full">
            <Loader2 size={13} strokeWidth={2} className="animate-spin-slow" />
            Loading…
          </div>
        ) : (
          children.map((child, i) => {
            const status = child.status?.status ?? "downloading";
            const progress = child.status?.progress ?? 0;
            const isDone = ["transcript", "clean", "split", "render", "done"].includes(
              status,
            );
            const isFailed = status === "failed";
            // With concurrency=1, queued children stay at progress=0 until
            // their turn. The runner emits a 1% bump the moment it acquires
            // its slot, but yt-dlp then takes ~5-8 s fetching the YouTube
            // manifest before its first real percent line lands. Three
            // visible states:
            //   progress=0  → Waiting in queue
            //   progress=1  → Starting download (warm-up window)
            //   progress>1  → Downloading (live percent ticking)
            const isQueued = status === "downloading" && progress === 0;
            const isStarting = status === "downloading" && progress === 1;
            const isDownloading =
              status === "downloading" && progress > 1 && progress < 100;
            return (
              <div
                key={child.id}
                className="flex items-center gap-3 px-5 py-2.5 text-[13.5px]"
              >
                <span className="font-mono text-[12px] text-slate-400 nums tabular-nums shrink-0 w-7 text-right">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex-1 truncate text-slate-700">
                  {child.sourceName}
                </span>
                <span className="shrink-0">
                  {isDone ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-emerald-50 text-emerald-700 border-emerald-100">
                      <Check size={9} strokeWidth={2.6} />
                      Ready
                    </span>
                  ) : isFailed ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-rose-50 text-rose-700 border-rose-100">
                      <AlertTriangle size={9} strokeWidth={2.6} />
                      Failed
                    </span>
                  ) : isStarting ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-indigo-50 text-indigo-700 border-indigo-100">
                      <Loader2
                        size={9}
                        strokeWidth={2.6}
                        className="animate-spin-slow"
                      />
                      Starting…
                    </span>
                  ) : isDownloading ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-indigo-50 text-indigo-700 border-indigo-100 nums">
                      <Loader2
                        size={9}
                        strokeWidth={2.6}
                        className="animate-spin-slow"
                      />
                      {progress}%
                    </span>
                  ) : isQueued ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-slate-100 text-slate-500 border-slate-200">
                      <Clock size={9} strokeWidth={2.6} />
                      Waiting
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-slate-100 text-slate-500 border-slate-200">
                      Waiting
                    </span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="relative p-4 flex items-center gap-3 flex-wrap border-t border-slate-100">
        <p className="flex-1 min-w-[200px] text-[12px] text-slate-500 leading-relaxed">
          You can navigate away — the playlist keeps processing in the
          background. Find it in <span className="font-semibold text-slate-700">Recent Jobs</span>.
        </p>
        <Link
          href={`/new?job=${parentId}`}
          className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13.5px] font-medium text-white bg-gradient-to-br from-fuchsia-600 via-pink-600 to-rose-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_2px_8px_-2px_rgba(217,70,239,0.4)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_6px_18px_-4px_rgba(217,70,239,0.6)] transition-shadow"
        >
          <ListVideo size={13} strokeWidth={2} />
          Open full overview
          <ArrowRight size={13} strokeWidth={2.2} />
        </Link>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Multi-file BATCH UI — preview card + inline progress card. Mirrors the
// playlist components above; only the labelling, icons, and the "starting
// step" differ (batches start at audio-extract, playlists at download).
// ---------------------------------------------------------------------------

function BatchPreviewCard({
  entries,
  submitting,
  uploadProgress,
  onConfirm,
  onCancel,
}: {
  entries: BatchEntry[];
  submitting: boolean;
  uploadProgress: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const totalDurationSec = entries.reduce(
    (s, e) => s + (e.durationSec ?? 0),
    0,
  );
  const totalSize = entries.reduce((s, e) => s + e.file.size, 0);
  const tooMany = entries.length > 25;
  // Cost estimate: Whisper $0.006/min + GPT-4o ~$0.07 per video, simple sum.
  const estCost = (
    (totalDurationSec / 60) * 0.006 +
    entries.length * 0.07
  ).toFixed(2);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)]"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-indigo-500/8 to-fuchsia-500/8 blur-3xl pointer-events-none"
      />

      {/* Header */}
      <div className="relative p-6 pb-4 flex items-start gap-4 flex-wrap">
        <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-fuchsia-500 text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(99,102,241,0.4)]">
          <FileVideo size={22} strokeWidth={1.8} />
        </span>
        <div className="flex-1 min-w-[200px]">
          <p className="text-[12px] text-indigo-700 uppercase tracking-wide font-semibold mb-0.5">
            Multi-file batch
          </p>
          <p className="text-[19px] font-semibold text-slate-900 leading-snug">
            {entries.length} files ready to upload
          </p>
          <p className="text-[13.5px] text-slate-500 nums leading-tight mt-1">
            {formatBytes(totalSize)} total
            {totalDurationSec > 0 && (
              <> · {formatDuration(totalDurationSec)} total</>
            )}
          </p>
        </div>
      </div>

      {/* Entry list */}
      <div className="relative max-h-[300px] overflow-y-auto border-y border-slate-100 bg-slate-50/40 divide-y divide-slate-100">
        {entries.map((entry, i) => (
          <div
            key={`${entry.file.name}-${i}`}
            className="flex items-center gap-3 px-6 py-2.5 text-[14px]"
          >
            <span className="font-mono text-[12.5px] text-slate-400 nums tabular-nums shrink-0 w-8 text-right">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="flex-1 truncate text-slate-700">
              {entry.file.name}
            </span>
            <span className="font-mono text-[12.5px] text-slate-400 nums tabular-nums shrink-0">
              {formatBytes(entry.file.size)}
            </span>
            <span className="font-mono text-[12.5px] text-slate-500 nums tabular-nums shrink-0 min-w-[56px] text-right">
              {entry.durationSec != null
                ? formatDuration(entry.durationSec)
                : "—"}
            </span>
          </div>
        ))}
      </div>

      {/* Upload progress bar — only visible during the actual XHR upload */}
      {submitting && (
        <div className="relative px-6 pt-4">
          <p className="text-[12.5px] text-indigo-700 font-medium flex items-center justify-between gap-2 mb-1.5 nums">
            <span className="flex items-center gap-1.5">
              <Loader2 size={11} strokeWidth={2.4} className="animate-spin-slow" />
              Uploading {entries.length} files…
            </span>
            <span className="text-slate-900">{uploadProgress}%</span>
          </p>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full shimmer-bar rounded-full transition-[width] duration-150"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="relative p-5 flex items-center gap-3 flex-wrap">
        {tooMany ? (
          <p className="flex-1 min-w-[200px] text-[13.5px] text-rose-700 font-medium flex items-start gap-1.5">
            <AlertTriangle size={14} strokeWidth={2.4} className="mt-0.5 shrink-0" />
            <span>
              Too many files — max 25 per batch. Cancel and pick a smaller
              set.
            </span>
          </p>
        ) : (
          <p className="flex-1 min-w-[200px] text-[13px] text-slate-500 leading-relaxed">
            This will create {entries.length} jobs and extract audio one at
            a time. Estimated cost:{" "}
            <span className="font-semibold text-slate-700 nums">~${estCost}</span>{" "}
            in API costs if you push every file through transcription.
          </p>
        )}

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[14px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <motion.button
            whileHover={!submitting && !tooMany ? { y: -1 } : undefined}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={onConfirm}
            disabled={submitting || tooMany}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-[14px] font-medium text-white bg-gradient-to-br from-indigo-600 via-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_4px_14px_-2px_rgba(99,102,241,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_8px_22px_-4px_rgba(99,102,241,0.6)] transition-shadow disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <Loader2 size={14} strokeWidth={2} className="animate-spin-slow" />
            ) : (
              <Sparkles size={14} strokeWidth={2} />
            )}
            {submitting ? "Uploading…" : `Process all ${entries.length} →`}
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}

type InlineBatchData = {
  parent: { id: string; sourceName: string; sourceDurationSec: number | null };
  children: InlineChildRow[];
};

function BatchProgressInline({
  parentId,
  title,
  totalCount,
  onDismiss,
}: {
  parentId: string;
  title: string;
  totalCount: number;
  onDismiss: () => void;
}) {
  const [data, setData] = useState<InlineBatchData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/jobs/${parentId}/batch`);
        if (!r.ok) return;
        const payload = (await r.json()) as InlineBatchData;
        if (!cancelled) setData(payload);
      } catch {
        /* ignore — next tick will retry */
      }
    };
    void load();
    const id = window.setInterval(() => {
      // Keep polling while ANY child is still on the audio step. Once
      // every child has moved past `audio`, stop hitting the server.
      setData((prev) => {
        if (
          !prev ||
          prev.children.some((c) => c.status?.status === "audio")
        ) {
          void load();
        }
        return prev;
      });
    }, 600);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [parentId]);

  const children = data?.children ?? [];
  const total = children.length || totalCount;
  // For batches the "active" step is audio-extract. Keep the same
  // queued / starting / ticking split as the playlist UI.
  const extractingCount = children.filter(
    (c) =>
      c.status?.status === "audio" && (c.status?.progress ?? 0) > 0,
  ).length;
  const queuedCount = children.filter(
    (c) =>
      c.status?.status === "audio" && (c.status?.progress ?? 0) === 0,
  ).length;
  const doneCount = children.filter((c) =>
    ["transcript", "clean", "split", "render", "done"].includes(
      c.status?.status ?? "",
    ),
  ).length;
  const failedCount = children.filter(
    (c) => c.status?.status === "failed",
  ).length;
  const overallPct = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  const allDone = total > 0 && doneCount === total;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)]"
    >
      <div
        aria-hidden
        className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-gradient-to-br from-indigo-500/8 to-fuchsia-500/8 blur-3xl pointer-events-none"
      />

      {/* Header */}
      <div className="relative p-5 flex items-start gap-4 flex-wrap">
        <span
          className={`flex items-center justify-center w-12 h-12 rounded-xl text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-4px_rgba(99,102,241,0.4)] ${
            allDone
              ? "bg-gradient-to-br from-emerald-500 to-teal-500"
              : "bg-gradient-to-br from-indigo-500 via-indigo-600 to-fuchsia-500"
          }`}
        >
          {allDone ? (
            <Check size={22} strokeWidth={2.4} />
          ) : (
            <FileVideo size={22} strokeWidth={1.8} />
          )}
        </span>
        <div className="flex-1 min-w-[200px]">
          <p className="text-[12px] text-indigo-700 uppercase tracking-wide font-semibold mb-0.5">
            {allDone ? "Batch ready" : "Processing batch"}
          </p>
          <p className="text-[18px] font-semibold text-slate-900 break-words leading-snug">
            {data?.parent.sourceName ?? title}
          </p>
          <p className="text-[12.5px] text-slate-500 mt-1 nums leading-tight">
            <span className="font-semibold text-slate-700">
              {doneCount} / {total}
            </span>{" "}
            done
            {extractingCount > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="text-indigo-700 font-medium">
                  {extractingCount} extracting
                </span>
              </>
            )}
            {queuedCount > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="text-slate-600 font-medium">
                  {queuedCount} waiting
                </span>
              </>
            )}
            {failedCount > 0 && (
              <>
                {" "}
                · <span className="text-rose-700 font-medium">{failedCount} failed</span>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss progress card"
          title="Hide this card (the batch keeps processing)"
          className="text-slate-400 hover:text-slate-700 transition-colors shrink-0"
        >
          <X size={18} strokeWidth={2} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="relative px-5 pb-3">
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <motion.div
            initial={false}
            animate={{ width: `${overallPct}%` }}
            transition={{ duration: 0.7, ease: "linear" }}
            className={`h-full rounded-full ${
              allDone
                ? "bg-gradient-to-r from-emerald-500 to-teal-500"
                : "shimmer-bar"
            }`}
          />
        </div>
      </div>

      {/* Compact child list */}
      <div className="relative max-h-[260px] overflow-y-auto border-t border-slate-100 bg-slate-50/40 divide-y divide-slate-100">
        {children.length === 0 ? (
          <div className="px-5 py-6 text-center text-[13px] text-slate-500 inline-flex items-center justify-center gap-2 w-full">
            <Loader2 size={13} strokeWidth={2} className="animate-spin-slow" />
            Loading…
          </div>
        ) : (
          children.map((child, i) => {
            const status = child.status?.status ?? "audio";
            const progress = child.status?.progress ?? 0;
            const isDone = ["transcript", "clean", "split", "render", "done"].includes(
              status,
            );
            const isFailed = status === "failed";
            // With concurrency=1, queued children stay at progress=0 until
            // their turn. ffmpeg.ts emits a 1% bump on slot acquire, then
            // ticks real percent as encoding progresses.
            const isQueued = status === "audio" && progress === 0;
            const isStarting = status === "audio" && progress === 1;
            const isExtracting =
              status === "audio" && progress > 1 && progress < 100;
            return (
              <div
                key={child.id}
                className="flex items-center gap-3 px-5 py-2.5 text-[13.5px]"
              >
                <span className="font-mono text-[12px] text-slate-400 nums tabular-nums shrink-0 w-7 text-right">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex-1 truncate text-slate-700">
                  {child.sourceName}
                </span>
                <span className="shrink-0">
                  {isDone ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-emerald-50 text-emerald-700 border-emerald-100">
                      <Check size={9} strokeWidth={2.6} />
                      Ready
                    </span>
                  ) : isFailed ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-rose-50 text-rose-700 border-rose-100">
                      <AlertTriangle size={9} strokeWidth={2.6} />
                      Failed
                    </span>
                  ) : isStarting ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-indigo-50 text-indigo-700 border-indigo-100">
                      <Loader2
                        size={9}
                        strokeWidth={2.6}
                        className="animate-spin-slow"
                      />
                      Starting…
                    </span>
                  ) : isExtracting ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-indigo-50 text-indigo-700 border-indigo-100 nums">
                      <Loader2
                        size={9}
                        strokeWidth={2.6}
                        className="animate-spin-slow"
                      />
                      {progress}%
                    </span>
                  ) : isQueued ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-slate-100 text-slate-500 border-slate-200">
                      <Clock size={9} strokeWidth={2.6} />
                      Waiting
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wide border bg-slate-100 text-slate-500 border-slate-200">
                      Waiting
                    </span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="relative p-4 flex items-center gap-3 flex-wrap border-t border-slate-100">
        <p className="flex-1 min-w-[200px] text-[12px] text-slate-500 leading-relaxed">
          You can navigate away — the batch keeps processing in the
          background. Find it in <span className="font-semibold text-slate-700">Recent Jobs</span>.
        </p>
        <Link
          href={`/new?job=${parentId}`}
          className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13.5px] font-medium text-white bg-gradient-to-br from-indigo-600 via-indigo-600 to-fuchsia-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_2px_8px_-2px_rgba(99,102,241,0.4)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_0_6px_18px_-4px_rgba(99,102,241,0.6)] transition-shadow"
        >
          <FileVideo size={13} strokeWidth={2} />
          Open full overview
          <ArrowRight size={13} strokeWidth={2.2} />
        </Link>
      </div>
    </motion.div>
  );
}
