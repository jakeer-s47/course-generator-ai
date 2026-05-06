@AGENTS.md

# Chapter AI — project knowledge

## What this is

Chapter AI is a 6-step wizard that converts long lecture videos into avatar-narrated micro-lessons. The wizard lives at `/new` and feeds a real Postgres-backed pipeline:

1. **Upload** — drag a file OR paste a YouTube/Vimeo/etc. URL (yt-dlp pulls audio only)
2. **Audio** — ffmpeg extracts 48 kHz mono mp3 (skipped for URL ingestion)
3. **Transcript** — OpenAI Whisper produces word-level timestamps
4. **Clean** — GPT-4o flags filler/admin/tangents to remove
5. **Split** — GPT-4o segments into topic chunks
6. **Render** — HeyGen renders an avatar video per chunk (not yet built)

Stack: Next.js 16 + React 19 + Prisma 6.19 + PostgreSQL 16 + Tailwind v4 + motion/react + lucide icons + OpenAI SDK + youtube-dl-exec.

## About the application

### Problem we're solving

University lectures and online courses are 60–180 minutes long. Students learn better in 10–20 minute focused chunks. Re-recording a long lecture as short clips is expensive — the instructor would have to re-shoot every micro-lesson by hand. Chapter AI does it automatically:

> **Long lecture in → topic-aware short avatar videos out.**

The instructor uploads once. The pipeline transcribes, removes filler, splits at real topic boundaries, and renders an avatar narrating each topic. The result is a series of short videos a student can binge in any order.

### Who uses it

- **Instructors / course creators** with a backlog of long-form lecture recordings they want to repurpose
- **L&D / corporate training** repackaging webinars into bite-sized modules
- **Students** (later phase) consuming the finished micro-lessons

### Why six steps (not one big "Process" button)

Each step has its own decisions worth surfacing to the user:

- **Cleanup level** is opinionated (Light vs Standard vs Aggressive).
- **Topic boundaries** sometimes need manual rename / merge / split.
- **Avatar + voice** is a creative choice.

Bundling everything behind one button hides those decisions. Bundling per-step also lets the user **resume** mid-pipeline (every job stage is durable in Postgres) and **iterate cheaply** — re-running clean at a different level only costs ~$0.07, not the full pipeline.

### Pipeline at a glance

```
                     ┌──────────────┐  ─ file or URL
   STEP 1  Upload    │    audio.mp3 │   ─ ffmpeg or yt-dlp post-process
                     └──────┬───────┘     into 48 kHz mono mp3
                            ▼
                     ┌──────────────┐  ─ OpenAI Whisper
   STEP 3  Transcript│   words.json │   ─ word-level timestamps
                     └──────┬───────┘
                            ▼
                     ┌──────────────┐  ─ GPT-4o
   STEP 4  Clean     │  cleaned.txt │   ─ removes filler / admin / tangents
                     │ removed.json │     (one row per level: light/std/agg)
                     └──────┬───────┘
                            ▼
                     ┌──────────────┐  ─ GPT-4o (two-pass: boundaries + titles)
   STEP 5  Split     │  chunks.json │   ─ ≤ targetMin chunks, hard cap
                     └──────┬───────┘     (one run per level + target combo)
                            ▼
                     ┌──────────────┐  ─ HeyGen (TODO)
   STEP 6  Render    │  N × mp4     │   ─ one avatar video per chunk
                     └──────────────┘
```

Step 2 (audio extract) is collapsed when the user pastes a URL — yt-dlp produces the mp3 directly, the runner inserts the `audios` row as `ready`, and `job_status` jumps from `downloading` to `transcript`.

### Design tenets

These show up in every layer of the codebase. When in doubt, pick the option that respects them:

