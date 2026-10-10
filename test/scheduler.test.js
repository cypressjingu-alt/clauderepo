import test from 'node:test';
import assert from 'node:assert/strict';
import { addAlert, open } from '../src/db.js';
import { nextNiche, tick } from '../src/scheduler.js';

test('weighted rotation follows the weights and never repeats a niche back to back', () => {
  const db = open(':memory:'), niches = [{ id: 'cafe', weight: 3 }, { id: 'lobby', weight: 2 }, { id: 'thunder', weight: 2 }];
  const ins = db.prepare(`INSERT INTO renders (id, channel_id, niche_id, status, created_at) VALUES (?, 'showcase', ?, 'passed', ?)`);
  let t = Date.parse('2026-10-01T00:00:00Z');
  const picks = [];
  for (let i = 0; i < 70; i++) {
    const n = nextNiche(db, 'showcase', niches, { now: t }).id;
    if (picks.length) assert.notEqual(n, picks.at(-1));
    picks.push(n);
    ins.run(`r${i}`, n, new Date(t).toISOString());
    t += 864e5 / 10; // 10 a day keeps all 70 inside the 30-day window
  }
  const share = id => picks.filter(p => p === id).length / picks.length;
  assert.ok(Math.abs(share('cafe') - 3 / 7) < 0.05 && Math.abs(share('lobby') - 2 / 7) < 0.05, JSON.stringify({ cafe: share('cafe'), lobby: share('lobby') }));
});

test('after Studio\'s daily upload limit, a tick does nothing for 24 h', async () => {
  process.env.AMBIENT_HOME_WIFI = ''; process.env.AMBIENT_ROBLOX_GATE = 'off'; // home, no Roblox: the tick gets as far as the limit
  const db = open(':memory:'), lines = [];
  addAlert(db, 'showcase', 'upload_limit', { error: 'limit' });
  await tick(db, { log: l => lines.push(l), now: Date.now() + 23 * 3600e3 });
  assert.match(lines.join('\n'), /daily upload limit was hit/);
});
