// Phase 1 of live lift status for Europe: find out which of our ski areas
// publish lift status through a provider we can read, and how well the
// provider's lift names match the OpenStreetMap lifts of the area.
//
//   node tools/build-areas.mjs --europe --out build/europe
//   node tools/probe-liftstatus.mjs [--areas build/europe] [--out data/build/liftstatus]
//
// Needs cheerio (npm install --no-save cheerio). Runs in GitHub Actions
// (.github/workflows/liftstatus-probe.yml); writes probe.json and probe.md,
// plus one sample page per provider for writing the real parsers.
//
// Four ways in:
// 1. The area's own website (from OpenSkiData): the home page and a few
//    lift-status-looking links on it, searched for known providers.
// 2. Infosnow (Switzerland): every page id, 1..INFOSNOW_MAX.
// 3. Lumiplan (France and others): station ids found on websites, known ones,
//    and guesses from area and village names.
// 4. Micado SkigebieteManager (Austria): endpoints found on websites, and the
//    ones we know.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { download, readFeatures } from './lib/openskidata.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc, []));
const AREAS = args.areas || 'build/europe';
const OUT = args.out || 'data/build/liftstatus';
const CACHE = process.env.OSD_CACHE || '/tmp/openskidata';
const INFOSNOW_MAX = Number(process.env.INFOSNOW_MAX || 450);
const UA = 'Mozilla/5.0 (compatible; SkiRouter/1.0; +https://github.com/WillemvanOs/SkiRouter)';
mkdirSync(`${OUT}/samples`, { recursive: true });
const started = Date.now();
const log = (...a) => console.log(`[${Math.round((Date.now() - started) / 1000)}s]`, ...a);

// ── Our areas and their lift names ───────────────────────────────────────────

const index = JSON.parse(readFileSync(`${AREAS}/index.json`, 'utf8'));
const report = JSON.parse(readFileSync(`${AREAS}/report.json`, 'utf8'));
const areas = index.map(meta => {
  const file = `${AREAS}/areas/${meta.id}.json`;
  const area = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { liften: [] };
  const lifts = area.liften.filter(l => l.type !== 'magic_carpet')
    .map(l => ({ nr: l.liftNr, naam: l.naam || '', key: norm(l.naam || '') })).filter(l => l.key);
  return { ...meta, osd: report[meta.id]?.osd || [], lifts };
});
log(`${areas.length} areas, ${areas.reduce((s, a) => s + a.lifts.length, 0)} named lifts`);

// Websites per OpenSkiData area.
const websites = new Map();
for await (const f of readFeatures(await download('ski_areas.geojson', CACHE))) {
  const p = f.properties || {};
  if (p.websites?.length) websites.set(p.id, p.websites);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function get(url, { timeout = 15000, json = false } = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, text };
  } catch (err) {
    return { ok: false, status: 0, url, text: '', error: err.message };
  }
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const samples = new Set();
function saveSample(name, text) {
  if (samples.has(name) || !text) return;
  samples.add(name);
  writeFileSync(`${OUT}/samples/${name}`, text.slice(0, 400000));
}

// ── 1. Websites ──────────────────────────────────────────────────────────────

const FINGERPRINTS = {
  micado:     /micadoweb|micado\.|skigebietemanager/i,
  lumiplan:   /lumiplan/i,
  infosnow:   /infosnow/i,
  intermaps:  /intermaps/i,
  skiplan:    /skiplan/i,
  feratel:    /feratel/i,
  axess:      /axess/i,
  skidata:    /skidata/i,
  bergfex:    /bergfex/i,
  skiresort:  /skiresort\.info/i,
  dolomiti:   /dolomitisuperski/i,
  snowpage:   /snowpage|snow-page/i,
  digitalsnow:/digisnow|digital-snow/i,
};
const STATUS_LINK = /lift|anlage|remont|pistes|impiant|status|bergbahn|seilbahn|open|ouvert|offen|aperti|bulletin|snow.?report|schnee/i;

