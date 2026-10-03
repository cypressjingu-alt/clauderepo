import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { normalizeNiche } from '../src/config.js';
import { assemble, keywords, lengthLabel, metadata, phrases, prompt, templates, validate } from '../src/metadata.js';

const recipe = normalizeNiche({
  id: 'rainy-tokyo-cafe', name: 'Rainy Tokyo Café', format: 'layered', music: ['jazz', 'lofi'], visual: 'tokyo-night', motion: 'effects',
  effects: { flicker: 0.02 }, length: ['1h15m', '1h45m'], ambience: { bed: 'rain', events: [{ type: 'cafe-cups', every: ['40s', '150s'], gain_db: [-18, -8] }] },
  metadata: { search: 'rainy tokyo cafe jazz', scene: 'a cozy Tokyo cafe on a rainy night' },
});
const plan = {
  recipe, duration: 5700, visual: { effects: { flicker: 0.02 } },
  music: { chapters: [{ at: 0, title: 'ACE-Step 1.5 (AI) – Velvet Hours' }, { at: 190, title: 'Kevin MacLeod – Lobby Time' }, { at: 400, title: 'Amber Lobby' }] },
  credits: [
    { source_id: 'incompetech', text: 'Lobby Time Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0', attribution_required: true },
    { source_id: 'ai-acestep', text: 'Velvet Hours', attribution_required: false },
    { source_id: 'freesound-cc0', text: 'Rain by x (Freesound, CC0)', attribution_required: false },
  ],
  sources: { incompetech: { name: 'incompetech (Kevin MacLeod)' }, 'ai-acestep': { name: 'ACE-Step 1.5 (AI-generated)', ai_generated: true }, 'freesound-cc0': { name: 'Freesound' } },
};
const good = {
  title: 'Rainy Night in a Tokyo Café ☕ 1.5 Hours of Soft Jazz & Rain Sounds', thumbnail_text: 'Rainy Tokyo Café',
  description: 'Settle into a small café tucked into a Tokyo side street while the rain taps on the window.\n\nSoft jazz and lofi drift over the sound of the city at night: good company for studying, working or winding down.',
  tags: ['rainy tokyo cafe', 'jazz cafe ambience', 'rain sounds', 'lofi jazz', 'study music', 'tokyo night'],
  short_titles: ['Rain on a Tokyo café window #shorts', 'Late-night jazz in Tokyo #shorts'],
};

test('length labels round down to whole or half hours', () => {
  assert.equal(lengthLabel(5700), '1.5 Hours');
  assert.equal(lengthLabel(5135), '1 Hour'); // 1h25 never claims "1.5 Hours"
  assert.equal(lengthLabel(32908), '9 Hours');
  assert.equal(lengthLabel(1800), '30 Minutes');
});

test('keyword phrases: counted once per video, frequent first', () => {
  const p = phrases([
    { title: 'Rainy Tokyo Cafe | Relaxing Jazz Music for Study', tags: ['jazz cafe', 'rain sounds'] },
    { title: 'Tokyo Cafe Ambience - Rain & Jazz for Sleep', tags: ['rain sounds', 'tokyo cafe'] },
    { title: 'Cozy Jazz Cafe 3 Hours', tags: ['jazz cafe'] },
  ]);
  assert.ok(p.includes('tokyo cafe') && p.includes('rain sounds') && p.includes('jazz cafe'), p.join(', '));
  assert.ok(!p.some(x => /^\d/.test(x)) && !p.includes('for'));
});

test('good LLM fields are kept; bad ones fall back to templates, field by field', () => {
  const fb = templates(plan, null, 2);
  assert.deepEqual(validate(good, fb, 2).used, { title: 'llm', thumbnail_text: 'llm', description: 'llm', tags: 'llm', short_titles: 'llm' });
  const bad = { ...good, title: 'x'.repeat(150), thumbnail_text: 'Far Too Many Words For A Thumbnail Here', tags: 'not a list' };
  const { fields, used } = validate(bad, fb, 2);
  assert.deepEqual([used.title, used.thumbnail_text, used.tags, used.description], ['template', 'template', 'template', 'llm']);
  assert.ok(fields.title.length <= 100 && fields.title.includes('1.5 Hours'));
});

