# Handoff: YouTube ambient-video automation, design decisions

Context from a planning ("grill me") session on 2026-09-24. **Nothing has been implemented yet.** Every decision below was confirmed by the owner (Cypress) unless it's listed under "Defaults filled in". This doc un-parks the "Parked: YouTube ambient automation" section of the laptop-server handoff and relies on that plan's topology.

## Goal
An automated pipeline that makes and publishes long ambient videos: "1 hour lobby jazz", "10 hours of thunder", "jazz in a rainy café". That means a still image or short visual loop over a long audio bed.
- **Main purpose: agency showcase.** The channel proves the tool works, so the tool can be sold or run for client channels. It's also a hobby/experiment. Ad revenue (YPP) is a minor goal.
- One showcase channel, **many small niche aesthetics** rotated on it, to avoid competing head-on with the big channels.

## Hard constraints (from the laptop plan)
- Runs on the **laptop**: 8 GB RAM (soldered), Windows, CPU unknown. The laptop sometimes leaves the house.
- Renders use the **loop-copy trick**: encode a short visual loop once, then stream-copy it to full length with the audio.
- **Heavy jobs never run while Roblox is running.** They queue until `RobloxPlayerBeta.exe` exits.
- User-facing text (Jingu alerts, dashboard) says "magenta engine", never "OmniRoute" or "gateway".
- New localhost HTTP endpoints get reviewed by `operator-security-reviewer` before they're committed.

## Decisions

### Rights and sources
- Music comes from **royalty-free sources, but only ones whose terms explicitly allow music-only / static-image / compilation videos.** Mainstream libraries prohibit this format:
  - Epidemic Sound: no music-only content, "still or minimal visuals" named explicitly.
  - Artlist: no playlist-style videos or "audio tracks with static images".
  - Pixabay: its "standalone" clause is risky.
- **Source registry** (`config/sources.yaml`): per source, the terms URL, date verified, `compilation_ok`, `attribution_required`, credit template and license type. Files from a source not marked `compilation_ok` are never used.
- Creative Commons: **CC0 and CC-BY only.** Not NC (the use is commercial), not SA (the video would have to be CC-BY-SA), not ND (CC 4.0 treats syncing music to moving images as an adaptation).
- Ambience (beds and one-shot events) comes from the same pool: CC0 recordings (e.g. downloaded by hand from Freesound) or your own recordings. Library sound effects carry the same "no standalone use" problem.

### Pool and ingest
- A person curates and drops files. **Everything after the drop is automated.**
- The drop point is a **dedicated `ambient-pool` Syncthing share** on the desktop and laptop, separate from the repo and vault shares. The pipeline treats it as **read-only**.
- Layout (folder = tag, and the second level is the source):
  ```
  ambient-pool/
    music/<genre>/<source>/...
    ambience/beds/<type>/<source>/...      # continuous: rain, wind, room tone
    ambience/events/<type>/<source>/...    # one-shots: thunderclaps, cups, birds
    visuals/<aesthetic>/<source>/...       # stills or short loops
  ```
- Ingest auto-analyzes every file: BPM, key, loudness, duration and silence.
- Credits are read from **embedded tags**. When tags are missing, the credit is **guessed from the filename**, and the track is still used.
- Derived data (analysis, usage history, cooldowns, blocked tracks, keyword cache) lives in a **local SQLite database, never synced** (the same lesson as `~/.omniroute`).

### Formats and audio engine
- Three formats: **music playlist**, **pure ambience**, and **layered music + ambience**.
- Playlists use **smooth-flow ordering**: neighbors have similar tempo, key and energy, with 3–6 s crossfades and matched loudness.
- Track reuse: **no repeats within a video**, plus a **cooldown across videos**. When the pool runs dry, the cooldown is **relaxed (least recently used first) and you get an alert**, and the video still publishes on schedule.
- Ambience is a **looped bed plus random events**: a crossfade-looped bed, with one-shot events at random times, volumes and stereo positions, so hours of audio never audibly repeat.
- Length is **per niche, as a range** (e.g. jazz 1–3 h, thunder 8–10 h). Each video picks a length within the range.

### Niches and rotation
- A niche is a **recipe over shared pools**, for example:
  ```yaml
  id: rainy-tokyo-cafe
  format: layered            # playlist | ambience | layered
  music: [jazz, lofi]
  ambience: { bed: rain, events: [cafe-cups, distant-thunder] }
  visual: tokyo-night
  motion: still              # still | loop | effects
  length: [1h, 3h]
  weight: 3
  ```
- The next niche is picked by **weighted rotation**, with no back-to-back repeats. Everything goes on **one channel**.

### Visuals
- The visual comes from the **pool first, with AI fallback** when an aesthetic has nothing in the pool.
- The AI fallback is **free only**: whatever the magenta engine's free providers can do. If nothing free works, **that niche's slot is skipped** and you get an alert.
- **Motion is set per template**: still, seamless loop, or code effects. **No overlays** (clean screen).

### Metadata and thumbnails
- Titles, descriptions and tags are **written by the LLM through the magenta engine** and steered by **keyword research** from the YouTube Data API (read-only).
- The code adds chapter timestamps and credits. If the LLM is down, **plain string templates** are used instead, so a video never waits on the LLM.
- The thumbnail is the **video's own frame plus title text**, with fonts and colors set per template.

### Publishing
- The **permanent publisher for all channels, including clients, is YouTube Studio browser automation**: Playwright driving a persistent Chromium profile.
- Videos are **auto-scheduled into fixed cadence slots**. Each one stays private until its slot, which gives a natural veto window.
- Production runs by **keeping a buffer full**: a job renders just enough to refill each channel's buffer of scheduled videos.
- Cadence **ramps up automatically**. It starts at 3 per week and steps up as the pools grow enough to keep the cooldown healthy.
- **Content ID**: the pipeline reads Studio's pre-publish copyright check.
  - If the claim is monetization-only, the video **publishes anyway**, the claim is logged, and **the claimed track is blocked from future videos**.
