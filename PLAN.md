# Distill — Production Architecture Plan

## Context

Distill currently ships as a polished 6-step wizard where **every pipeline stage is faked**: `estimateDuration()` guesses duration from file size, a 2.8 s `setInterval` pretends to extract audio, a typewriter streams a hardcoded thermodynamics transcript, a deterministic seeded function "cleans" filler, 6 hardcoded topics stand in for segmentation, and staggered `setTimeout`s impersonate avatar rendering. The UI is production-grade; the backend is not.

This plan wires every stage to real services so the app does the work it currently pretends to do, with progress streaming live to the existing wizard. All 6 pipeline steps + the completion screen are covered.

User-specified constraints:
- **PostgreSQL** for persistent state
- **OpenAI GPT-4o** for LLM tasks (transcript cleanup + topic segmentation)

## Stack

| Layer | Pick | Why |
|---|---|---|
| Database | **PostgreSQL** (user-specified) | Also hosts the job queue via `pg-boss` — no Redis needed |
| ORM + migrations | **Drizzle ORM** + `drizzle-kit` | TypeScript-first, lighter than Prisma, Next.js 16 compatible |
| LLM (cleanup + segmentation) | **OpenAI GPT-4o** (user-specified) | Chat-completions with JSON-schema structured output |
| Transcription | **OpenAI Whisper API** | Same billing as GPT-4o; 25 MB chunk limit handled by splitting |
| Avatar video | **HeyGen API** (default; swap path documented) | Most mature talking-head API |
| File storage | **Cloudflare R2** | S3-compatible, $0 egress, cheap at demo scale |
| Queue / background jobs | **pg-boss** (Postgres-backed) | Single dependency with DB; no Redis |
| Real-time progress → UI | **Server-Sent Events** from Next.js API routes | Simpler than WebSockets, works on Vercel |
| Web host | **Vercel** | Already configured |
| Worker host | **Railway** (long-running Node process) | Vercel serverless can't run 30-min jobs |
| Auth | **Skip for v1** — anonymous cookie session | Add Auth.js later if needed |

## Architecture

Three processes:
1. **Web** (Next.js on Vercel) — existing UI + new `/api` routes for upload, status, SSE.
2. **Worker** (Node on Railway) — consumes `pg-boss` queue, runs pipeline stages sequentially per job, writes DB updates.
3. **Postgres** (Railway managed) — data tables + `pg-boss` queue in the same database.

```
Browser ──► Next.js ──► R2 (multipart upload)
             │   └──► Postgres.jobs (INSERT + enqueue "pipeline.start")
             └──── SSE ◄──── Postgres LISTEN/NOTIFY as worker writes

Worker pg-boss loop per job:
  pipeline.start
    → audio.extract   (ffmpeg)
    → transcribe      (Whisper API — chunked)
    → clean           (GPT-4o structured output)
    → segment         (GPT-4o structured output)
    → render.chunk × N(HeyGen submit + poll + R2 fetch)
    → completed       (emits done event)
```

## Database schema (`src/lib/db/schema.ts`)

```ts
jobs            (id uuid PK, created_at, updated_at, session_cookie,
                 source_key, source_size, source_duration_sec,
                 current_stage enum, progress int, status enum,
                 error_code, error_message,
                 clean_level, target_minutes,
                 selected_avatar_id, selected_voice,
                 finished_at)

transcripts     (job_id PK, language, raw_text text, cleaned_text text,
                 words_jsonb jsonb, updated_at)

chunks          (id uuid PK, job_id FK, idx int, topic, start_sec, end_sec,
                 word_count, preview, transcript_text text)

renders         (chunk_id PK, provider, provider_job_id, status enum,
                 progress int, output_key, duration_sec,
                 error_code, error_message,
                 created_at, started_at, ready_at)
```

`pg-boss` creates its own `pgboss.*` tables in the same DB.

## All 6 steps — mock → real

### Step 1 — Upload
- **Now**: `UploadStep.tsx:21–24` estimates duration from size (6 MB/min heuristic).
- **Real**:
  - Client: `UploadStep.tsx` replaces `onInputChange` with a multipart XHR upload to `POST /api/jobs` (so it can report upload progress).
  - Server: `/api/jobs/route.ts` streams the body to R2 at key `src/{jobId}/original.{ext}`, creates `jobs` row with `current_stage='ingest'`, enqueues `pipeline.start`, returns `{ jobId }`.
  - Worker `pipeline.start` runs `ffprobe -show_format` to get real `duration_sec` and `size`, writes to `jobs`, emits NOTIFY, then chains into `audio.extract`.

