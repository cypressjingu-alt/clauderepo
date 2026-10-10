// Milestone 4: one scheduler pass ("tick"), run hourly on the laptop by the ambient-scheduler task.
// Each tick does at most one piece of heavy work, in this order:
//   1. finish any render whose uploads aren't all on Studio (resumable: Studio decides what's missing);
//   2. keep `buffer_days` of long videos scheduled ahead: render the next niche by weighted rotation, then publish;
//   3. delete the big files of renders that went live more than a day ago (manifest, metadata and thumbnail stay).
// It only works while the laptop is home (on mains, on the home Wi-Fi) and Roblox is closed.
import fs from 'node:fs';
import path from 'node:path';
import { loadChannel, loadNiche, loadSources, nicheIds } from './config.js';
import { addAlert } from './db.js';
import { robloxRunning, run } from './ff.js';
import { plan } from './plan.js';
import { render } from './render.js';

const DONE = new Set(['scheduled', 'verified', 'unverified', 'private']);
const RETRY_FAILED_MS = 6 * 3600e3; // a render whose upload failed is retried after this long

// Weighted rotation: the niche furthest below its share of the channel's renders in the last 30 days.
// Never the same niche twice in a row while another is available; ties go to the one used longest ago.
export function nextNiche(db, channelId, niches, { now = Date.now() } = {}) {
  const since = new Date(now - 30 * 864e5).toISOString();
  const rows = db.prepare(`SELECT niche_id, created_at FROM renders WHERE channel_id = ? AND status = 'passed' AND created_at >= ? ORDER BY created_at`)
    .all(channelId, since);
  const count = id => rows.filter(r => r.niche_id === id).length, last = id => rows.findLast(r => r.niche_id === id)?.created_at ?? '';
  const total = rows.length || 1, wsum = niches.reduce((s, n) => s + (n.weight ?? 1), 0), prev = rows.at(-1)?.niche_id;
  const pool = niches.length > 1 ? niches.filter(n => n.id !== prev) : niches;
  return pool.map(n => ({ n, gap: (n.weight ?? 1) / wsum - count(n.id) / total }))
    .sort((a, b) => b.gap - a.gap || last(a.n.id).localeCompare(last(b.n.id)))[0].n;
}

