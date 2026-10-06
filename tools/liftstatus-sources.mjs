// Which European ski areas have a live lift status source, and which one.
// Writes data/liftstatus/sources.json, read by tools/liftstatus-europe.mjs
// (which fetches the status every 30 minutes) and by tools/build-areas.mjs
// (which marks those areas in the app's area list), plus report.md.
//
//   node tools/build-areas.mjs --europe --out build/europe
//   node tools/liftstatus-sources.mjs [--areas build/europe] [--out data/liftstatus]
//
// Needs cheerio. Runs weekly in GitHub Actions (.github/workflows/liftstatus-sources.yml).
//
// Candidate sources come from:
// 1. each area's own website (from OpenSkiData): the home page and a few
//    lift-status-looking links on it, searched for Intermaps maps, Lumiplan
//    stations, Infosnow pages and Micado sites;
// 2. Intermaps maps guessed from area and village names;
// 3. every Infosnow page id up to INFOSNOW_MAX;
// 4. Lumiplan stations: known ones and guesses from area and village names;
// 5. Micado: the site's "sgm." client with a few region guesses.
// A source belongs to the area whose lift names it matches best
// (liftmatch.js); an area keeps its sources when together they cover at
// least MIN_SHARE % of its named lifts. When a source cannot be read this
// time, the area keeps what it had.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import * as cheerio from 'cheerio';
import { download, readFeatures } from './lib/openskidata.mjs';
import { get, readSource, sourceLabel, sourceHost } from './lib/liftstatus-providers.mjs';

vm.runInThisContext(readFileSync(new URL('../liftmatch.js', import.meta.url), 'utf8'));
const { liftNameKey, matchShare } = globalThis;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc, []));
const AREAS = args.areas || 'build/europe';
const OUT = args.out || 'data/liftstatus';
const CACHE = process.env.OSD_CACHE || '/tmp/openskidata';
const INFOSNOW_MAX = Number(process.env.INFOSNOW_MAX || 400);
const MIN_SHARE = 75;
mkdirSync(OUT, { recursive: true });
const started = Date.now();
const log = (...a) => console.log(`[${Math.round((Date.now() - started) / 1000)}s]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ── Our areas ────────────────────────────────────────────────────────────────

const index = JSON.parse(readFileSync(`${AREAS}/index.json`, 'utf8'));
const buildReport = JSON.parse(readFileSync(`${AREAS}/report.json`, 'utf8'));
const areas = index.map(meta => {
  const file = `${AREAS}/areas/${meta.id}.json`;
  const area = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { liften: [] };
  const lifts = area.liften.map(l => ({ liftNr: l.liftNr, naam: l.naam || '', type: l.type }));
  const words = new Set(lifts.flatMap(l => liftNameKey(l.naam).words));
  return { ...meta, osd: buildReport[meta.id]?.osd || [], lifts, words };
});
log(`${areas.length} areas`);

const websites = new Map();
for await (const f of readFeatures(await download('ski_areas.geojson', CACHE))) {
  const p = f.properties || {};
  if (p.websites?.length) websites.set(p.id, p.websites);
}

const previous = existsSync(`${OUT}/sources.json`) ? JSON.parse(readFileSync(`${OUT}/sources.json`, 'utf8')).areas || {} : {};

// ── Candidates ───────────────────────────────────────────────────────────────

const candidates = new Map(); // label -> { source, hint }
const add = (source, hint = null) => {
  const label = sourceLabel(source);
  if (!candidates.has(label)) candidates.set(label, { source, hint });
  else if (hint && !candidates.get(label).hint) candidates.get(label).hint = hint;
};
Object.entries(previous).forEach(([id, a]) => a.sources.forEach(s => add(s, id)));

// 1. Websites.
const STATUS_LINK = /lift|anlage|remont|pistes|impiant|status|bergbahn|seilbahn|open|ouvert|offen|aperti|bulletin|snow.?report|schnee/i;
const PROVIDER_HINT = /intermaps|lumiplan|infosnow|micado|skigebietemanager/i;
async function scanWebsite(area) {
  const urls = [...new Set(area.osd.flatMap(id => websites.get(id) || []))].filter(u => /^https?:/.test(u)).slice(0, 2);
  const queue = [...urls];
  const seen = new Set();
  let pages = 0;
  while (queue.length && pages < 5) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const page = await get(url, { timeout: 15000 });
    if (!page.ok) continue;
    pages++;
    const text = page.text.replace(/&amp;/g, '&');
    for (const m of text.matchAll(/https:\/\/(winter|skiarlberg|zillertal)\.intermaps\.com\/([\w%ß-]+)/g)) {
      if (!/_hike$/.test(m[2])) add({ provider: 'intermaps', project: `https://${m[1]}.intermaps.com/${m[2]}` }, area.id);
    }
    if (/lumiplan/i.test(text)) for (const m of text.matchAll(/station=([\w-]+)/g)) add({ provider: 'lumiplan', station: m[1] }, area.id);
    if (/infosnow/i.test(text)) for (const m of text.matchAll(/pid=(\d+)/g)) add({ provider: 'infosnow', pid: Number(m[1]) }, area.id);
    if (/micadoweb|micado\.webengine|skigebietemanager/i.test(text)) {
      const origin = new URL(page.url).origin;
      const host = new URL(origin).hostname.replace(/^www\./, '');
      const label = host.split('.').slice(-2, -1)[0];
      const clients = [...new Set([...text.matchAll(/https?:\/\/sgm\.[\w.-]+/g)].map(m => m[0]).concat(`https://sgm.${host}`))].slice(0, 2);
      const regions = [...new Set([label, label.replace(/-/g, ''), area.id.replace(/-[a-z]{2}(-\d+)?$/, '').split('-')[0], area.id.replace(/-[a-z]{2}(-\d+)?$/, '')])];
      for (const client of clients) for (const region of regions) add({ provider: 'micado', base: origin, client, region }, area.id);
    }
    if (pages === 1) {
      const $ = cheerio.load(page.text);
      const host = new URL(page.url).hostname.replace(/^www\./, '');
      const links = [];
      $('a[href]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href || !(STATUS_LINK.test(href) || STATUS_LINK.test($(a).text()))) return;
        try {
          const abs = new URL(href, page.url);
          if (!/^https?:$/.test(abs.protocol)) return;
          if (abs.hostname.replace(/^www\./, '') !== host && !PROVIDER_HINT.test(abs.href)) return;
          links.push(abs.href.split('#')[0]);
        } catch {}
      });
      const score = u => (/lift.?status|liftstatus|remontees|anlagen|impianti|lifts?-|lifte|open/i.test(u) ? 2 : 0) + (/pistes|status/i.test(u) ? 1 : 0);
      queue.push(...[...new Set(links)].sort((a, b) => score(b) - score(a)).slice(0, 4));
    }
  }
}
log('Area websites…');
await pool(areas, 8, scanWebsite);

