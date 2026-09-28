import fs from 'node:fs';
import path from 'node:path';
import { FFPROBE } from './config.js';
import { ffmpeg, measure, probe, run } from './ff.js';
import { SR, loopPath } from './audio.js';
import { segmentLength } from './video.js';

// PSNR between the frame just before time t and the one after it (2 frames decoded, 30 fps).
async function stepPsnr(video, t) {
  const { err } = await ffmpeg(['-ss', t - 1.5 / 30, '-t', 0.06, '-i', video, '-lavfi',
    '[0:v]split[a][b];[a]trim=end_frame=1[a1];[b]trim=start_frame=1,setpts=PTS-STARTPTS[b1];[a1][b1]psnr', '-f', 'null', '-']);
  const m = err.match(/average:([\d.]+|inf)/);
  return m ? (m[1] === 'inf' ? Infinity : +m[1]) : null;
}

// A bed loop's wrap point must look like any other moment of the bed: no sample jump bigger than
// 3x the bed's own 99.9th-percentile step (a click), and the 250 ms around it within 6 dB of the
// median level of the surrounding 10 s (a dropout). Real rain swings a few dB between 250 ms windows by itself.
export function seam(file) {
  const fd = fs.openSync(file, 'r');
  const frames = fs.fstatSync(fd).size / 8, W = Math.min(5 * SR, Math.floor(frames / 4));
  const buf = new Float32Array(W * 4), b = Buffer.from(buf.buffer);
  fs.readSync(fd, b, 0, W * 8, (frames - W) * 8); // last W frames, then the first W: the wrap is at W
  fs.readSync(fd, b, W * 8, W * 8, 0);
  fs.closeSync(fd);
  let jump = 0, rmsDb = 0;
  for (const c of [0, 1]) {
    const x = i => buf[i * 2 + c];
    const steps = Float64Array.from({ length: 2 * W - 1 }, (_, i) => Math.abs(x(i + 1) - x(i))).sort();
    const typical = Math.max(steps[Math.floor(steps.length * 0.999)], 1e-4);
    for (let i = W - 24; i < W + 24; i++) jump = Math.max(jump, Math.abs(x(i + 1) - x(i)) / typical);
    const win = Math.min(SR / 4, Math.floor(W / 4));
    const rms = s => { let a = 0; for (let i = 0; i < win; i++) a += x(s + i) ** 2; return Math.sqrt(a / win); };
    const levels = Array.from({ length: Math.floor(2 * W / win) }, (_, k) => rms(k * win)).sort((p, q) => p - q);
    const median = levels[Math.floor(levels.length / 2)] || 1e-9;
    rmsDb = Math.max(rmsDb, Math.abs(20 * Math.log10((rms(W - win / 2) || 1e-9) / median)));
  }
  return { pass: jump <= 3 && rmsDb <= 6, jump: +jump.toFixed(2), rms_db: +rmsDb.toFixed(2) };
}

export async function qa(dir, plan) {
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const video = path.join(dir, 'video.mp4');

  let p;
  try {
    const { err } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', video]);
    p = await probe(video);
    check('probe', !err.trim(), err.trim() || 'ffprobe reads it with no errors');
  } catch (e) {
    check('probe', false, e.message);
    return { pass: false, checks };
  }
  const v = p.streams.find(s => s.codec_type === 'video'), a = p.streams.find(s => s.codec_type === 'audio');
  check('streams', v?.codec_name === 'h264' && v.width === 1920 && v.height === 1080 && a?.codec_name === 'aac' && +a.sample_rate === 48000 && a.channels === 2,
    `${v?.codec_name} ${v?.width}x${v?.height}, ${a?.codec_name} ${a?.sample_rate} Hz ${a?.channels} ch`);
  const dur = +p.format.duration;
  check('duration', Math.abs(dur - plan.duration) <= 1, `${dur.toFixed(2)} s, planned ${plan.duration} s`);
  check('av_sync', Math.abs(+v.duration - +a.duration) <= 0.25, `video ${(+v.duration).toFixed(3)} s, audio ${(+a.duration).toFixed(3)} s`);

  const maxSilence = plan.recipe.max_silence ?? 5;
  const m = await measure(video, { silenceMin: maxSilence });
  check('loudness', m.lufs != null && Math.abs(m.lufs - plan.loudness) <= 1, `${m.lufs} LUFS, target ${plan.loudness}`);
  check('true_peak', m.truePeak != null && m.truePeak <= -1, `${m.truePeak} dBTP, limit -1`);
  const gaps = m.silences.filter(s => s.start > 3 && (s.end ?? dur) < dur - 10); // the master fades are allowed to be quiet
  check('silence', !gaps.length, gaps.length ? `silent at ${gaps.map(s => `${s.start.toFixed(1)}-${s.end?.toFixed(1)}`).join(', ')}` : `no gap over ${maxSilence} s`);

  // The picture's loop point must be no bigger a jump than an ordinary frame step (within 4 dB of PSNR),
  // or visually identical anyway (40 dB+). The reference step is a quarter in: mid-loop the zoom stands still.
  const L = segmentLength(plan.visual);
  if (dur > L + 1) {
    const seamDb = await stepPsnr(video, L), normalDb = await stepPsnr(video, L / 4);
    check('video_seam', seamDb != null && normalDb != null && (seamDb >= 40 || seamDb >= normalDb - 4),
      `wrap ${seamDb} dB vs normal step ${normalDb} dB`);
  }

  for (const sha of new Set((plan.bed ?? []).map(s => s.sha256))) {
    const s = seam(loopPath(sha));
    check('loop_seam', s.pass, `${sha.slice(0, 8)}: jump ${s.jump}x typical, level ${s.rms_db} dB`);
  }

  const thumb = ['thumb.png', 'thumb.jpg'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
  if (thumb) {
    const t = (await probe(thumb)).streams[0], size = fs.statSync(thumb).size;
    check('thumbnail', t.width === 1280 && t.height === 720 && size < 2 * 1024 * 1024, `${t.width}x${t.height}, ${(size / 1024).toFixed(0)} KB`);
  } else check('thumbnail', false, 'missing');

  const shorts = fs.readdirSync(dir).filter(f => /^short-\d+\.mp4$/.test(f));
  check('shorts', shorts.length >= 1, `${shorts.length} made`);
  for (const f of shorts) {
    const s = await probe(path.join(dir, f)), sv = s.streams.find(x => x.codec_type === 'video'), d = +s.format.duration;
    check(f, sv?.width === 1080 && sv.height === 1920 && d >= 19.5 && d <= 40.5 && s.streams.some(x => x.codec_type === 'audio'),
      `${sv?.width}x${sv?.height}, ${d.toFixed(1)} s`);
  }
  return { pass: checks.every(c => c.pass), checks };
}
