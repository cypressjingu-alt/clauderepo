import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DATA, FFMPEG, hms } from './config.js';

// The mixer streams float32 stereo PCM in 1-second blocks: decoders feed Node, Node sums
// the layers, and one ffmpeg process limits and encodes. Memory stays flat whatever the length.

export const SR = 48000;
const dB = x => 10 ** (x / 20);
export const loopPath = sha => path.join(DATA(), 'cache', 'loops', `${sha}.f32`);

function decode(file, from = 0) {
  const p = spawn(FFMPEG, ['-v', 'error', '-nostdin', '-ss', String(from), '-i', file,
    '-map', '0:a:0', '-f', 'f32le', '-ac', '2', '-ar', String(SR), 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => (err += d));
  p.on('close', code => { if (code && !p.killed) console.error(`decode failed for ${file}: ${err.trim()}`); }); // killed = we stopped reading on purpose
  return p;
}

const toFloats = buf => {
  const out = new Float32Array(Math.floor(buf.length / 8) * 2);
  Buffer.from(out.buffer).set(buf.subarray(0, out.length * 4));
  return out;
};

class Decoder {
  constructor(file, from) {
    this.p = decode(file, from);
    this.it = this.p.stdout[Symbol.asyncIterator]();
    this.buf = Buffer.alloc(0);
    this.done = false;
  }
  async read(frames) { // zero-padded past the end of the file
    const need = frames * 8;
    while (this.buf.length < need && !this.done) {
      const { value, done } = await this.it.next();
      if (done) this.done = true;
      else this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value;
    }
    const out = new Float32Array(frames * 2);
    const n = Math.min(need, this.buf.length);
    Buffer.from(out.buffer).set(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }
  close() { this.p.stdout.destroy(); this.p.kill(); }
}

async function decodeAll(file) {
  const parts = [];
  for await (const c of decode(file).stdout) parts.push(c);
  return toFloats(Buffer.concat(parts));
}

// A cached seamless loop is raw f32 on disk; reading wraps around its end.
class LoopReader {
  constructor(file, offset) {
    this.fd = fs.openSync(file, 'r');
    this.frames = fs.fstatSync(this.fd).size / 8;
    this.pos = Math.floor(offset * this.frames);
  }
  read(frames) {
    const out = new Float32Array(frames * 2), b = Buffer.from(out.buffer);
    for (let done = 0; done < frames;) {
      const n = Math.min(frames - done, this.frames - this.pos);
      fs.readSync(this.fd, b, done * 8, n * 8, this.pos * 8);
      done += n;
      this.pos = (this.pos + n) % this.frames;
    }
    return out;
  }
  close() { fs.closeSync(this.fd); }
}

// Make a bed loop once: its last X seconds crossfade into its first X, so the end runs straight into the start.
export async function makeLoop(file, from, dur, out) {
  if (fs.existsSync(out)) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const X = Math.round(Math.min(8, dur / 4) * SR), total = Math.floor(dur * SR);
  const d = new Decoder(file, from);
  const head = await d.read(X);
  const fd = fs.openSync(out + '.part', 'w');
  for (let left = total - 2 * X; left > 0;) {
    const n = Math.min(10 * SR, left);
    fs.writeSync(fd, Buffer.from((await d.read(n)).buffer));
    left -= n;
  }
  const tail = await d.read(X);
  d.close();
  for (let i = 0; i < X; i++) {
    const t = ((i + 0.5) / X) * (Math.PI / 2), gi = Math.sin(t), go = Math.cos(t);
    tail[2 * i] = tail[2 * i] * go + head[2 * i] * gi;
    tail[2 * i + 1] = tail[2 * i + 1] * go + head[2 * i + 1] * gi;
  }
  fs.writeSync(fd, Buffer.from(tail.buffer));
  fs.closeSync(fd);
  fs.renameSync(out + '.part', out);
}

// Segments that follow each other with equal-power crossfades (playlist tracks, rotating beds).
class Sequence {
  constructor(segs, open) { this.segs = segs; this.open = open; }
  async mix(out, b, n) {
    const e = b + n;
    for (const s of this.segs) {
      if (s.f0 >= e) break;
      if (s.f1 <= b) { if (s.r) { s.r.close(); s.r = null; } continue; }
      s.r ??= this.open(s);
      const from = Math.max(b, s.f0), to = Math.min(e, s.f1);
      const buf = await s.r.read(to - from);
      for (let f = from; f < to; f++) {
        const t = f - s.f0, left = s.f1 - f;
        let g = s.g;
        if (t < s.fin) g *= Math.sin(((t + 0.5) / s.fin) * (Math.PI / 2));
        else if (left <= s.fout) g *= Math.sin(((left - 0.5) / s.fout) * (Math.PI / 2));
        const j = (f - from) * 2, o = (f - b) * 2;
        out[o] += buf[j] * g;
        out[o + 1] += buf[j + 1] * g;
      }
    }
  }
}

// One-shots at planned times. Decoded PCM is cached per file and dropped after its last use.
class Events {
  constructor(events, abs) {
    this.ev = events.map(e => {
      const p = (e.pan + 1) * (Math.PI / 4), g = dB(e.gain_db) * Math.SQRT2; // equal-power pan, unity at centre
      return { ...e, f0: Math.round(e.at * SR), gl: g * Math.cos(p), gr: g * Math.sin(p), file: abs(e.path) };
    });
    this.left = new Map();
    for (const e of this.ev) this.left.set(e.file, (this.left.get(e.file) ?? 0) + 1);
    this.cache = new Map();
    this.i = 0;
  }
  async mix(out, b, n) {
    const e = b + n;
    for (let k = this.i; k < this.ev.length && this.ev[k].f0 < e; k++) {
      const v = this.ev[k];
      if (!this.cache.has(v.file)) this.cache.set(v.file, await decodeAll(v.file));
      const pcm = this.cache.get(v.file), f1 = v.f0 + pcm.length / 2;
      for (let f = Math.max(b, v.f0); f < Math.min(e, f1); f++) {
        const j = (f - v.f0) * 2, o = (f - b) * 2;
        out[o] += pcm[j] * v.gl;
        out[o + 1] += pcm[j + 1] * v.gr;
      }
      if (f1 <= e && k === this.i) { // finished: forget it
        this.i++;
        const left = this.left.get(v.file) - 1;
        this.left.set(v.file, left);
        if (!left) this.cache.delete(v.file);
      }
    }
  }
}

export async function mix(plan, pool, out, log = () => {}) {
  const abs = p => path.join(pool, p);
  const frames = s => ({ ...s, f0: Math.round(s.start * SR), f1: Math.round((s.start + s.dur) * SR),
    fin: Math.round(s.fade_in * SR), fout: Math.round(s.fade_out * SR), g: dB(s.gain_db) });
  const layers = [];
  if (plan.music) layers.push(new Sequence(plan.music.segments.map(frames), s => new Decoder(abs(s.path), s.in)));
  if (plan.bed) layers.push(new Sequence(plan.bed.map(frames), s => new LoopReader(loopPath(s.sha256), s.offset)));
  if (plan.events?.length) layers.push(new Events(plan.events, abs));

  // ponytail: sample-peak limiter at -2 dBFS as headroom for -1 dBTP after AAC (a 10 h noise bed measured -1.4 at -1.5);
  // QA measures the real true peak. A true-peak limiter (oversampled) is the upgrade if music renders fail it.
  const enc = spawn(FFMPEG, ['-hide_banner', '-nostats', '-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', 'pipe:0',
    '-af', `alimiter=limit=${dB(-2).toFixed(4)}:level=false:attack=5:release=100:latency=true`,
    // ffmpeg's fast AAC coder at 288k: really ~290 kbps at ~130x realtime. Asked for 320k or more it caps near
    // 250 kbps and runs 5x slower; the default twoloop coder does a true 384k but at only ~9x (a 10-hour mix
    // takes over an hour). 290 kbps AAC-LC is transparent; YouTube re-encodes to ~130 kbps anyway.
    '-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '288k', '-ar', String(SR), out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  enc.stderr.on('data', d => (err += d));
  enc.stdin.on('error', () => {}); // a dead encoder surfaces through its exit code below
  const exited = new Promise(res => enc.on('close', res));

  const total = Math.round(plan.duration * SR), FIN = 2 * SR, FOUT = Math.min(8 * SR, Math.floor(total / 4));
  for (let b = 0; b < total && enc.exitCode === null; b += SR) {
    const n = Math.min(SR, total - b), buf = new Float32Array(n * 2);
    for (const l of layers) await l.mix(buf, b, n);
    if (b < FIN || b + n > total - FOUT) {
      for (let f = b; f < b + n; f++) {
        const g = Math.min(1, Math.sin(Math.min(1, (f + 0.5) / FIN) * (Math.PI / 2)), Math.sin(Math.min(1, (total - f - 0.5) / FOUT) * (Math.PI / 2)));
        buf[(f - b) * 2] *= g;
        buf[(f - b) * 2 + 1] *= g;
      }
    }
    if (!enc.stdin.write(Buffer.from(buf.buffer))) await Promise.race([once(enc.stdin, 'drain'), exited]);
    if (b % (1800 * SR) === 0 && b) log(`  audio ${hms(b / SR)} / ${hms(total / SR)}`);
  }
  enc.stdin.end();
  for (const l of layers) for (const s of l.segs ?? []) s.r?.close();
  const code = await exited;
  if (code !== 0) throw new Error(`audio encode failed (${code}): ${err.trim()}`);
}
