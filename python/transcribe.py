"""
Stream-style transcription helper for the Chapter AI Node app.

Usage:
    python3 transcribe.py <audio_path> [model_name]

Defaults to model `base.en`. Other valid names: `tiny.en`, `base.en`,
`small.en`, `medium.en`, `large-v3`, `large-v3-turbo`, etc. The first run
for a given model downloads it to ~/.cache/huggingface (~150 MB for base).

Output: NDJSON lines on stdout, one of:
    {"type": "progress", "percent": 0..100, "partial_text": "..."}
    {"type": "result",   "text": "...", "language": "...",
                         "duration": <sec>, "words": [...]}
    {"type": "error",    "message": "..."}

Diagnostics go to stderr so stdout stays parseable.
"""

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        emit_error("usage: transcribe.py <audio_path> [model_name]")
        return 2

    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base.en"

    if not Path(audio_path).is_file():
        emit_error(f"audio file not found: {audio_path}")
        return 2

    try:
        # Imported here so usage errors above don't pay the import cost.
        from faster_whisper import WhisperModel
    except ImportError as exc:
        emit_error(
            "faster-whisper not installed. Run "
            "'pip install -r python/requirements.txt' inside the venv. "
            f"Original error: {exc}"
        )
        return 3

    # int8 on CPU is the right default for our use case — ~3-4x faster than
    # float16 with negligible accuracy hit on lecture audio. CUDA users can
    # set FW_DEVICE=cuda + FW_COMPUTE_TYPE=float16 in the env.
    import os

    device = os.environ.get("FW_DEVICE", "cpu")
    compute_type = os.environ.get(
        "FW_COMPUTE_TYPE", "int8" if device == "cpu" else "float16"
    )
    # When the Node side spawns N workers in parallel, each Python process
    # should use ONE CPU thread — otherwise the workers fight each other
    # and we get worse-than-serial throughput. Defaults to 1.
    cpu_threads = int(os.environ.get("FW_CPU_THREADS", "1"))
    # VAD silence-skipping. Built into faster-whisper (Silero VAD); shaves
    # ~30 % off lecture-style audio at no quality cost. Disable per-job
    # via WHISPER_PYTHON_VAD=0 if it ever drops content.
    vad_filter = os.environ.get("WHISPER_PYTHON_VAD", "1") != "0"

    print(
        f"[transcribe] loading model={model_name} device={device} "
        f"compute_type={compute_type} threads={cpu_threads} vad={vad_filter}",
        file=sys.stderr,
        flush=True,
    )
    model = WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        cpu_threads=cpu_threads,
    )

    # word_timestamps=True forces faster-whisper to emit per-word time
    # ranges; without it `segment.words` is None.
    segments, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        beam_size=5,
        vad_filter=vad_filter,
    )

    total_dur = float(info.duration) or 0.0
    language = info.language or None

    all_words: list[dict] = []
    last_emit_percent = -1

    for seg in segments:
        if seg.words:
            for w in seg.words:
                all_words.append(
                    {
                        "word": w.word,
                        "start": float(w.start),
                        "end": float(w.end),
                    }
                )

        percent = (
            min(100, int((float(seg.end) / total_dur) * 100))
            if total_dur > 0
            else 0
        )
        # Throttle: only emit when percent moves at least 2 points (cuts
        # stdout volume on dense word streams).
        if percent - last_emit_percent >= 2:
            last_emit_percent = percent
            partial_text = " ".join(w["word"].strip() for w in all_words)
            emit_line(
                {
                    "type": "progress",
                    "percent": percent,
                    "partial_text": partial_text,
                }
            )

    final_text = " ".join(w["word"].strip() for w in all_words).strip()
    emit_line(
        {
            "type": "result",
            "text": final_text,
            "language": language,
            "duration": total_dur,
            "words": all_words,
        }
    )
    return 0


def emit_line(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def emit_error(message: str) -> None:
    emit_line({"type": "error", "message": message})


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        emit_error(f"{type(exc).__name__}: {exc}")
        sys.exit(1)