### Step 2 — Audio extract
- **Now**: `AudioStep.tsx:40–66` fakes progress with a 2.8 s `setInterval`.
- **Real** (`worker/stages/audio.ts`):
  - `ffmpeg -i <r2-signed-url> -ac 1 -ar 48000 -vn -f mp3 out.mp3`, streamed in/out.
  - Progress is parsed from `ffmpeg -progress pipe:1` (emits `out_time_ms`) → compute `progress = out_time_ms / duration_ms * 100` → write every 5% change.
  - Upload `out.mp3` to R2 at `audio/{jobId}/extracted.mp3`.
  - Waveform PNG rendered with `ffmpeg showwavespic` filter (replaces the current synthetic waveform).
  - Enqueue `transcribe`.
- Fallback: if source is already audio, skip extraction and pass through.

### Step 3 — Transcript
- **Now**: `TranscriptStep.tsx:34–58` streams a hardcoded thermo lecture 55 ms per word.
- **Real** (`worker/stages/transcribe.ts`):
  - Whisper API limit = 25 MB per request. Split extracted audio into ~24-minute chunks with `ffmpeg -ss/-t`.
  - Loop: call `openai.audio.transcriptions.create({ model: "whisper-1", response_format: "verbose_json", timestamp_granularities: ["word"] })` per chunk.
  - After each chunk: append words to `transcripts.words_jsonb`, concatenate `raw_text`, update `progress = (done_chunks / total_chunks) * 100`, NOTIFY.
  - SSE pushes partial transcript text → frontend `TranscriptStep` renders streaming output (typewriter effect preserved, but backed by real data).
  - On completion: enqueue `clean`.

### Step 4 — Clean
- **Now**: `CleanStep.tsx:69–85` deterministic `(i*31)%10 < factor*0.85` pseudo-filter.
- **Real** (`worker/stages/clean.ts`):
  - Single GPT-4o call with `response_format: { type: "json_schema", strict: true, schema: ... }`.
  - Prompt (see `worker/prompts/clean.ts`):
    > Clean this lecture transcript. Remove filler (um/uh/like), admin chatter (roll call, schedule), off-topic asides, false starts. Keep derivations, definitions, worked examples, transitions. Strictness = `{level}` (light/standard/aggressive). Preserve original word-level timecodes where possible. Return `{ cleaned_text, removed_segments: [{start_sec, end_sec, reason}] }`.
  - Write `transcripts.cleaned_text`, set `jobs.progress=100`, enqueue `segment`.
  - User changing `clean_level` in UI → PATCH `/api/jobs/[id]` → re-enqueue `clean` (replaces setTimeout regenerate).

### Step 5 — Split
- **Now**: `SplitStep.tsx:21–70` hardcoded `SEED_TOPICS`.
- **Real** (`worker/stages/segment.ts`):
  - GPT-4o call with JSON schema output:
    > Split this cleaned transcript into topic chunks targeting `{target_minutes}` minutes each. Never split mid-derivation — always at a topic-shift sentence. Each chunk: 5–8 word `topic`, 1-sentence `preview`, `start_sec`, `end_sec`, `word_count`.
  - Validate: sum of chunk durations ≈ transcript duration, chunks sorted by start, no overlaps.
  - `DELETE FROM chunks WHERE job_id = $1` then `INSERT ... VALUES ...` (so re-segmentation is clean).
  - Enqueue nothing — wait for user to click Generate on step 6.
  - User manual edits (`rename`, `mergeUp`, `splitChunk`) → PATCH `/api/jobs/[id]/chunks` → direct SQL mutation, no GPT call.

### Step 6 — Render
- **Now**: `AvatarStep.tsx:93–123` staggered `setTimeout` loop per chunk.
- **Real** (`worker/stages/render.ts`):
  - User clicks "Generate all" → `POST /api/jobs/[id]/render` enqueues one `render.chunk` job per row in `chunks` (6 jobs for a typical lecture).
  - Worker concurrency capped at 2 to respect HeyGen rate limits.
  - Per-chunk handler:
    1. Pull `chunks.transcript_text`, `jobs.selected_avatar_id`, `jobs.selected_voice`.
    2. Map internal avatar id (atlas/nova/sage/...) → HeyGen `avatar_id` + `voice_id` via a static lookup table in `worker/stages/render.ts`.
    3. `POST https://api.heygen.com/v2/video/generate` with `{ video_inputs: [{ character: { type: "avatar", avatar_id, avatar_style: "normal" }, voice: { type: "text", input_text, voice_id } }], test: false, dimension: { width: 1920, height: 1080 } }`.
    4. Write `renders.provider_job_id`, status=`submitted`.
    5. Poll `GET /v1/video_status.get?video_id=...` every 15 s. HeyGen returns `{ status: pending|processing|completed|failed, video_url, duration }`. On every change: update `renders.status`, `renders.progress`, NOTIFY → SSE pushes to UI → per-chunk bars in `AvatarStep` update live.
    6. On `completed`: stream the returned `video_url` MP4 directly into R2 at `renders/{jobId}/chunk-{idx}.mp4`. Write `renders.output_key`, `renders.ready_at`.
    7. On `failed`: write `renders.error_*`, emit failure toast via SSE, allow retry via `POST /api/jobs/[id]/render?retry=chunk-id`.
  - When the last render in the job transitions to `ready`: worker transitions `jobs.status = 'done'`, `jobs.finished_at = now()`, NOTIFY `completed`.
  - Frontend `AvatarStep.tsx`:
    - Play button → `VideoPreviewModal` opens with `src={signedUrlFor(renders.output_key)}` — real `<video controls>` replaces the SVG silhouette.
    - Download button → browser downloads the R2-signed URL directly (no server in the middle).
    - Download all → `GET /api/jobs/[id]/zip` streams a ZIP (see below).

