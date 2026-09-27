import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { plan, camelot } from '../src/plan.js';
import { normalizeNiche } from '../src/config.js';

const reg = {
  good: { name: 'Good', license: 'CC0', compilation_ok: true, credit: '{title} by {artist}' },
  nope: { name: 'Nope', license: 'CC-BY-NC', compilation_ok: false },
};
const channel = { id: 'showcase', loudness_lufs: -14, cooldown_days: 30 };
const KEYS = ['C major', 'G major', 'A minor', 'E minor', 'D major', 'F major'];
const recipe = (over = {}) => normalizeNiche({
  id: 'jazz', name: 'Jazz', format: 'layered', music: ['jazz'], visual: 'lobby', motion: 'still', length: ['20m', '20m'],
  ambience: { bed: 'rain', bed_level_db: -16, events: [{ type: 'cups', every: ['20s', '60s'], gain_db: [-18, -8] }] }, ...over,
});

function pool(tracks = 12) {
  const db = open(':memory:');
  const ins = db.prepare(`INSERT INTO assets (kind, tag, source_id, path, sha256, duration, lufs, lead_silence, trail_silence, bpm, key, energy, artist, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < tracks; i++) ins.run('music', 'jazz', 'good', `music/jazz/good/t${i}.mp3`, `m${i}`, 180 + i * 7, -12 - (i % 4), 0.5, 1, 80 + i * 5, KEYS[i % 6], (i % 10) / 10, `A${i}`, `T${i}`);
  ins.run('music', 'jazz', 'nope', 'music/jazz/nope/x.mp3', 'x', 900, -14, 0, 0, 100, 'C major', 0.5, 'X', 'X');
  ins.run('bed', 'rain', 'good', 'ambience/beds/rain/good/r1.flac', 'b1', 600, -30, 0, 0, null, null, null, null, 'Rain 1');
  ins.run('bed', 'rain', 'good', 'ambience/beds/rain/good/r2.flac', 'b2', 500, -28, 0, 0, null, null, null, null, 'Rain 2');
  ins.run('event', 'cups', 'good', 'ambience/events/cups/good/c1.wav', 'e1', 2, -25, 0, 0, null, null, null, null, 'Cup');
  ins.run('event', 'cups', 'good', 'ambience/events/cups/good/c2.wav', 'e2', 3, -22, 0, 0, null, null, null, null, 'Cup 2');
  ins.run('visual', 'lobby', 'good', 'visuals/lobby/good/v.png', 'v1', null, null, 0, 0, null, null, null, null, 'Lobby');
  return db;
}
const use = (db, id, daysAgo) => db.prepare('INSERT INTO usage VALUES (?, ?, ?, ?)').run(id, 'showcase', 'r', new Date(Date.now() - daysAgo * 864e5).toISOString());

test('same seed gives the same plan, another seed a different one', () => {
  const db = pool();
  const a = plan(db, { recipe: recipe(), channel, reg, seed: 7, now: 0 });
  const b = plan(db, { recipe: recipe(), channel, reg, seed: 7, now: 0 });
  const c = plan(db, { recipe: recipe(), channel, reg, seed: 8, now: 0 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.music.segments.map(s => s.asset_id), c.music.segments.map(s => s.asset_id));
});

test('only compilation-safe sources, no track twice, length within 5%', () => {
  const db = pool();
  for (let seed = 1; seed <= 20; seed++) {
    const p = plan(db, { recipe: recipe(), channel, reg, seed });
    const ids = p.music.segments.map(s => s.asset_id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(p.music.segments.every(s => s.source_id === 'good'));
    assert.ok(Math.abs(p.duration - 1200) <= 60, `duration ${p.duration}`);
    assert.ok(p.music.segments.every((s, i) => i === 0 || (s.fade_in >= 3 && s.fade_in <= 6)));
  }
});

test('cooldown skips recent tracks, then relaxes least recently used first with an alert', () => {
  const db = pool();
  assert.deepEqual(plan(db, { recipe: recipe(), channel, reg, seed: 1 }).alerts, []);
  for (let id = 1; id <= 11; id++) use(db, id, id); // track id n was used n days ago; only id 12 has rested
  const p = plan(db, { recipe: recipe(), channel, reg, seed: 1 });
  const alert = p.alerts.find(a => a.type === 'cooldown_relaxed');
  assert.ok(alert, 'cooldown_relaxed alert');
  const ids = p.music.segments.map(s => s.asset_id);
  const oldest = 12 - alert.payload.reused; // the reused ones must be ids 11, 10, ...: the longest rested
  assert.ok(ids.every(id => id >= oldest), `used ${ids}, reused ${alert.payload.reused}`);
});

test('a pool that cannot fill the video fails the plan', () => {
  const db = pool(3);
  assert.throws(() => plan(db, { recipe: recipe(), channel, reg, seed: 1 }), /not enough music/);
});

test('playlist chapters start at 0:00, at least 3, each at least 10 s', () => {
  const p = plan(pool(), { recipe: recipe({ format: 'playlist' }), channel, reg, seed: 3 });
  const ch = p.music.chapters;
  assert.ok(ch.length >= 3);
  assert.equal(ch[0].at, 0);
  ch.forEach((c, i) => assert.ok((ch[i + 1]?.at ?? p.duration) - c.at >= 10));
  assert.equal(p.bed, undefined);
});

test('events never stack and stay clear of the ending', () => {
  const p = plan(pool(), { recipe: recipe(), channel, reg, seed: 5 });
  assert.ok(p.events.length > 5);
  p.events.forEach((e, i) => {
    if (i) assert.ok(e.at >= p.events[i - 1].at + p.events[i - 1].len + 4);
    assert.ok(e.at + e.len <= p.duration - 10);
    assert.ok(Math.abs(e.pan) <= 0.7);
  });
});

test('beds rotate with crossfades on long ambience', () => {
  const p = plan(pool(), { recipe: recipe({ format: 'ambience', length: ['8h', '8h'] }), channel, reg, seed: 2 });
  assert.equal(p.duration, 8 * 3600);
  assert.ok(p.bed.length > 5);
  p.bed.forEach((s, i) => {
    if (i) assert.notEqual(s.asset_id, p.bed[i - 1].asset_id);
    if (i) assert.ok(Math.abs(p.bed[i - 1].start + p.bed[i - 1].dur - (s.start + s.fade_in)) < 0.01, 'crossfade overlap');
  });
  assert.ok(Math.abs(p.bed.at(-1).start + p.bed.at(-1).dur - p.duration) < 0.01);
});

test('quiet masters are loudness-matched only as far as 3 dB of limiting allows', () => {
  const db = pool(0);
  const ins = db.prepare(`INSERT INTO assets (kind, tag, source_id, path, sha256, duration, lufs, true_peak, bpm, key, energy, artist, title)
    VALUES ('music', 'jazz', 'good', ?, ?, 300, ?, ?, 100, 'C major', 0.5, 'A', ?)`);
  for (let i = 0; i < 5; i++) ins.run(`music/jazz/good/q${i}.mp3`, `q${i}`, i ? -14 : -30, i ? -1 : -9, i ? 'Loud' : 'Quiet');
  const p = plan(db, { recipe: recipe({ format: 'playlist' }), channel, reg, seed: 1 });
  const quiet = p.music.segments.find(s => s.title === 'Quiet');
  assert.equal(quiet.gain_db, 10); // -2 ceiling + 3 dB limiting - (-9 peak), not the 16 dB full match
  assert.ok(p.music.segments.filter(s => s.title === 'Loud').every(s => s.gain_db === 0));
});

test('camelot numbers', () => {
  assert.deepEqual(camelot('C major'), { num: 8, minor: false });
  assert.deepEqual(camelot('A minor'), { num: 8, minor: true });
  assert.deepEqual(camelot('F# major'), { num: 2, minor: false });
  assert.deepEqual(camelot('D minor'), { num: 7, minor: true });
});
