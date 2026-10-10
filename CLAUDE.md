# Ambient video pipeline: notes for Claude

Makes long ambient YouTube videos (lobby jazz, rainy Tokyo café, thunder night), with a still or looping image over
AI music and ambience, and publishes them to the owner's channel **Calm Ambiance Music** (`UCL4JMjQiC72Sn2wy1i5MyNQ`)
through YouTube Studio. The owner is Cypress. The full design brief is `docs/HANDOFF.md` (§5 is settled; don't
re-argue it). Detailed notes and history are in the Obsidian vault `C:\Users\Cypress\Desktop\ambient vault`:
Home, Setup, Architecture, Config reference, Milestone 1–4, Build log, Open questions. Read the relevant note first.

## Status (2026-10-10)
- **M1 render, M2 metadata, M3 Studio publisher and M4 scheduler are done.**
- **What runs on its own:** one long video a day at 18:00 Asia/Singapore, each with 2 Shorts 6 h and 12 h later. The hourly scheduler keeps 7 days scheduled ahead.
- **Next:**
  - Pool top-up of about 200 jazz tracks on the PC, so tracks don't repeat within 30 days.
  - Test whether Studio stays signed in under an S4U task, which would let the scheduler run with nobody logged in.
  - M5 (the `/yt` dashboard and Jingu alerts; touches OmniRouteChat and needs a security review), M6 (proof page), M7 (clients).

## Machines
- **Desktop PC (this repo):** `C:\Users\Cypress\Documents\clauderepo`.
  - Develop and **commit here**, push to GitHub `cypressjingu-alt/clauderepo` on `main`.
  - It has the GPU (RTX 3070 Ti) for AI generation: `generate/` (ACE-Step 1.5 music, Z-Image-Turbo images) in the venv at `C:\Users\Cypress\tools\ace-step`.
  - Generation needs the GPU to itself: no games, Wallpaper Engine or Medal.
- **Laptop (runtime host):** `C:\Users\User\Documents\clauderepo`.
  - Pulls from GitHub. Renders, uploads and runs the scheduler.
  - Reach it with `ssh user@100.86.68.11` (Tailscale). The remote shell is cmd, so send PowerShell **encoded**:
    `$e = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script)); ssh -o BatchMode=yes user@100.86.68.11 "powershell -NoProfile -NonInteractive -EncodedCommand $e"`.
    One-off scripts go to the laptop by `scp` into `data\`, as `.cjs` files (the repo is `"type": "module"`). Quotes in `node -e` get mangled over SSH.
  - SSH drops now and then. Long jobs keep running on the laptop: check `data\logs\*.log` instead of waiting on SSH.
- **The pool** (music, ambience, visuals) lives in `C:\Users\Cypress\ambient-pool` and syncs desktop → laptop with Syncthing (folder `ambient-pool`). The pipeline never writes to the pool.

## Laptop tasks and logs
| Task | What it does | Log |
|---|---|---|
| `ambient-scheduler` (hourly, interactive) | `node src/cli.js tick`: finish uploads → refill the 7-day buffer (weighted rotation) → delete `.mp4`s a day after going live | `data\logs\scheduler.log` |
| `ambient-heartbeat` (every 5 min, S4U) | `src/heartbeat.js`: healthchecks.io ping (laptop-down alert), `buffer_low` alarm, posts alerts to Discord | (exit code) |
| `Jingu` | the owner's assistant stack. **Never enable or disable it**; the owner decides which machine runs Jingu | |

`data\logs\studio.log` has every Studio action. The uploads table and undelivered alerts: `node data\show-uploads.cjs`.

## Commands (`node src/cli.js …`)
`ingest`, `pool status`, `plan|render --niche <id>`, `qa`, `rebuild`, `metadata <render>`, `adopt <render>`,
`publish <render> [--private]`, `schedule <render> [--now]`, `verify <render>`, `tick`. Tests: `npm test` (28).

## Owner rules (always)
- **Secrets:**
  - Never type, print or echo a password, key, token, webhook or ping URL; probe with status codes only.
  - When code adds an env var, write its empty placeholder line into `.env` and `.env.example` yourself; the owner pastes the values.
  - The `.env` keys are `YOUTUBE_API_KEY`, `AMBIENT_PING_URL`, `AMBIENT_ALERT_WEBHOOK`, `MAGENTA_ENGINE_KEY`, and `OMNIROUTE_KEY` (a user env var).
- **Windows:** don't change Windows system or security settings yourself; give the owner the command.
- **The AI gateway:**
  - In user-facing text, call it the **"magenta engine"**: never OmniRoute or gateway.
  - Gemini models only: never Qwen, never `auto/*`.
- **Roblox:** no rendering, publishing or analysis while `RobloxPlayerBeta.exe` runs on the laptop.
- **Music sources:** incompetech is out of use. AI music (`ai-acestep`) and AI images (`ai-zimage`) are the main sources.
- **Descriptions** carry no AI wording; Studio's AI-use answer is "Yes" for every video.
- **Signed out:** if Studio is signed out or asks to verify, alert and stop. Never retry the sign-in. The owner signs in over RustDesk.
- **The owner's email** (cypress.jingu@gmail.com) is for identification only.

## Hard-won gotchas
- **Studio automation** (`src/studio.js`):
  - **Navigation:** always go through `about:blank` (`go()`); otherwise Studio swallows navigations.
  - **Saving:** the Save button enables a moment after Done.
  - **Success:** a save is judged by Studio's own page (`studioState`), not by confirmation text.
  - **Pop-ups:** a "You're all set … refresh" notice can block the upload; the uploader refreshes and retries.
  - **Re-running `publish` is always safe:** it reconciles with Studio first.
  - **Daily upload limit:** until a further one-time verification, Studio allows about 10 uploads in 24 h. It only bites when catching up; `tick` then pauses for 24 h (`upload_limit` alert).
  - **Silent exits:** Playwright exits quietly on Ctrl+C or a closed console. `cli.js` logs `stopped by SIG…` when that happens.
- **Linking a Short to its video** needs YouTube's advanced-features verification. It's not done yet, so Shorts are unlinked.
- **The Claude desktop app virtualizes AppData:** put scripts in `C:\Users\Cypress\tools`, not in the scratchpad.
- **PowerShell 5.1:**
  - `git commit -m` with quotes breaks, so use `-F <file>`.
  - Use `npm.cmd`, not `npm`.
  - `"$var:"` inside strings is a parse error: write `"${var}:"`.
