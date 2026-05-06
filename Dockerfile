# syntax=docker/dockerfile:1.7

# ─── Stage 1: install npm deps ───────────────────────────────────────────
# Separate stage so a code-only change doesn't re-run `npm ci`.
FROM node:22-bookworm-slim AS deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ─── Stage 2: build Next.js ──────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app/web

COPY --from=deps /app/web/node_modules ./node_modules

# Schema first so `prisma generate` can run before the rest of the source.
COPY web/prisma ./prisma
RUN npx prisma generate

COPY web ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ─── Stage 3: runtime image ──────────────────────────────────────────────
# Final image carries: Node + ffmpeg + the built Next.js app + production
# node_modules. NO Python — transcription is delegated to the `whisper`
# service over HTTP (see python/server.py + python/Dockerfile).
FROM node:22-bookworm-slim AS runtime
WORKDIR /app/web

# System deps:
#   - ffmpeg / ffprobe — Step 2 audio extraction + Step 3 chunking
#   - python3          — yt-dlp ships as a Python script bundled inside
#                        node_modules/youtube-dl-exec/bin/, so the runtime
#                        still needs a Python interpreter for URL ingestion.
#                        Using python3-minimal (~30 MB) keeps the image
#                        small without pulling pip / faster-whisper / torch.
#   - tini             - proper PID 1 so SIGTERM reaches Node and ffmpeg
#                        children get killed cleanly on shutdown.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3-minimal \
        tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/web/.next ./.next
COPY --from=builder /app/web/public ./public
COPY --from=builder /app/web/package.json ./
COPY --from=builder /app/web/package-lock.json ./
COPY --from=builder /app/web/next.config.ts ./
COPY --from=builder /app/web/prisma ./prisma
COPY --from=builder /app/web/node_modules ./node_modules
COPY --from=builder /app/web/src ./src
COPY --from=builder /app/web/tsconfig.json ./tsconfig.json

# Persistent uploads dir — backed by a docker volume in compose.
RUN mkdir -p /app/web/uploads

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_DIR=/app/web/uploads \
    NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

# Entrypoint runs prisma db push (idempotent) on every boot so a fresh
# Postgres volume gets the schema automatically.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["npm", "start"]