1. **Durable state, not in-memory progress.** Every stage's status lives in a Postgres row, not React state. Refresh-mid-pipeline is a first-class flow.
2. **Per-stage sibling rows.** Each step has its own table (`audios`, `transcripts`, `cleaned_transcripts`, `segment_runs`, `chunks`). When in doubt, **add a sibling table** rather than column-extend `jobs`.
3. **Idempotent stage routes.** Hitting `POST /api/jobs/[id]/<stage>` twice never double-spends. If the row is mid-flight, return 200 with the current row.
4. **One source of truth for paths.** Storage helpers in `src/lib/storage.ts`. Never hardcode `uploads/{jobId}/...` paths in routes or components.
5. **Real gating, not feature flags.** Step N's Next button is enabled iff that step's real completion flag is true. No `NEXT_PUBLIC_USE_REAL_API=stepN` flags.
6. **UI polls, server pushes are deferred.** Every step's UI fetches its stage endpoint at 1500 ms while in-flight. SSE/WebSocket migration is planned for later.

## ⚠️ This is Next.js 16

`AGENTS.md` already says it but it's worth repeating: read the relevant page in `node_modules/next/dist/docs/01-app/` before writing any new route or page code. Two breaking changes that bite repeatedly:

- Route handler params are `Promise<{ id: string }>` — `const { id } = await ctx.params;`
- `searchParams` is a `Promise` on server components.

## Database schema

All in `web/prisma/schema.prisma`. **7 tables** + 1 status enum.

```
                        ┌──────────────┐
                        │     jobs     │  source identity (one per upload/URL)
                        └──────┬───────┘
        ┌─────────────────┬────┴─────┬─────────────────┬──────────────┐
        ▼ 1:1             ▼ 1:1      ▼ 1:1             ▼ 1:N          ▼ 1:N
  ┌────────────┐   ┌──────────┐  ┌────────────┐  ┌─────────────────┐  ┌────────────┐
  │ job_status │   │  audios  │  │ transcripts│  │cleaned_         │  │segment_    │
  │            │   │          │  │            │  │transcripts      │  │runs        │
  │ which step │   │ extracted│  │  Whisper   │  │ ≤3 per job      │  │ N per job  │
  │ + 0..100%  │   │ mp3      │  │  rawText   │  │ (light/std/agg) │  │ (level+min)│
  └────────────┘   └──────────┘  └────────────┘  └─────────────────┘  └─────┬──────┘
                                                                            │ 1:N
                                                                            ▼
                                                                       ┌──────────┐
                                                                       │  chunks  │
                                                                       │ topic +  │
                                                                       │ text for │
                                                                       │ HeyGen   │
                                                                       └──────────┘
```

`job_status.status` enum (`STATUS_VALUES` in `src/lib/steps.ts`):

```
downloading → audio → transcript → clean → split → render → done
                                                              failed (any stage)
```

`downloading` is only used by URL-ingestion jobs. File-upload jobs start at `audio`. URL jobs **skip** `audio` and jump to `transcript` because yt-dlp produces the mp3 directly.

### Composite-unique tables

- **`cleaned_transcripts`** — unique on `(job_id, clean_level)`. Up to 3 rows per job (light/standard/aggressive). Switching levels in the UI is instant once each level has been run.
- **`segment_runs`** — unique on `(job_id, clean_level, target_min)`. Many rows per job. Same UX: instant flip between combos that have been run.

## Sibling-row pattern (every stage looks the same)

Each pipeline stage has a sibling table with the same shape:

```
status        pending | <stage> | ready | failed
progress      0..100
errorCode     E_<STAGE>_<REASON>   (e.g. E_OPENAI_AUTH, E_FFMPEG, E_YTDLP_LIVE)
errorMessage  user-facing string
createdAt | startedAt | readyAt
```

The pattern for each stage:

1. **`POST /api/jobs/[id]/<stage>`** — idempotent: if mid-flight, return 200 with the row; otherwise upsert to `<stage>/0` and fire `void run<Stage>(...)` background task.
2. **Background runner** — updates `<stage>.progress` + `job_status.progress` as it works. On success, writes outputs to disk + advances `job_status.status` to next stage. On failure, records `errorCode`/`errorMessage`, sets `job_status.status="failed"`.
3. **`GET /api/jobs/[id]/<stage>`** — UI polling endpoint, hit every 1500 ms while in-flight.

