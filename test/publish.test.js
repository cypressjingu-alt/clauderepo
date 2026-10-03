import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { nextSlot, zoned } from '../src/publish.js';

test('one slot a day at the channel\'s local time, skipping taken and too-soon slots', () => {
  const db = open(':memory:'), ch = { id: 'showcase', timezone: 'Asia/Singapore', publish_times: ['18:00'] };
  assert.equal(new Date(zoned('2026-10-03', '18:00', 'Asia/Singapore')).toISOString(), '2026-10-03T10:00:00.000Z');
  assert.equal(new Date(zoned('2026-07-01', '18:00', 'America/New_York')).toISOString(), '2026-07-01T22:00:00.000Z'); // DST
  const now = Date.parse('2026-10-03T07:00:00Z'); // 15:00 in Singapore: today's 18:00 is 3 h away
  assert.equal(nextSlot(db, ch, { now }), '2026-10-03T10:00:00.000Z');
  assert.equal(nextSlot(db, ch, { now: Date.parse('2026-10-03T09:00:00Z') }), '2026-10-04T10:00:00.000Z'); // 1 h is too soon
  const add = (at, status = 'scheduled', kind = 'video') => db.prepare(`INSERT INTO uploads (render_id, channel_id, kind, file, publish_at, status)
    VALUES (?, 'showcase', ?, ?, ?, ?)`).run(at, kind, `${kind}.mp4`, at, status);
  add('2026-10-03T10:00:00.000Z');
  add('2026-10-04T10:00:00.000Z', 'failed');      // a failed upload frees its slot
  add('2026-10-05T10:00:00.000Z', 'scheduled', 'short'); // Shorts don't take slots
  assert.equal(nextSlot(db, ch, { now }), '2026-10-04T10:00:00.000Z');
});
