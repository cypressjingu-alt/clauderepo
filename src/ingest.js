import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { POOL, PYTHON, ROOT, loadSources } from './config.js';
import { ffmpeg, measure, probe, run, waitForRoblox } from './ff.js';

const KINDS = [['music', 'music'], ['bed', 'ambience/beds'], ['event', 'ambience/events'], ['visual', 'visuals']];
const AUDIO = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|aiff?)$/i;
const VISUAL = /\.(jpe?g|png|webp|mp4|mov|webm|mkv)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const SYNC_TEMP = /^~syncthing~.*\.tmp$|^\.syncthing\..*\.tmp$/i;
const SETTLE_MS = 60_000; // a file modified this recently may still be arriving

const sha256 = file => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

// "01 - Artist - Title.mp3" -> { artist, title }. Only used when tags are missing.
export function guessCredit(file) {
  const stem = path.basename(file, path.extname(file)).replace(/_/g, ' ').replace(/^\d+\s*[-.]\s*/, '').trim();
  const i = stem.indexOf(' - ');
  return i > 0 ? { artist: stem.slice(0, i).trim(), title: stem.slice(i + 3).trim() } : { artist: null, title: stem };
}

async function examine(abs, kind) {
  const p = await probe(abs);
  const tags = Object.fromEntries(Object.entries({ ...p.streams?.[0]?.tags, ...p.format?.tags })
    .map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const row = { duration: +p.format.duration || null, sha256: await sha256(abs), artist: tags.artist || tags.album_artist || null, title: tags.title || null, credit_guessed: 0 };
  if (!row.artist || !row.title) {
    const g = guessCredit(abs);
    row.artist ??= g.artist;
    row.title ??= g.title;
    row.credit_guessed = 1;
  }
  if (kind === 'visual') {
    const v = p.streams.find(s => s.codec_type === 'video');
    row.width = v?.width;
    row.height = v?.height;
    if (IMAGE.test(abs)) row.duration = null;
    return row;
  }
  const m = await measure(abs, { peaks: true });
  row.lufs = m.lufs > -69 ? m.lufs : null; // too short or too quiet for a gated measurement
  row.true_peak = m.truePeak;
  row.peak_p99 = m.peakP99;
  const first = m.silences[0], last = m.silences.at(-1), d = row.duration;
  row.lead_silence = first && first.start <= 0.05 ? (first.end ?? d) : 0;
  row.trail_silence = last && (last.end == null || last.end >= d - 0.05) && last.start > row.lead_silence ? d - last.start : 0;
  if (row.lead_silence + row.trail_silence >= d) row.lead_silence = row.trail_silence = 0; // all silent: leave it for QA to catch
  return row;
}

const COLS = ['kind', 'tag', 'source_id', 'path', 'size', 'mtime', 'sha256', 'duration', 'lufs', 'true_peak', 'peak_p99', 'lead_silence',
  'trail_silence', 'width', 'height', 'artist', 'title', 'credit_guessed'];
const bind = row => Object.fromEntries(COLS.map(c => [c, row[c] ?? null]));

export async function ingest(db, { log = console.log, now = Date.now() } = {}) {
  const root = POOL();
  if (!fs.existsSync(root)) throw new Error(`pool not found at ${root} (set AMBIENT_POOL)`); // never mark a whole unmounted pool missing
  const reg = loadSources();
  const rep = { added: 0, updated: 0, moved: 0, unchanged: 0, missing: 0, settling: 0, duplicates: [], unusable: new Set(), errors: [] };
  const seen = new Set();
  const byPath = db.prepare('SELECT id, size, mtime, missing FROM assets WHERE path = ?');
  const bySha = db.prepare('SELECT id, path FROM assets WHERE sha256 = ? AND path != ?');
  const insert = db.prepare(`INSERT INTO assets (${COLS.join(', ')}, added_at) VALUES (${COLS.map(c => ':' + c).join(', ')}, :added_at)`);
  const update = db.prepare(`UPDATE assets SET ${COLS.map(c => `${c} = :${c}`).join(', ')}, analyzed = 0, missing = 0 WHERE id = :id`);

  for (const [kind, dir] of KINDS) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    for (const ent of fs.readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const abs = path.join(ent.parentPath, ent.name);
      const parts = path.relative(base, abs).split(path.sep); // <tag>/<source>/.../<file>
      if (parts.length < 3 || SYNC_TEMP.test(ent.name) || parts.some(p => p.startsWith('.st'))) continue;
      if (!(kind === 'visual' ? VISUAL : AUDIO).test(ent.name)) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      seen.add(rel);
      const st = fs.statSync(abs);
      if (now - st.mtimeMs < SETTLE_MS) { rep.settling++; continue; }
      const [tag, source_id] = parts;
      if (!reg[source_id]?.compilation_ok) rep.unusable.add(source_id);
      const old = byPath.get(rel);
      if (old && old.size === st.size && old.mtime === st.mtimeMs) {
        if (old.missing) db.prepare('UPDATE assets SET missing = 0 WHERE id = ?').run(old.id);
        rep.unchanged++;
        continue;
      }
      try {
        const row = { kind, tag, source_id, path: rel, size: st.size, mtime: st.mtimeMs, ...await examine(abs, kind) };
        if (old) { update.run({ ...bind(row), id: old.id }); rep.updated++; continue; }
        const twin = bySha.get(row.sha256, rel);
        if (twin && fs.existsSync(path.join(root, twin.path))) { rep.duplicates.push(`${rel} = ${twin.path}`); continue; }
        if (twin) { update.run({ ...bind(row), id: twin.id }); rep.moved++; continue; } // renamed or moved: keep its history
        insert.run({ ...bind(row), added_at: new Date(now).toISOString() });
        rep.added++;
      } catch (e) {
        rep.errors.push(`${rel}: ${e.message}`);
      }
    }
  }
  for (const r of db.prepare('SELECT id, path FROM assets WHERE missing = 0').all()) {
    if (!seen.has(r.path)) { db.prepare('UPDATE assets SET missing = 1 WHERE id = ?').run(r.id); rep.missing++; }
  }
  rep.analyzed = await analyzeMusic(db, root, log);
  rep.unusable = [...rep.unusable];
  return rep;
}