Reference implementations to mirror when adding a new stage:

- Audio: `web/src/app/api/jobs/[id]/extract/route.ts`
- Transcript: `web/src/app/api/jobs/[id]/transcribe/route.ts`
- Clean: `web/src/app/api/jobs/[id]/clean/route.ts`
- Split: `web/src/app/api/jobs/[id]/segment/route.ts`
- Download (URL ingestion): `web/src/app/api/jobs/[id]/download/route.ts` + `runner.ts`

## File storage layout

All under `web/uploads/{jobId}/`. Helpers in `web/src/lib/storage.ts` — never hardcode paths.

```
original.mp4                                        # source video (file uploads only)
audio.mp3                                           # 48 kHz mono mp3 (every job)
words.json                                          # Whisper word-level timestamps
cleaned/{level}/cleaned.txt                         # cleaned plain text per level
cleaned/{level}/cleaned_words.json                  # cleaned words with timing
cleaned/{level}/removed_segments.json               # GPT-4o removal decisions
chunks/{level}/{N}min/chunks.json                   # topic chunks per (level, target)
```

URL-ingestion jobs do NOT have `original.mp4` — yt-dlp writes `audio.mp3` directly.

## Key library files

| File | Purpose |
|---|---|
| `src/lib/db/index.ts` | Prisma singleton + `serializeJob`/`serializeAudio` BigInt helpers |
| `src/lib/ffmpeg.ts` | `extractAudio()`, `probeDuration()` — spawns system `ffmpeg`/`ffprobe` |
| `src/lib/whisper.ts` | `transcribeAudio()` — chunks audio ~10 min, Whisper API, stitches word offsets |
| `src/lib/cleaner.ts` | `cleanTranscript()` — GPT-4o per-chunk; emits `removed_segments`, backend filters words.json |
| `src/lib/segmenter.ts` | `segmentTranscript()` — two-pass GPT-4o (boundaries → titles), then `enforceMaxDuration()` |
| `src/lib/ytdlp.ts` | `probeUrl()`, `downloadAudio()` — spawns yt-dlp binary from `node_modules/youtube-dl-exec/bin/` |
| `src/lib/storage.ts` | All disk paths. `originalKey`, `audioKey`, `wordsJsonKey`, `cleanedTextKey`, etc. |
| `src/lib/steps.ts` | `STATUS_VALUES`, `STATUS_TO_STEP`, `STEP_LABELS`, `nextStatus()` |
| `src/lib/session.ts` | `getOrCreateSessionId()` / `getSessionId()` — anonymous cookie, scopes every API to one user |

## Frontend patterns

- **`useWizard()` from `WizardContext.tsx`** is the single source of truth for wizard step state. `update(patch)` merges into state.
- **Polling** — every step polls its stage endpoint at **1500 ms** (`setInterval` in a `useEffect`). Stops when status is `ready` or `failed`. Patterns to copy: `AudioStep.tsx`, `TranscriptStep.tsx`, `CleanStep.tsx`, `SplitStep.tsx`.
- **`canAdvance` gating** — Step N's Next button is disabled until that step's *real* completion flag is true (`audioReady`, `transcriptReady`, `cleanedReady`, etc.). No mock/feature flags. URL jobs additionally gate Step 1 on `urlDownloadDone`.
- **Toast** — `useToast()` from `src/components/ui/Toast.tsx`. Methods: `success`/`error`/`info`/`loading`/`warn`/`download`/`dismiss(id)`.
- **Resume from URL** — `/new?job=<id>` rehydrates WizardContext via `ResumeFromUrl` in `src/app/new/page.tsx`. URL jobs are detected by `source_name` starting with `http(s)://`.

## Steps in detail

A deep dive on each step — what the user does, what the backend does, what gets stored where, and which files to read.

---

### Step 1 — Upload (file or URL)

**What it does**: Accept the source lecture into the system as a `Job` row + an audio file on disk.

#### Two ingestion modes

