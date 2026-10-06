// The live lift status of every European ski area in data/liftstatus/sources.json,
// one file per area: <out>/europe/<area id>.json, plus <out>/index.json.
//
//   node tools/liftstatus-europe.mjs [--sources data/liftstatus/sources.json] [--out liftstatus-data]
//
// Runs every 30 minutes during the day in GitHub Actions
// (.github/workflows/liftstatus-europe.yml), which publishes <out> as the
// single commit of the `liftstatus` branch; the app reads the files from
// there (raw.githubusercontent.com), so main and the site are not touched.
//
// A file keeps the provider's own lift names:
//   { bron, sourceUpdate, lifts: [{ n, open, hours?, text? }] }
// and the app matches them to the area's lifts (liftmatch.js). When an
// area's sources cannot be read, its previous file stays, with its time.
// Needs cheerio.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { readSource, sourceLabel } from './lib/liftstatus-providers.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc, []));
const SOURCES = args.sources || 'data/liftstatus/sources.json';
const OUT = args.out || 'liftstatus-data';
mkdirSync(`${OUT}/europe`, { recursive: true });

if (!existsSync(SOURCES)) {
  console.log(`${SOURCES} not found: run tools/liftstatus-sources.mjs first.`);
  process.exit(0);
}
const { areas } = JSON.parse(readFileSync(SOURCES, 'utf8'));
const now = new Date().toISOString();
const index = { updated: now, areas: {} };
let ok = 0, kept = 0, missing = 0;

const entries = Object.entries(areas);
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < entries.length) {
    const [id, area] = entries[next++];
    const file = `${OUT}/europe/${id}.json`;
    const lifts = [];
    const errors = [];
    for (const source of area.sources) {
      try {
        lifts.push(...(await readSource(source)).lifts);
      } catch (err) {
        errors.push(`${sourceLabel(source)}: ${err.message}`);
      }
    }
    let out;
    if (lifts.length && !errors.length) {
      out = { bron: area.bron, sourceUpdate: now, lifts };
      writeFileSync(file, JSON.stringify(out) + '\n');
      ok++;
    } else if (existsSync(file)) {
      out = JSON.parse(readFileSync(file, 'utf8'));
      kept++;
      console.log(`- ${id}: ${errors.join('; ') || 'no lifts'}; keeps the status of ${out.sourceUpdate}`);
    } else {
      missing++;
      console.log(`- ${id}: ${errors.join('; ') || 'no lifts'}`);
    }
    if (out) index.areas[id] = { sourceUpdate: out.sourceUpdate, open: out.lifts.filter(l => l.open).length, lifts: out.lifts.length };
  }
}));

writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1) + '\n');
console.log(`${ok} areas updated, ${kept} kept their previous status, ${missing} without status (of ${entries.length})`);