async function probeWebsite(area) {
  const urls = [...new Set(area.osd.flatMap(id => websites.get(id) || []))].filter(u => /^https?:/.test(u)).slice(0, 2);
  const result = { id: area.id, websites: urls, providers: {}, pages: 0 };
  if (!urls.length) return result;
  const seen = new Set();
  const queue = [...urls];
  while (queue.length && result.pages < 5) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const page = await get(url);
    if (!page.ok) continue;
    result.pages++;
    for (const [name, re] of Object.entries(FINGERPRINTS)) {
      if (!re.test(page.text)) continue;
      const hit = result.providers[name] || (result.providers[name] = { pages: [], ids: [] });
      hit.pages.push(page.url);
      if (name === 'lumiplan') for (const m of page.text.matchAll(/station=([\w-]+)/g)) hit.ids.push(m[1]);
      if (name === 'infosnow') for (const m of page.text.matchAll(/pid=(\d+)/g)) hit.ids.push(m[1]);
      if (name === 'micado') for (const m of page.text.matchAll(/["'(]((?:https?:)?\/\/[^"'()\s]*micadoweb[^"'()\s]*|\/webapi\/micadoweb[^"'()\s]*)/g)) hit.ids.push(new URL(m[1].replace(/&amp;/g, '&'), page.url).href);
      if (name === 'micado') for (const m of page.text.matchAll(/(?:client|region)["']?\s*[:=]\s*["']([\w.:/-]+)["']/g)) hit.ids.push(m[0].slice(0, 120));
      if (name === 'micado') for (const m of page.text.matchAll(/https?:\/\/sgm\.[\w.-]+/g)) hit.ids.push(m[0]);
      if (name === 'micado') hit.origin = hit.origin || new URL(page.url).origin;
      if (name === 'intermaps') for (const m of page.text.matchAll(/https?:\/\/[\w.-]*intermaps[\w.-]*\/[^"'\s<>]*/g)) hit.ids.push(m[0].slice(0, 200));
      saveSample(`site-${name}.html`, page.text);
    }
    if (result.pages === 1) {
      const $ = cheerio.load(page.text);
      const host = new URL(page.url).hostname.replace(/^www\./, '');
      const links = [];
      $('a[href]').each((_, a) => {
        const href = $(a).attr('href');
        const text = $(a).text().trim();
        if (!href || !(STATUS_LINK.test(href) || STATUS_LINK.test(text))) return;
        try {
          const abs = new URL(href, page.url);
          if (!/^https?:$/.test(abs.protocol)) return;
          if (abs.hostname.replace(/^www\./, '') !== host && !Object.values(FINGERPRINTS).some(re => re.test(abs.href))) return;
          links.push(abs.href.split('#')[0]);
        } catch {}
      });
      // Prefer links that look like a lift status page.
      links.sort((a, b) => score(b) - score(a));
      queue.push(...[...new Set(links)].slice(0, 4));
    }
  }
  for (const hit of Object.values(result.providers)) { hit.ids = [...new Set(hit.ids)].slice(0, 10); hit.pages = [...new Set(hit.pages)]; }
  return result;
  function score(u) { return (/lift.?status|liftstatus|remontees|anlagen|impianti|lifts?-|lifte|open/i.test(u) ? 2 : 0) + (/pistes|status/i.test(u) ? 1 : 0); }
}

log('Websites…');
const sites = await pool(areas, 8, probeWebsite);
log(`websites: ${sites.filter(s => s.websites.length).length} areas with a website, ${sites.filter(s => Object.keys(s.providers).length).length} with a known provider`);

// ── 2. Infosnow ──────────────────────────────────────────────────────────────

// The lift block of an Infosnow (APG|SGA) page: a .block whose heading says
// "Lifts (2 from 34 installations in service)", then tables with three cells
// per lift: status icon (…/data/status/8/1.gif: 1 open, 2 in preparation,
// 3 closed), type icon, name.
function parseInfosnow(html) {
  const $ = cheerio.load(html);
  const title = $('title').text().trim();
  const lifts = [];
  $('.block').each((_, block) => {
    if (!/^\s*Lifts\b/.test($(block).children('h1').text())) return;
    $(block).find('.content img.icon[src*="/data/status/"]').each((_, icon) => {
      const cell = $(icon).closest('td');
      const name = cell.next().next().text().trim();
      const code = (/\/(\d)\.gif$/.exec($(icon).attr('src') || '') || [])[1];
      if (name) lifts.push({ name, status: { 1: 'open', 2: 'preparation', 3: 'closed' }[code] || code });
    });
  });
  return { title, lifts };
}

log('Infosnow…');
const infosnow = [];
for (let pid = 1; pid <= INFOSNOW_MAX; pid++) {
  const url = `https://www.infosnow.ch/~apgmontagne/?lang=en&pid=${pid}&tab=web-wi`;
  const page = await get(url);
  if (pid === 1 || pid === 31) saveSample(`infosnow-${pid}.html`, page.text);
  if (page.ok) {
    const parsed = parseInfosnow(page.text);
    if (parsed.lifts.length) infosnow.push({ pid, url, ...parsed });
  } else if (pid <= 3) log(`infosnow pid ${pid}: HTTP ${page.status} ${page.error || ''}`);
  await sleep(250);
}
log(`infosnow: ${infosnow.length} pages with lifts`);

// ── 3. Lumiplan ──────────────────────────────────────────────────────────────

function parseLumiplan(html) {
  const $ = cheerio.load(html);
  const lifts = [];
  // Liftie: '.POI_title:contains(Lifts) + .liaisons .POI_info'; the heading
  // may be in French too.
  $('.POI_title').each((_, t) => {
    if (!/lift|remont/i.test($(t).text())) return;
    $(t).next('.liaisons').find('.POI_info').each((_, info) => {
      if (lifts.length === 0) saveSample('lumiplan-poi.html', $.html(info));
      const raw = $(info).children().eq(1).text().trim().split('\n')[0].trim() || $(info).text().trim().split('\n')[0].trim();
      // The opening time or a remark is glued to the name: "Lys09:30 AM".
      const name = raw.replace(/\d{1,2}:\d{2}\s*(AM|PM)?.*$/i, '').replace(/(Closed|Every|Fermé|Ouvert|Open)\b.*$/i, '').trim();
      const src = $(info).find('img').map((_, i) => $(i).attr('src')).get().find(s => /lp_runway_trail_/.test(s)) || '';
      lifts.push({ name, status: (/lp_runway_trail_(\w+)\.svg/.exec(src) || [])[1] || null });
    });
  });
  return { title: $('title').text().trim(), lifts };
}

const KNOWN_LUMIPLAN = ['meribel', 'courchevel', 'lesmenuires', 'valthorens', 'tignes', 'valdisere', 'laplagne', 'lesarcs', 'larosiere',
  'chamonix', 'megeve', 'morzine', 'avoriaz', 'montgenevre', 'alpedhuez', 'les2alpes', 'serrechevalier', 'vars', 'risoul', 'flaine',
  'lesgets', 'lagrave', 'valmorel', 'lasaisies', 'lesorres', 'superdevoluy', 'peyragudes', 'saintlary', 'lamongie', 'font-romeu', 'orcieres'];
const guesses = new Set(KNOWN_LUMIPLAN);
sites.forEach(s => s.providers.lumiplan?.ids.forEach(id => guesses.add(id)));
for (const a of areas.filter(a => ['FR', 'CH', 'IT', 'ES', 'AD', 'BE'].includes(a.country))) {
  for (const name of [a.name, ...a.places.slice(0, 3)]) {
    const base = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[,/(–-]| - /)[0].trim();
    if (!base || base.length < 3) continue;
    guesses.add(base.replace(/[^a-z0-9]/g, ''));
    guesses.add(base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  }
}
log(`Lumiplan: ${guesses.size} station ids to try`);
const lumiplan = (await pool([...guesses], 4, async station => {
  const url = `https://bulletinv3.lumiplan.pro/bulletin.php?station=${encodeURIComponent(station)}&lang=en`;
  const page = await get(url);
  if (station === 'risoul') saveSample('lumiplan-risoul.html', page.text || `HTTP ${page.status} ${page.error || ''}`);
  await sleep(150);
  if (!page.ok) return null;
  const parsed = parseLumiplan(page.text);
  return parsed.lifts.length ? { station, url, ...parsed } : null;
})).filter(Boolean);
log(`lumiplan: ${lumiplan.length} stations with lifts`);
// Lumiplan's newer app back end, for the record.
for (const u of ['https://bulletinv3.lumiplan.pro/', 'https://www.lumiplan.com/']) {
  const page = await get(u);
  saveSample(`lumiplan-root-${new URL(u).hostname}.html`, page.text || `HTTP ${page.status} ${page.error || ''}`);
}

// ── 4. Micado ────────────────────────────────────────────────────────────────

const MICADO_API = 'SkigebieteManager/Micado.SkigebieteManager.Plugin.FacilityApi/ListFacilities.api';
const micadoCandidates = [
  { base: 'https://www.skiwelt.at', client: 'https://sgm.skiwelt.at', region: 'skiwelt', area: 'skiwelt-wilder-kaiser-brixental-at' },
];
// Sites built on Micado: the lift list sits at <site>/webapi/micadoweb with
// the site's "sgm." host as client and a region name we have to guess.
for (const s of sites) {
  const hit = s.providers.micado;
  if (!hit?.origin) continue;
  const host = new URL(hit.origin).hostname.replace(/^www\./, '');
  const label = host.split('.').slice(-2, -1)[0];
  const clients = [...new Set([...hit.ids.filter(i => /^https?:\/\/sgm\./.test(i)), `https://sgm.${host}`])];
  const regions = [...new Set([label, label.replace(/-/g, ''), s.id.replace(/-at$|-de$|-ch$|-it$/, '').split('-')[0], s.id.replace(/-[a-z]{2}$/, '')])];
  for (const client of clients.slice(0, 2)) for (const region of regions) micadoCandidates.push({ base: hit.origin, client, region, area: s.id });
}
log(`Micado: ${micadoCandidates.length} endpoints to try`);
const micado = (await pool(micadoCandidates, 3, async c => {
  const params = new URLSearchParams({ api: MICADO_API, client: c.client, lang: 'de', region: c.region, season: 'winter', type: 'lift' });
  const url = `${c.base}/webapi/micadoweb?${params}`;
  const page = await get(url, { json: true });
  let data = null;
  try { data = JSON.parse(page.text); } catch {}
  saveSample(`micado-${c.area}.txt`, `${url}\n\n${page.text || `HTTP ${page.status} ${page.error || ''}`}`.slice(0, 20000));
  const lifts = (data?.facilities || []).map(f => ({ name: f.title || f.name || f.identifier, id: f.identifier, status: f.status }));
  return lifts.length ? { ...c, url, lifts } : { ...c, url, lifts: [], error: page.error || `HTTP ${page.status}` };
}));
log(`micado: ${micado.filter(m => m.lifts.length).length}/${micado.length} endpoints with lifts`);

// ── 5. Intermaps, Digisnow, Dolomiti Superski: where does the status come from? ─
//
// No parser yet: save the map pages, the scripts they load and a few likely
// data URLs, to find each one's data feed.

const explore = [];
async function exploreUrl(name, url) {
  const page = await get(url);
  explore.push({ name, url, status: page.status, bytes: page.text.length, json: /^\s*[[{]/.test(page.text), error: page.error });
  saveSample(name, `${url}\n\n${page.text || `HTTP ${page.status} ${page.error || ''}`}`);
  return page;
}
const intermapsProjects = new Map(); // "https://winter.intermaps.com/obertauern" -> area
for (const s of sites) {
  for (const id of s.providers.intermaps?.ids || []) {
    const m = /^(https:\/\/(?:winter|skiarlberg|zillertal)\.intermaps\.com)\/([\w%ß-]+)/.exec(id.replace(/&amp;/g, '&'));
    if (m && !/_hike$/.test(m[2])) intermapsProjects.set(`${m[1]}/${m[2]}`, s.id);
  }
}
log(`Intermaps: ${intermapsProjects.size} map projects`);
let n = 0;
for (const [project] of [...intermapsProjects].slice(0, 4)) {
  const tag = `intermaps-${++n}`;
  const page = await exploreUrl(`${tag}-map.html`, `${project}?lang=en`);
  const scripts = [...page.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => new URL(m[1], page.url || project).href);
  for (const [i, src] of scripts.slice(0, 4).entries()) if (n === 1) await exploreUrl(`${tag}-script${i}.js`, src);
  for (const path of ['data?lang=en', 'data', 'api/data?lang=en', 'json?lang=en', 'status?lang=en']) await exploreUrl(`${tag}-${path.replace(/\W+/g, '_')}.txt`, `${project}/${path}`);
}
await exploreUrl('digisnow-avoriaz.html', 'https://avoriaz.digisnow.app/');
await exploreUrl('digisnow-avoriaz-lifts.html', 'https://avoriaz.digisnow.app/lifts/winter/true/fr');
await exploreUrl('dolomiti-lifts.html', 'https://www.dolomitisuperski.com/en/live-info/lifts');
await exploreUrl('altabadia-lifts.html', 'https://www.altabadia.org/en/winter-holidays/italian-alps/open-lifts-snow-report.html');
await exploreUrl('bergfex-lifte-630.html', 'https://content.bergfex.at/lifte/630/');

// ── Matching ─────────────────────────────────────────────────────────────────

// Lift names compared without accents, punctuation and type words.
function norm(name) {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/\b(telesiege|telesiège|teleski|telecabine|telepherique|telemix|funiculaire|tsd\d*|tsf\d*|tk|tc|tps|tph|tsd|tlc|tm|ts|tb|ski ?lift|chair ?lift|drag ?lift|gondola|cable ?car|sesselbahn|sessellift|schlepplift|gondelbahn|kabinenbahn|seilbahn|pendelbahn|standseilbahn|bahn|lift|express|seggiovia|sciovia|cabinovia|funivia|skilift|sesselift|6er|8er|4er|2er|[0-9]+ ?(er|sk|kb|sb|pb)|ex)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function same(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  const shared = [...ta].filter(t => tb.has(t) && t.length > 1).length;
  return shared / Math.max(ta.size, tb.size) >= 0.6;
}

// The area a provider's lift list belongs to: the one sharing the most lift names.
function bestArea(lifts, hint) {
  const keys = lifts.map(l => norm(l.name || '')).filter(Boolean);
  let best = null;
  for (const area of areas) {
    if (!area.lifts.length) continue;
    const matched = area.lifts.filter(l => keys.some(k => same(k, l.key)));
    if (!matched.length) continue;
    const s = matched.length + (hint === area.id ? 0.5 : 0);
    if (!best || s > best.s) best = { s, area, matched };
  }
  if (!best || best.matched.length < 3) return null;
  return {
    area: best.area.id, name: best.area.name, country: best.area.country,
    ourLifts: best.area.lifts.length, sourceLifts: keys.length, matched: best.matched.length,
    share: Math.round(100 * best.matched.length / best.area.lifts.length),
    unmatchedSource: lifts.map(l => l.name).filter(n => !best.area.lifts.some(l => same(norm(n || ''), l.key))).slice(0, 8),
    unmatchedOurs: best.area.lifts.filter(l => !best.matched.includes(l)).map(l => l.naam).slice(0, 8),
  };
}

const sources = [
  ...infosnow.map(s => ({ provider: 'infosnow', source: `pid ${s.pid}`, title: s.title, lifts: s.lifts })),
  ...lumiplan.map(s => ({ provider: 'lumiplan', source: s.station, title: s.title, lifts: s.lifts })),
  ...micado.filter(m => m.lifts.length).map(m => ({ provider: 'micado', source: `${m.base} ${m.region}`, title: m.region, lifts: m.lifts, hint: m.area })),
].map(s => ({ ...s, match: bestArea(s.lifts, s.hint) }));

// Per area: the best-matching source.
const byArea = new Map();
for (const s of sources) {
  if (!s.match) continue;
  const prev = byArea.get(s.match.area);
  if (!prev || s.match.share > prev.match.share) byArea.set(s.match.area, s);
}

// ── Report ───────────────────────────────────────────────────────────────────

const bucket = share => share >= 75 ? '≥75 %' : share >= 50 ? '50–74 %' : '<50 %';
const providerCount = {};
sites.forEach(s => Object.keys(s.providers).forEach(p => { providerCount[p] = (providerCount[p] || 0) + 1; }));
const covered = [...byArea.values()];
const summary = {
  date: new Date().toISOString(),
  areas: areas.length,
  withWebsite: sites.filter(s => s.websites.length).length,
  websiteProviders: providerCount,
  sources: { infosnow: infosnow.length, lumiplan: lumiplan.length, micado: micado.filter(m => m.lifts.length).length },
  areasWithSource: covered.length,
  byShare: covered.reduce((acc, s) => { const b = bucket(s.match.share); acc[b] = (acc[b] || 0) + 1; return acc; }, {}),
  byCountry: covered.reduce((acc, s) => { acc[s.match.country] = (acc[s.match.country] || 0) + 1; return acc; }, {}),
  minutes: Math.round((Date.now() - started) / 60000),
};
writeFileSync(`${OUT}/probe.json`, JSON.stringify({ summary, sites, sources: sources.map(({ lifts, ...s }) => ({ ...s, liftCount: lifts.length, lifts: lifts.slice(0, 80) })), micado: micado.map(({ lifts, ...m }) => ({ ...m, liftCount: lifts.length })), intermapsProjects: Object.fromEntries(intermapsProjects), explore }, null, 1) + '\n');

const md = [];
md.push('# Live lift status: probe', '', `Run ${summary.date.slice(0, 16)} UTC, ${summary.minutes} min.`, '');
md.push(`- ${summary.areas} listed areas, ${summary.withWebsite} with a website in OpenSkiData`);
md.push(`- Providers seen on area websites: ${Object.entries(providerCount).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(', ') || 'none'}`);
md.push(`- Sources with lifts: Infosnow ${summary.sources.infosnow}, Lumiplan ${summary.sources.lumiplan}, Micado ${summary.sources.micado}`);
md.push(`- **Areas with a matching source: ${summary.areasWithSource}** — share of our lifts matched by name: ${Object.entries(summary.byShare).map(([b, n]) => `${b}: ${n}`).join(', ')}`);
md.push(`- Per country: ${Object.entries(summary.byCountry).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}`, '');
md.push('## Areas with a source', '', '| Area | Country | Provider | Source | Our lifts | Source lifts | Matched | Share |', '|---|---|---|---|---:|---:|---:|---:|');
for (const s of covered.sort((a, b) => b.match.share - a.match.share)) {
  md.push(`| ${s.match.name} | ${s.match.country} | ${s.provider} | ${s.source} | ${s.match.ourLifts} | ${s.match.sourceLifts} | ${s.match.matched} | ${s.match.share} % |`);
}
md.push('', '## Sources without a matching area', '');
for (const s of sources.filter(s => !s.match)) md.push(`- ${s.provider} ${s.source} (${s.title}): ${s.lifts.length} lifts, e.g. ${s.lifts.slice(0, 4).map(l => l.name).join(', ')}`);
md.push('', '## Name mismatches (areas under 75 %)', '');
for (const s of covered.filter(s => s.match.share < 75)) {
  md.push(`- **${s.match.name}** (${s.provider} ${s.source}): source only: ${s.match.unmatchedSource.join(', ') || '–'}; ours only: ${s.match.unmatchedOurs.join(', ') || '–'}`);
}
md.push('', '## Providers on websites', '');
for (const s of sites.filter(s => Object.keys(s.providers).length)) {
  md.push(`- ${s.id}: ${Object.entries(s.providers).map(([p, h]) => `${p}${h.ids.length ? ` (${h.ids.slice(0, 3).join(', ')})` : ''}`).join('; ')}`);
}
writeFileSync(`${OUT}/probe.md`, md.join('\n') + '\n');
log(JSON.stringify(summary));
