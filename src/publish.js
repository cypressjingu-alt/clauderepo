// Publishing through YouTube Studio: schedule slots now, the Studio automation itself next.

// Milliseconds the zone is ahead of UTC at instant t.
function offset(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(t).map(x => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
}
// Wall-clock date (YYYY-MM-DD) and time (HH:MM) in tz -> epoch ms. ponytail: off by the gap hour on a DST change day.
export const zoned = (date, time, tz) => { const g = Date.parse(`${date}T${time}:00Z`); return g - offset(g, tz); };
export const localDate = (t, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(t);

// The first free daily slot at least `leadMs` from now. A slot is taken by any long video not marked failed.
export function nextSlot(db, channel, { now = Date.now(), leadMs = 2 * 3600e3 } = {}) {
  const tz = channel.timezone ?? 'UTC', times = channel.publish_times ?? ['18:00'];
  const taken = new Set(db.prepare(`SELECT publish_at FROM uploads WHERE channel_id = ? AND kind = 'video' AND status != 'failed'`)
    .all(channel.id).map(r => r.publish_at));
  const day0 = Date.parse(`${localDate(now, tz)}T00:00:00Z`);
  for (let d = 0; d < 366; d++) {
    const date = new Date(day0 + d * 864e5).toISOString().slice(0, 10);
    for (const time of times) {
      const t = zoned(date, time, tz), iso = new Date(t).toISOString();
      if (t >= now + leadMs && !taken.has(iso)) return iso;
    }
  }
  throw new Error('no free slot in the next year');
}