| Mode | When | Server work | Step 1 progress UI | Status it advances to |
|---|---|---|---|---|
| **File upload** | Drag-drop / file picker | Receive multipart, write `original.{ext}` | XHR upload bar (browser → server) | `audio` (Step 2) |
| **URL paste** | Paste YouTube/Vimeo/etc. | yt-dlp pulls audio in background | DB-driven progress bar (1500 ms poll) | `transcript` (Step 3, Step 2 skipped) |

The `POST /api/jobs` route content-type-discriminates:

- **`multipart/form-data`** → file flow → write to `uploads/{jobId}/original.{ext}` → `job_status` starts at `audio`.
- **`application/json` with `{ sourceUrl }`** → URL flow → synchronous `probeUrl()` (~1 s) returns title + duration → 4xx with friendly message if probe fails → otherwise create Job + `job_status="downloading"` and fire `runDownload`.

#### URL flow specifics

- **`source_name`** holds the URL initially, replaced by resolved video title after probe.
- **`source_key`** is `""` until download lands, then `{jobId}/audio.mp3`.
- yt-dlp runs with `--extract-audio --audio-format mp3 --postprocessor-args "ffmpeg:-ac 1 -ar 48000"` so the result is byte-identical to what Step 2 would produce for a file upload — 48 kHz mono 128 kbps.
- The runner backfills `Job` source columns + inserts `audios` as `ready` + advances `job_status` to `transcript`. Step 2 is skipped entirely.
- Detection rule: any `source_name` starting with `http(s)://` is a URL job. The wizard's resume-from-URL logic uses this.

#### UI behaviour

`UploadStep.tsx` shows a tab switcher: **Upload file** | **Paste link**. Once a file/URL is committed, both paths share the same source card with mode-specific status messages:

- File mid-upload: "Uploading… 42%" XHR bar
- URL mid-download: "Downloading audio… 42%" DB-poll bar
- Failure: red error pill + Retry button (URL only — file uploads abort the XHR client-side)
- Done: "Audio ready · skipping straight to transcript" (URL) or "Uploaded · ready to process" (file)

#### Tables touched

- **`jobs`** (insert): id, sessionCookie, sourceName, sourceKey, sourceSize, sourceType, sourceDurationSec
- **`job_status`** (insert): status (`audio` for files, `downloading` for URLs), progress
- **`audios`** (insert, URL only): inserted as `ready` once yt-dlp finishes — contains size, duration, sampleRate, channels, codec, bitrateKbps

#### Disk artifacts

```
File upload:  uploads/{jobId}/original.{ext}
URL upload:   uploads/{jobId}/audio.mp3      (no original.mp4)
```

#### Key files

- `web/src/components/wizard/steps/UploadStep.tsx` — UI with tab switcher + dual progress flows
- `web/src/app/api/jobs/route.ts` — content-type discriminator
- `web/src/app/api/jobs/[id]/download/route.ts` + `runner.ts` — URL flow
- `web/src/lib/ytdlp.ts` — `probeUrl()` + `downloadAudio()`
- `web/src/lib/storage.ts` — `originalKey`, `audioKey`, `saveFileToDisk`

---

### Step 2 — Audio extract

**What it does**: Strip the audio track from the source video and encode it as 48 kHz mono mp3 ready for Whisper.

**Skipped entirely for URL-ingestion jobs** — yt-dlp produced the mp3 directly. Step 2's UI for URL jobs shows "Audio ready (from URL)" with a green check and no extract CTA.

#### What the user does

Click **Extract audio**. The button kicks off a background ffmpeg run; the panel becomes a progress bar.

#### Server flow

1. `POST /api/jobs/[id]/extract` — upserts the `Audio` row to `extracting/0`, sets `job_status` to `audio/0`, fires `runExtraction`.
2. **Background runner** spawns:
   ```bash
   ffmpeg -hide_banner -loglevel warning -nostats \
     -progress pipe:1 -y -i <src> -vn -ac 1 -ar 48000 -b:a 128k <audio.mp3>
   ```
   Parses `out_time_ms` lines from stdout to drive `audios.progress` + `job_status.progress`. Throttled to ≥2% delta or 400 ms.
