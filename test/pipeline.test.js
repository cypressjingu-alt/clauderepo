// End to end on generated fixtures: ingest -> plan -> render -> QA. Needs ffmpeg and the venv.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg } from '../src/ff.js';
import { open } from '../src/db.js';
import { ingest } from '../src/ingest.js';
import { plan } from '../src/plan.js';
import { render } from '../src/render.js';
import { seam } from '../src/qa.js';
import { SR, loopPath, makeLoop } from '../src/audio.js';
import { loadChannel, loadNiche, loadSources } from '../src/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-test-'));
const POOL = path.join(tmp, 'pool');
Object.assign(process.env, { AMBIENT_POOL: POOL, AMBIENT_DATA: path.join(tmp, 'data'), AMBIENT_CONFIG: path.join(tmp, 'config') });
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };
const dir = rel => { const d = path.join(POOL, rel); fs.mkdirSync(d, { recursive: true }); return d; };
const lavfi = (src, out, extra = []) => ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', src, ...extra, out]);

// Click tracks at known tempos over a sustained major triad, 1 s of silence at each end.
const TRACKS = [[80, 261.63], [90, 392], [100, 293.66], [110, 220], [120, 261.63], [128, 329.63], [135, 349.23], [140, 220]];
const triad = f => [1, 1.2599, 1.4983].map(k => `sin(2*PI*${(f * k).toFixed(2)}*t)`).join('+');

put('config/sources.yaml', 'dev:\n  name: Dev fixtures\n  license: CC0\n  compilation_ok: true\n  credit: "{title} by {artist}"\n');
put('config/channels/showcase.yaml', 'id: showcase\nloudness_lufs: -14\ncooldown_days: 30\nshorts_per_video: 2\n');
const niche = (id, y) => put(`config/niches/${id}.yaml`, `id: ${id}\nname: Test ${id}\nvisual: tokyo-night\nweight: 1\n${y}`);
niche('t-playlist', 'format: playlist\nmusic: [jazz]\nmotion: effects\nlength: [2m, 2m]\n');
niche('t-ambience', 'format: ambience\nambience:\n  bed: rain\n  events:\n    - { type: thunder, every: [15s, 30s], gain_db: [-6, 0], flash: true }\nmotion: effects\neffects: { rain: 0.3, flicker: 0.02 }\nlength: [3m, 3m]\nloudness: -20\n');
niche('t-layered', 'format: layered\nmusic: [jazz]\nambience:\n  bed: rain\n  bed_level_db: -16\n  events:\n    - { type: cups, every: [8s, 20s], gain_db: [-18, -8] }\nmotion: loop\nlength: [2m, 2m]\n');
niche('t-long', 'format: ambience\nambience:\n  bed: rain\n  events:\n    - { type: thunder, every: [60s, 120s], gain_db: [-6, 0] }\nmotion: still\nlength: [30m, 30m]\nloudness: -20\n');

const db = open(path.join(tmp, 'data', 'ambient.db'));
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const reg = () => loadSources(), channel = () => loadChannel('showcase');

