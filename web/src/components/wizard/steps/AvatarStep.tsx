"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Play,
  Download,
  Loader2,
  Check,
  User,
  Clock,
  Sparkles,
  Upload,
  Film,
  PenLine,
  X,
  AlertTriangle,
  RefreshCw,
  Layers,
  Combine,
  Square,
} from "lucide-react";
import { useWizard } from "../WizardContext";
import { formatDuration } from "@/lib/utils";
import { StepHeader } from "../StepHeader";
import {
  VideoPreviewModal,
  type VideoPreviewData,
} from "@/components/ui/VideoPreviewModal";
import { useToast } from "@/components/ui/Toast";

const AVATARS = [
  { id: "atlas-04",  name: "Atlas",   style: "Neutral professor",     tone: "Warm",       hue: 220 },
  { id: "nova-02",   name: "Nova",    style: "Upbeat presenter",      tone: "Energetic",  hue: 15  },
  { id: "sage-07",   name: "Sage",    style: "Calm scholar",          tone: "Calm",       hue: 160 },
  { id: "kai-01",    name: "Kai",     style: "Modern instructor",     tone: "Clear",      hue: 280 },
  { id: "juno-03",   name: "Juno",    style: "Documentary narrator",  tone: "Deep",       hue: 45  },
  { id: "river-05",  name: "River",   style: "Conversational tutor",  tone: "Friendly",   hue: 190 },
];

// Map a voices-fetch failure to a single short, user-facing line.
// The raw error from HeyGen can be a JSON blob, an HTML error page from
// a CDN, or an SDK string — none of which are appropriate for the UI.
function formatVoicesError(
  status: number,
  code: string | undefined,
  raw: string | undefined,
): string {
  if (code === "E_HEYGEN_AUTH" || status === 503) {
    return "HeyGen API key not configured. Add HEYGEN_API_KEY to web/.env.local and restart the server.";
  }
  if (status === 502 || status === 504) {
    return "HeyGen is taking too long to respond — temporary upstream issue. Try again in a moment.";
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(raw ?? "")) {
    return "HeyGen rate limit reached. Wait ~30 seconds and try again.";
  }
  if (status === 0 || /fetch failed|network/i.test(raw ?? "")) {
    return "Couldn't reach HeyGen — network issue or HeyGen is down. Retry in a moment.";
  }
  if (status === 404) {
    return "HeyGen voices endpoint returned 404. Their API may have changed; please report this.";
  }
  // Generic fallback — show the HTTP code only, NEVER the raw HTML/JSON.
  return `HeyGen voices unavailable (HTTP ${status || "??"}). Retry in a moment.`;
}

type HeyGenVoiceOption = {
  voiceId: string;
  name: string;
  gender: string;
  language: string;
  previewUrl?: string;
};

