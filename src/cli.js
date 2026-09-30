#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DATA, hms, loadChannel, loadNiche, loadSources, secs } from './config.js';
import { addAlert, open } from './db.js';
import { ingest } from './ingest.js';
import { plan } from './plan.js';
import { recordUsage, render } from './render.js';
import { metadata } from './metadata.js';
import { thumbnail } from './video.js';
import { qa } from './qa.js';

const USAGE = `ambient <command>
  ingest                                   scan the pool, measure and analyze new files
  pool status                              what's in the pool and what needs attention
  plan --niche <id> [--length 2h] [--seed n]   write a plan to data/plans/
  render <plan.json> | --niche <id> [--length] [--seed]
  qa <render-id>                           re-run QA on a finished render
  rebuild <manifest.json>                  render the exact same plan again
  metadata <render-id | render dir>        (re)write title, description, tags and thumbnail text
  adopt <render-id | render dir>           a dry-run render becomes a real video: its files go on cooldown
options: --channel <id> (default showcase), --dry-run (don't touch cooldowns or alerts)`;

const { values: o, positionals: [cmd, ...args] } = parseArgs({
  allowPositionals: true,
  options: { niche: { type: 'string' }, length: { type: 'string' }, seed: { type: 'string' }, channel: { type: 'string', default: 'showcase' }, 'dry-run': { type: 'boolean' } },
});
const db = open(path.join(DATA(), 'ambient.db'));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
// A render id known to this machine's DB, or a render folder (e.g. one copied from the other machine).
function renderDir(arg) {
  if (arg && fs.existsSync(path.join(arg, 'manifest.json'))) return path.resolve(arg);
  const row = db.prepare('SELECT dir FROM renders WHERE id = ?').get(arg);
  if (!row) throw new Error(`no render ${arg}`);
  return row.dir;
}

function makePlan() {
  if (!o.niche) throw new Error('--niche is required');
  const channel = loadChannel(o.channel);
  try {
    const p = plan(db, { recipe: loadNiche(o.niche), channel, reg: loadSources(), seed: o.seed && +o.seed, length: o.length && secs(o.length) });
    p.shorts = channel.shorts_per_video;
    return p;
  } catch (e) {
    if (cmd === 'render' && !o['dry-run']) addAlert(db, o.channel, 'plan_failed', { niche: o.niche, error: e.message });
    throw e;
  }
}

function summary(p) {
  const bits = [`${p.niche} (${p.recipe.format}), ${hms(p.duration)}, seed ${p.seed}`];
  if (p.music) bits.push(`${p.music.segments.length} tracks, ${p.music.chapters.length} chapters`);
  if (p.bed) bits.push(`${p.bed.length} bed segment(s), ${p.events.length} events`);
  bits.push(`visual ${p.visual.path} (${p.visual.motion})`);
  for (const a of p.alerts) bits.push(`ALERT ${a.type}: ${JSON.stringify(a.payload)}`);
  return bits.join('\n  ');
}