test('ingest measures, analyzes and filters the pool', async () => {
  for (const [i, [bpm, root]] of TRACKS.entries()) {
    const tags = i % 2 ? ['-metadata', 'artist=Dev', '-metadata', `title=Click ${bpm}`] : [];
    const name = i % 2 ? `click-${bpm}.mp3` : `Dev Band - Tune ${bpm}.mp3`;
    await lavfi(`aevalsrc='0.5*sin(2*PI*1000*t)*exp(-60*mod(t,${60 / bpm}))+0.1*(${triad(root)})':s=48000:d=${40 + i * 3}`,
      path.join(dir('music/jazz/dev'), name), ['-af', 'adelay=1000:all=1,apad=pad_dur=1', '-ac', 2, '-b:a', '192k', ...tags]);
  }
  await lavfi(`aevalsrc='0.3*sin(2*PI*500*t)*exp(-40*mod(t,0.5))':s=48000:d=40`, path.join(dir('music/jazz/unlisted'), 'Other - Song.mp3'), ['-ac', 2]);
  for (const [i, c] of ['pink', 'brown'].entries())
    await lavfi(`anoisesrc=color=${c}:amplitude=0.3:seed=${i + 1}:d=45`, path.join(dir('ambience/beds/rain/dev'), `rain-${c}.flac`), ['-ac', 2]);
  for (const i of [1, 2]) {
    await lavfi(`anoisesrc=color=brown:amplitude=0.9:seed=${i + 5}:d=${2 + i}`, path.join(dir('ambience/events/thunder/dev'), `thunder-${i}.wav`), ['-af', `afade=t=in:d=0.3,afade=t=out:st=1:d=${1 + i}`, '-ac', 2]);
    await lavfi(`sine=f=${2000 + i * 400}:d=0.4`, path.join(dir('ambience/events/cups/dev'), `cup-${i}.wav`), ['-af', 'afade=t=out:d=0.35', '-ac', 2]);
  }
  for (const [i, c] of ['0x1b2a4a', '0x3a1f3d'].entries())
    await lavfi(`color=c=${c}:s=1920x1080,drawbox=x=${500 + i * 200}:y=300:w=600:h=400:color=0xf0c070:t=fill`, path.join(dir('visuals/tokyo-night/dev'), `still-${i}.png`), ['-frames:v', 1]);
  await lavfi('testsrc2=s=1280x720:r=30:d=4', path.join(dir('visuals/tokyo-night/dev'), 'clip.mp4'), ['-pix_fmt', 'yuv420p']);
  fs.writeFileSync(path.join(dir('music/jazz/dev'), '~syncthing~half.mp3.tmp'), 'partial');
  const old = new Date(Date.now() - 600_000);
  for (const e of fs.readdirSync(POOL, { recursive: true, withFileTypes: true })) if (e.isFile()) fs.utimesSync(path.join(e.parentPath, e.name), old, old);
  await lavfi('sine=f=300:d=5', path.join(dir('music/jazz/dev'), 'arriving.mp3')); // too fresh to ingest

  const r = await ingest(db, { log: () => {} });
  assert.deepEqual(r.errors, []);
  assert.equal(r.added, 9 + 2 + 4 + 3);
  assert.equal(r.settling, 1);
  assert.deepEqual(r.unusable, ['unlisted']);
  const row = t => db.prepare('SELECT * FROM assets WHERE path LIKE ?').get(`%${t}%`);
  for (const [bpm] of TRACKS) {
    const got = row(`${bpm}.mp3`).bpm, ratio = got / bpm;
    assert.ok([0.5, 1, 2].some(k => Math.abs(ratio - k) < 0.04 * k), `bpm ${bpm} detected as ${got}`);
  }
  assert.equal(row('Tune 120').key, 'C major');
  assert.ok(Math.abs(row('Tune 80').lead_silence - 1) < 0.1 && Math.abs(row('Tune 80').trail_silence - 1) < 0.2);
  assert.deepEqual([row('Tune 80').artist, row('Tune 80').title, row('Tune 80').credit_guessed], ['Dev Band', 'Tune 80', 1]);
  assert.deepEqual([row('click-90').artist, row('click-90').credit_guessed], ['Dev', 0]);
  assert.ok(row('cup-1').lufs < -15); // even a 0.4 s one-shot gets a loudness reading

  fs.renameSync(path.join(dir('music/jazz/dev'), 'click-90.mp3'), path.join(dir('music/jazz/dev'), 'moved-90.mp3'));
  const again = await ingest(db, { log: () => {} });
  assert.equal(again.moved, 1);
  assert.equal(again.unchanged, 17);
});

for (const id of ['t-playlist', 't-ambience', 't-layered', 't-long']) {
  test(`renders ${id} with passing QA`, async () => {
    const p = plan(db, { recipe: loadNiche(id), channel: channel(), reg: reg(), seed: 11 });
    const r = await render(db, p, { log: () => {} });
    const failed = r.qa.checks.filter(c => !c.pass).map(c => `${c.name}: ${c.detail}`);
    assert.ok(r.qa.pass, failed.join('; '));
    const m = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'));
    assert.equal(m.plan.seed, 11);
    if (id === 't-playlist') assert.ok(m.chapters.length >= 3);
    if (id === 't-ambience') {
      assert.ok(m.plan.events.some(e => e.flash), 'lightning planned');
      assert.ok(r.qa.checks.some(c => c.name === 'video_seam'), 'video seam checked');
    }
    if (id === 't-long') assert.ok(r.qa.checks.find(c => c.name === 'av_sync').pass);
  });
}

test('loop seam check: crossfaded loop passes, a hard cut fails', async () => {
  const sine = path.join(tmp, 'sine.wav');
  await lavfi('sine=f=441.3:d=10', sine, ['-ac', 2]);
  const cut = path.join(tmp, 'cut.f32'), x = new Float32Array(9.7 * SR * 2);
  for (let i = 0; i < x.length / 2; i++) x[2 * i] = x[2 * i + 1] = 0.5 * Math.sin((2 * Math.PI * 441.3 * i) / SR);
  fs.writeFileSync(cut, Buffer.from(x.buffer));
  assert.equal(seam(cut).pass, false);
  const loops = fs.readdirSync(path.dirname(loopPath('x')));
  assert.ok(loops.length >= 1);
  for (const f of loops) assert.ok(seam(path.join(path.dirname(loopPath('x')), f)).pass, f);
  const noise = path.join(tmp, 'noise.f32');
  await makeLoop(path.join(POOL, 'ambience/beds/rain/dev/rain-pink.flac'), 0, 30, noise);
  assert.ok(seam(noise).pass);
});

test('used tracks go on cooldown; dry runs leave cooldowns alone', async () => {
  const count = () => db.prepare("SELECT COUNT(*) n FROM usage").get().n;
  const before = count();
  const p = plan(db, { recipe: loadNiche('t-playlist'), channel: channel(), reg: reg(), seed: 12 });
  await render(db, p, { dryRun: true, log: () => {} });
  assert.equal(count(), before);
  assert.ok(before > 0);
});
