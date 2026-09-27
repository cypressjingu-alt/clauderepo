# Handoff: YouTube ambient-video automation

**Snapshot:** 2026-09-27 · **Status:** planning done, nothing built yet · **Next step:** Milestone 1, render quality (local only)

This brief is for a Claude session that will build the project on the owner's own machines. It comes from a planning ("grill me") session in Claude Code on the web ([session link](https://claude.ai/code/session_01964E9D1Bdi1WQBx2B6VC5m)). That session ran in a cloud container that can't reach local files, so the build continues in a local session.

The owner is Cypress. Pronouns weren't stated, so this doc uses "they".
- Everything under **Decisions** was confirmed by the owner.
- Everything under **Defaults** was filled in by the planner and is open to change.

This file replaces the earlier `docs/design-decisions.md` and contains everything that was in it.

## Start here

1. **Get the repo:** `git clone https://github.com/cypressjingu-alt/clauderepo`.
   - Its only branch is `claude/clever-fermat-37fw8v`. GitHub made it the default because it was pushed first.
   - It holds nothing but this file. Ask the owner whether to create `main` from it.
2. **Check the setup:** ask the owner which machine you're on, and which parts of the laptop-server plan (section 3) exist yet. Milestone 1 depends on none of them, so the desktop is fine for development.
3. **Build Milestone 1** (section 9). Keep the laptop's 8 GB RAM limit in mind even while developing on the desktop.
4. **What's settled:** don't re-argue the owner's decisions (section 5) or accepted risks (section 6). The defaults in section 7 are open to change.
5. **Asking the owner:** they asked for this question style during planning, so use it. Put one multiple-choice question at a time (AskUserQuestion), with 2–4 concrete options and the recommended option first.

## 1. What we're building

An automated pipeline that makes and publishes long ambient YouTube videos, like "1 hour lobby jazz", "10 hours of thunder" or "jazz in a rainy café". Each video is a still image or short visual loop over a long audio bed, usually an hour or more.

Purpose, in the owner's order of priority:
1. **Agency showcase.** The channel proves the tool works, so the owner can sell the tool or run channels for clients.
2. **Hobby and experiment.**
3. **Ad revenue** matters least. YouTube's Partner Program rules on mass-produced, repetitive content target this format anyway.

Strategy: one showcase channel that rotates many small niche aesthetics, so it isn't competing head-on with the big channels.

## 2. Where things stand