3. On success: probes the mp3 for real duration, fills `Audio` metadata, advances `job_status` to `transcript`.
4. On failure: `audios.errorCode = "E_FFMPEG"`, `errorMessage = stderr.slice(0,500)`, `job_status.status = "failed"`.

#### UI

`AudioStep.tsx` is the most visually rich step:

- **Source-video card** — shows file name, original size/duration/format
- **Extract CTA** — only when no run has started
- **Progress panel** — gradient indigo→cyan, real-time percent
- **Real audio player** when ready — `<audio src="/api/jobs/[id]/audio/file">` with HTTP Range support (Step 2 streams audio with byte ranges so the player can scrub)
- **Bar-style waveform** + **WebAudio FFT frequency bands** — analyser on the live audio element with 5 frequency buckets (Sub/Low/Mid/High/Air) animating in real time

#### Tables touched

- **`audios`** (upsert): file location, codec metadata, status, progress
- **`job_status`** (upsert): status flips `audio` → `transcript` on success

#### Disk artifacts

```
uploads/{jobId}/audio.mp3
```

#### Key files

- `web/src/components/wizard/steps/AudioStep.tsx` — UI, hook for audio playback + FFT
- `web/src/app/api/jobs/[id]/extract/route.ts` — POST + GET + background runner
- `web/src/app/api/jobs/[id]/audio/file/route.ts` — Range-aware audio streaming endpoint
- `web/src/lib/ffmpeg.ts` — `extractAudio()` wrapper

---

### Step 3 — Transcribe

**What it does**: Call OpenAI Whisper to convert audio to text with word-level timestamps.

#### What the user does

Click **Transcribe**. The button costs API quota (~$0.36 for a 1-hr lecture), so it's an explicit user action — never auto-fires.

#### Server flow

1. `POST /api/jobs/[id]/transcribe` — 503 if `OPENAI_API_KEY` unset; otherwise upsert `Transcript` row to `transcribing/0`, fire `runTranscription`.
2. **Background runner** ([src/lib/whisper.ts](web/src/lib/whisper.ts)):
   - Splits `audio.mp3` into ~10-min chunks via ffmpeg `-ss N -t 600 -c copy chunkN.mp3` (Whisper has a 25 MB upload cap; 10-min slices stay safely under).
   - For each chunk: POST to Whisper with `verbose_json` + `timestamp_granularities=["word"]`. Each word's `start/end` is offset by `i × 600` to the full-audio timeline.
   - Updates `transcripts.progress` after every chunk.
3. On success: writes `words.json` to disk, fills `Transcript` row with `rawText` (joined plain text), `wordCount`, `language`, `durationSec`, `wordsJsonKey`. Advances `job_status` to `clean`.

#### UI

`TranscriptStep.tsx`:

- **Source-audio card** — duration, bitrate, size of the mp3 from Step 2
- **Transcribe CTA** — only when no run has started
- **Progress panel** — violet, with chunk-by-chunk percent
- **Plain tab** — `rawText` displayed as it grows during the run
- **Timestamped tab** — once ready, lazy-fetches `words.json` and renders ~12-second subtitle-style segments with violet `[mm:ss]` timecodes

#### Tables touched

- **`transcripts`** (upsert): `rawText`, `wordsJsonKey`, language, wordCount, durationSec, status, progress
- **`job_status`**: `transcript` → `clean` on success

#### Disk artifacts

```
uploads/{jobId}/words.json     # [{word, start, end}, ...]
```

#### Key files

- `web/src/components/wizard/steps/TranscriptStep.tsx`
- `web/src/app/api/jobs/[id]/transcribe/route.ts`
- `web/src/app/api/jobs/[id]/transcript/route.ts` (polling)
- `web/src/app/api/jobs/[id]/transcript/words/route.ts` (streams `words.json`)
- `web/src/lib/whisper.ts`

---