export function AvatarStep() {
  const {
    jobId,
    chunks,
    renders,
    selectedAvatarId,
    selectedVoiceId,
    voiceGenderFilter,
    voiceSpeed,
    renderStyle,
    instructorPhotoKey,
    instructorPhotoPreviewUrl,
    update,
    updateRender,
  } = useWizard();
  const [voiceCatalogue, setVoiceCatalogue] = useState<HeyGenVoiceOption[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  // Voice preview playback. The catalogue ships preview_audio mp3 URLs;
  // we stream them through a single hidden <audio> so only one preview
  // plays at a time and the button can show Stop while playing.
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewPlayingVoiceId, setPreviewPlayingVoiceId] = useState<
    string | null
  >(null);

  function playVoicePreview(voiceId: string, url: string | undefined) {
    if (!url) return;
    const audio = previewAudioRef.current;
    if (!audio) return;
    // Toggle: clicking Play on the currently-playing voice stops it.
    if (previewPlayingVoiceId === voiceId && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      setPreviewPlayingVoiceId(null);
      return;
    }
    audio.src = url;
    audio.currentTime = 0;
    void audio
      .play()
      .then(() => setPreviewPlayingVoiceId(voiceId))
      .catch(() => setPreviewPlayingVoiceId(null));
  }
  const [generating, setGenerating] = useState(false);
  const timeoutsRef = useRef<number[]>([]);
  const [preview, setPreview] = useState<VideoPreviewData | null>(null);
  const toast = useToast();

  // Used by the (mocked) video-preview modal to colour the placeholder.
  // The preset-avatar grid was removed when we shipped the three render
  // styles — we still keep the hue palette for the preview tile until
  // Step 6 is wired to a real provider that returns thumbnail URLs.
  const activeAvatar = AVATARS.find((a) => a.id === selectedAvatarId) ?? AVATARS[0];

  // Hydrate chunks when this step is entered directly (e.g. ?job=<id> deep
  // link or a refresh on step 6). SplitStep normally writes chunks into
  // wizard context, but if the user never rendered Step 5 in this session
  // the array is empty and the "No chunks to render" empty-state shows
  // until they go back + forward. Fetch the latest ready segment_run for
  // this job once and project to TopicChunk[] matching SplitStep's shape.
  useEffect(() => {
    if (!jobId || chunks.length > 0) return;
    let cancelled = false;
    void fetch(`/api/jobs/${jobId}/chunks`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            chunks?: Array<{
              id: string;
              topic: string;
              startSec: number;
              endSec: number;
              wordCount: number;
              preview: string;
              text?: string;
              enrichedText?: string | null;
              level?: string;
              duplicateOfChunkId?: string | null;
            }>;
          } | null,
        ) => {
          if (cancelled || !data?.chunks) return;
          const projected = data.chunks
            .filter(
              (c) =>
                (c.level ?? "planet") === "planet" && !c.duplicateOfChunkId,
            )
            .map((c) => {
              const narrationText = c.enrichedText ?? c.text ?? "";
              return {
                id: c.id,
                topic: c.topic,
                startSec: c.startSec,
                endSec: c.endSec,
                wordCount: c.wordCount,
                preview: c.preview,
                narrationChars: narrationText.length,
              };
            });
          if (projected.length > 0) update({ chunks: projected });
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, chunks.length]);

  // Hydrate persisted render prefs once on mount so a refresh restores
  // the user's style choice + uploaded photo + voice + speed.
  useEffect(() => {
    if (!jobId) return;
    void fetch(`/api/jobs/${jobId}/render-prefs`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            renderStyle?: string;
            instructorPhotoKey?: string | null;
            voiceId?: string | null;
            voiceSpeed?: number | null;
          } | null,
        ) => {
          if (!data) return;
          const patch: Partial<Parameters<typeof update>[0]> = {};
          if (
            data.renderStyle === "instructor" ||
            data.renderStyle === "animated" ||
            data.renderStyle === "whiteboard"
          ) {
            patch.renderStyle = data.renderStyle;
          }
          if (data.instructorPhotoKey) {
            patch.instructorPhotoKey = data.instructorPhotoKey;
          }
          if (typeof data.voiceId === "string" && data.voiceId.length > 0) {
            patch.selectedVoiceId = data.voiceId;
          }
          if (
            typeof data.voiceSpeed === "number" &&
            data.voiceSpeed >= 0.5 &&
            data.voiceSpeed <= 2.0
          ) {
            patch.voiceSpeed = data.voiceSpeed;
          }
          if (Object.keys(patch).length > 0) update(patch);
        },
      )
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Fetch the HeyGen voice catalogue. Server-side caches for 1 hour so
  // this is cheap to re-fire on Retry after a transient HeyGen blip.
  const loadVoices = useCallback(async () => {
    setVoicesLoading(true);
    setVoicesError(null);
    try {
      const r = await fetch(`/api/heygen/voices`);
      const json = (await r.json().catch(() => null)) as {
        voices?: HeyGenVoiceOption[];
        error?: string;
        code?: string;
      } | null;
      if (!r.ok) {
        setVoicesError(formatVoicesError(r.status, json?.code, json?.error));
        return;
      }
      setVoiceCatalogue(json?.voices ?? []);
      setVoicesError(null);
    } catch (err) {
      setVoicesError(
        formatVoicesError(
          0,
          undefined,
          err instanceof Error ? err.message : String(err),
        ),
      );
    } finally {
      setVoicesLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadVoices();
  }, [loadVoices]);

  // PATCH /api/jobs/[id]/render-prefs whenever voice or speed changes,
  // so a refresh restores them. Debounced via the parent's update().
  async function persistVoicePref(patch: {
    voiceId?: string | null;
    voiceSpeed?: number;
  }) {
    if (!jobId) return;
    try {
      await fetch(`/api/jobs/${jobId}/render-prefs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch {
      // non-fatal — local state is the source of truth for the current
      // session; persistence is just for the refresh case.
    }
  }


  // Server-side Render row map: chunkId → renderId. Lets us
  // construct the per-chunk file URL (/api/jobs/[id]/render/[renderId]/file)
  // when the user clicks Preview / Download.
  const [renderIdByChunk, setRenderIdByChunk] = useState<
    Record<string, string>
  >({});

  // Per-chunk render status + error from the poller. The wizard's
  // RenderState only carries progress/ready, which can't tell a FAILED
  // render (stuck at e.g. 10%) apart from one that's actively rendering.
  // Tracking status here lets the row show "Failed + Retry" instead of a
  // perpetual spinner.
  type PartInfo = {
    id: string;
    idx: number;
    status: string;
    progress: number;
    outputKey: string | null;
    durationSec: number | null;
    charLength: number | null;
    errorMessage: string | null;
  };
  const [statusByChunk, setStatusByChunk] = useState<
    Record<
      string,
      {
        status: string;
        errorMessage: string | null;
        totalParts: number | null;
        currentPart: number | null;
        parts: PartInfo[];
      }
    >
  >({});

  function openPreview(chunkIndex: number) {
    const c = chunks[chunkIndex];
    if (!c) return;
    const rid = renderIdByChunk[c.id];
    const videoUrl =
      rid && jobId
        ? `/api/jobs/${jobId}/render/${rid}/file`
        : undefined;
    setPreview({
      index: chunkIndex + 1,
      topic: c.topic,
      durationSec: c.endSec - c.startSec,
      avatarHue: activeAvatar.hue,
      avatarName: activeAvatar.name,
      wordCount: c.wordCount,
      videoUrl,
    });
  }

  function handleDownloadOne(chunkIndex: number) {
    const c = chunks[chunkIndex];
    if (!c) return;
    const rid = renderIdByChunk[c.id];
    if (!rid || !jobId) {
      toast.error("Not ready", "Render hasn't finished yet");
      return;
    }
    // The file route honours ?download=1 by setting Content-Disposition.
    window.open(
      `/api/jobs/${jobId}/render/${rid}/file?download=1`,
      "_blank",
      "noopener,noreferrer",
    );
    toast.download("Download started", `${c.topic} · MP4`);
  }

  function handleDownloadAll() {
    const ready = Object.values(renders).filter((r) => r.ready).length;
    if (ready === 0 || !jobId) return;
    // Best-effort: open each ready file in a new tab. The browser
    // queues them. A real zip flow could be added later.
    for (const c of chunks) {
      const rid = renderIdByChunk[c.id];
      const r = renders[c.id];
      if (rid && r?.ready) {
        window.open(
          `/api/jobs/${jobId}/render/${rid}/file?download=1`,
          "_blank",
          "noopener,noreferrer",
        );
      }
    }
    toast.download(`Downloading ${ready} videos`, "Tabs opening per chunk");
  }

  useEffect(() => {
    if (!selectedAvatarId) {
      update({ selectedAvatarId: AVATARS[0].id });
    }
    // No mock timers to clean up anymore — server-side runner owns the
    // render lifecycle. Polling is the only thing the UI does.
  }, [selectedAvatarId, update]);

  // ─── Server polling: GET /api/jobs/[id]/render every 2 sec while any
  // render is non-terminal. Stops once everything is ready/failed.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: number | null = null;

    type Part = {
      id: string;
      idx: number;
      status: string;
      progress: number;
      outputKey: string | null;
      durationSec: number | null;
      charLength: number | null;
      errorCode: string | null;
      errorMessage: string | null;
    };
    type Row = {
      id: string;
      chunkId: string;
      status: string;
      progress: number;
      outputKey: string | null;
      videoUrl: string | null;
      errorMessage: string | null;
      totalParts: number | null;
      currentPart: number | null;
      parts: Part[];
    };

    const tick = async () => {
      try {
        const resp = await fetch(`/api/jobs/${jobId}/render`);
        if (!resp.ok) return;
        const body = (await resp.json()) as { renders: Row[] };
        if (cancelled) return;
        const idMap: Record<string, string> = {};
        const statusMap: Record<
          string,
          {
            status: string;
            errorMessage: string | null;
            totalParts: number | null;
            currentPart: number | null;
            parts: PartInfo[];
          }
        > = {};
        const seenChunkIds = new Set<string>();
        for (const r of body.renders) {
          idMap[r.chunkId] = r.id;
          statusMap[r.chunkId] = {
            status: r.status,
            errorMessage: r.errorMessage,
            totalParts: r.totalParts,
            currentPart: r.currentPart,
            parts: (r.parts ?? []).map((p) => ({
              id: p.id,
              idx: p.idx,
              status: p.status,
              progress: p.progress,
              outputKey: p.outputKey,
              durationSec: p.durationSec,
              charLength: p.charLength,
              errorMessage: p.errorMessage,
            })),
          };
          seenChunkIds.add(r.chunkId);
          updateRender(r.chunkId, {
            progress: r.progress,
            ready: r.status === "ready",
          });
        }
        // Reset chunks whose render row VANISHED (cleared from DB) — without
        // this, local state stays frozen at the last-seen progress (e.g.
        // optimistic 15% from a render row that's since been deleted), and
        // the chunk shows a stuck spinner. Reset to idle so the per-chunk
        // Generate button comes back.
        for (const c of chunks) {
          if (!seenChunkIds.has(c.id) && renders[c.id]) {
            updateRender(c.id, { progress: 0, ready: false });
          }
        }
        setRenderIdByChunk(idMap);
        setStatusByChunk(statusMap);

        // Keep polling while any render is mid-pipeline OR awaiting user
        // merge — we need to see the parts_ready → merging → ready
        // transition after the user clicks Merge. Polling stops only
        // when every render is in a final state (ready / failed /
        // cancelled).
        const anyInFlight = body.renders.some(
          (r) =>
            r.status === "pending" ||
            r.status === "uploading" ||
            r.status === "rendering" ||
            r.status === "parts_ready" ||
            r.status === "merging",
        );
        if (!anyInFlight) {
          setGenerating(false);
          if (timer) {
            window.clearInterval(timer);
            timer = null;
          }
        }
      } catch {
        /* transient — next tick retries */
      }
    };

    void tick();
    timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
    // `generating` is a dep so the poller RESTARTS when a render is kicked
    // off (generateOne/generateAll flip it true). Without this, once the
    // loop sees nothing in flight and clears its interval, a render started
    // later would never be polled and the UI freezes on the optimistic 1%.
  }, [jobId, updateRender, generating]);

  async function generateAll() {
    if (chunks.length === 0 || !jobId) return;
    setGenerating(true);
    toast.info("Rendering started", `${chunks.length} videos · HeyGen`);

    try {
      const resp = await fetch(`/api/jobs/${jobId}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const body = (await resp.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          /* ignore */
        }
        setGenerating(false);
        toast.error("Couldn't start render", msg);
        return;
      }
      // The poller (useEffect above) will keep updating UI state until
      // everything is ready. We don't need to do anything more here.
    } catch (err) {
      setGenerating(false);
      toast.error(
        "Couldn't start render",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Render a SINGLE chunk. Sends just that chunk's id so HeyGen cost is
  // spent one video at a time. The poller picks up its progress.
  async function generateOne(chunkId: string, topic: string) {
    if (!jobId) return;
    // Optimistically flip this chunk to "in progress" (progress=1) so
    // the row shows "Rendering" immediately, before the first poll.
    updateRender(chunkId, { progress: 1, ready: false });
    setGenerating(true);
    toast.info("Rendering started", topic);
    try {
      const resp = await fetch(`/api/jobs/${jobId}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkIds: [chunkId] }),
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const body = (await resp.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          /* ignore */
        }
        updateRender(chunkId, { progress: 0, ready: false });
        toast.error("Couldn't start render", msg);
      }
    } catch (err) {
      updateRender(chunkId, { progress: 0, ready: false });
      toast.error(
        "Couldn't start render",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Triggered by the per-chunk "Merge All Parts" button once the runner
  // has dropped the Render row to status="parts_ready". POSTs to the
  // merge endpoint; backend ffmpeg-concats the parts in idx order, writes
  // output.mp4, and the row flips to status="ready" (Play/Download light
  // up). The UI keeps polling through "merging" until "ready" lands.
  async function mergeChunk(renderId: string, topic: string) {
    if (!jobId) return;
    try {
      const resp = await fetch(
        `/api/jobs/${jobId}/render/${renderId}/merge`,
        { method: "POST" },
      );
      if (!resp.ok && resp.status !== 202) {
        let msg = `HTTP ${resp.status}`;
        try {
          const body = (await resp.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          /* ignore */
        }
        toast.error("Couldn't merge", msg);
        return;
      }
      toast.info("Merging parts…", topic);
    } catch (err) {
      toast.error(
        "Couldn't merge",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Open the preview modal for ONE part of a chunk (used before merge).
  // Streams via the /parts/[idx]/file endpoint just like the final-output
  // /file endpoint does after merge.
  function previewPart(
    renderId: string,
    idx: number,
    topic: string,
    durationSec: number | null,
  ) {
    if (!jobId) return;
    setPreview({
      index: idx + 1,
      topic: `${topic} — Part ${idx + 1}`,
      durationSec: durationSec ?? 0,
      avatarHue: activeAvatar.hue,
      avatarName: activeAvatar.name,
      wordCount: 0,
      videoUrl: `/api/jobs/${jobId}/render/${renderId}/parts/${idx}/file`,
    });
  }

  function downloadPart(renderId: string, idx: number, topic: string) {
    if (!jobId) return;
    window.open(
      `/api/jobs/${jobId}/render/${renderId}/parts/${idx}/file?download=1`,
      "_blank",
      "noopener,noreferrer",
    );
    toast.download(`Downloading Part ${idx + 1}`, topic);
  }

  // Stop every in-flight render for this job. The DELETE flips
  // pending/uploading/rendering rows to "cancelled"; the runner notices
  // at its next checkpoint, breaks out of the parts loop, and ffmpeg-
  // concats whatever parts it already downloaded into a partial output
  // mp4 (flips status back to "ready" with a "Stopped at Part X of N"
  // note). User keeps the value of credits they've already paid for
  // instead of throwing it away.
  async function cancelGeneration() {
    if (!jobId) return;
    try {
      const resp = await fetch(`/api/jobs/${jobId}/render`, { method: "DELETE" });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const body = (await resp.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          /* ignore */
        }
        toast.error("Couldn't stop", msg);
        return;
      }
      setGenerating(false);
      toast.info(
        "Stopping render…",
        "Saving any parts that finished — Preview will appear once concat completes",
      );
    } catch (err) {
      toast.error(
        "Couldn't stop",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Stop just ONE chunk's in-flight render. Same DELETE semantics as
  // cancelGeneration but with a chunkIds filter so other chunks in the
  // job (e.g. a Generate-all batch) keep running.
  async function cancelChunk(chunkId: string, topic: string) {
    if (!jobId) return;
    try {
      const resp = await fetch(`/api/jobs/${jobId}/render`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkIds: [chunkId] }),
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const body = (await resp.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch { /* ignore */ }
        toast.error("Couldn't stop", msg);
        return;
      }
      toast.info("Stopping render…", topic);
    } catch (err) {
      toast.error(
        "Couldn't stop",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const readyCount = Object.values(renders).filter((r) => r.ready).length;
  const totalCount = chunks.length;
  // Genuinely in-flight (excludes failed/cancelled, which the old
  // progress>0 check wrongly counted as rendering).
  const anyRendering =
    generating ||
    Object.values(statusByChunk).some(
      (s) =>
        s.status === "pending" ||
        s.status === "uploading" ||
        s.status === "rendering",
    );

  // Generate-all gating. Only the "instructor" style is wired to a real
  // provider (HeyGen Talking Photo); animated + whiteboard return 501 on
  // the server, so we don't let the user spend a click on them yet. They
  // also require an uploaded photo.
  const canGenerate =
    totalCount > 0 &&
    renderStyle === "instructor" &&
    !!instructorPhotoKey;
  // Reason the Generate button is disabled, shown as its tooltip.
  const generateBlockedReason =
    totalCount === 0
      ? "No chunks to render"
      : renderStyle !== "instructor"
        ? "Animated and Whiteboard styles are coming soon — use Instructor for now."
        : !instructorPhotoKey
          ? "Upload an instructor photo first"
          : undefined;

  return (
    <div className="max-w-5xl mx-auto w-full flex flex-col gap-7 animate-reveal">
      <StepHeader
        step={6}
        title="Render avatar videos"
        description={`Pick an avatar and voice, then generate a narrated video for each of your ${totalCount} topic chunks.`}
        actions={
          <div className="flex items-center gap-2">
            {readyCount > 0 && (
              <motion.button
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.97 }}
                type="button"
                onClick={handleDownloadAll}
                disabled={readyCount === 0}
                title="Download all rendered videos as a zip"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[14.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
              >
                <Download size={14} strokeWidth={2} />
                Download all ({readyCount})
              </motion.button>
            )}
            {generating && (
              <motion.button
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.97 }}
                type="button"
                onClick={cancelGeneration}
                title="Stop the render — already-generated parts will be saved as partial output"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[14.5px] font-medium text-rose-700 bg-white border border-rose-200 hover:bg-rose-50 hover:border-rose-300 transition-colors shadow-sm"
              >
                <X size={14} strokeWidth={2.2} />
                Stop
              </motion.button>
            )}
            <motion.button
              whileHover={
                !generating && canGenerate ? { y: -1 } : undefined
              }
              whileTap={
                !generating && canGenerate ? { scale: 0.97 } : undefined
              }
              type="button"
              onClick={generateAll}
              disabled={generating || !canGenerate}
              title={generateBlockedReason}
              className={`relative inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[14.5px] font-medium text-white transition-shadow ${
                generating || !canGenerate
                  ? "bg-slate-300 cursor-not-allowed shadow-none"
                  : "bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_14px_-2px_rgba(16,185,129,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_8px_22px_-4px_rgba(16,185,129,0.6)]"
              }`}
            >
              {generating ? (
                <>
                  <Loader2
                    size={14}
                    strokeWidth={2}
                    className="animate-spin-slow"
                  />
                  Generating…
                </>
              ) : (
                <>
                  <Sparkles size={14} strokeWidth={2} />
                  {readyCount > 0 ? "Regenerate all" : "Generate all"}
                </>
              )}
            </motion.button>
          </div>
        }
      />

      {/* ─── Render-style picker ─────────────────────────────────────
          Three modes the user picks before generating. When
          "instructor" is selected, the instructor-photo upload appears
          inline; the other two styles need no extra input. The
          selection is persisted on the Job row via
          PATCH /api/jobs/[id]/render-prefs so a refresh restores it. */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] p-5"
      >
        <p className="text-[13.5px] text-slate-500 font-semibold uppercase tracking-wide mb-3.5 flex items-center gap-1.5">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
            <Sparkles size={12} strokeWidth={2} />
          </span>
          Choose a render style
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <StyleCard
            id="instructor"
            active={renderStyle === "instructor"}
            title="Instructor"
            description="Upload a photo and an AI talking-head avatar narrates each chunk in that instructor's likeness."
            badge="Photo required"
            accent="from-indigo-500 to-fuchsia-500"
            icon={<User size={16} strokeWidth={2.2} />}
            onClick={() => {
              update({ renderStyle: "instructor" });
              if (jobId) {
                void fetch(`/api/jobs/${jobId}/render-prefs`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ renderStyle: "instructor" }),
                }).catch(() => {});
              }
            }}
          />
          <StyleCard
            id="animated"
            active={renderStyle === "animated"}
            title="Animated"
            description="Illustrated explainer with motion graphics. Narrator voice over animated scenes built from each chunk."
            badge="Coming soon"
            accent="from-rose-500 to-orange-500"
            icon={<Film size={16} strokeWidth={2.2} />}
            onClick={() => {
              update({ renderStyle: "animated" });
              if (jobId) {
                void fetch(`/api/jobs/${jobId}/render-prefs`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ renderStyle: "animated" }),
                }).catch(() => {});
              }
            }}
          />
          <StyleCard
            id="whiteboard"
            active={renderStyle === "whiteboard"}
            title="Whiteboard"
            description="Voiceover narrating an animated whiteboard. Words and diagrams sketch themselves as the script unfolds."
            badge="Coming soon"
            accent="from-sky-500 to-cyan-500"
            icon={<PenLine size={16} strokeWidth={2.2} />}
            onClick={() => {
              update({ renderStyle: "whiteboard" });
              if (jobId) {
                void fetch(`/api/jobs/${jobId}/render-prefs`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ renderStyle: "whiteboard" }),
                }).catch(() => {});
              }
            }}
          />
        </div>

        {/* ─── Instructor photo upload (only for "instructor" style) ── */}
        <AnimatePresence initial={false}>
          {renderStyle === "instructor" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              <div className="mt-5">
                <InstructorPhotoUpload
                  jobId={jobId}
                  instructorPhotoKey={instructorPhotoKey}
                  instructorPhotoPreviewUrl={instructorPhotoPreviewUrl}
                  onUploaded={(key, previewUrl) =>
                    update({
                      instructorPhotoKey: key,
                      instructorPhotoPreviewUrl: previewUrl,
                    })
                  }
                  onRemove={() =>
                    update({
                      instructorPhotoKey: null,
                      instructorPhotoPreviewUrl: null,
                    })
                  }
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Voice + speed picker (only meaningful when renderStyle === "instructor") */}
      <AnimatePresence initial={false}>
        {renderStyle === "instructor" && (
          <motion.div
            initial={{ opacity: 0, y: 6, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: 6, height: 0 }}
            transition={{ duration: 0.3 }}
            className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] overflow-hidden"
          >
            <div className="px-5 py-3 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
              <p className="text-[15px] font-semibold text-slate-900 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                  <User size={13} strokeWidth={2} />
                </span>
                Voice & speed
              </p>
            </div>
            <div className="p-5 space-y-4">
              {/* Gender filter chips */}
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wider">
                  Filter
                </span>
                {(["all", "male", "female"] as const).map((g) => {
                  const active = voiceGenderFilter === g;
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() => update({ voiceGenderFilter: g })}
                      className={`px-3 py-1 rounded-full text-[12.5px] font-semibold transition-colors ${
                        active
                          ? "bg-violet-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      {g[0].toUpperCase() + g.slice(1)}
                    </button>
                  );
                })}
                <div className="ml-auto inline-flex items-center gap-2 text-[12px] text-slate-500">
                  {voicesLoading ? (
                    <span className="inline-flex items-center gap-1.5 text-slate-600">
                      <Loader2
                        size={12}
                        strokeWidth={2.2}
                        className="animate-spin-slow"
                      />
                      Loading voices…
                    </span>
                  ) : voicesError ? (
                    <span className="inline-flex items-center gap-1.5 text-rose-600">
                      <AlertTriangle size={12} strokeWidth={2.2} />
                      Could not load voices
                    </span>
                  ) : (
                    <span className="nums">
                      {voiceCatalogue.filter(
                        (v) =>
                          voiceGenderFilter === "all" ||
                          v.gender.toLowerCase() === voiceGenderFilter,
                      ).length}{" "}
                      of {voiceCatalogue.length} voices
                    </span>
                  )}
                </div>
              </div>

              {/* Inline error banner with Retry — only renders when fetch
                  failed. Shows the user-facing message from formatVoicesError,
                  never the raw HeyGen JSON / HTML body. */}
              {voicesError && !voicesLoading && (
                <div className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px]">
                  <AlertTriangle
                    size={16}
                    strokeWidth={2.2}
                    className="text-rose-600 shrink-0 mt-0.5"
                  />
                  <div className="flex-1 min-w-0 text-rose-900">
                    {voicesError}
                  </div>
                  <motion.button
                    whileHover={{ y: -1 }}
                    whileTap={{ scale: 0.97 }}
                    type="button"
                    onClick={() => void loadVoices()}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-semibold text-white bg-gradient-to-br from-rose-500 to-orange-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_2px_8px_-2px_rgba(244,63,94,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_12px_-2px_rgba(244,63,94,0.6)] transition-shadow"
                  >
                    <RefreshCw size={11} strokeWidth={2.2} />
                    Retry
                  </motion.button>
                </div>
              )}

              {/* Voice select + preview play button */}
              <div className="flex items-center gap-3">
                <label className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wider min-w-[60px]">
                  Voice
                </label>
                <select
                  value={selectedVoiceId ?? ""}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    update({ selectedVoiceId: v });
                    void persistVoicePref({ voiceId: v });
                    // Stop any in-flight preview when the user changes voice.
                    const audio = previewAudioRef.current;
                    if (audio && !audio.paused) {
                      audio.pause();
                      audio.currentTime = 0;
                      setPreviewPlayingVoiceId(null);
                    }
                  }}
                  disabled={voicesLoading || !!voicesError}
                  className="flex-1 px-3 py-2 rounded-lg border border-slate-200 bg-white text-[14px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50"
                >
                  <option value="">Default voice (John Doe)</option>
                  {voiceCatalogue
                    .filter(
                      (v) =>
                        voiceGenderFilter === "all" ||
                        v.gender.toLowerCase() === voiceGenderFilter,
                    )
                    .map((v) => {
                      const gender =
                        v.gender.charAt(0).toUpperCase() +
                        v.gender.slice(1).toLowerCase();
                      return (
                        <option key={v.voiceId} value={v.voiceId}>
                          {v.name}
                          {gender ? ` (${gender})` : ""}
                        </option>
                      );
                    })}
                </select>
                {(() => {
                  const selected = voiceCatalogue.find(
                    (v) => v.voiceId === selectedVoiceId,
                  );
                  const hasPreview = !!selected?.previewUrl;
                  const isPlaying =
                    selected && previewPlayingVoiceId === selected.voiceId;
                  return (
                    <motion.button
                      whileHover={hasPreview ? { y: -1 } : undefined}
                      whileTap={{ scale: 0.97 }}
                      type="button"
                      onClick={() =>
                        selected &&
                        playVoicePreview(selected.voiceId, selected.previewUrl)
                      }
                      disabled={!hasPreview}
                      title={
                        !selected
                          ? "Pick a voice first to preview"
                          : !hasPreview
                            ? "No preview audio available for this voice"
                            : isPlaying
                              ? "Stop preview"
                              : "Play preview"
                      }
                      className="inline-flex items-center justify-center w-10 h-10 rounded-lg text-white bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_2px_8px_-2px_rgba(168,85,247,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_12px_-2px_rgba(168,85,247,0.6)] transition-shadow disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
                    >
                      {isPlaying ? (
                        <Square size={14} strokeWidth={2.4} />
                      ) : (
                        <Play size={14} strokeWidth={2.4} />
                      )}
                    </motion.button>
                  );
                })()}
              </div>
              {/* Hidden audio element drives the preview. Single instance
                  → only one voice plays at a time. */}
              <audio
                ref={previewAudioRef}
                onEnded={() => setPreviewPlayingVoiceId(null)}
                onPause={() => {
                  const a = previewAudioRef.current;
                  if (a && a.currentTime === 0) {
                    setPreviewPlayingVoiceId(null);
                  }
                }}
                hidden
              />
              <p className="text-[12px] text-slate-500 -mt-1">
                Voices with ▶ have an audio preview. Pick a voice and hit Play
                to hear it before rendering.
              </p>

              {/* Speed slider */}
              <div className="flex items-center gap-3">
                <label className="text-[12.5px] font-semibold text-slate-500 uppercase tracking-wider min-w-[60px]">
                  Speed
                </label>
                <input
                  type="range"
                  min={0.8}
                  max={1.5}
                  step={0.05}
                  value={voiceSpeed}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    update({ voiceSpeed: v });
                  }}
                  onMouseUp={(e) => {
                    void persistVoicePref({
                      voiceSpeed: Number((e.target as HTMLInputElement).value),
                    });
                  }}
                  onTouchEnd={(e) => {
                    void persistVoicePref({
                      voiceSpeed: Number((e.target as HTMLInputElement).value),
                    });
                  }}
                  className="flex-1 accent-violet-600"
                />
                <span className="nums tabular-nums text-[13px] font-semibold text-slate-700 min-w-[44px] text-right">
                  {voiceSpeed.toFixed(2)}x
                </span>
              </div>
              <p className="text-[12px] text-slate-500">
                Hint: 1.00× is natural narration. 1.15–1.25× sounds noticeably brisker without affecting clarity. HeyGen accepts 0.5–2.0.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Per-chunk progress list */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.2 }}
        className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04)] overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
          <p className="text-[15px] font-semibold text-slate-900 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
              <Sparkles size={13} strokeWidth={2} />
            </span>
            Chunks to render
          </p>
          <p className="text-[14px] text-slate-600 font-medium inline-flex items-center gap-1.5">
            <span
              className={`nums font-bold text-[18px] ${
                readyCount === totalCount && totalCount > 0
                  ? "text-emerald-600"
                  : "text-slate-900"
              }`}
            >
              {readyCount}
            </span>
            <span className="text-slate-400">/</span>
            <span className="nums">{totalCount}</span>
            <span className="text-slate-500">ready</span>
          </p>
        </div>
        <div className="divide-y divide-slate-100">
          {chunks.map((c, i) => {
            const r = renders[c.id] ?? { progress: 0, ready: false };
            const meta = statusByChunk[c.id];
            const isReady = r.ready || meta?.status === "ready";
            const isFailed =
              meta?.status === "failed" || meta?.status === "cancelled";
            // Running = not done, not failed, and either the server says it's
            // in flight OR we optimistically bumped progress before the first
            // poll (no status yet).
            // Parts loop finished, all parts saved, waiting for user to
            // click Merge. UI shows the per-part Play buttons + a "Merge
            // All Parts" CTA.
            const isPartsReady = meta?.status === "parts_ready";
            // Merge endpoint is running its ffmpeg-concat in the background.
            const isMerging = meta?.status === "merging";
            const isRunning =
              !isReady &&
              !isFailed &&
              !isPartsReady &&
              !isMerging &&
              (meta?.status === "pending" ||
                meta?.status === "uploading" ||
                meta?.status === "rendering" ||
                (!meta && r.progress > 0));
            const duration = c.endSec - c.startSec;
            // Show the parts list whenever the runner has touched at least
            // one part — during streaming, after handoff to user, and
            // through the merge phase.
            const showPartsList =
              (isRunning || isPartsReady || isMerging) &&
              (meta?.parts?.length ?? 0) > 0;
            const renderIdForThis = renderIdByChunk[c.id];
            return (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: 0.02 * i }}
                className="px-5 py-4 flex flex-col gap-3 hover:bg-slate-50/60 transition-colors"
              >
                <div className="flex items-center gap-4">
                <span
                  className="flex items-center justify-center w-9 h-9 rounded-xl text-white text-[14px] font-semibold nums shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_2px_8px_-2px_rgba(15,23,42,0.25)]"
                  style={{
                    backgroundImage: `linear-gradient(135deg, hsl(${(i * 55) % 360} 72% 55%), hsl(${(i * 55 + 35) % 360} 72% 45%))`,
                  }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[16px] font-semibold text-slate-900 truncate">
                    {c.topic}
                  </p>
                  <p className="text-[13.5px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} strokeWidth={2} />
                      <span className="nums">{formatDuration(duration)}</span>
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="nums">
                      {c.wordCount.toLocaleString()} words
                    </span>
                    {typeof c.narrationChars === "number" && c.narrationChars > 0 && (
                      <>
                        <span className="text-slate-300">·</span>
                        <span
                          className="nums inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-violet-50 text-violet-700 border border-violet-100 font-semibold"
                          title={`HeyGen will see ${c.narrationChars.toLocaleString()} chars from this chunk's narration script. At 2,800 chars per part, this generates ${Math.max(1, Math.ceil(c.narrationChars / 2800))} HeyGen video part${Math.ceil(c.narrationChars / 2800) === 1 ? "" : "s"}.`}
                        >
                          {c.narrationChars.toLocaleString()} chars
                          <span className="text-violet-400 font-normal">
                            · {Math.max(1, Math.ceil(c.narrationChars / 2800))} parts
                          </span>
                        </span>
                      </>
                    )}
                  </p>
                  {/* Inline failure / cancellation reason — surfaces the
                      server's errorMessage so the user knows WHY without
                      hovering the small Failed pill. Trimmed to one line. */}
                  {isFailed && meta?.errorMessage && (
                    <p
                      className="text-[12.5px] text-rose-600 mt-1 truncate"
                      title={meta.errorMessage}
                    >
                      <span className="font-semibold">
                        {meta.status === "cancelled" ? "Cancelled:" : "Error:"}
                      </span>{" "}
                      {meta.errorMessage}
                    </p>
                  )}
                </div>

                <div className="hidden md:flex items-center gap-3 w-56 shrink-0">
                  <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${isFailed ? 100 : r.progress}%` }}
                      transition={{ duration: 0.3 }}
                      className={`h-full rounded-full ${
                        isReady
                          ? "bg-gradient-to-r from-emerald-500 to-teal-500 shadow-[0_0_10px_rgba(16,185,129,0.4)]"
                          : isFailed
                            ? "bg-gradient-to-r from-rose-500 to-orange-500"
                            : "shimmer-bar"
                      }`}
                    />
                  </div>
                  <span
                    className={`text-[13px] font-mono nums w-10 text-right font-semibold ${
                      isReady
                        ? "text-emerald-600"
                        : isFailed
                          ? "text-rose-600"
                          : "text-slate-500"
                    }`}
                  >
                    {isFailed ? "—" : `${r.progress}%`}
                  </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {isReady ? (
                    <>
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.92 }}
                        type="button"
                        onClick={() => openPreview(i)}
                        className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-600 hover:text-white hover:bg-gradient-to-br hover:from-indigo-500 hover:to-fuchsia-500 transition-colors"
                        aria-label="Preview video"
                        title="Preview video"
                      >
                        <Play size={14} strokeWidth={0} fill="currentColor" />
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.92 }}
                        type="button"
                        onClick={() => handleDownloadOne(i)}
                        className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-600 hover:text-white hover:bg-gradient-to-br hover:from-emerald-500 hover:to-teal-500 transition-colors"
                        aria-label="Download MP4"
                        title="Download MP4"
                      >
                        <Download size={14} strokeWidth={2} />
                      </motion.button>
                    </>
                  ) : isFailed ? (
                    // Failed / cancelled → red pill + Retry. Without this a
                    // failed render (stuck progress, not ready) would render
                    // as a perpetual "Rendering" spinner.
                    <div className="flex items-center gap-1.5">
                      <span
                        title={meta?.errorMessage ?? undefined}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12.5px] font-semibold text-rose-700 bg-rose-50 border border-rose-100"
                      >
                        <AlertTriangle size={12} strokeWidth={2.2} />
                        {meta?.status === "cancelled" ? "Cancelled" : "Failed"}
                      </span>
                      <motion.button
                        whileHover={canGenerate ? { y: -1 } : undefined}
                        whileTap={{ scale: 0.97 }}
                        type="button"
                        onClick={() => void generateOne(c.id, c.topic)}
                        disabled={!canGenerate}
                        title={generateBlockedReason ?? "Retry this render"}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-semibold text-white bg-gradient-to-br from-rose-500 to-orange-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_2px_8px_-2px_rgba(244,63,94,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_12px_-2px_rgba(244,63,94,0.6)] transition-shadow disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
                      >
                        <RefreshCw size={12} strokeWidth={2.2} />
                        Retry
                      </motion.button>
                    </div>
                  ) : isPartsReady && renderIdForThis ? (
                    // All parts done (or stopped). Show the Merge button so
                    // the user can stitch them into a final output.mp4.
                    <motion.button
                      whileHover={{ y: -1 }}
                      whileTap={{ scale: 0.97 }}
                      type="button"
                      onClick={() => void mergeChunk(renderIdForThis, c.topic)}
                      title="Stitch all ready parts into one MP4"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-semibold text-white bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_2px_8px_-2px_rgba(168,85,247,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_12px_-2px_rgba(168,85,247,0.6)] transition-shadow"
                    >
                      <Combine size={12} strokeWidth={2.2} />
                      Merge {(meta?.parts ?? []).filter((p) => p.status === "ready").length} parts
                    </motion.button>
                  ) : isMerging ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12.5px] font-semibold text-violet-700 bg-violet-50 border border-violet-100">
                      <Loader2
                        size={12}
                        strokeWidth={2.2}
                        className="animate-spin-slow"
                      />
                      Merging…
                    </span>
                  ) : isRunning ? (
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12.5px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-100">
                        <Loader2
                          size={12}
                          strokeWidth={2.2}
                          className="animate-spin-slow"
                        />
                        {meta?.totalParts && meta.totalParts > 1
                          ? `Part ${meta.currentPart ?? 1} of ${meta.totalParts}`
                          : "Rendering"}
                      </span>
                      <motion.button
                        whileHover={{ y: -1 }}
                        whileTap={{ scale: 0.97 }}
                        type="button"
                        onClick={() => void cancelChunk(c.id, c.topic)}
                        title="Stop rendering this chunk (keeps any parts already finished)"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-semibold text-rose-700 bg-white border border-rose-200 hover:bg-rose-50 hover:border-rose-300 transition-colors"
                      >
                        <Square size={11} strokeWidth={2.4} />
                        Stop
                      </motion.button>
                    </div>
                  ) : (
                    // Idle / not-yet-started → per-chunk Generate button.
                    // Renders just this one chunk so HeyGen cost is spent one
                    // video at a time. Disabled until the style is supported
                    // and an instructor photo is uploaded.
                    <motion.button
                      whileHover={canGenerate ? { y: -1 } : undefined}
                      whileTap={{ scale: 0.97 }}
                      type="button"
                      onClick={() => void generateOne(c.id, c.topic)}
                      disabled={!canGenerate}
                      title={generateBlockedReason ?? "Generate this video"}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-semibold text-white bg-gradient-to-br from-emerald-500 to-teal-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_2px_8px_-2px_rgba(16,185,129,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_12px_-2px_rgba(16,185,129,0.6)] transition-shadow disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
                    >
                      <Sparkles size={12} strokeWidth={2} />
                      Generate
                    </motion.button>
                  )}
                </div>
                </div>
                {showPartsList && renderIdForThis && (
                  <div className="pl-12 pr-1">
                    <div className="rounded-lg border border-slate-200 bg-slate-50/60 overflow-hidden">
                      <div className="px-3 py-2 border-b border-slate-200 bg-white flex items-center justify-between">
                        <p className="text-[12px] uppercase tracking-wide font-semibold text-slate-600 inline-flex items-center gap-1.5">
                          <Layers size={12} strokeWidth={2.2} />
                          {(meta?.parts ?? []).length} parts
                        </p>
                        <p className="text-[12px] text-slate-500">
                          {(meta?.parts ?? []).filter((p) => p.status === "ready").length} ready
                        </p>
                      </div>
                      <div className="divide-y divide-slate-100">
                        {(meta?.parts ?? []).map((part) => {
                          const partReady = part.status === "ready";
                          const partFailed =
                            part.status === "failed" ||
                            part.status === "cancelled";
                          const partRunning =
                            part.status === "uploading" ||
                            part.status === "rendering";
                          return (
                            <div
                              key={part.id}
                              className="px-3 py-2 flex items-center gap-3"
                            >
                              <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 nums shrink-0">
                                {String(part.idx + 1).padStart(2, "0")}
                              </span>
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] font-medium text-slate-800">
                                  Part {part.idx + 1}
                                  {part.charLength != null && (
                                    <span className="text-slate-400 font-normal ml-1.5">
                                      · {part.charLength.toLocaleString()} chars
                                    </span>
                                  )}
                                  {part.durationSec != null &&
                                    part.durationSec > 0 && (
                                      <span className="text-slate-400 font-normal ml-1.5">
                                        · {formatDuration(part.durationSec)}
                                      </span>
                                    )}
                                </p>
                                <div className="mt-1 h-1 bg-slate-200 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all duration-300 ${
                                      partReady
                                        ? "bg-emerald-500 w-full"
                                        : partFailed
                                          ? "bg-rose-500 w-full"
                                          : "bg-gradient-to-r from-indigo-400 to-fuchsia-400"
                                    }`}
                                    style={
                                      partReady || partFailed
                                        ? undefined
                                        : { width: `${part.progress}%` }
                                    }
                                  />
                                </div>
                                {partFailed && part.errorMessage && (
                                  <p
                                    className="text-[11.5px] text-rose-600 mt-1 truncate"
                                    title={part.errorMessage}
                                  >
                                    {part.errorMessage}
                                  </p>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {partReady ? (
                                  <>
                                    <motion.button
                                      whileHover={{ scale: 1.08 }}
                                      whileTap={{ scale: 0.95 }}
                                      type="button"
                                      onClick={() =>
                                        previewPart(
                                          renderIdForThis,
                                          part.idx,
                                          c.topic,
                                          part.durationSec,
                                        )
                                      }
                                      title={`Preview Part ${part.idx + 1}`}
                                      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-600 hover:text-white hover:bg-gradient-to-br hover:from-indigo-500 hover:to-fuchsia-500 transition-colors"
                                    >
                                      <Play
                                        size={11}
                                        strokeWidth={0}
                                        fill="currentColor"
                                      />
                                    </motion.button>
                                    <motion.button
                                      whileHover={{ scale: 1.08 }}
                                      whileTap={{ scale: 0.95 }}
                                      type="button"
                                      onClick={() =>
                                        downloadPart(
                                          renderIdForThis,
                                          part.idx,
                                          c.topic,
                                        )
                                      }
                                      title={`Download Part ${part.idx + 1}`}
                                      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-600 hover:text-white hover:bg-gradient-to-br hover:from-emerald-500 hover:to-teal-500 transition-colors"
                                    >
                                      <Download size={11} strokeWidth={2} />
                                    </motion.button>
                                  </>
                                ) : partFailed ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-100">
                                    Failed
                                  </span>
                                ) : partRunning ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-100 nums">
                                    {part.progress}%
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-slate-500 bg-white border border-slate-200">
                                    queued
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>

        <AnimatePresence>
          {readyCount === totalCount && totalCount > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="px-5 py-4 bg-gradient-to-br from-emerald-50 to-teal-50/60 border-t border-emerald-200 flex items-center gap-3"
            >
              <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                <Check size={15} strokeWidth={2.5} />
              </span>
              <p className="text-[15px] text-emerald-800 font-semibold">
                All {totalCount} chunks rendered. Ready to download.
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {readyCount === 0 && !anyRendering && (
          <div className="px-5 py-10 text-center text-slate-400 text-[15px] bg-gradient-to-b from-white to-slate-50/50">
            No renders yet. Click{" "}
            <span className="text-slate-700 font-semibold">Generate all</span> to
            start.
          </div>
        )}
      </motion.div>

      <VideoPreviewModal
        open={preview !== null}
        onClose={() => setPreview(null)}
        data={preview}
      />
    </div>
  );
}

function AvatarTile({
  hue,
  name,
  active,
}: {
  hue: number;
  name: string;
  active: boolean;
}) {
  const bgFrom = `hsl(${hue} 72% ${active ? 48 : 54}%)`;
  const bgTo = `hsl(${(hue + 30) % 360} 76% ${active ? 32 : 38}%)`;
  const initial = name[0];
  return (
    <div
      className="w-full h-full flex items-center justify-center relative"
      style={{
        backgroundImage: `linear-gradient(135deg, ${bgFrom}, ${bgTo})`,
      }}
    >
      <div
        className="absolute inset-0 opacity-35 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.6), transparent 55%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-20 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at 70% 90%, rgba(0,0,0,0.4), transparent 50%)",
        }}
      />
      <span className="relative text-white text-[36px] font-semibold tracking-tight drop-shadow-[0_2px_6px_rgba(0,0,0,0.25)]">
        {initial}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// StyleCard — one of three render-style options at Step 6.
// ─────────────────────────────────────────────────────────────────────────

function StyleCard({
  active,
  title,
  description,
  badge,
  accent,
  icon,
  onClick,
}: {
  id: "instructor" | "animated" | "whiteboard";
  active: boolean;
  title: string;
  description: string;
  badge: string;
  accent: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={!active ? { y: -2 } : undefined}
      whileTap={{ scale: 0.985 }}
      className={`relative text-left rounded-2xl border p-4 transition-all overflow-hidden ${
        active
          ? "border-indigo-500 bg-indigo-50/40 ring-2 ring-indigo-100 shadow-[0_4px_18px_-4px_rgba(99,102,241,0.3)]"
          : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-[0_1px_2px_rgba(9,9,11,0.04),_0_8px_20px_-10px_rgba(15,23,42,0.2)]"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex items-center justify-center w-10 h-10 rounded-xl shrink-0 text-white bg-gradient-to-br ${accent} shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_10px_-3px_rgba(15,23,42,0.25)]`}
        >
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <p
            className={`text-[15.5px] font-semibold leading-snug ${
              active ? "text-indigo-700" : "text-slate-900"
            }`}
          >
            {title}
          </p>
          <p className="text-[12.5px] text-slate-500 leading-snug mt-1">
            {description}
          </p>
          <span
            className={`inline-flex items-center mt-2.5 px-2 py-0.5 rounded-md text-[10.5px] font-semibold uppercase tracking-wide border ${
              active
                ? "bg-indigo-100 text-indigo-700 border-indigo-200"
                : "bg-slate-50 text-slate-500 border-slate-200"
            }`}
          >
            {badge}
          </span>
        </div>
        <AnimatePresence>
          {active && (
            <motion.span
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 18 }}
              className="absolute top-3 right-3 w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white flex items-center justify-center shadow-[0_4px_10px_-2px_rgba(99,102,241,0.5)]"
            >
              <Check size={12} strokeWidth={2.8} />
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </motion.button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// InstructorPhotoUpload — drag/drop or click-to-pick a single photo.
// ─────────────────────────────────────────────────────────────────────────
//
// Uploads to POST /api/jobs/[id]/instructor-photo and shows a live
// preview (blob URL) until the user navigates away. After successful
// upload, the server-side `instructorPhotoKey` is persisted on the Job
// row — a refresh re-loads via GET /api/jobs/[id]/instructor-photo.

// JPEG/PNG only — HeyGen's Talking Photo API rejects WebP, so the server
// upload route does too. Keep the client validation in sync.
const ALLOWED_PHOTO_TYPES = new Set(["image/jpeg", "image/png"]);
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

function InstructorPhotoUpload({
  jobId,
  instructorPhotoKey,
  instructorPhotoPreviewUrl,
  onUploaded,
  onRemove,
}: {
  jobId: string | null;
  instructorPhotoKey: string | null;
  instructorPhotoPreviewUrl: string | null;
  onUploaded: (key: string, previewUrl: string) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Effective preview URL: prefer the freshly-uploaded blob URL (instant
  // feedback, no network). Fall back to the persisted server-side photo
  // (e.g. after page refresh) by streaming the GET endpoint.
  const previewSrc =
    instructorPhotoPreviewUrl ??
    (instructorPhotoKey && jobId
      ? `/api/jobs/${jobId}/instructor-photo`
      : null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || !jobId) return;
    const f = files[0];
    setError(null);
    if (!ALLOWED_PHOTO_TYPES.has(f.type)) {
      setError("Use a JPEG or PNG image.");
      return;
    }
    if (f.size > PHOTO_MAX_BYTES) {
      setError("Photo is too large (max 10 MB).");
      return;
    }

    setUploading(true);
    setProgress(0);
    try {
      // XHR for upload progress (fetch doesn't expose upload bytes).
      const key = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const form = new FormData();
        form.append("photo", f);
        xhr.open("POST", `/api/jobs/${jobId}/instructor-photo`);
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const body = JSON.parse(xhr.responseText) as { key?: string };
              if (body.key) return resolve(body.key);
              return reject(new Error("Server returned no key"));
            } catch (err) {
              return reject(
                new Error(
                  err instanceof Error ? err.message : "Bad server response",
                ),
              );
            }
          }
          try {
            const body = JSON.parse(xhr.responseText) as { error?: string };
            reject(new Error(body.error ?? `HTTP ${xhr.status}`));
          } catch {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.send(form);
      });

      const previewUrl = URL.createObjectURL(f);
      onUploaded(key, previewUrl);
      setProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function clickToPick() {
    if (uploading) return;
    inputRef.current?.click();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-indigo-50/30 via-white to-fuchsia-50/20 p-4">
      <p className="text-[13px] text-slate-600 font-semibold uppercase tracking-wide mb-2.5 flex items-center gap-1.5">
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
          <User size={12} strokeWidth={2.2} />
        </span>
        Instructor photo
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {previewSrc ? (
        <div className="flex items-center gap-4">
          <div className="relative w-24 h-24 rounded-xl overflow-hidden border border-slate-200 bg-slate-100 shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewSrc}
              alt="Uploaded instructor portrait"
              className="w-full h-full object-cover"
            />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14.5px] text-slate-900 font-semibold flex items-center gap-2">
              <Check
                size={14}
                strokeWidth={2.5}
                className="text-emerald-500"
              />
              Photo ready
            </p>
            <p className="text-[12.5px] text-slate-500 mt-0.5">
              Used as the talking-head reference when generating each
              chunk's avatar video.
            </p>
            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                onClick={clickToPick}
                disabled={uploading}
                className="text-[12.5px] font-medium text-indigo-700 hover:text-indigo-900 hover:underline disabled:opacity-50"
              >
                Replace
              </button>
              <span className="text-slate-300">·</span>
              <button
                type="button"
                onClick={onRemove}
                disabled={uploading}
                className="text-[12.5px] font-medium text-rose-700 hover:text-rose-900 hover:underline disabled:opacity-50 inline-flex items-center gap-1"
              >
                <X size={12} strokeWidth={2.4} />
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={clickToPick}
          disabled={uploading || !jobId}
          className="w-full rounded-xl border-2 border-dashed border-slate-300 bg-white px-4 py-6 flex flex-col items-center justify-center gap-2 text-slate-500 hover:border-indigo-400 hover:bg-indigo-50/30 hover:text-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {uploading ? (
            <>
              <Loader2
                size={20}
                strokeWidth={2}
                className="animate-spin-slow text-indigo-500"
              />
              <span className="text-[13.5px] font-medium">
                Uploading… {progress}%
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),_0_4px_10px_-3px_rgba(99,102,241,0.5)]">
                <Upload size={14} strokeWidth={2.4} />
              </span>
              <span className="text-[14px] font-semibold text-slate-700">
                Click to upload an instructor photo
              </span>
              <span className="text-[11.5px] text-slate-400">
                JPEG or PNG · 10 MB max · clear front-facing shot
                works best
              </span>
            </>
          )}
        </button>
      )}

      {error ? (
        <p className="mt-2 inline-flex items-start gap-1.5 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-2 py-1">
          <AlertTriangle
            size={12}
            strokeWidth={2.2}
            className="shrink-0 mt-[2px]"
          />
          {error}
        </p>
      ) : null}
    </div>
  );
}
