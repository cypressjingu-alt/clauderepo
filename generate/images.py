"""Generate still images for the pool with Z-Image-Turbo (Apache-2.0), locally on the desktop's GPU.

  <ace-step>\\.venv\\Scripts\\python.exe generate\\images.py <out_dir> <prompts.json>
prompts.json: [{"name": "Lobby 01", "dir": "hotel-lobby/ai-zimage", "prompt": "...", "seed": 1}, ...]
Each image lands as <out_dir>/<dir>/<name>.png at 1920x1088 (the video crops it to 1080).
Images already on disk are skipped, so an interrupted batch just resumes.
Don't run it next to generate/music.py: both want the whole 8 GB card.
"""
import json
import os
import sys
import time
from pathlib import Path

import torch
from diffusers import ZImagePipeline, ZImageTransformer2DModel
from diffusers.hooks import apply_group_offloading

ROOT = os.environ.get("ZIMAGE_ROOT", r"C:\Users\Cypress\tools\ace-step\zimage")
MODEL = os.path.join(ROOT, "split_files", "diffusion_models", "z_image_turbo_bf16.safetensors")


def load():
    transformer = ZImageTransformer2DModel.from_single_file(MODEL, config=ROOT, subfolder="transformer", torch_dtype=torch.bfloat16)
    pipe = ZImagePipeline.from_pretrained(ROOT, transformer=transformer, torch_dtype=torch.bfloat16)
    # The 11.5 GB transformer and 7.5 GB text encoder don't fit an 8 GB card: stream their layers
    # from system RAM as they run. The small VAE stays on the GPU.
    for model in (pipe.transformer, pipe.text_encoder):
        apply_group_offloading(model, onload_device=torch.device("cuda"), offload_type="leaf_level", use_stream=True)
    pipe.vae.to("cuda")
    return pipe


def main(out_dir, prompts_file):
    prompts = json.loads(Path(prompts_file).read_text(encoding="utf-8-sig"))  # -sig: Windows tools often add a BOM
    todo = [p for p in prompts if not (Path(out_dir) / p.get("dir", "") / f"{p['name']}.png").exists()]
    if not todo:
        return
    pipe = load()
    for p in todo:
        target = Path(out_dir) / p.get("dir", "") / f"{p['name']}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        image = pipe(prompt=p["prompt"], width=1920, height=1088, num_inference_steps=9, guidance_scale=0.0,
                     generator=torch.Generator("cuda").manual_seed(p.get("seed", 1))).images[0]
        image.save(target)
        print(json.dumps({"name": p["name"], "file": str(target), "seconds": round(time.time() - t0)}), flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