- **Shorts**: 1–2 per long video. Each is a vertical crop with the best 20–40 s of audio and a short hook, linked to the long video through Studio's "related video" field. The same scheduler slots them between long uploads.

### Operations
- The pipeline runs **only on the laptop, and only while it's "home"** (plugged in and on the home Wi-Fi, the same check as Jingu). It **pauses when away**, and the buffer of videos already scheduled in Studio covers trips. There's no desktop failover, and the Google sessions live on one machine.
- **Control**: a web dashboard at `/yt` behind the operator's front door shows the queue, schedule, pool health and veto buttons. **Jingu relays urgent alerts** (pool low, Studio script broke, re-auth needed, niche skipped).
- **Showcase**: the channel itself, plus a weekly **static proof page** (growth, output volume) exported to free static hosting. Nothing on the laptop is exposed to the internet.

### Architecture
- The code lives in **this repo** (`cypressjingu-alt/clauderepo`), cloned on the laptop **outside** the Syncthing folders. It talks to Jingu only over HTTP.
- **Node service** for orchestration, Studio automation, the dashboard API and ffmpeg. It uses the same style as the other services: a `run-*.cmd` restart loop and a boot-time scheduled task, and the laptop home-check starts and stops it.
- **Short-lived Python worker** (librosa) for audio analysis at ingest time. It exits when done, so it uses no memory while idle.
- **Channel-scoped data from day one** (pools, cooldowns, Studio profile, schedule, all keyed by channel), but **v1 runs only the showcase channel**. Adding a client later should be a config entry.

## Accepted risks (the owner chose these knowingly; don't re-argue them)
- **Studio automation as the permanent publisher, including on client accounts.**
  - It breaks when Studio's UI changes.
  - It stores client Google sessions on a laptop that leaves the house.
  - YouTube's terms frown on this kind of automation.
  - No API audit is planned.
- **Many niches on one channel.** The algorithm will have a harder time finding the channel's audience.
- **Credits guessed from filenames** can be wrong in public descriptions.
- **Publishing despite monetization-only Content ID claims.**

## Defaults filled in (not asked explicitly; change freely)
- **Claims that block or mute**: if a claim would block the video in some countries or mute its audio, delete the draft and re-render without that track rather than publish.
- **Guessed credits**: every filename-guessed credit is flagged in the dashboard for a spot-check.
- **Studio sessions**: when Google asks for re-verification, publishing pauses and alerts you instead of retrying. After every upload, a read-only API call confirms the video is actually scheduled.
- **Roblox rule**: "never alongside Roblox" also covers Studio publishing (Chromium uses about 0.5–1 GB) and the Python analysis worker, not just renders.
- **Loop-copy for every motion style**: each style (including code effects such as a zoom that goes in and back out) renders one seamless segment, so the loop-copy trick always applies. AI fallback visuals use still or effects motion, because free image-to-video is unlikely.
- **Keyword research** results are cached weekly per niche. Each search call costs a lot of the daily API quota.
- **Chapters** only for playlists. YouTube requires chapters to start at 00:00, at least 3 of them, each at least 10 s long.
- **AI disclosure**: when an AI-generated visual is used, the pipeline ticks Studio's "altered or synthetic content" box.
- **Local renders** are deleted once an upload is verified. The render manifest is kept, so any video can be rebuilt exactly.
- **Ingest ignores incomplete files**: Syncthing temp files, and files whose size is still changing.
- **Duplicates** are detected by audio fingerprint (chromaprint).
- **Loudness targets**: about −14 LUFS for music. Quieter per-template targets for sleep ambience.

## Check before relying on it
- **Laptop specs**: model, CPU, Windows edition and free disk space. Also whether Windows Home's Device Encryption is available on it, which is required now that it holds Google sessions.
- **Compilation-safe sources**: which ones actually allow this format, confirmed from their terms page and recorded in the source registry. Candidates like ZENmix and Free Safe Music are **unverified**.
- **Magenta engine images**: whether any of its free providers can generate images. If none can, the "AI fallback" is effectively "skip", and every visual tag needs pool visuals.
- **Channel verification**: the channel must be phone-verified before it can upload videos longer than 15 minutes or set custom thumbnails.
- **Studio automation on the virtual display**: whether Playwright in headed mode on the lid-closed virtual display survives Google's automated-browser checks.
- **Proof page hosting**: GitHub Pages on a private repo needs a paid plan. Use a separate public repo, or Cloudflare Pages direct upload.
- **`/yt` dependency**: `/yt` depends on the operator split (laptop plan, step 1). It needs its own `operator-security-reviewer` pass.

## Build order (owner chose "render quality first")
1. **Render quality, local only.** This covers:
   - ingest and the Python analysis worker, SQLite, the source registry and recipes;
   - playlist sequencing, the bed-plus-events ambience engine and layered mixing;
   - per-motion loop segments, loop-copy muxing, thumbnails, Shorts cuts, and automatic QA (silence, clipping, loudness, duration, loop seams).
2. **Metadata**: the LLM through the magenta engine with the template fallback, the keyword cache, chapters and credits.
3. **Studio publisher**: upload, schedule, related-video links for Shorts, reading the copyright check, and read-back verification.
4. **Scheduler**: buffer refill, weighted rotation, the cadence ramp, and home/Roblox gating.
5. **Dashboard** `/yt` plus Jingu alerts (security review).
6. **Proof page.**
7. **Client onboarding** (config only, thanks to channel-scoped data).