// 2. Intermaps guesses, 4. Lumiplan guesses.
const base = name => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[,/(–]| - /)[0].trim();
const KNOWN_LUMIPLAN = ['meribel', 'courchevel', 'lesmenuires', 'valthorens', 'tignes', 'valdisere', 'laplagne', 'la-plagne', 'lesarcs', 'les-arcs',
  'larosiere', 'chamonix', 'megeve', 'morzine', 'avoriaz', 'montgenevre', 'alpedhuez', 'les2alpes', 'serrechevalier', 'vars', 'risoul',
  'flaine', 'lesgets', 'valmorel', 'lasaisies', 'lesorres', 'superdevoluy', 'peyragudes', 'saintlary', 'lamongie', 'font-romeu', 'orcieres'];
KNOWN_LUMIPLAN.forEach(station => add({ provider: 'lumiplan', station }));
for (const a of areas) {
  for (const name of [a.name, ...a.places.slice(0, 2)]) {
    const b = base(name);
    if (b.length < 3) continue;
    if (['AT', 'DE', 'CH', 'IT', 'LI', 'SI', 'FR'].includes(a.country)) {
      add({ provider: 'intermaps', project: `https://winter.intermaps.com/${b.replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}` });
    }
    if (['FR', 'CH', 'IT', 'ES', 'AD', 'BE'].includes(a.country)) {
      add({ provider: 'lumiplan', station: b.replace(/[^a-z0-9]/g, '') });
      add({ provider: 'lumiplan', station: b.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') });
    }
  }
}
// 3. Infosnow.
for (let pid = 1; pid <= INFOSNOW_MAX; pid++) add({ provider: 'infosnow', pid });
// 5. Micado: SkiWelt is known.
add({ provider: 'micado', base: 'https://www.skiwelt.at', client: 'https://sgm.skiwelt.at', region: 'skiwelt' }, 'skiwelt-wilder-kaiser-brixental-at');
log(`${candidates.size} candidate sources`);

// ── Read every candidate ─────────────────────────────────────────────────────

const read = new Map(); // label -> { source, hint, lifts } (only sources with lifts)
const failed = new Set();
await pool([...candidates], 4, async ([label, c]) => {
  try {
    const { lifts } = await readSource(c.source);
    if (lifts.length) read.set(label, { ...c, lifts });
  } catch { failed.add(label); }
  await sleep(c.source.provider === 'infosnow' ? 250 : 120);
});
log(`${read.size} sources with lifts (${failed.size} could not be read)`);

// ── Match sources to areas ───────────────────────────────────────────────────

// Candidate areas share at least three lift-name words with the source;
// the best full match wins.
const byArea = new Map(); // area id -> [{ label, source, lifts, share }]
for (const [label, s] of read) {
  const words = new Set(s.lifts.flatMap(l => liftNameKey(l.n).words));
  const near = areas.map(a => ({ a, shared: [...words].filter(w => a.words.has(w)).length }))
    .filter(x => x.shared >= 3 || x.a.id === s.hint).sort((x, y) => y.shared - x.shared).slice(0, 6);
  let best = null;
  for (const { a } of near) {
    const share = matchShare(a.lifts, s.lifts);
    if (!best || share > best.share) best = { a, share };
  }
  if (!best || best.share < 20) continue;
  if (!byArea.has(best.a.id)) byArea.set(best.a.id, []);
  byArea.get(best.a.id).push({ label, source: s.source, lifts: s.lifts, share: best.share });
}

// Per area: the best source, plus any other that raises the share (Paradiski
// is two Lumiplan stations).
const result = {};
const report = [];
for (const a of areas) {
  const found = (byArea.get(a.id) || []).sort((x, y) => y.share - x.share);
  let chosen = [], lifts = [], share = 0;
  for (const f of found) {
    const s = matchShare(a.lifts, [...lifts, ...f.lifts]);
    if (s > share + 2) { chosen.push(f); lifts = [...lifts, ...f.lifts]; share = s; }
  }
  const prev = previous[a.id];
  if (share >= MIN_SHARE) {
    result[a.id] = { name: a.name, country: a.country, share, bron: [...new Set(chosen.map(f => sourceHost(f.source)))].join(', '), sources: chosen.map(f => f.source) };
  } else if (prev && prev.sources.some(s => failed.has(sourceLabel(s)))) {
    result[a.id] = prev; // could not be read this time
  }
  if (found.length) report.push({ a, chosen: chosen.length ? chosen : found.slice(0, 1), share: share || found[0].share, kept: !!result[a.id] });
}

// ── Write ────────────────────────────────────────────────────────────────────

const ids = Object.keys(result).sort();
writeFileSync(`${OUT}/sources.json`, JSON.stringify({
  updated: new Date().toISOString().slice(0, 10),
  minShare: MIN_SHARE,
  areas: Object.fromEntries(ids.map(id => [id, result[id]])),
}, null, 1) + '\n');

const countries = ids.reduce((acc, id) => { acc[result[id].country] = (acc[result[id].country] || 0) + 1; return acc; }, {});
const providers = ids.reduce((acc, id) => { result[id].sources.forEach(s => { acc[s.provider] = (acc[s.provider] || 0) + 1; }); return acc; }, {});
const md = [
  '# Live lift status: sources', '',
  `Run ${new Date().toISOString().slice(0, 16)} UTC, ${Math.round((Date.now() - started) / 60000)} min. ${candidates.size} candidate sources, ${read.size} with lifts.`, '',
  `**${ids.length} areas with live lift status** (at least ${MIN_SHARE} % of their named lifts matched).`, '',
  `- Per country: ${Object.entries(countries).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}`,
  `- Per provider: ${Object.entries(providers).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(', ')}`, '',
  '| Area | Country | Source | Match | Live |', '|---|---|---|---:|---|',
  ...report.sort((x, y) => y.share - x.share).map(r =>
    `| ${r.a.name} | ${r.a.country} | ${r.chosen.map(c => c.label).join(' + ')} | ${r.share} % | ${r.kept ? 'yes' : 'no'} |`),
];
writeFileSync(`${OUT}/report.md`, md.join('\n') + '\n');
log(`${ids.length} areas with live lift status: ${JSON.stringify(countries)} ${JSON.stringify(providers)}`);
