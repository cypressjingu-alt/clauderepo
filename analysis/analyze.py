"""Audio analysis worker for ingest.

Reads {"files": [{"id": ..., "path": ...}]} as JSON on stdin and writes one JSON line
per file: {"id", "bpm", "key", "energy"} or {"id", "error"}. Exits when done.
Inputs are short mono WAVs that ingest cuts with ffmpeg.
"""
import json
import sys

import librosa
import numpy as np

# Krumhansl-Schmuckler key profiles (librosa has no key detection of its own).
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def key_of(y, sr):
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    if chroma.std() == 0:
        return None
    score, root, mode = max(
        (np.corrcoef(np.roll(profile, k), chroma)[0, 1], k, mode)
        for mode, profile in (("major", MAJOR), ("minor", MINOR))
        for k in range(12)
    )
    return f"{NAMES[root]} {mode}"


def analyze(path):
    y, sr = librosa.load(path, sr=22050, mono=True)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    rate = len(onsets) / max(len(y) / sr, 1.0)
    centroid = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    # ponytail: naive energy = onset density + brightness on 0..1. Replace if playlist flow feels off by ear.
    energy = 0.5 * min(rate / 4.0, 1.0) + 0.5 * min(centroid / 4000.0, 1.0)
    return {"bpm": round(float(np.atleast_1d(tempo)[0]), 2), "key": key_of(y, sr), "energy": round(energy, 3)}


for f in json.load(sys.stdin)["files"]:
    try:
        out = {"id": f["id"], **analyze(f["path"])}
    except Exception as e:  # one bad file must not stop the batch
        out = {"id": f["id"], "error": str(e)}
    print(json.dumps(out), flush=True)
