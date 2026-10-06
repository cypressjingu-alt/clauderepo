#!/usr/bin/env node
// Run every 5 min by the laptop's "ambient-heartbeat" scheduled task:
// 1. pings AMBIENT_PING_URL, so healthchecks.io alerts the owner when the pings stop (laptop off, asleep, offline);
// 2. posts undelivered pipeline alerts (failed uploads, sign-out, copyright, pool) to AMBIENT_ALERT_WEBHOOK (Discord).
// Either setting empty: that part does nothing.
import path from 'node:path';
import { DATA } from './config.js'; // also loads .env
import { open } from './db.js';

const isDiscord = u => /(^|\.)discord(app)?\.com$/.test(new URL(u).host);

const ping = process.env.AMBIENT_PING_URL;
if (ping && isDiscord(ping)) {
  // A webhook can't report its own machine's death; it belongs in healthchecks.io's Discord integration.
  console.error('AMBIENT_PING_URL is a Discord webhook; it needs the check\'s healthchecks.io ping URL (https://hc-ping.com/...)');
  process.exitCode = 2;
} else if (ping) {
  try {
    if (!(await fetch(ping, { signal: AbortSignal.timeout(15000) })).ok) process.exitCode = 1;
  } catch {
    process.exitCode = 1; // offline: the missing ping is the alert
  }
}

const hook = process.env.AMBIENT_ALERT_WEBHOOK;
if (hook && !(isDiscord(hook) && new URL(hook).pathname.startsWith('/api/webhooks/'))) {
  console.error('AMBIENT_ALERT_WEBHOOK must be a Discord webhook URL (https://discord.com/api/webhooks/...)');
  process.exitCode = 2;
} else if (hook) {
  const db = open(path.join(DATA(), 'ambient.db'));
  const rows = db.prepare('SELECT id, channel_id, type, payload, created_at FROM alerts WHERE delivered_at IS NULL ORDER BY id LIMIT 10').all();
  if (rows.length) {
    const line = a => {
      const p = JSON.parse(a.payload ?? '{}');
      const what = p.error ?? p.problem ?? p.checks ?? p.url ?? JSON.stringify(p);
      return `**${a.type}** (${a.channel_id}${p.render ? `, ${p.render}` : ''}${p.file ? ` ${p.file}` : ''}${p.video ? `, ${p.video}` : ''}): ${String(what).split('\n')[0].slice(0, 200)}`;
    };
    const content = `Ambient pipeline alerts from the laptop:\n${rows.map(line).join('\n')}`.slice(0, 1900);
    try {
      const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
      if (r.ok) {
        const mark = db.prepare('UPDATE alerts SET delivered_at = ? WHERE id = ?'), now = new Date().toISOString();
        for (const a of rows) mark.run(now, a.id);
      } else process.exitCode = 1; // undelivered: retried next run
    } catch {
      process.exitCode = 1;
    }
  }
}