### Step 4 — Clean

**What it does**: Use GPT-4o to identify spans the listener should NOT hear (filler, admin, tangents) and produce a cleaned transcript that stays word-aligned with the audio.

#### Three levels

The user picks **Light**, **Standard**, or **Aggressive**. Each level allows different removal categories in the GPT prompt:

| Level | Categories allowed |
|---|---|
| Light | `filler`, `falsestart` |
| Standard | + `admin`, `tangent` |
| Aggressive | + `recap`, `redundant` |

`cleaned_transcripts` has a composite unique on `(jobId, cleanLevel)` so all three levels can coexist. Switching levels in the UI is instant once a level has been run.

#### Key design decision: GPT returns spans, not rewritten text

GPT-4o emits **only** `[{ start_sec, end_sec, category, reason }]`. The backend then:

1. Filters the source `words.json` to drop words whose `start` falls inside any removed range.
2. Reassembles `cleanedText` from the surviving words.
3. Saves `cleaned_words.json` (alignment-preserving) and `removed_segments.json`.

This guarantees timing alignment downstream (Step 5 needs word-level timestamps to map "topic 3 spans 14:32–22:08" back to real audio offsets).

#### Server flow

1. `POST /api/jobs/[id]/clean` with `{ level }` — idempotent for in-flight; otherwise upsert + fire `runCleaning`.
2. Runner chunks the transcript into ~10-min pieces via [cleaner.ts](web/src/lib/cleaner.ts) so each GPT-4o call's output stays under the 16K-token cap. (Aggressive on a 48-min lecture would otherwise truncate JSON mid-stream.)
3. For each chunk: GPT-4o with `response_format: { type: "json_schema", strict: true, ... }` returning a removed-segments array. Few-shot examples in the system prompt prevent over-eager removal of analogies or transitions.
4. Backend normalizes ranges (drops invalid, splits >20 s, merges <1 s gaps), filters `words.json`, writes outputs, advances `job_status` to `split`.

#### UI

`CleanStep.tsx`:

- **Source-transcript card** — words / duration / language
- **Cleaning level selector** — three cards with status pills (Ready / 42% / Empty) per level
- **CTA** — "Clean transcript" if no row at this level; otherwise re-clean banner card with confirm-on-click
- **Progress panel** — fuchsia gradient
- **Stats grid** — original / cleaned word counts, % removed, time saved
- **Side-by-side diff** — left pane renders the source words with `diff-remove` strikethroughs on removed ranges; right pane shows cleaned text
- **Removed inspector** — collapsible list of `[mm:ss → mm:ss] [Category] reason` rows

#### Tables touched

- **`cleaned_transcripts`** (upsert by composite key): cleanLevel, status, cleanedText, cleanedWordsKey, removedJsonKey, stats (originalWords, cleanedWords, removedSegments, removedDurSec)
- **`job_status`**: `clean` → `split` on success

#### Disk artifacts

```
uploads/{jobId}/cleaned/{level}/cleaned.txt
uploads/{jobId}/cleaned/{level}/cleaned_words.json
uploads/{jobId}/cleaned/{level}/removed_segments.json
```

(Files are namespaced by level so Light/Standard/Aggressive runs coexist on disk.)

#### Cost

~$0.07 per run per level. A user clicking through all three levels: ~$0.21 total.

#### Key files

- `web/src/components/wizard/steps/CleanStep.tsx`
- `web/src/app/api/jobs/[id]/clean/route.ts`
- `web/src/app/api/jobs/[id]/clean/removed/route.ts` + `words/route.ts`
- `web/src/lib/cleaner.ts`

---

### Step 5 — Split

**What it does**: Use GPT-4o to slice the cleaned transcript into topic chunks. Optionally enforce a hard duration cap so no single chunk exceeds the user's target length.

#### Two key inputs

- **Cleaned source** — which `cleanLevel` row from Step 4 to operate on (UI picker shows Light/Standard/Aggressive with stats)
- **Target minutes** — user's desired chunk length (default 20 min)

