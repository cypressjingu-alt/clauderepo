import fs from 'node:fs';
import path from 'node:path';
import { DATA, FFMPEG, POOL, rng } from './config.js';
import { addAlert } from './db.js';
import { run, waitForRoblox } from './ff.js';
import { AAC, loopPath, makeLoop, mix } from './audio.js';
import { FLASH_LEAD, flashVariant, mux, segment, segmentCrf, shortFlashArgs, thumbnail } from './video.js';
import { qa } from './qa.js';
import { metadata } from './metadata.js';

// Put every file a render used on this channel's cooldown. Assets are matched by pool path, so a render made on
// the other machine (different DB ids) can be adopted too. Returns how many files matched.
export function recordUsage(db, plan, renderId) {
  const paths = new Set([...(plan.music?.segments ?? []), ...(plan.bed ?? []), ...(plan.events ?? []), plan.visual].map(a => a.path));
  const find = db.prepare('SELECT id FROM assets WHERE path = ?'), ins = db.prepare('INSERT INTO usage (asset_id, channel_id, render_id, used_at) VALUES (?, ?, ?, ?)');
  const at = new Date().toISOString();
  let n = 0;
  for (const p of paths) { const a = find.get(p); if (a) { ins.run(a.id, plan.channel, renderId, at); n++; } }
  return n;
}

// Shorts audio: a clean stretch of an energetic track (away from crossfades), or for
// pure ambience a window around one of the loudest events so each clip has one in it.
export function shortWindows(plan, count) {
  const r = rng(plan.seed + 1), out = [];
  if (plan.music) {
    const solos = plan.music.segments.map(s => ({ s, lo: s.start + s.fade_in + 2, hi: s.start + s.dur - s.fade_out - 2 }))
      .filter(w => w.hi - w.lo >= 24).sort((x, y) => (y.s.energy ?? 0) - (x.s.energy ?? 0));
    for (const w of solos.slice(0, count)) {
      const len = Math.round(Math.min(r.range(20, 40), w.hi - w.lo - 2));
      out.push({ start: +r.range(w.lo, w.hi - len).toFixed(3), dur: len });
    }
  } else {
    for (const e of [...plan.events].sort((x, y) => y.level_db - x.level_db).slice(0, count)) {
      const len = Math.round(r.range(20, 40));
      const start = +Math.max(3, Math.min(e.at - len * 0.3, plan.duration - len - 10)).toFixed(3);
      const flashAt = e.flash ? +(e.at - FLASH_LEAD - start).toFixed(3) : -1; // the Short burns its own flash in
      out.push({ start, dur: len, ...(flashAt >= 0 && flashAt < len && { flash_at: flashAt }) });
    }
    if (!out.length) out.push({ start: Math.round(plan.duration / 2), dur: 30 });
  }
  return out;
}

export async function render(db, plan, { dryRun = false, log = console.log } = {}) {
  await waitForRoblox(log);
  const id = `${new Date().toISOString().slice(0, 19).replace(/-|:/g, '').replace('T', '-')}-${plan.niche}-${plan.seed}`;
  const dir = path.join(DATA(), 'renders', plan.channel, id), work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const setStatus = (status, q) => db.prepare('UPDATE renders SET status = ?, qa = ? WHERE id = ?').run(status, q && JSON.stringify(q), id);
  db.prepare('INSERT INTO renders (id, channel_id, niche_id, status, seed, target_length, dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, plan.channel, plan.niche, 'rendering', plan.seed, plan.duration, dir, new Date().toISOString());
  if (!dryRun) for (const a of plan.alerts) addAlert(db, plan.channel, a.type, a.payload);
  const abs = p => path.join(POOL(), p), t0 = Date.now(), step = s => log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

  try {
    for (const s of plan.bed ?? []) await makeLoop(abs(s.path), s.in, s.body, loopPath(s.sha256));
    step(`mixing ${plan.duration} s of audio`);
    const audio = path.join(work, 'audio.m4a');
    await mix(plan, POOL(), audio, log);
    step('video segment');
    const seg = path.join(work, 'seg.mp4');
    const segSecs = await segment(abs(plan.visual.path), plan.visual, 1920, 1080, seg);
    // One slot per segment; slots whose segment holds a lightning flash use a flash variant instead.
    const slots = Array(Math.ceil(plan.duration / segSecs) + 1).fill(seg), variants = new Map();
    for (const e of (plan.events ?? []).filter(x => x.flash)) {
      if (!variants.has(e.flash.o)) {
        const f = path.join(work, `flash-${e.flash.o}.mp4`);
        await flashVariant(seg, segSecs, e.flash.o, f, segmentCrf(plan.visual));
        variants.set(e.flash.o, f);
      }
      slots[e.flash.seg] = variants.get(e.flash.o);
    }
    step(`muxing video.mp4 (${slots.filter(s => s !== seg).length} lightning flashes)`);
    await mux(slots, segSecs, audio, path.join(dir, 'video.mp4'), { t: plan.duration });
    const wins = shortWindows(plan, plan.shorts ?? 2);
    step('metadata (magenta engine, template fallback)');
    const meta = await metadata(db, plan, { shorts: wins.length, log });
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
    const title = meta.title;
    const thumb = await thumbnail(seg, meta.thumbnail_text, plan.recipe.thumbnail, dir);
    if (wins.length) {
      step(`${wins.length} short(s)`);
      const vseg = path.join(work, 'vseg.mp4');
      const vsecs = await segment(abs(plan.visual.path), plan.visual, 1080, 1920, vseg);
      for (const [i, w] of wins.entries()) {
        await mux([vseg], vsecs, audio, path.join(dir, `short-${i + 1}.mp4`), { ss: w.start, t: w.dur,
          ...(w.flash_at != null && { videoArgs: shortFlashArgs(w.flash_at) }),
          audioArgs: ['-af', `afade=t=in:d=0.5,afade=t=out:st=${w.dur - 1.5}:d=1.5`, ...AAC, '-b:a', '256k'] });
      }
    }
    step('QA');
    const result = await qa(dir, plan);
    const ffv = (await run(FFMPEG, ['-version'])).out.split('\n')[0];
    fs.writeFileSync(path.join(dir, 'qa.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      render_id: id, created_at: new Date().toISOString(), title, dry_run: dryRun, render_seconds: Math.round((Date.now() - t0) / 1000),
      outputs: { video: 'video.mp4', thumbnail: path.basename(thumb), shorts: wins.map((w, i) => ({ file: `short-${i + 1}.mp4`, ...w })) },
      chapters: plan.music?.chapters ?? [], credits: plan.credits, sources: plan.sources, tools: { ffmpeg: ffv }, plan,
    }, null, 2));
    setStatus(result.pass ? 'passed' : 'failed', result);
    if (result.pass) {
      fs.rmSync(work, { recursive: true, force: true }); // everything needed to rebuild is in the manifest
      if (!dryRun) recordUsage(db, plan, id);
    }
    step(`done: QA ${result.pass ? 'passed' : 'FAILED'}`);
    return { id, dir, qa: result };
  } catch (e) {
    setStatus('failed', { pass: false, error: e.message });
    throw e;
  }
}
