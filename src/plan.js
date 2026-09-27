import { hms, rng } from './config.js';

// A plan is everything a render needs, fixed up front: which files, where, how loud.
// It's pure data (saved in the manifest), so `rebuild` just renders the same plan again.

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BED_XF = 20;          // seconds of crossfade when beds rotate
const BED_TURN = [900, 2400]; // each bed plays 15-40 min before the next takes over
const EVENT_GAP = 4;        // seconds of quiet enforced between one-shots, so they never stack

export function camelot(key) {
  const [name, mode] = (key ?? '').split(' ');
  const p = NAMES.indexOf(name);
  if (p < 0) return null;
  const q = mode === 'minor' ? (p + 3) % 12 : p; // a minor key shares its number with its relative major
  return { num: ((q * 7 + 7) % 12) + 1, minor: mode === 'minor' };
}

// ponytail: equal weights, 1 unit = 8% tempo, 1 Camelot step, or 0.1 energy. Tune by ear.
export function distance(a, b) {
  let d = 0;
  if (a.bpm && b.bpm) {
    const r = Math.log2(a.bpm / b.bpm); // half and double time count as close
    d += Math.min(Math.abs(r), Math.abs(r - 1), Math.abs(r + 1)) / Math.log2(1.08);
  } else d += 1;
  const ka = camelot(a.key), kb = camelot(b.key);
  if (ka && kb) {
    const s = Math.abs(ka.num - kb.num);
    d += Math.min(s, 12 - s) + (ka.minor !== kb.minor ? 1 : 0);
  } else d += 1;
  d += a.energy != null && b.energy != null ? Math.abs(a.energy - b.energy) / 0.1 : 1;
  return d;
}

function candidates(db, kind, tags, reg) {
  const rows = db.prepare(`SELECT * FROM assets WHERE kind = ? AND blocked = 0 AND missing = 0
    AND tag IN (${tags.map(() => '?').join(', ')}) ORDER BY id`).all(kind, ...tags);
  return rows.filter(r => reg[r.source_id]?.compilation_ok === true);
}

const lastUsed = (db, channel) => new Map(db.prepare(
  'SELECT asset_id, MAX(used_at) t FROM usage WHERE channel_id = ? GROUP BY asset_id').all(channel)
  .map(r => [r.asset_id, Date.parse(r.t)]));

const body = a => Math.max(0, (a.duration ?? 0) - (a.lead_silence ?? 0) - (a.trail_silence ?? 0));
const r3 = x => Math.round(x * 1000) / 1000;
const credit = a => ({ asset_id: a.id, path: a.path, source_id: a.source_id, artist: a.artist, title: a.title });