### After step 6 — Completion screen
- **Now**: `CompletionScreen.tsx` is reached by clicking Finish, then renders mock stats + 6 mock videos.
- **Real**:
  - Reached automatically when SSE receives `status: done`, not from a manual click. Footer Finish button still works manually as a fallback.
  - Summary stats computed from DB: `sum(chunks.end_sec - chunks.start_sec)` for total runtime, `sum over r2 heads` for output size, `len(chunks)` for count, `jobs.source_duration_sec - jobs.finished_at_delta` for "time saved".
  - "Download all (6)" → `GET /api/jobs/[id]/zip` streams a ZIP of all `renders.output_key` MP4s using `archiver` piped to the response.
  - Share button → `POST /api/jobs/[id]/share` creates a `share_links` row (UUID, optional expires_at, read-only), returns URL. ShareModal displays it with Copy.
  - Each per-chunk Play → same real `<video>` source as step 6.
  - Start new job → `reset()` clears local context; the DB job remains (can be found via a future `/jobs` history view).

## Real-time progress (SSE)

- `/api/jobs/[id]/stream/route.ts` returns `text/event-stream`.
- Opens a Postgres client, runs `LISTEN job_{id}`, pipes each payload as `data: {...}\n\n`.
- Worker issues `NOTIFY job_{id} '<json>'` after every DB write (wrapped in a helper `events.notify(jobId, patch)`).
- Client hook `useJobStream(jobId)` in `WizardContext` subscribes and calls `update(patch)` — existing setters are reused unchanged.
- Heartbeat every 15 s (`: ping\n\n`) to keep proxies from closing idle SSE.

## Frontend changes

Only **two** structural changes to the existing UI:
1. `WizardContext.tsx` gains `jobId: string | null` + a `useJobStream` effect.
2. Every `setInterval` / `setTimeout` used to simulate progress in the step components is removed. State arrives via SSE.

Gradients, animations, stepper, toasts, modals, drawers, and completion confetti all stay exactly as they are.

### Files to modify

| File | Change |
|---|---|
| `src/components/wizard/WizardContext.tsx` | Add `jobId`, `errorStage`, `renders.output_key`; add `useJobStream` hook |
| `src/components/wizard/steps/UploadStep.tsx` | Replace `onInputChange` with real XHR upload to `POST /api/jobs` |
| `src/components/wizard/steps/AudioStep.tsx` | Delete 40–66 (setInterval); keep view |
| `src/components/wizard/steps/TranscriptStep.tsx` | Delete 34–58 (typewriter); keep view |
| `src/components/wizard/steps/CleanStep.tsx` | `setLevel` → PATCH `/api/jobs/[id]`; regenerate re-enqueues |
| `src/components/wizard/steps/SplitStep.tsx` | Replace `SEED_TOPICS` seeding with fetch; edits become PATCHes |
| `src/components/wizard/steps/AvatarStep.tsx` | `generateAll` → POST `/render`; Play→ real video, Download→ signed URL |
| `src/components/ui/VideoPreviewModal.tsx` | Replace SVG silhouette with `<video src={signedUrl} controls>` |
| `src/components/wizard/CompletionScreen.tsx` | Download-all hits real ZIP; Share opens real share-link modal |

### New files

| File | Purpose |
|---|---|
| `src/app/api/jobs/route.ts` | POST upload + create |
| `src/app/api/jobs/[id]/route.ts` | GET status, PATCH edit |
| `src/app/api/jobs/[id]/stream/route.ts` | SSE |
| `src/app/api/jobs/[id]/chunks/route.ts` | PATCH chunk edits |
| `src/app/api/jobs/[id]/render/route.ts` | POST enqueue renders |
| `src/app/api/jobs/[id]/zip/route.ts` | GET ZIP of outputs |
| `src/app/api/jobs/[id]/share/route.ts` | POST create share link |
| `src/lib/db/schema.ts`, `src/lib/db/index.ts` | Drizzle setup |
| `src/lib/storage.ts` | R2 upload/download + signed URLs (`@aws-sdk/client-s3`) |
| `src/lib/queue.ts` | pg-boss wrapper |
| `src/lib/openai.ts` | Whisper + GPT-4o clients |
| `src/lib/heygen.ts` | HeyGen client |
| `src/lib/events.ts` | Postgres NOTIFY helper |
| `worker/package.json`, `worker/tsconfig.json` | Separate worker package |
| `worker/index.ts` | Register handlers, run pg-boss |
| `worker/stages/audio.ts`, `transcribe.ts`, `clean.ts`, `segment.ts`, `render.ts` | One per stage |
| `worker/prompts/clean.ts`, `segment.ts` | GPT-4o prompts + JSON schemas |

