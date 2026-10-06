// Builds ski area datasets (format 2) from OpenSkiData and writes a
// validation report per area.
//
//   node tools/build-areas.mjs [--out build] [--only kitzski]   areas in the config
//   node tools/build-areas.mjs --europe [--out build/europe]   every European ski area
//
// Which areas: tools/build-areas.config.json lists hand-picked ones, each with
// its OpenSkiData ski area ids (`osd`). With --europe every operating downhill
// ski area in a European country is built, and kept when it has at least
// MIN_LIFTS lifts and MIN_KM km of pistes. Areas in the config keep their id
// there (e.g. "kitzski"); others get one from their name and country.
// Hand-made additions (bus links, names, …) live in overrides/<id>.json and
// are merged in on every build, so a rebuild never loses them.
//
// Output: <out>/areas/<id>.json (with --europe; else <out>/<id>.json),
// <out>/index.json (one line per area for the area picker), <out>/report.json
// and <out>/report.md.
//
// Runs in GitHub Actions (.github/workflows/build-areas.yml): cloud sessions
// cannot reach OpenSkiData.

import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, rmSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { compileArea, validate } from './lib/compile-area.mjs';
import { download, readFeatures, skiAreaIds, toLift, toRuns } from './lib/openskidata.mjs';

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const MIN_LIFTS = 5;
const MIN_KM = 10;
// European countries (ISO 3166-1 alpha-2), incl. Turkey, Georgia and Russia,
// which all have ski areas OpenSkiData lists.
const EUROPE = new Set(('AD AL AM AT AZ BA BE BG BY CH CY CZ DE DK EE ES FI FR GB GE GR HR HU IE IS IT ' +
  'LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM TR UA XK').split(' '));

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc, []));
const EUROPE_MODE = !!args.europe;
const OUT = args.out || (EUROPE_MODE ? 'build/europe' : 'build');
const AREA_DIR = EUROPE_MODE ? `${OUT}/areas` : OUT;
const CACHE = process.env.OSD_CACHE || '/tmp/openskidata';
const SPILL = `${CACHE}/spill`;
const SAMPLE = new Set(String(args.sample || '').split(',').filter(Boolean)); // also copy these to <out>/sample/
mkdirSync(AREA_DIR, { recursive: true });
mkdirSync(CACHE, { recursive: true });
rmSync(SPILL, { recursive: true, force: true });
mkdirSync(SPILL, { recursive: true });

const config = JSON.parse(readFileSync('tools/build-areas.config.json', 'utf8'));
const configured = config.areas.filter(a => !args.only || a.id === args.only);
const configByOsd = new Map(configured.flatMap(a => (a.osd || []).map(osd => [osd, a])));

// 1. Ski areas: which OpenSkiData areas to build, under which id.
console.log('Reading ski areas…');
const areaFile = await download('ski_areas.geojson', CACHE);
const osdToArea = new Map();          // OpenSkiData id -> our id
const areas = new Map();              // our id -> { id, name, country, region, osd: [] }
const usedIds = new Set(configured.map(a => a.id));
let unnamed = 0;
for await (const f of readFeatures(areaFile)) {
  const p = f.properties || {};
  const place = (p.places || [])[0] || {};
  const country = place.iso3166_1Alpha2 || null;
  const cfg = configByOsd.get(p.id);
  let id;
  if (cfg) id = cfg.id;
  else if (EUROPE_MODE && EUROPE.has(country) && (p.activities || []).includes('downhill')
           && (!p.status || p.status === 'operating')) {
    if (!p.name) { unnamed++; continue; }
    id = uniqueId(`${slug(p.name)}-${country.toLowerCase()}`);
  } else continue;
  osdToArea.set(p.id, id);
  if (!areas.has(id)) areas.set(id, { id, name: cfg?.name || p.name, country, region: place.localized?.en?.region || null, osd: [], places: new Set(), listed: cfg?.listed !== false });
  areas.get(id).osd.push(p.id);
  // Villages and regions, so the area picker also finds "Selva" or "Davos".
  for (const pl of p.places || []) {
    const en = pl.localized?.en || {};
    for (const name of [en.locality, en.region]) if (name) areas.get(id).places.add(name);
  }
}
console.log(`- ${areas.size} ski areas to build${EUROPE_MODE ? ` (${unnamed} unnamed skipped)` : ''}`);

// 2. Lifts and runs, streamed once, spilled to one file per area so all of
//    Europe never has to sit in memory at once.
const buffers = new Map();
let buffered = 0;
const flush = () => {
  for (const [id, lines] of buffers) appendFileSync(`${SPILL}/${id}.ndjson`, lines.join('\n') + '\n');
  buffers.clear();
  buffered = 0;
};
const spill = (id, kind, item) => {
  const line = JSON.stringify([kind, item]);
  if (!buffers.has(id)) buffers.set(id, []);
  buffers.get(id).push(line);
  buffered += line.length;
  if (buffered > 64e6) flush();
};
for (const [name, convert] of [['lifts.geojson', f => { const l = toLift(f); return l ? [['l', l]] : []; }],
                               ['runs.geojson', f => toRuns(f).map(r => ['r', r])]]) {
  console.log(`Reading ${name}…`);
  const file = await download(name, CACHE);
  for await (const f of readFeatures(file)) {
    const ids = new Set(skiAreaIds(f).map(id => osdToArea.get(id)).filter(Boolean));
    if (!ids.size) continue;
    const items = convert(f);
    for (const id of ids) for (const [kind, item] of items) spill(id, kind, item);
  }
  flush();
}