// BPM, key and energy come from the short-lived Python worker. ffmpeg cuts a 2-minute
// mono window from the middle of each track first, so Python never needs to decode anything.
async function analyzeMusic(db, root, log) {
  const rows = db.prepare("SELECT id, path, duration FROM assets WHERE kind = 'music' AND analyzed = 0 AND missing = 0").all();
  if (!rows.length) return 0;
  await waitForRoblox(log);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-'));
  const save = db.prepare('UPDATE assets SET bpm = ?, key = ?, energy = ?, analyzed = 1 WHERE id = ?');
  try {
    for (let i = 0; i < rows.length; i += 25) {
      const files = [];
      for (const r of rows.slice(i, i + 25)) {
        const wav = path.join(tmp, `${r.id}.wav`);
        await ffmpeg(['-v', 'error', '-ss', Math.max(0, (r.duration ?? 0) / 2 - 60), '-t', 120, '-i', path.join(root, r.path), '-ac', 1, '-ar', 22050, wav]);
        files.push({ id: r.id, path: wav });
      }
      const { out } = await run(PYTHON, [path.join(ROOT, 'analysis', 'analyze.py')], { input: JSON.stringify({ files }) });
      for (const line of out.split('\n').filter(Boolean)) {
        const a = JSON.parse(line);
        if (a.error) log(`analysis failed for asset ${a.id}: ${a.error}`);
        save.run(a.bpm ?? null, a.key ?? null, a.energy ?? null, a.id);
      }
      log(`analyzed ${Math.min(i + 25, rows.length)}/${rows.length} tracks`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return rows.length;
}
