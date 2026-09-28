"""Generate instrumental tracks with ACE-Step 1.5 (MIT; outputs usable commercially) for the pool.

Runs in ACE-Step's own venv, on the desktop's GPU (the laptop can't run it):
  <ace-step>\\.venv\\Scripts\\python.exe generate\\music.py <out_dir> <prompts.json>
prompts.json: [{"name": "Lobby Piano 1", "dir": "jazz/ai-acestep", "caption": "...", "bpm": 90, "duration": 240, "seed": 7}, ...]
(make_prompts.py writes these.) Each track lands as <out_dir>/<dir>/<name>.flac, tagged with title and artist
so ingest credits it without guessing. Tracks already on disk are skipped, so an interrupted batch just resumes.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ACE = os.environ.get("ACESTEP_ROOT", r"C:\Users\Cypress\tools\ace-step\ACE-Step-1.5")
FFMPEG = os.environ.get("FFMPEG", r"C:\Users\Cypress\tools\ffmpeg\bin\ffmpeg.exe")
ARTIST = "ACE-Step 1.5 (AI)"

import acestep.core.generation.handler.init_service_downloads as downloads  # noqa: E402
from acestep.handler import AceStepHandler  # noqa: E402
from acestep.inference import GenerationConfig, GenerationParams, generate_music  # noqa: E402
from acestep.llm_inference import LLMHandler  # noqa: E402

# Only the 0.6B LM is installed (the one for 8 GB cards). The stock check also insists on the
# 1.7B LM and would pull the whole 9.4 GB main repo to get it.
NEEDED = ["acestep-v15-turbo", "vae", "Qwen3-Embedding-0.6B"]
downloads.check_main_model_exists = lambda p: all((Path(p) / c).is_dir() for c in NEEDED)


def main(out_dir, prompts_file):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    prompts = json.loads(Path(prompts_file).read_text(encoding="utf-8-sig"))  # -sig: Windows tools often add a BOM
    dit, lm = AceStepHandler(), LLMHandler()
    # 8 GB card: park whichever model is idle in system RAM, or a 4-minute track runs out of VRAM.
    msg, ok = dit.initialize_service(project_root=ACE, config_path="acestep-v15-turbo", device="cuda", offload_to_cpu=True)
    if not ok:
        sys.exit(f"DiT init failed: {msg}")
    msg, ok = lm.initialize(checkpoint_dir=os.path.join(ACE, "checkpoints"), lm_model_path="acestep-5Hz-lm-0.6B", backend="pt",
                            device="cuda", offload_to_cpu=True)
    if not ok:
        sys.exit(f"LM init failed: {msg}")
    # A prompt can occasionally hang the generator. Each one is marked "started" first; a mark left over
    # from a killed run (see run-batch.ps1) means it hung, so it's skipped for good instead of retried.
    started = out / ".acestep"
    started.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for p in prompts:
            target = out / p.get("dir", "") / f"{p['name']}.flac"
            mark = started / f"{p['name']}.started"
            if target.exists() or mark.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            mark.touch()
            seed = p.get("seed", 1)
            params = GenerationParams(caption=p["caption"], lyrics="[Instrumental]", instrumental=True, bpm=p.get("bpm"),
                                      duration=p.get("duration", 240), shift=3.0, seed=seed)
            config = GenerationConfig(batch_size=1, audio_format="flac", use_random_seed=False, seeds=[seed])
            result = generate_music(dit, lm, params, config, save_dir=tmp)
            if not result.success:
                print(json.dumps({"name": p["name"], "error": result.error}), flush=True)
                mark.unlink()  # a clean failure may be worth a retry next run
                continue
            subprocess.run([FFMPEG, "-hide_banner", "-v", "error", "-y", "-i", result.audios[0]["path"], "-map_metadata", "-1",
                            "-metadata", f"title={p['name']}", "-metadata", f"artist={ARTIST}", "-c", "copy", str(target)], check=True)
            mark.unlink()
            print(json.dumps({"name": p["name"], "file": str(target), "seed": seed}), flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