## Reused existing code / patterns

- **Toast system** (`src/components/ui/Toast.tsx`) — fire on SSE events (`render.ready`, `job.failed`). API unchanged.
- **ErrorState** (`src/components/ui/ErrorState.tsx`) — render when `jobs.error_code` is set; Retry re-enqueues the failing stage.
- **VideoPreviewModal** — transport bar + modal shell reused; only the video source becomes real.
- **WizardContext.update()** — single write point; SSE handler passes patches through.

## Phased delivery

Each phase ends with something demoable. Feature flag `NEXT_PUBLIC_USE_REAL_API=` on a per-stage basis controls which steps read from SSE vs. keep their mock.

1. **Skeleton — 2–3 days**
   Postgres + migrations, R2 upload, worker boilerplate, SSE endpoint wired end-to-end with a placeholder `echo` stage.
2. **Audio + Transcribe — 2–3 days**
   ffmpeg + Whisper. Steps 2–3 real, 4–6 still mocked.
3. **Clean + Split — 1–2 days**
   GPT-4o with JSON-schema output. Steps 4–5 real.
4. **Render — 2–3 days**
   HeyGen submit + poll + R2 fetch. Step 6 + Completion real. Remove feature flag.
5. **Polish — 1–2 days**
   Retries, wire `ErrorState`, real toasts, structured logs, `/health` endpoint, ZIP download.

**Total: 8–13 days** for a single engineer.

## Cost (per 1-hour lecture)

- Whisper API: **$0.36** (6 × 10-min chunks × $0.006/min)
- GPT-4o cleanup (~30k in / 20k out tokens): **~$0.30**
- GPT-4o segmentation (~20k in / 2k out tokens): **~$0.08**
- HeyGen rendering (6 × ~20 min chunks): **$12–$30** depending on plan
- R2 storage + bandwidth: <$0.10
- **≈ $13–$31 per finished job**

Infra (monthly, demo scale):
- Vercel Hobby: $0
- Railway Postgres + worker: ~$10
- R2: ~$0.10

## Environment variables

```
DATABASE_URL=                  # Railway Postgres
OPENAI_API_KEY=               # Whisper + GPT-4o
HEYGEN_API_KEY=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=distill-media
R2_PUBLIC_URL=                # For signed URLs
NEXT_PUBLIC_APP_URL=
NEXT_PUBLIC_USE_REAL_API=     # Feature flag during migration
```

## Verification (end-to-end)

1. `docker compose up` → local Postgres + worker.
2. `pnpm db:push` runs Drizzle migrations.
3. `pnpm dev` starts Next.js; `pnpm --filter worker dev` starts worker.
4. Navigate to `/new`, upload a real 10-min lecture MP4.
5. Observe: source uploads to R2 → audio extracted → transcription appears with real words (not thermo mock) → Clean shows real filler highlighted → Split shows topics matching actual content → Render produces real HeyGen MP4s visible in `VideoPreviewModal`.
6. Refresh mid-pipeline → state restores from DB via `GET /api/jobs/[id]`.
7. Kill the worker during Step 3 → restart it → job resumes via pg-boss redelivery.
8. Force a failure (invalid `OPENAI_API_KEY`) → `ErrorState` renders with real error; Retry re-enqueues the failed stage.
9. Click Play on a rendered chunk → plays real R2 video.
10. Click Download all → browser receives a ZIP of 6 MP4s.
11. Click Share → modal shows real `/s/{token}` URL; opening it in another tab loads a read-only view.

## Open decisions / assumptions

- **Avatar provider = HeyGen** by default. Swap to D-ID / Tavus by changing only `worker/stages/render.ts` — the rest of the plan is provider-agnostic.
- **No auth in v1.** Jobs owned by a `session_cookie`. Add Auth.js with a migration to `user_id` when needed.
- **ORM = Drizzle**. Swap to Prisma by replacing `src/lib/db/*` — the rest of the plan is ORM-agnostic.
- **Dev-only**: start with local Postgres + Minio (S3-compatible) via `docker-compose`, switch to Railway Postgres + R2 when deploying.
