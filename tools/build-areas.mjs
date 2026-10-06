// Builds ski area datasets (format 2) from OpenSkiData and writes a
// validation report per area.
//
//   node tools/build-areas.mjs [--out build] [--only kitzski]
//
// Which areas: tools/build-areas.config.json lists them, each with the
// OpenSkiData ski area ids (`osd`) or a name pattern (`match`) to find them
// by. Hand-made additions (bus links, names, …) live in overrides/<id>.json
// and are merged in on every build, so a rebuild never loses them.
//
// Runs in GitHub Actions (.github/workflows/build-areas.yml): cloud sessions
// cannot reach OpenSkiData.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { compileArea, validate } from './lib/compile-area.mjs';
import { download, readFeatures, skiAreaIds, toLift, toRuns } from './lib/openskidata.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc, []));
const OUT = args.out || 'build';
const CACHE = process.env.OSD_CACHE || '/tmp/openskidata';
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

const config = JSON.parse(readFileSync('tools/build-areas.config.json', 'utf8'));
const wanted = config.areas.filter(a => !args.only || a.id === args.only);

// 1. Ski areas: resolve every configured area to OpenSkiData ids.
console.log('Reading ski areas…');
const areaFile = await download('ski_areas.geojson', CACHE);
const osdToArea = new Map();
const osdInfo = new Map();
for await (const f of readFeatures(areaFile)) {
  const p = f.properties || {};
  for (const a of wanted) {
    const byId = (a.osd || []).includes(p.id);
    const byName = a.match && new RegExp(a.match, 'i').test(p.name || '');
    if (byId || byName) {
      osdToArea.set(p.id, a.id);
      osdInfo.set(p.id, { name: p.name, activities: p.activities, location: p.location });
    }
  }
}
for (const a of wanted) {
  const ids = [...osdToArea].filter(([, id]) => id === a.id).map(([osd]) => osd);
  console.log(`- ${a.id}: ${ids.length ? ids.map(i => `${i} (${osdInfo.get(i).name})`).join(', ') : 'NOT FOUND'}`);
}

// 2. Lifts and runs, streamed once, bucketed per area.
const inputs = new Map(wanted.map(a => [a.id, { lifts: [], runs: [] }]));
for (const [name, add] of [['lifts.geojson', (f, input) => { const l = toLift(f); if (l) input.lifts.push(l); }],
                           ['runs.geojson', (f, input) => input.runs.push(...toRuns(f))]]) {
  console.log(`Reading ${name}…`);
  const file = await download(name, CACHE);
  for await (const f of readFeatures(file)) {
    const areaIds = new Set(skiAreaIds(f).map(id => osdToArea.get(id)).filter(Boolean));
    for (const id of areaIds) add(f, inputs.get(id));
  }
}

// 3. Compile, merge overrides, write.
const reports = {};
for (const a of wanted) {
  const input = inputs.get(a.id);
  const overrides = existsSync(`overrides/${a.id}.json`) ? JSON.parse(readFileSync(`overrides/${a.id}.json`, 'utf8')) : {};
  const osdIds = [...osdToArea].filter(([, id]) => id === a.id).map(([osd]) => osd);
  const { area } = compileArea(input, {
    id: a.id,
    name: overrides.name || a.name || osdInfo.get(osdIds[0])?.name || a.id,
    subtitle: overrides.subtitle || '',
    bron: `OpenSkiData (OpenStreetMap) ${osdIds.join(', ')}, ${new Date().toISOString().slice(0, 10)}`,
  });
  applyOverrides(area, overrides);
  const report = validate(area);
  reports[a.id] = { ...report, osd: osdIds, inputLifts: input.lifts.length, inputRuns: input.runs.length, reviewed: !!overrides.reviewed };
  writeFileSync(`${OUT}/${a.id}.json`, JSON.stringify(area) + '\n');
  console.log(`- ${a.id}: ${JSON.stringify(reports[a.id])}`);
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(reports, null, 2) + '\n');

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
  if (o.verbindingen) area.verbindingen = o.verbindingen;
}
