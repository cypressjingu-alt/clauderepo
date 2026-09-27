import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { FFMPEG, FFPROBE } from './config.js';

export function run(bin, args, { input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args.map(String), { cwd, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve({ out, err })
      : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').slice(-6).join('\n')}`)));
    if (input != null) p.stdin.end(input);
  });
}

export const ffmpeg = (args, opts) => run(FFMPEG, ['-hide_banner', '-nostats', '-y', ...args], opts);

export async function probe(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  return JSON.parse(out);
}

// One decode pass: integrated loudness, true peak, silent stretches and, with `peaks`,
// the sample peak of every 1-second window (so one stray spike doesn't define a file's headroom).
export async function measure(file, { silenceDb = -50, silenceMin = 0.5, peaks = false } = {}) {
  const perSecond = peaks ? ',aresample=48000,asetnsamples=n=48000:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level,ametadata=mode=print:key=lavfi.astats.Overall.Peak_level' : '';
  const { err } = await ffmpeg(['-i', file, '-map', '0:a:0', '-af',
    `ebur128=peak=true:framelog=verbose,silencedetect=n=${silenceDb}dB:d=${silenceMin}${perSecond}`, '-f', 'null', '-']);
  const last = re => {
    const m = [...err.matchAll(re)].at(-1);
    return m && m[1] !== '-inf' ? +m[1] : null;
  };
  const silences = [];
  for (const m of err.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    if (m[1] === 'start') silences.push({ start: +m[2], end: null });
    else if (silences.length) silences.at(-1).end = +m[2];
  }
  const secs = [...err.matchAll(/Peak_level=(-?[\d.]+)/g)].map(m => +m[1]).sort((a, b) => b - a);
  const peakP99 = secs.length ? secs[Math.floor(secs.length * 0.01)] : null; // exceeded in only 1% of seconds
  return { lufs: last(/I:\s+(-?[\d.]+|-inf) LUFS/g), truePeak: last(/Peak:\s+(-?[\d.]+|-inf) dBFS/g), silences, peakP99 };
}

// Roblox rule (the laptop's 8 GB): renders, publishing and analysis never run next to
// RobloxPlayerBeta.exe. On by default; a machine with RAM to spare sets AMBIENT_ROBLOX_GATE=off.
export async function robloxRunning() {
  if (process.platform !== 'win32' || process.env.AMBIENT_ROBLOX_GATE === 'off') return false;
  const { out } = await run('tasklist', ['/FI', 'IMAGENAME eq RobloxPlayerBeta.exe', '/NH']);
  return /RobloxPlayerBeta\.exe/i.test(out);
}

export async function waitForRoblox(log = console.log) {
  for (let told = false; await robloxRunning(); told = true) {
    if (!told) log('Roblox is running. Waiting for it to close before heavy work.');
    await sleep(60_000);
  }
}
