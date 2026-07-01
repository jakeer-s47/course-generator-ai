// Avatar IV smoke test — uploads the existing instructor.png, generates a
// ~10 s test clip with hand/body motion via custom_motion_prompt, polls
// until ready, downloads to /tmp/heygen-iv-test.mp4.
//
// Cost: ~5–10 HeyGen credits. Does NOT touch our DB or our render
// routes — pure isolated probe to confirm the v3 contract works on this
// account before we refactor heygen.ts.
//
// Run:  cd web && node scripts/heygen-iv-smoke.mjs
//
// Reads HEYGEN_API_KEY from web/.env.local automatically.

import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");

// ─── load HEYGEN_API_KEY from .env.local ──────────────────────────────
const envText = await fs.readFile(path.join(WEB_ROOT, ".env.local"), "utf8");
const apiKey = (envText.match(/^HEYGEN_API_KEY=(.+)$/m)?.[1] ?? "").trim();
if (!apiKey) {
  console.error("HEYGEN_API_KEY not found in web/.env.local — aborting.");
  process.exit(1);
}

const JOB_ID = "4b53cc6d-80ea-43af-b440-aa6c13ecb752";
const PHOTO_ABS = path.join(WEB_ROOT, "uploads", JOB_ID, "render", "instructor.png");
const OUT_MP4 = "/tmp/heygen-iv-test.mp4";

const SCRIPT = "Hello! This is a motion test for the Avatar IV pipeline.";
const MOTION_PROMPT = "Speaks calmly and gestures naturally with both hands while explaining.";
const VOICE_ID = "d92994ae0de34b2e8659b456a2f388b8"; // John Doe (free-tier default)

// ─── helpers ───────────────────────────────────────────────────────────
const HG = "https://api.heygen.com";
const UP = "https://upload.heygen.com";

async function tryFetch(url, init, label) {
  const resp = await fetch(url, init);
  const body = await resp.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* keep raw */ }
  return { status: resp.status, ok: resp.ok, body, json, label };
}

function fmt({ status, body }) {
  return `HTTP ${status} — ${body.slice(0, 300)}`;
}

// ─── 1. Upload the photo ───────────────────────────────────────────────
console.log(`[1/4] Reading ${PHOTO_ABS}`);
const photoBytes = await fs.readFile(PHOTO_ABS);
console.log(`      ${photoBytes.length} bytes`);

console.log(`[2/4] POST ${UP}/v1/talking_photo  (Content-Type: image/png)`);
const upload = await tryFetch(
  `${UP}/v1/talking_photo`,
  {
    method: "POST",
    headers: { "X-Api-Key": apiKey, "Content-Type": "image/png" },
    body: photoBytes,
  },
  "upload-talking-photo",
);
console.log(`      ${fmt(upload)}`);

const talkingPhotoId = upload.json?.data?.talking_photo_id;
if (!upload.ok || !talkingPhotoId) {
  console.error("Could not extract talking_photo_id. Aborting.");
  process.exit(2);
}
console.log(`      talking_photo_id = ${talkingPhotoId}`);

// Pass talking_photo_id directly as avatar_id in /v3/videos — HeyGen
// treats talking_photo IDs as a kind of avatar internally (the error
// message from the previous attempt confirmed: "Talking photo <id> has
// missing image dimensions"). Skip the /v3/avatars create+train step.
const avatarId = talkingPhotoId;

// ─── 3. Create Avatar IV video ─────────────────────────────────────────
console.log(`[4/5] POST ${HG}/v3/videos  (Avatar IV)`);
const body = {
  type: "avatar",
  avatar_id: avatarId,
  script: SCRIPT,
  voice_id: VOICE_ID,
  title: "Avatar IV smoke test",
  motion_prompt: MOTION_PROMPT,
  expressiveness: "high",
  engine: { type: "avatar_iv" },
  resolution: "720p",
};
console.log(`      body = ${JSON.stringify(body)}`);

// Avatar is still "processing" right after create — retry video create
// until it succeeds or we time out (15 s between attempts, 5 min cap).
let create = null;
const createDeadline = Date.now() + 5 * 60_000;
while (Date.now() < createDeadline) {
  create = await tryFetch(
    `${HG}/v3/videos`,
    {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    "create",
  );
  if (create.ok) { console.log(`      ${fmt(create)}`); break; }
  const errMsg = (create.json?.error?.message ?? "").toLowerCase();
  const looksLikeNotReady =
    errMsg.includes("avatar") &&
    (errMsg.includes("not ready") || errMsg.includes("processing") || errMsg.includes("invalid") || errMsg.includes("not found"));
  if (!looksLikeNotReady) {
    console.error(`      ${fmt(create)}\n      Terminal create error — aborting.`);
    process.exit(7);
  }
  console.log(`      avatar not ready yet → wait 15 s and retry. ${fmt(create)}`);
  await new Promise((r) => setTimeout(r, 15_000));
}
if (!create?.ok) { console.error("create video timed out."); process.exit(7); }

const videoId =
  create.json?.data?.video_id ??
  create.json?.data?.id ??
  create.json?.video_id;
if (!videoId) {
  console.error("No video_id in create response. Aborting.");
  process.exit(8);
}
console.log(`      video_id = ${videoId}`);

// ─── 4. Poll ───────────────────────────────────────────────────────────
console.log(`[5/5] Polling GET ${HG}/v3/videos/${videoId}`);
let lastStatus = "";
let videoUrl = null;
const deadline = Date.now() + 5 * 60_000; // 5 min cap
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5_000));
  // Try v3 status first; if 404, fall back to v1 status.
  let poll = await tryFetch(
    `${HG}/v3/videos/${videoId}`,
    { method: "GET", headers: { "X-Api-Key": apiKey } },
    "poll-v3",
  );
  if (poll.status === 404) {
    poll = await tryFetch(
      `${HG}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
      { method: "GET", headers: { "X-Api-Key": apiKey } },
      "poll-v1",
    );
  }
  const data = poll.json?.data ?? poll.json;
  const status = data?.status ?? "unknown";
  if (status !== lastStatus) {
    console.log(`      status=${status}  ${poll.label}  HTTP ${poll.status}`);
    lastStatus = status;
  }
  if (status === "completed") {
    videoUrl = data?.video_url;
    break;
  }
  if (status === "failed") {
    console.error(`Render failed: ${data?.error?.message ?? "no reason"}`);
    process.exit(5);
  }
}
if (!videoUrl) { console.error("Timed out waiting for completion."); process.exit(6); }
console.log(`      video_url = ${videoUrl.slice(0, 80)}…`);

// ─── 4. Download ───────────────────────────────────────────────────────
console.log(`      Downloading to ${OUT_MP4}`);
const dl = await fetch(videoUrl);
if (!dl.ok || !dl.body) {
  console.error(`Download failed: HTTP ${dl.status}`);
  process.exit(7);
}
await pipeline(Readable.fromWeb(dl.body), createWriteStream(OUT_MP4));
const stat = await fs.stat(OUT_MP4);
console.log(`\n✓ SUCCESS — ${(stat.size / 1024 / 1024).toFixed(2)} MB at ${OUT_MP4}`);
console.log(`Open it and look for hand/body motion.`);