// Home = on mains power and on one of AMBIENT_HOME_WIFI's networks (comma-separated). Unset: always home.
export async function atHome() {
  const wifi = (process.env.AMBIENT_HOME_WIFI ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (process.platform !== 'win32' || !wifi.length) return { home: true, why: 'no home check configured' };
  const { out } = await run('powershell', ['-NoProfile', '-Command',
    '(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus; netsh wlan show interfaces']);
  const ac = /^\s*2\s*$/m.test(out.split('\n')[0]) || !/\d/.test(out.split('\n')[0]); // 2 = on mains; no battery = desktop-like
  const ssid = out.match(/^\s*SSID\s*:\s*(.+?)\s*$/m)?.[1];
  const home = ac && wifi.includes(ssid);
  return { home, why: home ? `on mains, on ${ssid}` : `${ac ? 'on mains' : 'on battery'}, Wi-Fi ${ssid ?? 'none'}` };
}

const engineUp = () => fetch(`${process.env.MAGENTA_ENGINE_URL || 'http://127.0.0.1:20128'}/v1/models`, { signal: AbortSignal.timeout(5000) })
  .then(r => r.status < 500, () => false); // 401 without a key still means it's up

export async function tick(db, { channelId = 'showcase', log = console.log, now = Date.now() } = {}) {
  const channel = loadChannel(channelId);
  const where = await atHome();
  if (!where.home) return log(`not home (${where.why}); nothing to do`);
  if (await robloxRunning()) return log('Roblox is running; skipping this tick');
  // Studio's daily upload limit: no uploads for 24 h, and no renders either (they'd only pile up behind it).
  const capped = db.prepare(`SELECT MAX(created_at) t FROM alerts WHERE channel_id = ? AND type = 'upload_limit'`).get(channelId).t;
  if (capped && Date.parse(capped) > now - 864e5) return log(`Studio's daily upload limit was hit at ${capped}; uploads resume 24 h later`);
  const { publishRender } = await import('./studio.js');

  // 1. Unfinished uploads first: a render that passed, isn't a dry run, and has files not yet on Studio.
  for (const r of db.prepare(`SELECT id, dir FROM renders WHERE channel_id = ? AND status = 'passed' ORDER BY created_at`).all(channelId)) {
    const mf = path.join(r.dir, 'manifest.json'), md = path.join(r.dir, 'metadata.json');
    if (!fs.existsSync(mf) || !fs.existsSync(md)) continue;
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (m.dry_run || !fs.existsSync(path.join(r.dir, m.outputs.video))) continue;
    const files = [m.outputs.video, ...JSON.parse(fs.readFileSync(md, 'utf8')).shorts.map(s => s.file)];
    const ups = db.prepare('SELECT file, status, created_at FROM uploads WHERE render_id = ?').all(r.id);
    const rows = Object.fromEntries(ups.map(u => [u.file, u.status]));
    // Only renders whose publishing already began (a manual test render is never published by surprise).
    if (!ups.length || files.every(f => DONE.has(rows[f]))) continue;
    // One that failed lately waits its turn, so a stuck upload can't hold up the buffer (and alert every hour).
    if (ups.some(u => u.status === 'failed' && Date.parse(u.created_at) > now - RETRY_FAILED_MS)) continue;
    log(`finishing ${r.id}`);
    await publishRender(db, r.dir, { channel, log });
    return;
  }

  // 2. Buffer: long videos scheduled after now.
  const ahead = db.prepare(`SELECT COUNT(*) n FROM uploads WHERE channel_id = ? AND kind = 'video' AND status IN ('scheduled', 'verified', 'unverified') AND publish_at > ?`)
    .get(channelId, new Date(now).toISOString()).n;
  const want = (channel.buffer_days ?? 7) * (channel.publish_times ?? ['18:00']).length;
  if (ahead < want) {
    if (!await engineUp() && ahead >= 2) return log(`buffer ${ahead}/${want}, but the magenta engine is down; waiting for it so titles aren't templates`);
    const niches = (channel.niches ?? nicheIds()).map(loadNiche);
    const recipe = nextNiche(db, channelId, niches, { now });
    log(`buffer ${ahead}/${want}: rendering ${recipe.id}`);
    let p;
    try {
      p = plan(db, { recipe, channel, reg: loadSources(), now });
    } catch (e) {
      addAlert(db, channelId, 'plan_failed', { niche: recipe.id, error: e.message });
      throw e;
    }
    p.shorts = channel.shorts_per_video;
    const r = await render(db, p, { log });
    if (!r.qa.pass) { addAlert(db, channelId, 'render_failed_qa', { niche: recipe.id, dir: r.dir, checks: r.qa.checks.filter(c => !c.pass).map(c => c.name) }); return; }
    await publishRender(db, r.dir, { channel, log });
    return;
  }

  // 3. Cleanup: video files of renders whose every upload is live (publish time passed) for more than a day.
  const cutoff = new Date(now - 864e5).toISOString();
  for (const r of db.prepare(`SELECT id, dir FROM renders WHERE channel_id = ? AND status = 'passed'`).all(channelId)) {
    const ups = db.prepare('SELECT status, publish_at FROM uploads WHERE render_id = ?').all(r.id);
    if (!ups.length || !ups.every(u => DONE.has(u.status) && u.publish_at && u.publish_at < cutoff)) continue;
    const big = fs.existsSync(r.dir) ? fs.readdirSync(r.dir).filter(f => /\.mp4$/.test(f)) : [];
    if (!big.length) continue;
    for (const f of big) fs.unlinkSync(path.join(r.dir, f));
    log(`cleaned ${r.id}: removed ${big.join(', ')} (live for over a day; manifest kept for a rebuild)`);
  }
  log(`buffer ${ahead}/${want}; nothing to do`);
}
