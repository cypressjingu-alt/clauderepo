import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { nextNiche } from '../src/scheduler.js';

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