- **This repo:** only this file. No code.
- **OmniRouteChat** (the owner's "Jingu" stack at `C:\Users\Cypress\Documents\OmniRouteChat`): the planning session never touched it.
- **Laptop-server plan:** a separate handoff, also planned but not yet implemented when it was written.
  - Ask the owner what has been done since.
  - Section 3 summarizes the parts this project relies on.
  - If you need the full details, ask the owner to paste that handoff.

## 3. The machines and the laptop plan

**Desktop** (ASUS, Windows 11 Home)
- Ryzen 7 7700X, 31 GB RAM, RTX 3070 Ti.
- Shut down every night. Good for development.

**Laptop**
- 8 GB RAM, soldered and not upgradeable.
- Must stay on Windows, because Roblox's anti-cheat blocks Linux.
- Model, CPU, Windows edition and free disk space are unknown.
- It's the **runtime host**, and it sometimes leaves the house.

From the laptop plan:
- The laptop counts as **"home" when it's plugged in AND on the home Wi-Fi**. A home-check script starts services at home and stops them when away.
- Services run as **boot-time scheduled tasks** that need no sign-in, each in a `run-*.cmd` restart loop. There's no auto-login.
- **Syncthing** keeps folders in sync between the desktop and the laptop.
- **Roblox AFK sessions** run overnight on the laptop and are started by hand.
  - Rule: **renders never run while Roblox is running.** They queue until it closes.
  - On a Roblox night the RAM budget is already about 7 of 8 GB.
- **Remote access:** Windows OpenSSH over Tailscale for a shell, and RustDesk for the screen.
- **Display:** the lid stays closed, with a virtual display driver installed.
- **Monitoring:** a dead-man's-switch ping (e.g. healthchecks.io).
- **Jingu**, the owner's personal AI assistant, is a set of Node services bound to 127.0.0.1:

| Service | Port | Role in this project |
|---|---|---|
| magenta engine | 20128 | OpenAI-compatible gateway to mostly free AI providers. Use it for LLM metadata and free image generation. |
| operator (front door) | 20150 | Serves the phone UI through `tailscale serve`. The `/yt` dashboard becomes a route here in a later milestone. |
| brain | 20160 | Sends proactive messages such as reminders and service alerts. Pipeline alerts go through it in a later milestone. |

## 4. Standing rules from the owner

- **Naming:** user-facing text (alerts, dashboard) calls the AI gateway **"magenta engine"**, never "OmniRoute" or "gateway".
- **Env variables:** when a change adds one, **write the placeholder line into `.env` / `.env.example` yourself.** Don't just mention it.
- **Security review:** changes to the operator, the brain or **any localhost HTTP endpoint** are reviewed by the `operator-security-reviewer` agent before they're committed. That agent belongs to the OmniRouteChat setup; ask the owner if you can't find it.
- **If you touch OmniRouteChat:** it has **no git remote**, so run `git status` first. It had uncommitted changes in `operator/` and `discord-bot/settings.json` that must not be clobbered.
- **Jingu-wide rules:** if an alert passes through Jingu, `discord-bot/persona.txt` is the one persona, and Jingu never speaks aloud (text output only).

## 5. Decisions (owner-confirmed)

### 5.1 Music rights and sources
- Music comes from royalty-free sources, **but only from sources whose terms explicitly allow music-only, static-image or compilation videos.**
  - Mainstream libraries forbid exactly this format (section 11).
  - Don't use Epidemic Sound, Artlist or Pixabay music.
- Ambience comes from the same curated pool. It must be CC0 or the owner's own recordings, because library sound effects carry the same "no standalone use" clause.
- Creative Commons licenses: **CC0 and CC-BY only** (reasons in section 11). This follows from the rule above.

### 5.2 Pool and ingest
- A person curates the files and drops them in. **Everything after the drop is automated.** The owner wants it "as automated as possible".
- **Drop point:** a dedicated **`ambient-pool` Syncthing share**.
- **Folder name = tag.** Ingest measures everything else automatically: BPM, key, loudness, duration and silence.
- **Credits:** read from **embedded tags**. When tags are missing, **guess from the filename** and use the track anyway.

### 5.3 Formats and audio
- **Three formats:** music playlist, pure ambience, and layered music + ambience.
- **Playlist order: smooth flow.** Neighboring tracks have similar tempo, key and energy, joined with 3–6 s crossfades at matched loudness.
- **Reuse:** no track repeats within a video, plus a cooldown across videos.
- **When a video can't be filled:** relax the cooldown (least recently used first), still publish on schedule, and send an alert.
- **Ambience: a looped bed plus random one-shot events,** each at a random time, volume and stereo position.
- **Length varies, with a range per niche,** e.g. jazz 1–3 h and thunder 8–10 h.

### 5.4 Niches and rotation
- A niche is a **recipe over shared pools**: music tags, ambience, visual aesthetic, motion style, length range and weight.
- **Weighted rotation** across **many niche aesthetics**, all on **one channel**.

### 5.5 Visuals
- **Visuals come from the pool first, with AI as a fallback** when an aesthetic has no pool visuals.
- **The AI fallback is free only.** If nothing free works, **skip that niche's slot and send an alert.**
- **Motion is set per niche:** still, seamless loop, or code-generated effects.
- **No overlays.** The screen stays clean: no now-playing text, no visualizer, no watermark.

### 5.6 Metadata and thumbnails
- **Titles, descriptions and tags are written by an LLM, steered by keyword research** (YouTube Data API, read-only). Code adds the chapters and credits.
- **Thumbnail:** the video's own frame plus title text, with fonts and colors set per niche.

### 5.7 Publishing
- **YouTube Studio browser automation** (Playwright) is the **permanent publisher for every channel, including clients**. No API upload audit is planned.
- Videos are **auto-scheduled into fixed cadence slots** and stay private until their slot.
- Production **keeps a buffer of scheduled videos full**.
- **Cadence ramps up automatically.** It starts at 3 a week and rises as the pools grow enough to keep cooldowns healthy.
- **Content ID:** if Studio's pre-publish copyright check flags a claim, **publish anyway, log it, and block that track from future videos.**
- **Shorts:** 1–2 per long video, vertical, 20–40 s, linked to the long video.

### 5.8 Operations
- The pipeline runs **only on the laptop, and only while it's home.** It pauses when the laptop is away, with no desktop failover. Videos already scheduled cover trips.
- **Control:** a web dashboard at `/yt` behind the operator's front door. **Jingu relays urgent alerts.**
- **Showcase:** the channel itself, plus a **static proof page** (weekly stats) on free static hosting. Nothing on the laptop is exposed to the internet.

### 5.9 Architecture and scope
- **Code location:** this repo, cloned on the laptop **outside** the Syncthing folders. It talks to Jingu only over HTTP.
- **Node** runs orchestration, Studio automation, the dashboard API and ffmpeg.
- **A short-lived Python worker** (librosa) analyzes audio at ingest time and exits when it's done.
- **Data is channel-scoped from day one,** but v1 runs only the showcase channel.
- **Build order: render quality first** (sections 9 and 10).

## 6. Accepted risks (the owner chose these knowingly; don't re-argue them)

- **Studio automation as the permanent publisher, including on client accounts.** It breaks when Studio's UI changes, it stores client Google sessions on a laptop that travels, and YouTube's terms frown on this kind of automation.
- **Many niches on one channel.** This makes it harder for YouTube to find the channel an audience.
- **Credits guessed from filenames** can be wrong in public descriptions.
- **Publishing despite Content ID claims.**

## 7. Defaults filled in by the planner (not asked; change freely)

**Pool and data**
- **Source from the path:** each file's source is the second folder level, e.g. `music/<genre>/<source>/…`.
- **Source registry** (`config/sources.yaml`): each source's terms URL, date checked, `compilation_ok`, `attribution_required`, credit template and license type. Files from unregistered sources, or from sources without `compilation_ok`, are never used.
- **Read-only pool:** the pipeline never writes to the pool. Derived data goes in a **local SQLite database that is never synced**, because a live database corrupts under sync (the same lesson as `~/.omniroute`).
- **Incomplete files:** ingest ignores Syncthing temp files and files whose size is still changing.
- **Duplicates:** caught by file hash, plus an audio fingerprint (chromaprint) for re-encoded copies.
- **Guessed credits:** flagged on the dashboard so the owner can spot-check them.

**Audio and video**
- **Loudness:** about −14 LUFS for music, with quieter per-niche targets for sleep ambience.
- **Loop segments:** every motion style renders one seamless segment, so the loop-copy trick always applies. AI fallback visuals use still or effects motion, because free image-to-video is unlikely.
- **Chapters:** playlists only.
- **Cleanup:** local renders are deleted once an upload is verified. The manifest (including the random seed) is kept, so any video can be rebuilt.

**Services**
- **LLM metadata** goes through the **magenta engine**. If it's down, use plain string templates, so a video never waits on the LLM. Never use a paid API.
- **Keyword research** results are cached weekly per niche, because search calls use a lot of API quota.

**Publishing**
- **Claims that would block or mute** the video (not just redirect ad revenue): re-render without that track instead of publishing.
- **Studio sessions:** automation uses a **persistent Chromium profile** that the owner signs into once over RustDesk. If Google asks for re-verification, **pause and alert. Never retry.**
- **Upload check:** after each upload, a **read-only API call confirms** the video is actually scheduled. Reading needs no audit.
- **AI disclosure:** when an AI-generated visual is used, tick Studio's **"altered or synthetic content"** box.
- **Veto:** an "unschedule" button on the dashboard makes the Studio automation delete that scheduled video.

**Operations**
- **The Roblox rule is wider than renders.** It also blocks **Studio publishing** (Chromium uses about 0.5–1 GB) and **the analysis worker**. Roblox's process is `RobloxPlayerBeta.exe`.
- **Start/stop:** the laptop's home-check starts and stops the pipeline service, just like the Jingu services.
- **Laptop disk encryption** is required once the laptop holds Google sessions. Check whether Windows Home's Device Encryption is available on it.
- **Proof page hosting:** GitHub Pages needs a paid plan for a private repo, so use a separate public repo or Cloudflare Pages direct upload.

## 8. Open checks (verify before relying on them)

- **Compilation-safe sources:** find real ones and verify each against its terms page, then record it in the registry.
  - ZENmix and Free Safe Music advertise playlist and 24/7 use, but that's **unverified**.
  - This blocks real content, not Milestone 1 code.
- **Magenta engine images:** can any of its free providers generate images? If none can, the AI fallback just means "skip", and every aesthetic needs pool visuals.
- **Laptop specs:** model, CPU, Windows edition, free disk space, and whether Device Encryption is available.
- **Channel verification:** phone-verify the channel. It's required for uploads over 15 minutes and for custom thumbnails.
- **Studio automation on the lid-closed virtual display:** does headed Playwright get past Google's automated-browser checks?
- **`/yt` dependency:** it needs the laptop plan's operator split (the front door moves to the laptop), and it needs its own security review.

## 9. Milestone 1: render quality (suggested plan)

The owner chose "render quality first": perfect the output locally before writing any publishing code. The shape below is the planner's suggestion. Adapt it freely, but check with the owner before changing anything in section 5.

**Deliverable.** A CLI that takes a niche recipe and works entirely offline. It writes these files to `<data>/renders/<channel>/<render-id>/`:
- `video.mp4`: 1080p, H.264 video with AAC-LC 48 kHz stereo audio.
- `thumb.png`: 1280×720, under 2 MB.
- `short-1.mp4` (and optionally `short-2.mp4`): 1080×1920, 20–40 s.
- `manifest.json`: the recipe snapshot, seed, timeline, credits, chapters, and each source's license.
- `qa.json`: the automatic checks, each marked pass or fail with a reason.

The title and description come in Milestone 2. Until then, M1 can use a placeholder built from a string template.

**Suggested layout**
```
config/
  sources.yaml               # source registry
  channels/showcase.yaml     # cadence, buffer size, slots, loudness targets
  niches/<id>.yaml           # recipes
src/                         # Node
  ingest/ plan/ audio/ video/ thumb/ shorts/ qa/ db/ cli.js
analysis/
  analyze.py                 # librosa worker: JSON on stdin, JSON lines out
  requirements.txt
test/
.env.example
```

**Prerequisites (Windows).**
- Tools: Node LTS, a Python 3.12 venv (`librosa`, `numpy`, `soundfile`), a full ffmpeg build with ffprobe (e.g. from gyan.dev), and chromaprint's `fpcalc`.
- Suggested npm packages: `better-sqlite3`, `yaml`, and `@napi-rs/canvas` (thumbnail text with custom fonts and no system dependencies).
- Tool paths go in `.env`, with placeholders in `.env.example`.
- `.gitignore`: `.env`, the data directory, `.venv/`, `node_modules/` and any media.

**Pool layout**
```
ambient-pool/
  music/<genre>/<source>/...
  ambience/beds/<type>/<source>/...     # continuous: rain, wind, room tone
  ambience/events/<type>/<source>/...   # one-shots: thunder, cups, birds
  visuals/<aesthetic>/<source>/...      # stills or short loops
```

**Niche recipe example.** The event rates and levels are suggested additions.
```yaml
id: rainy-tokyo-cafe
format: layered              # playlist | ambience | layered
music: [jazz, lofi]
ambience:
  bed: rain
  bed_level_db: -16          # relative to the music
  events:
    - { type: cafe-cups, every: [40s, 150s], gain_db: [-18, -8] }
    - { type: distant-thunder, every: [120s, 480s], gain_db: [-14, -6] }
visual: tokyo-night
motion: still                # still | loop | effects
length: [1h, 3h]
weight: 3
thumbnail: { font: "<font file>", colors: ["<text>", "<shadow>"] }
```

**Data model (SQLite, keyed by channel wherever it matters)**
- `assets`: id, kind (music / bed / event / visual), tag, source_id, path, sha256, fingerprint, duration, integrated LUFS, true peak, BPM, key, energy, artist, title, credit_guessed, blocked + reason, missing, added_at.
- `usage`: asset_id, channel_id, render_id, used_at. This drives the cooldowns.
- `renders`: id, channel_id, niche_id, status, seed, target length, output paths, QA result, created_at. The YouTube id and scheduled time are added later.
- `alerts`: id, channel_id, type, payload, created_at, delivered_at.

**Stages**
1. **Ingest.** Walk the pool.
   - Skip Syncthing temp files (`~syncthing~*.tmp` on Windows, `.syncthing.*.tmp` elsewhere) and files modified in the last minute.
   - Take the kind, tag and source from the path. Report files whose source is unregistered or lacks `compilation_ok`.
   - Read tags with `ffprobe`. When they're missing, parse the filename instead and set `credit_guessed`.
   - Measure loudness (`ebur128`, or `loudnorm` with `print_format=json`) and leading/trailing silence (`silencedetect`).
   - Send new music files in batches to `analyze.py` for:
     - BPM (`librosa.beat.beat_track`);
     - key (chroma features plus Krumhansl–Schmuckler profiles, since librosa has no built-in key detection);
     - an energy measure.
   - When a file disappears, mark its row `missing` instead of deleting it.
2. **Plan (playlists).**
   - Filter by the recipe's tags, compilation-safe sources, not blocked and off cooldown. If there aren't enough tracks, relax the cooldown least recently used first and raise an alert.
   - Order greedily by a distance that combines tempo (half and double time count as close), key (steps on the Camelot wheel) and energy.
   - Pick a target length within the recipe's range. Land within about ±5% by choosing whole tracks, and fade out the last one.
   - Record chapters. YouTube requires the first at 0:00, at least 3 of them, and each at least 10 s long.
   - Use a seeded random number generator so every plan is reproducible.
3. **Audio.**
   - **Playlists:** apply each track's gain from its ingest loudness, trim silence, chain `acrossfade`, and add a final limiter at about −1 dBTP. Encode straight to AAC: a 10-hour WAV at 48 kHz stereo 16-bit is about 7 GB.
   - **Ambience beds:** make a seamless loop of each bed once (crossfade its tail into its head) and cache it. When a type has several beds, rotate between them with long crossfades.
   - **Ambience events:** place events with a random process driven by each type's rate range, with random gain and pan. Enforce a minimum gap so loud events don't stack.
   - **Mixing events at length:** an ffmpeg filtergraph with one input per event doesn't scale to 10 hours. Either stream PCM from a Node mixer into ffmpeg's stdin, or render the event layer in ffmpeg chunks of about 10 minutes and join them. The owner agreed Python is for analysis only, so a Python mixer would need their OK.
   - **Layered:** mix the music and ambience streams at the recipe's relative level.
4. **Video.**
   - Render one seamless segment per motion style:
     - **still:** a few seconds with `-tune stillimage`;
     - **loop:** crossfade the clip's end into its start;
     - **effects:** an effect that returns to its start state, e.g. a slow zoom in and back out.
   - All segments share one spec (resolution, fps, pixel format, timebase) and start on a keyframe.
   - Build the full length with ffmpeg's concat demuxer (a list file that repeats the segment) and `-c copy`, then mux in the audio.
   - Prefer the concat demuxer over `-stream_loop` with stream copy, and check A/V sync at the end of a 10-hour file.
   - Skip `+faststart`: it rewrites the whole multi-GB file, and YouTube doesn't need it.
5. **Thumbnail.** Take a frame from the segment and add the title text with `@napi-rs/canvas`, using the recipe's font and colors.
6. **Shorts.** Take a 9:16 crop of the visual (or fit it over a blurred fill) with 20–40 s of audio from a strong section. Avoid crossfade boundaries, and for ambience make sure the clip includes an event.
7. **QA.** Check that:
   - duration is within ±1 s of the plan;
   - there are no silent gaps beyond the niche's limit;
   - true peak is at or below −1 dBTP, and integrated loudness is within ±1 LU of the target;
   - there are no clicks at bed loop points;
   - audio and video durations match, and the file probes cleanly.

   A failed check marks the render as failed and records why.

**Resource budget.** Outside Roblox nights the laptop has about 3 GB free (Windows takes about 3.5 GB and the Jingu stack about 1.5 GB). Keep a render's peak RAM under about 1.5 GB, and measure it on a 10-hour ambience render.

**Suggested CLI** (working name `ambient`):
- `ingest`
- `pool status`
- `plan --niche <id> [--length 2h] [--seed n]`
- `render <plan | --niche id>`
- `qa <render-id>`
- `rebuild <manifest>`
- `--dry-run`: runs without touching cooldowns.

**Tests.** Generate synthetic fixtures with ffmpeg so tests need no real media: click tracks at known BPMs, `anoisesrc` noise beds, short tone events and solid-color images. Cover:
- the no-repeat and cooldown rules, and cooldown relaxation with its alert;
- source filtering and deterministic plans;
- loop-seam QA and A/V sync on a long render.

**Done when:**
- each of the three formats renders from a small CC0 dev pool with passing QA;
- a 10-hour ambience render finishes on the desktop within the RAM budget, with no audible repetition or seams in spot checks;
- the owner has listened to samples and signed off.

**Out of scope for M1:** LLM metadata, Studio automation, scheduling, the dashboard, Jingu delivery (alerts are only stored in the table for now), and the proof page.

## 10. Later milestones (owner-confirmed order)

2. **Metadata:** the LLM through the magenta engine with a template fallback, the keyword cache, and chapters and credits in descriptions.
3. **Studio publisher:** upload, scheduling, the "related video" link for Shorts, reading the copyright check, and read-back verification.
4. **Scheduler:** buffer refill, weighted rotation, the cadence ramp, and home/Roblox gating.
5. **Dashboard** at `/yt` plus Jingu alerts. This touches OmniRouteChat and needs a security review.
6. **Proof page.**
7. **Client onboarding.** Config only, thanks to channel-scoped data.

## 11. Research notes (checked 2026-09-24)

- **Epidemic Sound** forbids music-only content under every license, including "a track against still or minimal visuals". ([help article](https://help.epidemicsound.com/hc/en-us/articles/26254496789266-Can-Epidemic-Sound-music-be-used-for-compilations-or-music-listening-content))
- **Artlist** forbids playlist-style videos for passive listening, "audio tracks with static images", and music-only compilations. ([license](https://help.artlist.io/hc/en-us/articles/29490991524253-Understanding-Artlist-s-license))
- **Pixabay** forbids "standalone" use with no creative effort, and a still-image compilation comes uncomfortably close. ([license](https://pixabay.com/service/license-summary/))
- **YouTube Audio Library** terms don't settle compilations either way. ([guide](https://www.licenseorg.com/guide/music-audio/youtube-audio-library))
- **Playlist-safe candidates** (unverified): [ZENmix](https://zenmix.io/royalty-free-lofi) and [Free Safe Music](https://freesafemusic.com/genres/lofi/).
- **Creative Commons** ([CC BY 4.0 legal code](https://creativecommons.org/licenses/by/4.0/legalcode.en)): only CC0 and CC-BY work here.
  - NC rules out commercial use.
  - SA would force the video itself under CC-BY-SA.
  - ND is out because CC 4.0 counts music synced to moving images as an adaptation.
- **YouTube facts behind the plan:**
  - Uploads from API projects that haven't passed YouTube's audit are locked private ([videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)). That's why Studio automation was chosen.
  - Videos over 15 minutes and custom thumbnails need a verified channel.
  - An upload can be at most 12 hours or 256 GB.
  - YouTube recommends AAC-LC stereo at 384 kbps and 48 kHz ([encoding settings](https://support.google.com/youtube/answer/1722171)).
  - The Data API's default quota is 10,000 units a day, and each search costs 100 ([quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)).
