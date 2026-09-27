import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env: defaults below */ }

// Read at call time so tests can point them elsewhere.
const env = (k, d) => process.env[k] || d;
export const FFMPEG = env('FFMPEG', 'ffmpeg');
export const FFPROBE = env('FFPROBE', 'ffprobe');
export const PYTHON = path.resolve(ROOT, env('PYTHON', '.venv/Scripts/python.exe'));
export const POOL = () => path.resolve(ROOT, env('AMBIENT_POOL', 'pool'));
export const DATA = () => path.resolve(ROOT, env('AMBIENT_DATA', 'data'));
const CONFIG = () => path.resolve(ROOT, env('AMBIENT_CONFIG', 'config'));

const readYaml = f => YAML.parse(fs.readFileSync(f, 'utf8'));
export const loadSources = () => readYaml(path.join(CONFIG(), 'sources.yaml')) ?? {};
export const loadChannel = id => readYaml(path.join(CONFIG(), 'channels', `${id}.yaml`));
export const loadNiche = id => normalizeNiche(readYaml(path.join(CONFIG(), 'niches', `${id}.yaml`)));

// Durations in recipes are written like 40s, 90m, 1h30m.
export function secs(v) {
  if (typeof v === 'number') return v;
  const m = String(v).trim().match(/^(?:([\d.]+)h)?(?:([\d.]+)m)?(?:([\d.]+)s)?$/);
  if (!m || !m[0]) throw new Error(`bad duration "${v}" (use e.g. 40s, 90m, 1h30m)`);
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

export function normalizeNiche(n) {
  if (!['playlist', 'ambience', 'layered'].includes(n.format)) throw new Error(`niche ${n.id}: format must be playlist, ambience or layered`);
  if (!['still', 'loop', 'effects'].includes(n.motion)) throw new Error(`niche ${n.id}: motion must be still, loop or effects`);
  return {
    ...n,
    length: n.length.map(secs),
    ambience: n.ambience && { ...n.ambience, events: (n.ambience.events ?? []).map(e => ({ ...e, every: e.every.map(secs) })) },
  };
}

// Seeded RNG (mulberry32), so a plan is reproducible from its seed.
export function rng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.pick = arr => arr[Math.floor(r() * arr.length)];
  return r;
}

export const hms = s => new Date(Math.round(s) * 1000).toISOString().slice(11, 19);
