import http from 'node:http';
import { hms } from './config.js';

// Titles, descriptions and tags (M2). The magenta engine's LLM writes the words, steered by keyword research
// from similar popular videos; code adds chapters, credits and hashtags. If the engine is down or answers
// badly, templates fill in field by field: a video never waits on the LLM. Never a paid API.

const ENGINE = () => process.env.MAGENTA_ENGINE_URL || 'http://127.0.0.1:20128';
const ENGINE_KEY = () => process.env.MAGENTA_ENGINE_KEY || process.env.OMNIROUTE_KEY;
const MODEL = () => process.env.AMBIENT_LLM_MODEL || 'antigravity/gemini-3.7-flash-low'; // owner rule: Gemini only
const WEEK = 7 * 864e5;
// YouTube's limits: title 100 characters, description 5000, tags 500 in total (quoted when they contain spaces).
const TITLE_MAX = 100, DESC_MAX = 5000, TAGS_MAX = 500;

const clean = s => String(s ?? '').replace(/[<>]/g, '').replace(/https?:\/\/\S+/g, '').replace(/[ \t]+/g, ' ').trim();
const titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());
const words = list => list.map(t => t.replace(/-/g, ' '));

// "At least" length: whole or half hours, rounded down, so a title never overstates.
export function lengthLabel(seconds) {
  if (seconds < 3600) return `${Math.floor(seconds / 60)} Minutes`;
  const h = Math.floor(seconds / 1800) / 2;
  return `${h} Hour${h === 1 ? '' : 's'}`;
}

// --- keyword research (YouTube Data API, read-only), cached for a week per niche ---

const STOP = new Set('a an and the of for to in on with at by from your you our is are be or this that it as into best new'.split(' '));

