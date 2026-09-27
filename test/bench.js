// Renders a long ambience video from generated noise and reports wall time and peak RAM
// (this Node process plus its ffmpeg children). Not part of `npm test`.
//   node test/bench.js [length=10h] [still|effects]
import fs from 'node:fs';
import path from 'node:path';
import { DATA, secs, loadChannel, loadNiche, loadSources } from '../src/config.js';
import { ffmpeg, run } from '../src/ff.js';
import { open } from '../src/db.js';
import { ingest } from '../src/ingest.js';
import { plan } from '../src/plan.js';
import { render } from '../src/render.js';

const [len = '10h', motion = 'still'] = process.argv.slice(2);
const base = path.join(DATA(), 'bench');
Object.assign(process.env, { AMBIENT_POOL: path.join(base, 'pool'), AMBIENT_CONFIG: path.join(base, 'config'), AMBIENT_DATA: path.join(base, 'data') });
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
const gen = async (rel, src, extra) => {
  const f = path.join(base, 'pool', rel);
  if (fs.existsSync(f)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', src, ...extra, f]);
  const old = new Date(Date.now() - 600_000);
  fs.utimesSync(f, old, old);
};

put('config/sources.yaml', 'bench:\n  name: Bench noise\n  license: CC0\n  compilation_ok: true\n');
put('config/channels/showcase.yaml', 'id: showcase\nloudness_lufs: -14\ncooldown_days: 30\nshorts_per_video: 2\n');
put('config/niches/bench.yaml', `id: bench\nname: Bench Night\nformat: ambience\nambience:\n  bed: rain\n  events:\n    - { type: thunder, every: [120s, 480s], gain_db: [-6, 2] }\nvisual: storm\nmotion: ${motion}\nlength: [${len}, ${len}]\nloudness: -20\n`);
for (const [i, c] of ['pink', 'brown'].entries()) await gen(`ambience/beds/rain/bench/rain-${c}.flac`, `anoisesrc=color=${c}:amplitude=0.3:seed=${i + 1}:d=180`, ['-ac', 2]);
for (const i of [1, 2, 3]) await gen(`ambience/events/thunder/bench/thunder-${i}.wav`, `anoisesrc=color=brown:amplitude=0.9:seed=${i + 9}:d=${3 + 2 * i}`, ['-af', `afade=t=in:d=0.4,afade=t=out:st=1:d=${2 + 2 * i}`, '-ac', 2]);
await gen('visuals/storm/bench/storm.png', 'gradients=s=3840x2160:c0=0x0b1026:c1=0x3b4a6b:seed=3', ['-frames:v', 1]);

const db = open(path.join(base, 'data', 'ambient.db'));
await ingest(db, { log: () => {} });

// Working set of this process and its direct children (ffmpeg), sampled every 5 s.
const ps = `$all = Get-CimInstance Win32_Process; $ids = @(${process.pid}) + @($all | Where-Object { $_.ParentProcessId -eq ${process.pid} -and $_.Name -ne 'powershell.exe' } | ForEach-Object ProcessId); ($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum`;
let peak = 0, sampling = true;
(async () => { while (sampling) { try { peak = Math.max(peak, +(await run('powershell', ['-NoProfile', '-Command', ps])).out / 2 ** 20); } catch {} await new Promise(r => setTimeout(r, 5000)); } })();

const t0 = Date.now();
const p = plan(db, { recipe: loadNiche('bench'), channel: loadChannel('showcase'), reg: loadSources(), seed: 1 });
const r = await render(db, p, { dryRun: true });
sampling = false;
console.log(`\n${len} ${motion}: ${((Date.now() - t0) / 60000).toFixed(1)} min, peak RAM ${peak.toFixed(0)} MB, QA ${r.qa.pass ? 'passed' : 'FAILED'}`);
for (const c of r.qa.checks) console.log(`  ${c.pass ? 'pass' : 'FAIL'} ${c.name}: ${c.detail}`);
console.log(`video: ${(fs.statSync(path.join(r.dir, 'video.mp4')).size / 2 ** 30).toFixed(2)} GB in ${r.dir}`);
process.exit(0);
