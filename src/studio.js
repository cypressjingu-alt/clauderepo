// YouTube Studio automation: drives the laptop's Edge with a profile the owner signed into once (data/studio/<channel>).
// Selectors were mapped from Studio on 2026-10-03; when Studio's UI changes, this is the file to fix.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DATA } from './config.js';
import { addAlert } from './db.js';
import { waitForRoblox } from './ff.js';
import { nextSlot } from './publish.js';

const STUDIO = 'https://studio.youtube.com';
const SHORT_OFFSETS_H = [6, 12]; // Shorts go live this many hours after their video

async function until(fn, ms, every = 2000) {
  for (const end = Date.now() + ms; ;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise(r => setTimeout(r, every));
  }
}

export async function openStudio(db, channel) {
  const ctx = await chromium.launchPersistentContext(path.join(DATA(), 'studio', channel.id), {
    channel: 'msedge', headless: true, ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1400, height: 1000 }, timezoneId: channel.timezone ?? 'UTC', locale: 'en-US',
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(STUDIO, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForURL(/studio\.youtube\.com\/channel\/UC|accounts\.google\.com/, { timeout: 60000 }).catch(() => {});
  const m = page.url().match(/(https:\/\/studio\.youtube\.com\/channel\/UC[\w-]+)/);
  if (!m) { // signed out or asked to re-verify: pause and alert, never retry (handoff §7)
    await ctx.close();
    addAlert(db, channel.id, 'studio_signed_out', { url: page.url().replace(/[?#].*/, '') });
    throw new Error('Studio needs the owner to sign in again on the laptop (RustDesk); nothing was uploaded');
  }
  return { ctx, page, base: m[1] };
}

const fmt = (t, tz, o) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(t);

// Uploads one file through the dialog (or reopens the draft `draftId` left by a failed run) and saves it
// private or scheduled. Returns { id, checks, blocked }; a failure after Studio assigned an id carries it as e.videoId.
async function upload(page, base, { file, draftId, ...it }, log) {
  const dlg = page.locator('ytcp-uploads-dialog'), titleBox = dlg.locator('#title-textarea #textbox');
  if (draftId) {
    await page.goto(`${STUDIO}/video/${draftId}/edit`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('button', { name: /edit draft/i }).first().click({ timeout: 60000 });
  } else {
    await page.goto(`${base}/videos/upload?d=ud`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dlg.locator('input[type="file"]').first().setInputFiles(file);
  }
  await titleBox.waitFor({ timeout: 120000 });
  const id = draftId ?? await until(async () => (await dlg.locator('a#video-link').getAttribute('href'))?.match(/(?:youtu\.be|shorts)\/([\w-]{11})/)?.[1], 180000);
  if (!id) throw new Error(`no video id for ${path.basename(file)}`);
  log(`  ${path.basename(file)} -> ${id}${draftId ? ' (resumed draft)' : ''}`);
  try {
    return { id, ...await fillAndSave(page, dlg, titleBox, id, it) };
  } catch (e) {
    e.videoId = id;
    throw e;
  }
}

async function fillAndSave(page, dlg, titleBox, id, { title, description, tags, thumb, ai, publishAt, tz, waitChecks }) {
  await titleBox.fill(title);
  await dlg.locator('#description-textarea #textbox').fill(description);
  if (thumb) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dlg.getByRole('button', { name: 'Upload file' }).click()]);
    await chooser.setFiles(thumb);
  }
  await dlg.locator('[name=VIDEO_MADE_FOR_KIDS_NOT_MFK]').click();
  if (!await dlg.locator('[name=VIDEO_HAS_ALTERED_CONTENT_YES]').isVisible()) await dlg.locator('#toggle-button').click();
  const paid = dlg.locator('[name=VIDEO_PAID_PRODUCT_PLACEMENT_NO]');
  if (await paid.isVisible()) await paid.click();
  await dlg.locator(`[name=VIDEO_HAS_ALTERED_CONTENT_${ai ? 'YES' : 'NO'}]`).click();
  const tagInput = dlg.locator('#tags-container input#text-input');
  if (/^0\//.test((await dlg.locator('#tags-count').innerText()).trim())) { // a resumed draft may have them already
    await tagInput.fill(tags.join(','));
    await tagInput.press('Enter');
  }
  // Read back what Studio actually holds.
  if ((await titleBox.innerText()).trim() !== title) throw new Error(`title didn't stick on ${id}`);
  if ((await dlg.locator('#description-textarea #textbox').innerText()).trim().length < description.trim().length * 0.9) throw new Error(`description didn't stick on ${id}`);
  if (/^0\//.test((await dlg.locator('#tags-count').innerText()).trim())) throw new Error(`tags didn't stick on ${id}`);

  // The browser must stay open until the file is up, and the copyright check needs SD processing first.
  const progress = dlg.locator('.progress-label, ytcp-video-upload-progress').first();
  await until(async () => !/uploading/i.test(await progress.innerText()), 3 * 3600e3, 10000)
    ?? (() => { throw new Error(`upload of ${id} didn't finish`); })();
  await dlg.locator('#next-button').click(); // video elements
  await dlg.locator('#next-button').click(); // checks
  const body = dlg.locator('#scrollable-content');
  const checks = (await until(async () => {
    const t = (await body.innerText()).replace(/\s+/g, ' ');
    return /issues found|content found/i.test(t) && !/checking if|will not run/i.test(t) ? t : null;
  }, waitChecks, 30000)) ?? 'checks still running when saved';
  await dlg.locator('#next-button').click(); // visibility
  const blocked = /block|mute/i.test(checks) && !/no issues/i.test(checks);

  if (publishAt && !blocked) {
    const t = Date.parse(publishAt), day = fmt(t, tz, { month: 'short', day: 'numeric', year: 'numeric' }), time = fmt(t, tz, { hour: 'numeric', minute: '2-digit', hour12: true });
    await dlg.locator('#second-container-expand-button').click();
    await dlg.locator('#datepicker-trigger').click();
    const dateInput = page.locator('ytcp-date-picker input').first();
    await dateInput.fill(day);
    await dateInput.press('Enter');
    const timeInput = dlg.locator('#time-of-day-container input').first();
    await timeInput.fill(time);
    await timeInput.press('Enter');
    await page.waitForTimeout(1000);
    const shown = `${(await dlg.locator('#datepicker-trigger').innerText()).trim()} ${await timeInput.inputValue()}`;
    if (shown !== `${day} ${time}`) throw new Error(`schedule shows "${shown}", wanted "${day} ${time}" (${id})`);
  } else {
    await dlg.locator('#privacy-radios [name=PRIVATE]').click();
  }
  await dlg.locator('#done-button').click();
  await until(async () => !await dlg.locator('#done-button').isVisible(), 60000);
  return { checks, blocked };
}

// Confirms on the video's own Studio page that it's saved the way we left it.
async function readBack(page, id, { title, publishAt }) {
  await page.goto(`${STUDIO}/video/${id}/edit`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const text = await until(async () => { const t = await page.locator('body').innerText(); return t.includes(title) ? t : null; }, 60000);
  if (!text) return `title not found on ${id}'s page`;
  if (/draft state/i.test(text)) return `${id} is still a draft`;
  if (publishAt ? !/scheduled/i.test(text) : !/private/i.test(text)) return `${id} isn't ${publishAt ? 'scheduled' : 'private'}`;
  return null;
}

// Uploads a render's video and Shorts. mode: 'private' (owner checks first) or 'schedule' (next free daily slot).
export async function publishRender(db, dir, { channel, mode = 'schedule', log = console.log }) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  const qa = JSON.parse(fs.readFileSync(path.join(dir, 'qa.json'), 'utf8'));
  if (!qa.pass) throw new Error('this render failed QA');
  if (m.dry_run) throw new Error('this is a dry run; `adopt` it first so its files go on cooldown');
  const prior = db.prepare('SELECT kind, file, video_id, status FROM uploads WHERE render_id = ?').all(m.render_id);
  const done = prior.filter(r => r.status !== 'failed');
  if (done.length) throw new Error(`already uploaded: ${done.map(r => `${r.file} ${r.video_id} (${r.status})`).join(', ')}`);
  const drafts = Object.fromEntries(prior.filter(r => r.video_id).map(r => [r.file, r.video_id])); // left by a failed run: resume, don't duplicate

  await waitForRoblox(log);
  const tz = channel.timezone ?? 'UTC', publishAt = mode === 'schedule' ? nextSlot(db, channel) : null;
  const ai = Object.values(m.plan.sources ?? {}).some(s => s.ai_generated);
  const row = db.prepare(`INSERT OR REPLACE INTO uploads (render_id, channel_id, kind, file, video_id, publish_at, status, claims, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const items = [
    { kind: 'video', file: m.outputs.video, title: meta.title, description: meta.description, thumb: path.join(dir, m.outputs.thumbnail), publishAt, waitChecks: 60 * 60e3 },
    ...meta.shorts.map((s, i) => ({ kind: 'short', file: s.file, title: s.title, description: s.description,
      publishAt: publishAt && new Date(Date.parse(publishAt) + SHORT_OFFSETS_H[i % SHORT_OFFSETS_H.length] * 3600e3).toISOString(), waitChecks: 10 * 60e3 })),
  ];
  log(`${m.render_id}: ${publishAt ? `scheduling for ${fmt(Date.parse(publishAt), tz, { dateStyle: 'medium', timeStyle: 'short' })} (${tz})` : 'uploading as private'}`);
  const { ctx, page, base } = await openStudio(db, channel);
  const results = [];
  try {
    for (const it of items) {
      let r;
      try {
        r = await upload(page, base, { ...it, file: path.join(dir, it.file), draftId: drafts[it.file], tags: meta.tags, ai, tz }, log);
      } catch (e) {
        await page.screenshot({ path: path.join(dir, `studio-error-${it.kind}.png`) }).catch(() => {});
        row.run(m.render_id, channel.id, it.kind, it.file, e.videoId ?? drafts[it.file] ?? null, it.publishAt, 'failed', null, e.message, new Date().toISOString());
        addAlert(db, channel.id, 'upload_failed', { render: m.render_id, file: it.file, error: e.message });
        throw e;
      }
      const status = r.blocked ? 'private' : it.publishAt ? 'scheduled' : 'private';
      row.run(m.render_id, channel.id, it.kind, it.file, r.id, r.blocked ? null : it.publishAt, status, r.checks, null, new Date().toISOString());
      if (!/no issues found/i.test(r.checks)) addAlert(db, channel.id, r.blocked ? 'copyright_block' : 'copyright_check', { render: m.render_id, video: r.id, checks: r.checks });
      // ponytail: claims are logged and alerted; blocking the claimed track needs the claim UI mapped (none seen yet).
      results.push({ ...it, ...r, status });
      log(`  ${it.kind} ${r.id}: ${status}; checks: ${r.checks.slice(0, 120)}`);
    }
    for (const r of results) {
      const problem = await readBack(page, r.id, { title: r.title, publishAt: r.status === 'scheduled' ? r.publishAt : null });
      // 'unverified' still holds its slot: the video may well be scheduled on Studio.
      db.prepare('UPDATE uploads SET status = ?, detail = ? WHERE video_id = ?').run(problem ? 'unverified' : r.status === 'scheduled' ? 'verified' : r.status, problem, r.id);
      if (problem) addAlert(db, channel.id, 'upload_unverified', { render: m.render_id, video: r.id, problem });
      log(`  read-back ${r.id}: ${problem ?? 'ok'}`);
    }
  } finally {
    await ctx.close();
  }
  return results;
}
