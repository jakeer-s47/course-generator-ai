# Whisper transcription service.
# Loads a faster-whisper model on startup; web container POSTs audio
# chunks here and gets word-level transcripts back as JSON.

FROM python:3.12-slim AS runtime

WORKDIR /app

# faster-whisper uses ffmpeg internally for audio decoding when given
# arbitrary input formats (mp3, m4a, webm, etc).  python:slim doesn't
# include it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first so a code-only edit doesn't re-install pip deps.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# App code.
COPY server.py ./

# Models cache to /root/.cache/huggingface — back this with a named
# volume in compose so model downloads survive container rebuilds.
ENV HF_HOME=/root/.cache/huggingface

# Default knobs — overridden by compose env.
ENV WHISPER_MODEL=base.en \
    FW_DEVICE=cpu \
    FW_COMPUTE_TYPE=int8 \
    FW_CPU_THREADS=4

EXPOSE 8000

# tini reaps zombie ffmpeg children if a transcribe call is cancelled.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