`segment_runs` has composite unique on `(jobId, cleanLevel, targetMin)` so many runs per job can coexist. The user can compare e.g. Standard@20 vs Aggressive@15 without re-running either.

#### Two-pass GPT-4o

This is the heart of the design. Naive single-pass GPT drifts — it generates plausible-sounding canonical titles and stamps them on its boundaries in document order, ignoring what the chunk actually contains. Two-pass fixes it ([src/lib/segmenter.ts](web/src/lib/segmenter.ts)):

1. **Pass 1 — boundaries**: GPT receives the full timestamped transcript and returns ONLY `[{ start_sec, end_sec }]`. No titles. The prompt is topic-driven: "find every topic shift; one chunk per topic; target length is a soft hint."
2. **Pass 2 — titling**: each chunk's actual text is sent back to GPT, which titles it based ONLY on the words in that chunk. The prompt explicitly forbids titles drawn from canonical course expectations and includes anti-examples.

Between the passes, the backend runs **`enforceMaxDuration()`** — slices any chunk longer than `targetMin × 60` seconds into back-to-back parts. A 50-min topic at target=20 becomes 20 + 20 + 10. The titler runs after the cap so each part is independently titled from its own text.

#### Server flow

1. `POST /api/jobs/[id]/segment` with `{ cleanLevel, targetMin }`.
2. Idempotent during in-flight runs. On `ready`/`failed`, wipes prior chunks + reruns.
3. Runner: pass 1 → normalize boundaries → enforceMaxDuration → slice text from `cleaned_words.json` → pass 2 → assemble final chunks → `INSERT chunks` + UPDATE `segment_runs` to `ready`.

#### UI

`SplitStep.tsx`:

- **Cleaned-source picker** — three large cards (Light/Standard/Aggressive) with status pills + stats. Active card has a top accent bar + halo + checkmark. Cards for un-run levels are disabled with a "Run cleanup on Step 4 →" hint.
- **Target minutes input** + **Auto-detect topics** CTA
- **Re-segment card** with confirm-on-click after a ready run
- **Progress panel** — rose gradient
- **Chunks accordion** — one row per chunk: index badge, `mm:ss → mm:ss`, topic, duration + word count chips, expand reveals preview + Rename action

#### Chunk edits

Real DB writes — not in-memory:

- `PATCH /api/jobs/[id]/chunks/[chunkId]` — rename (topic / preview)
- `POST /api/jobs/[id]/chunks/[chunkId]/merge` — merges into previous, renumbers idx in a transaction
- `POST /api/jobs/[id]/chunks/[chunkId]/split` — splits at midpoint or `?atSec=`, recomputes text from cleaned words

The merge/split buttons are currently hidden in the UI (handlers wired but not exposed); flip the comment in `SplitStep.tsx` to re-enable.

#### Tables touched

- **`segment_runs`** (upsert by composite key): cleanLevel, targetMin, status, progress, chunkCount, totalWordCount, chunksJsonKey
- **`chunks`** (insertMany): one row per topic chunk with `text` slice for HeyGen
- **`job_status`**: `split` → `render` on success

#### Disk artifacts

```
uploads/{jobId}/chunks/{level}/{N}min/chunks.json
```

#### Cost

~$0.07 per run (two GPT calls: one full-transcript boundary detection + one all-chunks titling).

#### Key files

- `web/src/components/wizard/steps/SplitStep.tsx`
- `web/src/app/api/jobs/[id]/segment/route.ts`
- `web/src/app/api/jobs/[id]/chunks/route.ts` (list)
- `web/src/app/api/jobs/[id]/chunks/[chunkId]/route.ts` + `/merge` + `/split`
- `web/src/lib/segmenter.ts`

---

### Step 6 — Render (not yet built)

**What it will do**: Send each chunk's `text` to a talking-head avatar API (HeyGen by default) along with a chosen avatar ID + voice ID. Poll for render completion. Pull the resulting MP4, store it under `uploads/{jobId}/renders/{chunkId}/`, mark the render row ready.

#### Planned shape

