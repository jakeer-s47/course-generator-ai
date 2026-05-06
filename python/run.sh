#!/usr/bin/env bash
# Start the whisper FastAPI server using the venv's binaries directly.
# No `source .venv/bin/activate` needed — your shell stays clean (no
# `(.venv)` prefix), nothing leaks into other terminals.
#
# Usage:
#   ./run.sh
# or from the project root:
#   ./python/run.sh

set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/uvicorn ]; then
  echo "[run.sh] venv not initialised. Setting it up…"
  python3 -m venv .venv
  ./.venv/bin/pip install --quiet -r requirements.txt
fi

exec ./.venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000
