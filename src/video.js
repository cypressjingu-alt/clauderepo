import fs from 'node:fs';
import path from 'node:path';
import { ROOT, rng } from './config.js';
import { ffmpeg } from './ff.js';

// Every motion style renders ONE seamless segment. The full video repeats it with the
// concat demuxer and stream copy, so a 10-hour video costs one short encode.

const FPS = 30;

const cover = (W, H) => `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
// 4 threads and a short lookahead keep x264 near 400 MB (default threading took 1.5 GB on 16 cores).
// Moving segments use a faster preset (full-frame motion at "slow" took 3 min for 2 min of video on the desktop)
// and CRF 23: moving clouds at CRF 18 ran 7.1 Mbit/s (~40 GB per 10 h); CRF 23 is 3.5 Mbit/s at SSIM 0.986.
const x264 = (frames, out, preset = 'slow', crf = 18) => ['-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p', '-threads', 4, '-rc-lookahead', 10,
  '-g', frames, '-bf', '0', '-an', '-video_track_timescale', FPS * 512, out];

// Segment length in seconds. Images loop every 60 s, or 120 s when the sky drifts (half the speed
// for the same seamless loop). A clip loops at its own length minus the crossfade.
export function segmentLength(visual) {
  if (visual.clip) {
    const F = Math.floor(visual.duration * FPS) - 2;
    return (F - Math.min(45, Math.floor(F / 4))) / FPS;
  }
  return visual.effects?.sky ? 120 : 60;
}

// Lightning: flash variants of the segment sit at these offsets. The plan snaps each flashing thunder
// event so its flash lands on one, and the flash always leads its thunder like distant lightning.
export const FLASH_LEAD = 1.5;
export const flashOffsets = L => [0.125, 0.375, 0.625, 0.875].map(f => +(f * L).toFixed(3));
const flashCurve = o => `(exp(-pow((t-${o})/0.05,2))+0.6*exp(-pow((t-${o}-0.25)/0.08,2)))`;
export const flashFilter = (o, strength = 0.35) =>
  `eq=brightness='${strength}*${flashCurve(o)}':saturation='1-0.5*min(1,${flashCurve(o)})':eval=frame`;

// Cloud texture: fractal value noise that wraps horizontally (the lattice repeats in x), so a strip of
// two copies scrolls seamlessly. Centred on mid-grey for overlay blending: lighter and darker patches.
function clouds(W, H, seed = 7) {
  const r = rng(seed), px = Buffer.alloc(W * H), acc = new Float32Array(W * H);
  const smooth = t => t * t * (3 - 2 * t);
  for (const [cells, amp] of [[4, 1], [8, 0.5], [16, 0.25], [32, 0.125], [64, 0.06]]) {
    const gy = Math.ceil((cells * H) / W) + 1, g = Float32Array.from({ length: cells * (gy + 1) }, () => r());
    for (let y = 0; y < H; y++) {
      const fy = (y / W) * cells, y0 = Math.floor(fy), ty = smooth(fy - y0);
      for (let x = 0; x < W; x++) {
        const fx = (x / W) * cells, x0 = Math.floor(fx), tx = smooth(fx - x0), x1 = (x0 + 1) % cells;
        const a = g[y0 * cells + x0], b = g[y0 * cells + x1], c = g[(y0 + 1) * cells + x0], d = g[(y0 + 1) * cells + x1];
        acc[y * W + x] += amp * ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty);
      }
    }
  }
  for (let i = 0; i < acc.length; i++) px[i] = Math.max(0, Math.min(255, 128 + (acc[i] / 1.935 - 0.5) * 300));
  return px;
}

// The cloud texture as a PNG, made once per size (identical every run).
async function cloudTexture(W, H, dir) {
  const f = path.join(dir, `clouds-${W}x${H}.png`);
  if (!fs.existsSync(f)) await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-i', 'pipe:0', '-frames:v', 1, '-update', 1, f], { input: clouds(W, H) });
  return f;
}

// Returns the segment length in seconds.
export async function segment(src, visual, W, H, out) {
  if (visual.clip) {
    // Loop: the clip's last X frames crossfade into its first X.
    const F = Math.floor(visual.duration * FPS) - 2, X = Math.min(45, Math.floor(F / 4));
    await ffmpeg(['-i', src, '-filter_complex',
      `[0:v]fps=${FPS},${cover(W, H)},format=yuv420p,split[a][b];` +
      `[a]trim=start_frame=${X}:end_frame=${F},setpts=PTS-STARTPTS[a1];[b]trim=end_frame=${X},setpts=PTS-STARTPTS[b1];` +
      `[a1][b1]xfade=transition=fade:duration=${X / FPS}:offset=${(F - 2 * X) / FPS}`, ...x264(F - X, out)]);
    return segmentLength(visual);
  }
  const L = segmentLength(visual), n = L * FPS, fx = visual.motion === 'effects' ? visual.effects ?? { zoom: 0.06 } : {};
  const dir = path.dirname(out), k = fx.zoom ? 2 : 1;
  // The image is decoded once per frame, so scale it to size once first: a 4K source otherwise adds ~450 MB.
  const sized = out.replace(/\.mp4$/, '.png');
  await ffmpeg(['-i', src, '-vf', cover(k * W, k * H), '-frames:v', 1, '-update', 1, sized]);
  const loop = f => ['-loop', 1, '-framerate', FPS, '-t', L, '-i', f];
  const inputs = [...loop(sized)], graph = [];
  // Slow zoom in and back out over one segment, so it ends where it began. Working at 2x keeps the motion smooth.
  graph.push(fx.zoom
    ? `[0:v]format=yuv420p,zoompan=z='1+${fx.zoom}*(1-cos(2*PI*on/${n}))/2':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=${FPS},setsar=1,format=gbrp[v0]`
    : '[0:v]format=gbrp[v0]');
  let v = 'v0', i = 1;
  if (fx.sky) {
    // Clouds drift sideways across the top of the frame, exactly one texture width per segment, so the
    // loop is seamless. The gradient mask fades them out by the middle of the frame.
    inputs.push(...loop(await cloudTexture(W, H, dir)));
    const c = i++, step = W / n;
    graph.push(`[${c}:v]format=gray,split[ca][cb];[ca][cb]hstack,crop=${W}:${H}:'mod(n*${step},${W})':0,format=gbrp[cl]`,
      `color=black:s=${W}x${H}:r=${FPS}:d=${L},format=gray,geq=lum='255*${fx.sky}*clip((0.6-Y/H)/0.45,0,1)',format=gbrp[mask]`,
      `[${v}]split[b1][b2];[b1][cl]blend=all_mode=overlay[sk];[b2][sk][mask]maskedmerge[v1]`);
    v = 'v1';
  }
  // (A procedural rain layer was tried twice and dropped: the owner found it unrealistic. Rain lives in the
  // image and the sound instead.)
  // Warm light "breathing": a few sines whose periods divide the segment, so it loops too.
  const flicker = fx.flicker ? `,eq=brightness='${fx.flicker}*(sin(2*PI*t*7/${L})+0.6*sin(2*PI*t*13/${L}+1.3)+0.4*sin(2*PI*t*29/${L}+0.7))/2':eval=frame` : '';
  graph.push(`[${v}]format=yuv420p${flicker}[out]`);
  const still = !fx.zoom && !fx.sky && !fx.flicker;
  await ffmpeg([...inputs, '-filter_complex', graph.join(';'), '-map', '[out]', ...(still ? ['-tune', 'stillimage'] : []), ...(still ? x264(n, out) : x264(n, out, 'medium', 23))]);
  return L;
}

// A copy of the segment with a lightning flash at offset o. Only a few frames differ, so a fast preset is fine.
export async function flashVariant(seg, L, o, out) {
  await ffmpeg(['-i', seg, '-vf', flashFilter(o), ...x264(L * FPS, out, 'veryfast', 23)]);
}

// A Short whose window holds a flashing thunder event re-encodes its video with the flash burned in.
export const shortFlashArgs = flashAt => ['-vf', flashFilter(flashAt), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', 4];

// Lay segment files end to end to length t and add audio (copied, or re-encoded with audioArgs).
// `files` is one entry per segment slot (a flash variant or the plain segment); it repeats if short.
export async function mux(files, segSecs, audio, out, { ss = 0, t, audioArgs = ['-c:a', 'copy'], videoArgs = ['-c:v', 'copy'] }) {
  const list = out + '.txt', count = Math.ceil(t / segSecs) + 1;
  const lines = Array.from({ length: count }, (_, k) => `file '${files[k % files.length].replace(/\\/g, '/')}'\n`);
  fs.writeFileSync(list, 'ffconcat version 1.0\n' + lines.join(''));
  try {
    await ffmpeg(['-f', 'concat', '-safe', 0, '-i', list, '-ss', ss, '-t', t, '-i', audio,
      '-map', '0:v:0', '-map', '1:a:0', ...videoArgs, ...audioArgs, '-t', t, out]);
  } finally {
    fs.unlinkSync(list);
  }
}

// Filter-option escaping for a Windows path inside single quotes.
const esc = p => p.replace(/\\/g, '/').replace(/:/g, '\\:');

function wrap(text, width = 18) {
  const lines = [];
  for (const w of text.split(/\s+/)) {
    if (lines.length && (lines.at(-1) + ' ' + w).length <= width) lines[lines.length - 1] += ' ' + w;
    else lines.push(w);
  }
  return lines;
}

// The video's own frame plus the title, in the niche's font and colours. PNG, or JPEG if PNG tops 2 MB.
export async function thumbnail(seg, title, style = {}, dir) {
  const font = path.resolve(ROOT, style.font ?? 'C:/Windows/Fonts/segoeuib.ttf');
  if (!fs.existsSync(font)) throw new Error(`thumbnail font not found: ${font}`);
  const [fg, shadow] = style.colors ?? ['#ffffff', '#000000'];
  const lines = title.split(' · ').flatMap(part => wrap(part)); // break at the separator first
  // ponytail: text width estimated from character count; measure glyphs (e.g. @napi-rs/canvas) if titles overflow.
  const size = Math.min(120, Math.floor(1150 / (Math.max(...lines.map(l => l.length)) * 0.56)));
  const txt = path.join(dir, 'work', 'title.txt');
  fs.writeFileSync(txt, lines.join('\n'));
  const vf = `scale=1280:720,drawtext=fontfile='${esc(font)}':textfile='${esc(txt)}':fontsize=${size}:fontcolor=${fg}` +
    `:borderw=${Math.max(2, Math.round(size / 16))}:bordercolor=${shadow}:shadowx=5:shadowy=5:shadowcolor=${shadow}@0.6` +
    `:line_spacing=${Math.round(size * 0.12)}:text_align=C:x=(w-text_w)/2:y=(h-text_h)/2`;
  const png = path.join(dir, 'thumb.png');
  await ffmpeg(['-ss', 1, '-i', seg, '-frames:v', 1, '-vf', vf, '-update', 1, png]);
  if (fs.statSync(png).size < 2 * 1024 * 1024) return png;
  const jpg = path.join(dir, 'thumb.jpg');
  await ffmpeg(['-i', png, '-q:v', 2, '-update', 1, jpg]);
  fs.unlinkSync(png);
  return jpg;
}