// 3. Compile each area, merge overrides, write.
const reports = {};
const index = [];
let skipped = 0;
for (const meta of areas.values()) {
  const input = await readSpill(meta.id);
  if (!input) { skipped++; continue; }
  const overrides = existsSync(`overrides/${meta.id}.json`) ? JSON.parse(readFileSync(`overrides/${meta.id}.json`, 'utf8')) : {};
  const { area, diagnostics } = compileArea(input, {
    id: meta.id,
    name: overrides.name || meta.name || meta.id,
    subtitle: overrides.subtitle || [meta.region, countryNames.of(meta.country)].filter(Boolean).join(', '),
    bron: `OpenSkiData (OpenStreetMap) ${meta.osd.join(', ')}, ${new Date().toISOString().slice(0, 10)}`,
  });
  applyOverrides(area, overrides);
  if (!area.liften.length) { skipped++; continue; }
  const report = validate(area);
  // Too small to be worth routing in (Europe build only; configured areas always stay).
  if (EUROPE_MODE && !configured.some(a => a.id === meta.id) && (report.lifts < MIN_LIFTS || report.pistesKm < MIN_KM)) {
    skipped++;
    continue;
  }
  const quality = overrides.reviewed ? 'gecontroleerd' : report.quality;
  // In the app's area list? Not ski passes made of several separate domains
  // (a second part at least a quarter the size of the first), nor areas where
  // under half the lifts connect; 50–75 % connected is shown with a warning.
  const [first = 0, second = 0] = report.domains;
  const listing = !meta.listed ? 'curated elsewhere'
    : (second >= 3 && second >= first / 4) ? 'hidden: several separate domains'
    : report.connectedShare < 50 ? 'hidden: under half the lifts connected'
    : report.connectedShare < 75 && !overrides.reviewed ? 'deels' : 'ok';
  const why = Object.fromEntries(report.outsideMainNetwork.map(nr =>
    [nr, [diagnostics[`${nr}-onder`], diagnostics[`${nr}-boven`]].filter(Boolean).join('; ') || 'runs attached, but no way into or out of the main network']));
  reports[meta.id] = { name: area.name, country: meta.country, region: meta.region, ...report, quality, listing,
    why, osd: meta.osd, inputLifts: input.lifts.length, inputRuns: input.runs.length };
  if (SAMPLE.has(meta.id)) { mkdirSync(`${OUT}/sample`, { recursive: true }); writeFileSync(`${OUT}/sample/${meta.id}.json`, JSON.stringify(area) + '\n'); }
  if (EUROPE_MODE && listing !== 'ok' && listing !== 'deels') continue;
  writeFileSync(`${AREA_DIR}/${meta.id}.json`, JSON.stringify(area) + '\n');
  const centre = area.liften.reduce((c, l) => [c[0] + l.coordOnder[0], c[1] + l.coordOnder[1]], [0, 0]).map(v => +(v / area.liften.length).toFixed(4));
  index.push({ id: meta.id, name: area.name, country: meta.country, region: (meta.region || '').replace(/[<>"`]/g, '') || null,
    places: [...meta.places].filter(n => n !== meta.region).map(n => n.replace(/[<>"`]/g, '')).slice(0, 8), centre,
    liften: report.lifts, pistesKm: report.pistesKm, hoogte: area.stats.hoogte,
    status: listing === 'deels' ? 'deels' : 'ok', file: `data/europe/areas/${meta.id}.json` });
  if (!EUROPE_MODE) console.log(`- ${meta.id}: ${JSON.stringify(reports[meta.id])}`);
}
rmSync(SPILL, { recursive: true, force: true });
index.sort((a, b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name));
writeFileSync(`${OUT}/index.json`, JSON.stringify(index) + '\n');
writeFileSync(`${OUT}/report.json`, JSON.stringify(reports, null, 1) + '\n');
writeFileSync(`${OUT}/report.md`, summary(reports, skipped));
console.log(`Built ${Object.keys(reports).length} areas (${index.length} listed), skipped ${skipped} (too small or empty).`);

// ── helpers ──────────────────────────────────────────────────────────────────

async function readSpill(id) {
  const file = `${SPILL}/${id}.ndjson`;
  if (!existsSync(file)) return null;
  const input = { lifts: [], runs: [] };
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const [kind, item] = JSON.parse(line);
    (kind === 'l' ? input.lifts : input.runs).push(item);
  }
  return input.lifts.length ? input : null;
}

function slug(name) {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'area';
}

function uniqueId(base) {
  let id = base, n = 2;
  while (usedIds.has(id)) id = `${base}-${n++}`;
  usedIds.add(id);
  return id;
}

// The review summary: how many areas per quality and per country, the
// biggest ones, and the biggest ones with gaps.
function summary(reports, skipped) {
  const rows = Object.entries(reports).map(([id, r]) => ({ id, ...r }));
  const by = (key) => rows.reduce((m, r) => (m[r[key]] = (m[r[key]] || 0) + 1, m), {});
  const quality = by('quality');
  const countries = Object.entries(by('country')).sort((a, b) => b[1] - a[1]);
  const big = [...rows].sort((a, b) => b.pistesKm - a.pistesKm);
  const line = r => `| ${r.name} | ${r.country} | ${r.lifts} | ${r.pistesKm} | ${r.connectedShare}% | ${r.domains.join('+') || '-'} | ${r.quality} | ${r.outsideMainNetwork.slice(0, 6).join(' ')}${r.outsideMainNetwork.length > 6 ? ' …' : ''} |`;
  const head = '| Area | Country | Lifts | km | Connected | Parts | Label | Lifts outside the main network |\n|---|---|---|---|---|---|---|---|';
  const causes = {};
  rows.forEach(r => Object.values(r.why || {}).forEach(w => {
    const k = /no run within/.test(w) ? 'no run within 500 m of a station'
      : /filtered by elevation/.test(w) ? 'run nearby but at another level'
      : /nearest run/.test(w) ? 'nearest run 80–500 m from a station'
      : 'runs attached, no way into/out of the main network';
    causes[k] = (causes[k] || 0) + 1;
  }));
  const shares = rows.map(r => r.connectedShare).sort((a, b) => a - b);
  const pct = f => shares[Math.floor(shares.length * f)] ?? '-';
  return [
    `# Europe build — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Built **${rows.length}** ski areas (at least ${MIN_LIFTS} lifts and ${MIN_KM} km of pistes); ${skipped} smaller or empty areas left out.`,
    '',
    `Labels: ${Object.entries(quality).map(([k, v]) => `**${k}** ${v}`).join(' · ')}`,
    '',
    `Share of lift stations that can all reach each other: p10 ${pct(0.1)}% · median ${pct(0.5)}% · p90 ${pct(0.9)}%`,
    '',
    `Per country: ${countries.map(([c, n]) => `${c} ${n}`).join(' · ')}`,
    '',
    `Why lifts fall outside their area's main network: ${Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · ')}`,
    '',
    `Areas made of several separate parts (ski passes covering several domains): ${rows.filter(r => r.domains.length > 1).length}`,
    '',
    `In the app: ${Object.entries(by('listing')).map(([k, v]) => `**${k}** ${v}`).join(' · ')}`,
    '',
    '## The 40 biggest areas',
    '',
    head,
    ...big.slice(0, 40).map(line),
    '',
    '## The 25 biggest areas with gaps (label onvolledig)',
    '',
    head,
    ...big.filter(r => r.quality === 'onvolledig').slice(0, 25).map(line),
    '',
  ].join('\n');
}

// overrides/<id>.json:
//   { "name", "subtitle", "reviewed": true,
//     "verbindingen": [...],                 // bus / walking links, as in format 1
//     "liftNrs": { "<OSM ref or generated nr>": "<nr to show>" },
//     "drop": { "lifts": [nr…], "afdalingen": [["A1", "B2"]…] } }
function applyOverrides(area, o) {
  if (o.liftNrs) {
    const rename = nr => o.liftNrs[nr] || nr;
    area.liften.forEach(l => { l.liftNr = rename(l.liftNr); });
    area.afdalingen.forEach(d => { d.van = rename(d.van); d.naar = rename(d.naar); });
    area.overstappen = area.overstappen.map(pair => pair.map(id => id.replace(/^(.*)-(onder|boven)$/, (m, nr, side) => `${rename(nr)}-${side}`)));
  }
  if (o.drop?.lifts) {
    const drop = new Set(o.drop.lifts);
    area.liften = area.liften.filter(l => !drop.has(l.liftNr));
    area.afdalingen = area.afdalingen.filter(d => !drop.has(d.van) && !drop.has(d.naar));
    area.overstappen = area.overstappen.filter(pair => !pair.some(id => drop.has(id.replace(/-(onder|boven)$/, ''))));
  }
  if (o.drop?.afdalingen) {
    const drop = new Set(o.drop.afdalingen.map(p => p.join('>')));
    area.afdalingen = area.afdalingen.filter(d => !drop.has(`${d.van}>${d.naar}`));
  }
  // Hand-made links (e.g. a ski bus) come on top of the generated walks; a
  // hand-made link between the same two stations replaces the walk.
  if (o.verbindingen) {
    const key = v => [v.van, v.naar].sort().join('|');
    const own = new Set(o.verbindingen.map(key));
    area.verbindingen = [...area.verbindingen.filter(v => !own.has(key(v))), ...o.verbindingen];
  }
}
