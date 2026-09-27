# ambient

Makes long ambient YouTube videos (lobby jazz, thunder nights, rainy cafés) from a curated pool of music, ambience and visuals. The planning brief is [docs/HANDOFF.md](docs/HANDOFF.md). Milestone 1 (render quality, offline CLI) is built.

## Setup (Windows)
1. Node 24+, then `npm ci`.
2. ffmpeg + ffprobe (the gyan.dev essentials build is fine).
3. Python 3.13 venv: `python -m venv .venv`, then `.venv\Scripts\pip install -r analysis\requirements.txt`.
4. Copy `.env.example` to `.env` and fill in the paths.

## Use
```
node src/cli.js ingest                      # scan the pool (AMBIENT_POOL)
node src/cli.js pool status
node src/cli.js render --niche rainy-tokyo-cafe [--length 2h] [--seed 7] [--dry-run]
node src/cli.js qa <render-id>
node src/cli.js rebuild data/renders/showcase/<render-id>/manifest.json
npm test                                    # ~3 min, generates its own fixtures
node test/bench.js 10h still                # long-render time and peak RAM
```

Pool layout: `music/<genre>/<source>/…`, `ambience/beds/<type>/<source>/…`, `ambience/events/<type>/<source>/…`, `visuals/<aesthetic>/<source>/…`. A source is only used once it's registered in `config/sources.yaml` with `compilation_ok: true`.

Renders go to `data/renders/<channel>/<render-id>/`: `video.mp4`, `thumb.png`, `short-*.mp4`, `manifest.json` and `qa.json`.
