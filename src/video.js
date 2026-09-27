import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { ffmpeg } from './ff.js';

// Every motion style renders ONE seamless segment. The full video repeats it with the
// concat demuxer and stream copy, so a 10-hour video costs one short encode.

const FPS = 30;
const STILL_SECS = 60; // still and effects segments; also the zoom period for effects

const cover = (W, H) => `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
// 4 threads and a short lookahead keep x264 near 400 MB (default threading took 1.5 GB on 16 cores).
const x264 = (frames, out) => ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', 4, '-rc-lookahead', 10,
  '-g', frames, '-bf', '0', '-an', '-video_track_timescale', FPS * 512, out];

// Returns the segment length in seconds.
export async function segment(src, visual, W, H, out) {
  if (visual.clip) {
    // Loop: the clip's last X frames crossfade into its first X.
    const F = Math.floor(visual.duration * FPS) - 2, X = Math.min(45, Math.floor(F / 4));
    await ffmpeg(['-i', src, '-filter_complex',
      `[0:v]fps=${FPS},${cover(W, H)},format=yuv420p,split[a][b];` +
      `[a]trim=start_frame=${X}:end_frame=${F},setpts=PTS-STARTPTS[a1];[b]trim=end_frame=${X},setpts=PTS-STARTPTS[b1];` +
      `[a1][b1]xfade=transition=fade:duration=${X / FPS}:offset=${(F - 2 * X) / FPS}`, ...x264(F - X, out)]);
    return (F - X) / FPS;
  }
  // The image is decoded once per frame, so scale it to size once first: a 4K source otherwise adds ~450 MB.
  const n = STILL_SECS * FPS, effects = visual.motion === 'effects', k = effects ? 2 : 1;
  const sized = out.replace(/\.mp4$/, '.png');
  await ffmpeg(['-i', src, '-vf', cover(k * W, k * H), '-frames:v', 1, '-update', 1, sized]);
  let vf = 'format=yuv420p', tune = ['-tune', 'stillimage'];
  if (effects) {
    // Slow zoom in and back out over one segment, so it ends where it began. Working at 2x keeps the motion smooth.
    const zoom = visual.effect?.zoom ?? 0.06;
    vf = `format=yuv420p,zoompan=z='1+${zoom}*(1-cos(2*PI*on/${n}))/2':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=${FPS},setsar=1`;
    tune = [];
  }
  await ffmpeg(['-loop', 1, '-framerate', FPS, '-t', STILL_SECS, '-i', sized, '-vf', vf, ...tune, ...x264(n, out)]);
  return STILL_SECS;
}

// Repeat the segment to length t and add audio (copied, or re-encoded with audioArgs).
export async function mux(seg, segSecs, audio, out, { ss = 0, t, audioArgs = ['-c:a', 'copy'] }) {
  const list = out + '.txt';
  fs.writeFileSync(list, 'ffconcat version 1.0\n' + `file '${seg.replace(/\\/g, '/')}'\n`.repeat(Math.ceil(t / segSecs) + 1));
  try {
    await ffmpeg(['-f', 'concat', '-safe', 0, '-i', list, '-ss', ss, '-t', t, '-i', audio,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...audioArgs, '-t', t, out]);
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
  const lines = wrap(title);
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