When this stage ships it'll follow the sibling-row pattern:

- **`renders`** table: one row per chunk, with `provider_job_id`, status, progress, `output_key`, errors.
- **`POST /api/jobs/[id]/render`** — enqueues one HeyGen call per chunk.
- Per-chunk polling against HeyGen `/v1/video_status.get?video_id=...`.
- Storage: `uploads/{jobId}/renders/{chunkId}/output.mp4`.

#### Current state

`AvatarStep.tsx` is fully mocked — staggered `setTimeout`s pretend to render. The structural UI (avatar grid, voice picker, per-chunk render cards, "Generate all" button) is production-ready and waiting to be wired to a real API.

`CompletionScreen.tsx` and `VideoPreviewModal.tsx` are also mocked — they expect real `<video src="signed-url">` once the render writes are live.

#### Key files (when building)

- `web/src/components/wizard/steps/AvatarStep.tsx` — replace `setTimeout` loop with real `POST /render` + per-chunk polling
- `web/src/components/wizard/CompletionScreen.tsx` — swap fake URLs for real signed download URLs
- `web/src/components/ui/VideoPreviewModal.tsx` — replace SVG silhouette with `<video>` element
- New: `web/src/lib/heygen.ts`, `web/src/app/api/jobs/[id]/render/route.ts`

## Environment

`web/.env.local`:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/chapter_db
STORAGE_DIR=./uploads
NEXT_PUBLIC_APP_URL=http://localhost:3001
OPENAI_API_KEY=sk-...                # required from Step 3 onward
HEYGEN_API_KEY=                       # for Step 6 (not yet built)
```

External tools required on PATH:

- **`ffmpeg`** + **`ffprobe`** — system install (`brew install ffmpeg` / `apt install ffmpeg`)
- **`yt-dlp`** — auto-installed by `npm install`, lives at `node_modules/youtube-dl-exec/bin/yt-dlp`. Don't try to find it on the system PATH.

Postgres 16 must be running on `:5432` with database `chapter_db`. Run `npx prisma db push` on schema changes (no migration files for dev speed).

## Conventions

- App name is **Chapter AI**. Never revert (was "Lyceum" → "Distill" → "Chapter AI").
- **Don't run `git init`** — user owns repo creation. Pass `--no-git` to scaffolders.
- **No feature flags for incomplete pipeline stages.** Gate Next on the step's real completion state.
- **Sibling-row pattern over column-extension.** When in doubt, add a sibling table — matches the rest of the pipeline and keeps the polling UI uniform.
- **Tailwind v4** has stylistic warnings about `bg-gradient-to-br` → `bg-linear-to-br`. The codebase uses the legacy names consistently. Skip the warnings — keep style consistent across the app.

## Common dev tasks

### Reset a job entirely

```sql
DELETE FROM jobs WHERE id = '<jobId>';   -- cascades to every sibling row
```

Then:
```bash
rm -rf web/uploads/<jobId>
```

### Reset just chunks (re-run Step 5)

```sql
DELETE FROM segment_runs WHERE job_id = '<jobId>';   -- cascades to chunks
```

Or click **Re-segment** in the UI — the route already wipes chunks before re-running.

### Inspect job state

```sql
SELECT j.id, j.source_name, js.status, js.progress, j.created_at
FROM jobs j JOIN job_status js ON j.id = js.job_id
ORDER BY j.created_at DESC LIMIT 5;
```

### Run a one-off prisma push after schema changes

```bash
cd web && npx prisma db push
```

## Costs per 1-hr lecture (today)

- Whisper transcription: ~$0.36 (~6 chunks × $0.006/min)
- GPT-4o cleanup (per level): ~$0.07
- GPT-4o segmentation (per level + target combo): ~$0.07 (two passes)
- HeyGen render: ~$15–30 (when Step 6 ships)

A user who clicks through all three clean levels + a couple of segmentation combos will spend ~$0.50 in OpenAI before the avatar render even starts. Idempotency on the row level means re-clicking doesn't re-spend.