function planMusic(db, { recipe, channel, reg, r, target, now, loudness, alerts }) {
  const pool = candidates(db, 'music', recipe.music, reg);
  const last = lastUsed(db, channel.id);
  const cutoff = now - channel.cooldown_days * 864e5;
  const enough = list => list.reduce((s, t) => s + body(t) - 4.5, 0) >= target * 0.95; // 4.5 s = average crossfade
  const hot = t => last.get(t.id) > cutoff;
  const fresh = pool.filter(t => !hot(t));
  if (!enough(fresh)) {
    // Not enough rested tracks: bring back the ones that have rested longest, and say so.
    const cooled = pool.filter(hot).sort((a, b) => last.get(a.id) - last.get(b.id));
    let reused = 0;
    while (!enough(fresh) && cooled.length) { fresh.push(cooled.shift()); reused++; }
    if (!enough(fresh)) throw new Error(`not enough music for ${recipe.id}: ${pool.length} usable tracks can't fill ${hms(target)}`);
    alerts.push({ type: 'cooldown_relaxed', payload: { niche: recipe.id, reused } });
  }

  // Smooth flow: walk from a random start to one of the 3 nearest unused tracks that keep
  // the ±5% window reachable: either it lands inside, or a shorter track can still finish.
  // ponytail: one step of lookahead, no backtracking; overshoots only when nothing left fits.
  const avail = [...fresh];
  const picked = [avail.splice(Math.floor(r() * avail.length), 1)[0]];
  const xfs = [0];
  let end = body(picked[0]);
  while (end < target * 0.95 && avail.length) {
    const xf = Math.round(r.range(3, 6) * 10) / 10;
    const ranked = avail.map(t => [distance(picked.at(-1), t), t]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    const shortest = t => Math.min(...avail.filter(o => o !== t).map(body));
    const fits = ranked.filter(t => {
      const e = end + body(t) - xf;
      return e <= target * 1.05 && (e >= target * 0.95 || e + shortest(t) - 6 <= target * 1.05);
    });
    const next = fits.length ? fits[Math.floor(r() * Math.min(3, fits.length))] : ranked[0];
    avail.splice(avail.indexOf(next), 1);
    picked.push(next); xfs.push(xf);
    end += body(next) - xf;
  }

  let start = 0;
  const segments = picked.map((t, i) => {
    start = i ? start + body(picked[i - 1]) - xfs[i] : 0;
    return {
      ...credit(t), in: t.lead_silence ?? 0, dur: r3(body(t)), start: r3(start), fade_in: xfs[i], fade_out: xfs[i + 1] ?? 0,
      gain_db: r3(loudness - (t.lufs ?? loudness)), bpm: t.bpm, key: t.key, energy: t.energy,
    };
  });
  return { segments, duration: r3(end) };
}

// YouTube chapters: first at 0:00, at least 3, each at least 10 s. Otherwise none.
function chapters(segments, duration) {
  const ch = segments.map((s, i) => ({ at: i ? Math.floor(s.start + s.fade_in / 2) : 0, title: s.artist ? `${s.artist} – ${s.title}` : s.title }));
  const ok = ch.length >= 3 && ch.every((c, i) => (ch[i + 1]?.at ?? duration) - c.at >= 10);
  return ok ? ch : [];
}

function planBeds(db, { recipe, reg, r, duration, loudness, level }) {
  const beds = candidates(db, 'bed', [recipe.ambience.bed], reg).filter(b => body(b) >= 20);
  if (!beds.length) throw new Error(`no usable "${recipe.ambience.bed}" beds for ${recipe.id}`);
  // Crossfade centres. One bed plays the whole way; several take turns.
  const cuts = [0];
  if (beds.length > 1) for (let t = r.range(...BED_TURN); t < duration - 300; t += r.range(...BED_TURN)) cuts.push(t);
  cuts.push(duration);
  let prev;
  return cuts.slice(0, -1).map((c, i) => {
    const b = beds.length > 1 ? r.pick(beds.filter(x => x !== prev)) : beds[0];
    prev = b;
    const first = i === 0, lastSeg = i === cuts.length - 2;
    const start = first ? 0 : c - BED_XF / 2, end = lastSeg ? duration : cuts[i + 1] + BED_XF / 2;
    return {
      ...credit(b), sha256: b.sha256, in: b.lead_silence ?? 0, body: r3(body(b) - 0.5), offset: r3(r()),
      start: r3(start), dur: r3(end - start), fade_in: first ? 0 : BED_XF, fade_out: lastSeg ? 0 : BED_XF,
      gain_db: r3(loudness + level - (b.lufs ?? loudness)),
    };
  });
}

function planEvents(db, { recipe, reg, r, duration, loudness, alerts }) {
  const all = [];
  for (const spec of recipe.ambience.events ?? []) {
    const files = candidates(db, 'event', [spec.type], reg);
    if (!files.length) { alerts.push({ type: 'missing_events', payload: { niche: recipe.id, type: spec.type } }); continue; }
    let prev;
    for (let t = r.range(...spec.every); t < duration; t += r.range(...spec.every)) {
      const f = files.length > 1 ? r.pick(files.filter(x => x !== prev)) : files[0];
      prev = f;
      const level = r.range(...spec.gain_db); // relative to the program loudness
      // Clips too short for a gated loudness reading fall back to true peak minus 10 dB.
      const lufs = f.lufs ?? (f.true_peak ?? -10) - 10;
      all.push({ ...credit(f), at: t, len: f.duration ?? 1, level_db: r3(level), gain_db: r3(loudness + level - lufs), pan: r3(r.range(-0.7, 0.7)) });
    }
  }
  all.sort((a, b) => a.at - b.at);
  const out = [];
  let free = -Infinity;
  for (const e of all) {
    e.at = r3(Math.max(e.at, free + EVENT_GAP));
    if (e.at + e.len > duration - 10) continue; // keep the final fade-out clear
    out.push(e);
    free = e.at + e.len;
  }
  return out;
}

function pickVisual(db, { recipe, channel, reg, r }) {
  const wantClip = recipe.motion === 'loop';
  const all = candidates(db, 'visual', [recipe.visual], reg).filter(v => (v.duration > 0) === wantClip);
  if (!all.length) throw new Error(`no ${wantClip ? 'clip' : 'image'} visuals for aesthetic "${recipe.visual}" (${recipe.id}); the AI fallback isn't built yet`);
  const last = lastUsed(db, channel.id);
  const oldest = Math.min(...all.map(v => last.get(v.id) ?? 0));
  const v = r.pick(all.filter(x => (last.get(x.id) ?? 0) === oldest)); // least recently used, ties at random
  return { ...credit(v), sha256: v.sha256, clip: wantClip, duration: v.duration, motion: recipe.motion, effect: recipe.effect };
}

export function plan(db, { recipe, channel, reg, seed = Math.floor(Math.random() * 2 ** 31), length, now = Date.now() }) {
  const r = rng(seed);
  const alerts = [];
  const loudness = recipe.loudness ?? channel.loudness_lufs;
  const target = Math.round(length ?? r.range(...recipe.length));
  const ctx = { recipe, channel, reg, r, target, now, loudness, alerts };
  const p = { version: 1, channel: channel.id, niche: recipe.id, seed, recipe, loudness, target, created_at: new Date(now).toISOString() };

  let duration = target;
  if (recipe.format !== 'ambience') {
    const m = planMusic(db, ctx);
    duration = m.duration;
    p.music = { segments: m.segments, chapters: recipe.format === 'playlist' ? chapters(m.segments, duration) : [] };
  }
  if (recipe.format !== 'playlist') {
    const level = recipe.format === 'layered' ? recipe.ambience.bed_level_db ?? -16 : 0;
    p.bed = planBeds(db, { ...ctx, duration, level });
    p.events = planEvents(db, { ...ctx, duration });
  }
  p.visual = pickVisual(db, ctx);
  p.duration = duration;
  p.alerts = alerts;

  // Credits for every distinct file, with each source's license terms as registered today.
  const used = new Map([...(p.music?.segments ?? []), ...(p.bed ?? []), ...(p.events ?? []), p.visual].map(a => [a.asset_id, a]));
  p.credits = [...used.values()].map(a => {
    const src = reg[a.source_id];
    const vals = { title: a.title, artist: a.artist ?? 'Unknown', source: src.name ?? a.source_id, license: src.license };
    const guessed = db.prepare('SELECT credit_guessed FROM assets WHERE id = ?').get(a.asset_id)?.credit_guessed === 1;
    return { asset_id: a.asset_id, source_id: a.source_id, text: (src.credit ?? '{title} by {artist}').replace(/\{(\w+)\}/g, (_, k) => vals[k] ?? ''),
      attribution_required: !!src.attribution_required, guessed };
  });
  p.sources = Object.fromEntries([...new Set(p.credits.map(c => c.source_id))].map(id => [id, reg[id]]));
  return p;
}