try {
  switch (cmd) {
    case 'ingest': {
      const r = await ingest(db);
      console.log(`added ${r.added}, updated ${r.updated}, moved ${r.moved}, unchanged ${r.unchanged}, missing ${r.missing}, still arriving ${r.settling}, analyzed ${r.analyzed}`);
      for (const d of r.duplicates) console.log(`duplicate (skipped): ${d}`);
      for (const s of r.unusable) console.log(`source "${s}" isn't registered with compilation_ok in config/sources.yaml; its files won't be used`);
      for (const e of r.errors) console.log(`error: ${e}`);
      break;
    }
    case 'pool': {
      const reg = loadSources();
      for (const r of db.prepare(`SELECT kind, tag, COUNT(*) n, SUM(duration) d FROM assets WHERE missing = 0 GROUP BY kind, tag ORDER BY kind, tag`).all())
        console.log(`${r.kind.padEnd(7)} ${r.tag.padEnd(20)} ${String(r.n).padStart(4)} files  ${r.d ? hms(r.d) : ''}`);
      for (const r of db.prepare('SELECT source_id, COUNT(*) n FROM assets WHERE missing = 0 GROUP BY source_id').all())
        if (!reg[r.source_id]?.compilation_ok) console.log(`unusable source "${r.source_id}": ${r.n} files (not registered with compilation_ok)`);
      const c = db.prepare(`SELECT SUM(missing) missing, SUM(blocked) blocked, SUM(credit_guessed AND NOT missing) guessed,
        SUM(kind = 'music' AND analyzed = 0 AND NOT missing) unanalyzed, SUM(kind = 'music' AND max_gap >= 5 AND NOT missing) gappy FROM assets`).get();
      console.log(`missing ${c.missing ?? 0}, blocked ${c.blocked ?? 0}, guessed credits ${c.guessed ?? 0}, unanalyzed ${c.unanalyzed ?? 0}, ` +
        `tracks skipped for a mid-track silence of 5 s+ ${c.gappy ?? 0}`);
      for (const g of db.prepare('SELECT path, artist, title FROM assets WHERE credit_guessed = 1 AND missing = 0 LIMIT 50').all())
        console.log(`  guessed: ${g.path} -> "${g.title}" by ${g.artist ?? '?'}`);
      break;
    }
    case 'plan': {
      const p = makePlan();
      const f = path.join(DATA(), 'plans', `${p.niche}-${p.seed}.json`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(p, null, 2));
      console.log(`${summary(p)}\nsaved ${f}`);
      break;
    }
    case 'render':
    case 'rebuild': {
      const p = cmd === 'rebuild' ? readJson(args[0]).plan : args[0] ? readJson(args[0]) : makePlan();
      console.log(summary(p));
      const r = await render(db, p, { dryRun: o['dry-run'] });
      for (const c of r.qa.checks) console.log(`  ${c.pass ? 'pass' : 'FAIL'} ${c.name}: ${c.detail}`);
      console.log(r.dir);
      process.exitCode = r.qa.pass ? 0 : 1;
      break;
    }
    case 'qa': {
      const row = db.prepare('SELECT dir FROM renders WHERE id = ?').get(args[0]);
      if (!row) throw new Error(`no render ${args[0]}`);
      const r = await qa(row.dir, readJson(path.join(row.dir, 'manifest.json')).plan);
      fs.writeFileSync(path.join(row.dir, 'qa.json'), JSON.stringify(r, null, 2));
      db.prepare('UPDATE renders SET status = ?, qa = ? WHERE id = ?').run(r.pass ? 'passed' : 'failed', JSON.stringify(r), args[0]);
      for (const c of r.checks) console.log(`  ${c.pass ? 'pass' : 'FAIL'} ${c.name}: ${c.detail}`);
      process.exitCode = r.pass ? 0 : 1;
      break;
    }
    case 'metadata':
    case 'adopt': {
      const dir = renderDir(args[0]), mf = path.join(dir, 'manifest.json'), m = readJson(mf);
      if (cmd === 'adopt') {
        const n = recordUsage(db, m.plan, m.render_id);
        Object.assign(m, { dry_run: false, adopted_at: new Date().toISOString() });
        console.log(`${m.render_id}: ${n} files put on cooldown for channel ${m.plan.channel}`);
      } else {
        const meta = await metadata(db, m.plan, { shorts: m.outputs.shorts.length, log: console.log });
        fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
        for (const f of ['thumb.png', 'thumb.jpg']) if (fs.existsSync(path.join(dir, f))) fs.unlinkSync(path.join(dir, f));
        m.outputs.thumbnail = path.basename(await thumbnail(path.join(dir, 'video.mp4'), meta.thumbnail_text, m.plan.recipe.thumbnail, dir));
        fs.rmSync(path.join(dir, 'work'), { recursive: true, force: true });
        m.title = meta.title;
        console.log(`${meta.title}\n  thumbnail: "${meta.thumbnail_text}"  fields from: ${JSON.stringify(meta.fields_from)}`);
      }
      fs.writeFileSync(mf, JSON.stringify(m, null, 2));
      break;
    }
    default:
      console.log(USAGE);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