export function phrases(videos, limit = 25) {
  const seen = new Map();
  for (const v of videos) {
    const text = [v.title, ...(v.tags ?? [])].join(' | ').toLowerCase();
    const grams = new Set();
    for (const part of text.split(/[|,.:;!?()\[\]"“”•–—\/]+/)) {
      const w = part.split(/\s+/).map(x => x.replace(/[^\p{L}\p{N}'&-]/gu, '')).filter(Boolean);
      for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) {
        const g = w.slice(i, i + n);
        if (STOP.has(g[0]) || STOP.has(g.at(-1)) || g.some(x => /^\d+$/.test(x))) continue;
        grams.add(g.join(' '));
      }
    }
    for (const g of grams) seen.set(g, (seen.get(g) ?? 0) + 1); // counted once per video
  }
  return [...seen].filter(([g, c]) => c >= 2 && g.length > 2).sort((a, b) => b[1] - a[1] || b[0].split(' ').length - a[0].split(' ').length)
    .slice(0, limit).map(([g]) => g);
}

export async function keywords(db, recipe, { now = Date.now(), fetchImpl = fetch } = {}) {
  const row = db.prepare('SELECT fetched_at, data FROM keyword_cache WHERE niche_id = ?').get(recipe.id);
  if (row && now - Date.parse(row.fetched_at) < WEEK) return JSON.parse(row.data);
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return row ? JSON.parse(row.data) : null; // no key: stale cache or nothing
  const q = recipe.metadata?.search ?? recipe.name;
  const get = async url => {
    const r = await fetchImpl(url, { headers: { 'X-Goog-Api-Key': key } }); // key in a header, never in the URL
    if (!r.ok) throw new Error(`YouTube API ${r.status}`);
    return r.json();
  };
  try {
    const s = await get(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=25&order=relevance&videoDuration=long&relevanceLanguage=en&q=${encodeURIComponent(q)}`);
    const ids = s.items.map(i => i.id.videoId).join(',');
    const v = await get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids}`);
    const videos = v.items.map(i => ({ title: i.snippet.title, tags: i.snippet.tags ?? [], views: +(i.statistics.viewCount ?? 0) }))
      .sort((a, b) => b.views - a.views);
    const data = { query: q, top_titles: videos.slice(0, 10).map(x => x.title), keywords: phrases(videos) };
    db.prepare('INSERT INTO keyword_cache (niche_id, fetched_at, data) VALUES (?, ?, ?) ON CONFLICT(niche_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data')
      .run(recipe.id, new Date(now).toISOString(), JSON.stringify(data));
    return data;
  } catch {
    return row ? JSON.parse(row.data) : null; // research is optional; a failed refresh keeps the old cache
  }
}

// --- the LLM, through the magenta engine ---

function chat(messages, { timeoutMs = 120_000 } = {}) {
  // node:http rather than fetch: engine calls can outlast fetch's 300 s header timeout.
  const body = JSON.stringify({ model: MODEL(), messages, max_tokens: 2048, temperature: 0.8 }); // thinking models need room
  return new Promise((resolve, reject) => {
    const req = http.request(`${ENGINE()}/v1/chat/completions`, { method: 'POST', timeout: timeoutMs,
      headers: { Authorization: `Bearer ${ENGINE_KEY()}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => (d += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`magenta engine ${res.statusCode}`));
        try { resolve(JSON.parse(d).choices[0].message.content); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('magenta engine timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function describe(plan) {
  const r = plan.recipe, amb = r.ambience;
  const sounds = amb ? [amb.bed, ...(amb.events ?? []).map(e => e.type)].map(s => s.replace(/-/g, ' ')) : [];
  return {
    niche: r.name, format: r.format, length: lengthLabel(plan.duration), exact_length: hms(plan.duration),
    music: r.music ? words(r.music) : [], sounds, scene: r.metadata?.scene ?? r.visual.replace(/-/g, ' '),
    motion: plan.visual.effects ? Object.keys(plan.visual.effects) : [], audience: r.metadata?.audience,
  };
}

export function prompt(plan, research, shorts) {
  const d = describe(plan);
  return [
    { role: 'system', content: 'You write YouTube metadata for long ambient and music videos. Answer with one JSON object and nothing else.' },
    { role: 'user', content: `Video: ${JSON.stringify(d)}
${research ? `Phrases people search for, from popular similar videos: ${research.keywords.join(', ')}
Popular titles in this niche, for style only (never copy): ${research.top_titles.slice(0, 6).join(' | ')}` : 'No keyword research is available.'}

Return: {"title": string, "thumbnail_text": string, "description": string, "tags": [string], "short_titles": [string x ${shorts}]}
Rules:
- title: at most 90 characters; include "${d.length}"; evocative and specific to the scene and sounds; at most one emoji; no clickbait, no ALL CAPS, no claims of health effects or of a live band.
- thumbnail_text: 2 to 4 words that read well big on a thumbnail, no punctuation, no length.
- description: 2 short paragraphs (under 700 characters in total) inviting people to study, work, relax or sleep to it; honest and warm; no timestamps, links, hashtags or tracklists (those are added separately).
- tags: 15 to 25 lowercase search phrases, most relevant first, using the searched phrases where they fit.
- short_titles: ${shorts} titles for vertical Shorts cut from this video, each under 70 characters, each ending with " #shorts".` },
  ];
}

// --- validation and templates ---

function fitTags(list) {
  const out = [];
  let used = 0;
  for (const raw of list) {
    const t = clean(raw).toLowerCase().replace(/[,#"]/g, '');
    if (!t || t.length > 60 || out.includes(t)) continue;
    const cost = t.length + (t.includes(' ') ? 2 : 0) + (out.length ? 1 : 0);
    if (used + cost > TAGS_MAX) break;
    out.push(t);
    used += cost;
  }
  return out;
}

export function templates(plan, research, shorts) {
  const d = describe(plan), r = plan.recipe;
  const music = d.music.map(titleCase).join(' & '), sounds = d.sounds.map(titleCase).join(', ');
  const what = r.format === 'playlist' ? `${music} Music` : r.format === 'ambience' ? `${sounds} Sounds` : `${music} Music with ${sounds} Sounds`;
  return {
    title: `${r.name} · ${d.length} of ${what}`.slice(0, TITLE_MAX),
    thumbnail_text: r.name,
    description: `${d.length} of ${what.toLowerCase()} to study, work, relax or sleep to.\n\nPut it on in the background and let the ${d.scene} set the mood.`,
    tags: [r.name, ...d.music.map(m => `${m} music`), ...d.sounds.map(s => `${s} sounds`), ...(research?.keywords ?? []), 'ambience', 'relaxing music', 'study music'],
    short_titles: Array.from({ length: shorts }, () => `${r.name} #shorts`),
  };
}

// Keep each LLM field that passes its check; replace the rest with the template's.
export function validate(llm, fallback, shorts) {
  const out = {}, used = {};
  const pick = (k, ok, value) => { if (ok) { out[k] = value; used[k] = 'llm'; } else { out[k] = fallback[k]; used[k] = 'template'; } };
  const title = clean(llm?.title);
  pick('title', title.length >= 10 && title.length <= TITLE_MAX, title);
  const thumb = clean(llm?.thumbnail_text).replace(/[.!?,:;]/g, '');
  pick('thumbnail_text', thumb.length > 0 && thumb.length <= 32 && thumb.split(/\s+/).length <= 5, thumb);
  const desc = clean(llm?.description).replace(/#\w+/g, '').trim();
  pick('description', desc.length >= 80 && desc.length <= 1500, desc);
  const tags = Array.isArray(llm?.tags) ? llm.tags : [];
  pick('tags', tags.length >= 5, tags);
  const st = Array.isArray(llm?.short_titles) ? llm.short_titles.map(clean).filter(t => t.length >= 8 && t.length <= 100) : [];
  pick('short_titles', st.length >= shorts, st.slice(0, shorts).map(t => (/#shorts/i.test(t) ? t : `${t} #shorts`)));
  out.tags = fitTags(out.tags);
  return { fields: out, used };
}

// --- the description around the LLM's words ---

const stamp = s => { const t = hms(s); return t.startsWith('00:') ? t.slice(3).replace(/^0/, '') : t.replace(/^0/, ''); };

export function assemble(plan, fields) {
  const parts = [fields.description];
  const ch = plan.music?.chapters ?? [];
  if (ch.length) parts.push(['Tracklist', ...ch.map(c => `${stamp(c.at)} ${c.title.replace(/^.* – /, '')}`)].join('\n'));
  const credits = plan.credits ?? [];
  const required = [...new Set(credits.filter(c => c.attribution_required).map(c => c.text))];
  const others = [...new Set(credits.filter(c => !c.attribution_required).map(c => plan.sources?.[c.source_id]?.name ?? c.source_id))];
  const credit = [...(required.length ? ['Music credits:', ...required] : []), ...(others.length ? [`Sources: ${others.join(', ')}.`] : [])];
  if (credit.length) parts.push(credit.join('\n'));
  if (credits.some(c => plan.sources?.[c.source_id]?.ai_generated)) parts.push('Music and visuals in this video were created with AI tools.');
  parts.push(fields.tags.slice(0, 3).map(t => `#${t.replace(/\s+/g, '')}`).join(' '));
  let text = parts.filter(Boolean).join('\n\n');
  if (text.length > DESC_MAX) text = text.slice(0, DESC_MAX - 1).replace(/\s+\S*$/, '') + '…';
  return text;
}

// Everything for one render. `llm` is injectable for tests.
export async function metadata(db, plan, { shorts = 2, llm = chat, log = () => {} } = {}) {
  const research = await keywords(db, plan.recipe).catch(() => null);
  const fallback = templates(plan, research, shorts);
  let parsed = null;
  try {
    const text = await llm(prompt(plan, research, shorts));
    parsed = JSON.parse(String(text).replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1'));
  } catch (e) {
    log(`metadata: magenta engine unavailable or unreadable (${e.message}); using templates`);
  }
  const { fields, used } = validate(parsed, fallback, shorts);
  return {
    title: fields.title, thumbnail_text: fields.thumbnail_text, description: assemble(plan, fields), tags: fields.tags,
    shorts: fields.short_titles.map((t, i) => ({ file: `short-${i + 1}.mp4`, title: t.slice(0, TITLE_MAX),
      description: `${fields.title}\nThe full video is on the channel.\n\n${fields.tags.slice(0, 3).map(x => `#${x.replace(/\s+/g, '')}`).join(' ')} #shorts` })),
    fields_from: used, model: parsed ? MODEL() : null, research_query: research?.query ?? null,
    generated_at: new Date().toISOString(),
  };
}