test('tags fit YouTube\'s 500-character budget and strip unsafe characters', () => {
  const many = Array.from({ length: 80 }, (_, i) => `long search phrase number ${i}`);
  const { fields } = validate({ ...good, tags: ['<b>rain</b>', ...many] }, templates(plan, null, 2), 2);
  const cost = fields.tags.reduce((s, t) => s + t.length + (t.includes(' ') ? 2 : 0), 0) + fields.tags.length - 1;
  assert.ok(cost <= 500, `cost ${cost}`);
  assert.ok(fields.tags.every(t => !/[<>,#]/.test(t)));
});

test('description: LLM words, then tracklist, required credits and hashtags; no AI wording', () => {
  const d = assemble(plan, validate(good, templates(plan, null, 2), 2).fields);
  assert.match(d, /Tracklist\n0:00 Velvet Hours\n3:10 Lobby Time\n6:40 Amber Lobby/);
  assert.match(d, /Music credits:\nLobby Time Kevin MacLeod/);
  assert.doesNotMatch(d, /Sources:|\bAI\b/); // Studio's AI-use answer labels the video instead
  assert.match(d, /#rainytokyocafe #jazzcafeambience #rainsounds$/);
  assert.ok(d.length <= 5000 && !/[<>]/.test(d));
});

test('a dead or rambling engine still yields complete metadata from templates', async () => {
  const db = open(':memory:');
  for (const llm of [async () => { throw new Error('ECONNREFUSED'); }, async () => 'Sure! Here are some ideas...']) {
    const m = await metadata(db, plan, { llm });
    assert.ok(Object.values(m.fields_from).every(v => v === 'template'));
    assert.ok(m.title.startsWith('Rainy Tokyo Café · 1.5 Hours') && m.shorts.length === 2 && m.tags.length >= 5);
  }
  const m = await metadata(db, plan, { llm: async () => '```json\n' + JSON.stringify(good) + '\n```' });
  assert.equal(m.title, good.title);
  assert.equal(m.shorts[1].title, 'Late-night jazz in Tokyo #shorts');
});

test('the prompt lists this niche\'s recent titles so a new video doesn\'t echo them', () => {
  const p = prompt({ ...plan, niche: 'rainy-tokyo-cafe', channel: 'showcase' }, null, 2, ['Rainy Tokyo Café Ambience (1 Hour) [thumbnail: RAINY TOKYO CAFE]']);
  assert.match(p[1].content, /clearly different[\s\S]*RAINY TOKYO CAFE/);
  assert.doesNotMatch(prompt(plan, null, 2)[1].content, /clearly different/);
});

test('keyword research is cached for a week and sends the key only in a header', async () => {
  const db = open(':memory:'), calls = [];
  process.env.YOUTUBE_API_KEY = 'test-key';
  const fetchImpl = async (url, opts) => {
    calls.push({ url, key: opts.headers['X-Goog-Api-Key'] });
    const body = url.includes('/search') ? { items: [{ id: { videoId: 'a' } }, { id: { videoId: 'b' } }] }
      : { items: ['Tokyo Cafe Jazz | Rain Sounds', 'Rainy Tokyo Cafe Jazz'].map((t, i) => ({ snippet: { title: t, tags: ['rain sounds'] }, statistics: { viewCount: `${9 - i}` } })) };
    return { ok: true, json: async () => body };
  };
  try {
    const a = await keywords(db, recipe, { fetchImpl, now: 0 });
    const b = await keywords(db, recipe, { fetchImpl, now: 6 * 864e5 });
    assert.deepEqual(a, b);
    assert.equal(calls.length, 2); // one search + one videos call, then served from cache
    assert.ok(calls.every(c => c.key === 'test-key' && !c.url.includes('test-key')));
    assert.ok(a.keywords.includes('rain sounds') && a.top_titles[0] === 'Tokyo Cafe Jazz | Rain Sounds');
    await keywords(db, recipe, { fetchImpl, now: 8 * 864e5 });
    assert.equal(calls.length, 4); // a week later it refreshes
    await keywords(db, { ...recipe, metadata: { search: 'another phrase' } }, { fetchImpl, now: 8 * 864e5 });
    assert.equal(calls.length, 6); // a new search phrase refreshes at once
  } finally {
    delete process.env.YOUTUBE_API_KEY;
  }
});
