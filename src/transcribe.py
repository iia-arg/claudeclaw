#!/usr/bin/env python3
"""Transcribe an audio file using faster-whisper (local, medium model)."""
import sys
import os

# Override via env for non-standard installs. Defaults match a local
# faster-whisper-medium install under /opt/whisper-local/.
MODEL_BASE = os.environ.get(
    "WHISPER_MODEL_BASE",
    "/opt/whisper-local/models/models--Systran--faster-whisper-medium/snapshots",
)
WHISPER_VENV_SITE = os.environ.get(
    "WHISPER_VENV_SITE",
    "/opt/whisper-local/venv/lib/python3.12/site-packages",
)

def get_model_path():
    if os.path.isdir(MODEL_BASE):
        snaps = os.listdir(MODEL_BASE)
        if snaps:
            return os.path.join(MODEL_BASE, snaps[0])
    return "medium"

def main():
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f"File not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    if os.path.isdir(WHISPER_VENV_SITE):
        sys.path.insert(0, WHISPER_VENV_SITE)
    from faster_whisper import WhisperModel

    model_path = get_model_path()
    model = WhisperModel(model_path, device="cpu", compute_type="int8")

    segments, info = model.transcribe(audio_path, beam_size=5, language="ru")

    text = " ".join(seg.text.strip() for seg in segments)
    print(text)

if __name__ == "__main__":
    main()
