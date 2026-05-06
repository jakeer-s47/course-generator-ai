#!/usr/bin/env bash
# Entrypoint for the web container.
#
#   1. Wait for Postgres to accept connections (compose's healthcheck
#      already gates startup, but a belt-and-suspenders retry here means
#      `docker run` outside compose still works).
#   2. Apply the Prisma schema. `db push` is idempotent — safe on
#      every boot. Skips if the schema already matches.
#   3. Hand off to whatever CMD was passed (default: `npm start`).
#
# Exits non-zero if any step fails so the container is restarted by
# the orchestrator.

set -euo pipefail

cd /app/web

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] DATABASE_URL is not set — refusing to start" >&2
  exit 1
fi

# Parse host/port from DATABASE_URL for the wait loop.
db_host=$(node -e "const u = new URL(process.env.DATABASE_URL); process.stdout.write(u.hostname);")
db_port=$(node -e "const u = new URL(process.env.DATABASE_URL); process.stdout.write(u.port || '5432');")

echo "[entrypoint] waiting for $db_host:$db_port to accept connections…"
for i in $(seq 1 30); do
  if (echo > "/dev/tcp/$db_host/$db_port") >/dev/null 2>&1; then
    echo "[entrypoint] db reachable on attempt $i"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[entrypoint] db never came up — giving up" >&2
    exit 1
  fi
  sleep 1
done

echo "[entrypoint] applying Prisma schema…"
npx prisma db push --skip-generate

echo "[entrypoint] starting application: $*"
exec "$@"
