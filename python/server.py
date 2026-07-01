"""
Chapter AI — Whisper transcription service.

A small FastAPI app that wraps faster-whisper. The web container POSTs
audio chunks here and gets back word-level transcripts as JSON.

Why this exists (vs the previous spawn-per-chunk model):

  * The faster-whisper model takes ~1-2 s to load. Spawning a fresh
    Python process per 10-minute chunk paid that load cost N times per
    video. With this service, the model loads ONCE on container startup
    and every subsequent /transcribe call reuses it — saves ~10 s/video
    on a 6-chunk run, and grows linearly with video length.
  * Cleaner separation: the web image no longer needs Python or
    faster-whisper installed. The whisper image is the only thing
    holding model weights and torch dependencies.

Endpoints:
  GET  /health     → { ok, model, device }
  POST /transcribe → multipart file upload → { text, language, duration,
                                                words: [{word, start, end}] }

Environment:
  WHISPER_MODEL      default "base.en". Other valid values include
                     "tiny.en", "base.en", "small.en", "medium.en",
                     "large-v3", "large-v3-turbo".
  FW_DEVICE          "cpu" (default) or "cuda".
  FW_COMPUTE_TYPE    "int8" on CPU (default), "float16" on CUDA.
  FW_CPU_THREADS     CPU threads to use. Default 4.
  WHISPER_VAD        "1" (default) enables Silero VAD silence-skipping.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


# ── Model lifecycle ────────────────────────────────────────────────────
# Lazily imported in the lifespan handler so a /health probe before the
# model finishes loading still responds (and so import errors are
# captured in the logs cleanly).

_state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    from faster_whisper import WhisperModel

    model_name = os.environ.get("WHISPER_MODEL", "base.en")
    device = os.environ.get("FW_DEVICE", "cpu")
    compute_type = os.environ.get(
        "FW_COMPUTE_TYPE", "int8" if device == "cpu" else "float16"
    )
    cpu_threads = int(os.environ.get("FW_CPU_THREADS", "4"))

    print(
        f"[whisper-svc] loading model={model_name} device={device} "
        f"compute_type={compute_type} threads={cpu_threads}",
        flush=True,
    )
    t0 = time.time()
    model = WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        cpu_threads=cpu_threads,
    )
    print(
        f"[whisper-svc] model ready in {time.time() - t0:.1f}s",
        flush=True,
    )
    _state["model"] = model
    _state["model_name"] = model_name
    _state["device"] = device

    yield

    _state.clear()


app = FastAPI(title="Chapter AI Whisper service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": "model" in _state,
            "model": _state.get("model_name"),
            "device": _state.get("device"),
        }
    )


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    beam_size: int = Form(5),
    vad_filter: bool = Form(True),
) -> JSONResponse:
    """
    Transcribe a single audio file. Word timestamps are RELATIVE to the
    file's own timeline; the caller is responsible for shifting them onto
    the original full-audio timeline if it chunked the audio first.
    """
    if "model" not in _state:
        raise HTTPException(503, "model not loaded yet")

    model = _state["model"]

    # Save the uploaded chunk to a temp file. faster-whisper accepts a
    # path; passing a file-like object works too but keeps memory pinned
    # for the whole duration of the transcribe call.
    suffix = Path(file.filename or "audio.mp3").suffix or ".mp3"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        # Stream-copy to avoid loading the whole file into memory at once.
        while chunk := await file.read(1024 * 1024):
            tmp.write(chunk)
        tmp.close()

        # faster-whisper is blocking + CPU-bound. Running it directly on
        # the event loop freezes uvicorn — /health stops responding,
        # parallel /transcribe calls from Node time out at the TCP layer
        # because the accept() loop is blocked. asyncio.to_thread offloads
        # the work to a thread pool so the event loop stays free.
        result = await asyncio.to_thread(
            _run_transcribe, tmp.name, beam_size, vad_filter
        )
        return JSONResponse(result)
    finally:
        try:
            os.unlink(tmp.name)
        except FileNotFoundError:
            pass


def _run_transcribe(audio_path: str, beam_size: int, vad_filter: bool) -> dict:
    """
    Synchronous transcription. Runs in a worker thread so the event loop
    can keep handling other requests (notably /health probes and the next
    chunk's incoming connection from Node).

    Note: faster-whisper holds the GIL during transcription, so multiple
    threads still serialize. That's fine — chunks running through the
    same model on a single CPU are CPU-bound anyway. The thread offload
    is purely about keeping the event loop responsive.
    """
    model = _state["model"]
    # Tightened VAD parameters when vad_filter is on. Recorded live
    # classes have long Q&A pauses, screen-share waits, and reconnect
    # gaps — sending those silent stretches to the model wastes CPU.
    # min_silence_duration_ms=500 trims silences ≥0.5s (the default is
    # 2000 ms which leaves a lot of dead air through). speech_pad_ms
    # keeps a 100 ms cushion either side so word boundaries aren't
    # clipped. Skipped when the caller explicitly disables VAD.
    vad_kwargs: dict = {}
    if vad_filter:
        vad_kwargs["vad_parameters"] = {
            "min_silence_duration_ms": 500,
            "speech_pad_ms": 100,
        }
    segments, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        beam_size=beam_size,
        vad_filter=vad_filter,
        **vad_kwargs,
    )
    words: list[dict] = []
    for seg in segments:
        if not seg.words:
            continue
        for w in seg.words:
            words.append(
                {
                    "word": w.word,
                    "start": float(w.start),
                    "end": float(w.end),
                }
            )
    text = " ".join(w["word"].strip() for w in words).strip()
    return {
        "text": text,
        "language": info.language or None,
        "duration": float(info.duration or 0.0),
        "words": words,
    }
