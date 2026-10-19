// Fetches mountain restaurants, cafés, bars and huts from OpenStreetMap for
// every built ski area, and keeps the ones on or next to a piste, or at a top
// station, in data/pois/europe.json. tools/build-areas.mjs links them to the
// lift stations and runs of each area (see linkRestaurants in
// tools/lib/compile-area.mjs).
//
// With --kind landmarks it fetches named peaks, towns, villages and hamlets
// in and around each area instead, plus viewpoints and snow parks, for the
// route map and as places to go (tools/lib/landmarks.mjs),
// into data/pois/landmarks.json. The hand-curated areas in data/areas.json get
// theirs written into their own file (`plaatsen`), as they are not built.
//
//   node tools/build-areas.mjs --europe --out build/europe
//   tools/osm-extract.sh build/osm.geojsonseq
//   node tools/fetch-pois.mjs --osm build/osm.geojsonseq [--kind restaurants|landmarks] [--areas build/europe/areas] [--out data/pois/europe.json]
//
// The places come from our own OpenStreetMap extract (tools/osm-extract.sh,
// read by tools/lib/osm-local.mjs), not the public Overpass API, so every
// area is done in every run. Runs daily in GitHub Actions
// (.github/workflows/pois.yml); the extract is made again once a week.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { LANDMARK_PAD, areaPoints, boxOf, landmarksFor, poisFor } from './lib/landmarks.mjs';
import { osmElements } from './lib/osm-local.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc, []));
const LANDMARKS = args.kind === 'landmarks';
const AREAS_DIR = args.areas || 'build/europe/areas';
const OUT = args.out || (LANDMARKS ? 'data/pois/landmarks.json' : 'data/pois/europe.json');
const CURATED = 'data/areas.json'; // hand-curated areas, for landmarks
const OSM = args.osm;
if (!OSM || !existsSync(OSM)) throw new Error('--osm <extract.geojsonseq> is needed (tools/osm-extract.sh makes it)');
const PAD = LANDMARKS ? LANDMARK_PAD : 0.004; // ~400 m around an area's lifts and runs (landmarks: ~1.5 km)
const KEEP_RUN_M = 100;    // keep a place this close to a run's course…
const KEEP_TOP_M = 130;    // …or to a top station (the build applies the exact rules)

// Every built area: its bounding box, run courses and top stations. For
// landmarks also the hand-curated areas.
const curated = LANDMARKS && existsSync(CURATED)
  ? JSON.parse(readFileSync(CURATED, 'utf8')).filter(m => m.file && existsSync(m.file)).map(m => ({ file: m.file, area: JSON.parse(readFileSync(m.file, 'utf8')) }))
  : [];
const areas = [
  ...readdirSync(AREAS_DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(`${AREAS_DIR}/${f}`, 'utf8'))),
  ...curated.map(c => c.area),
].map(a => ({
  id: a.id,
  curated: curated.some(c => c.area === a),
  bbox: boxOf(areaPoints(a), PAD),
  lines: Object.values(a.pisteLijnen || {}).flat(),
  tops: a.liften.map(l => l.coordBoven).filter(Boolean),
})).filter(a => a.lines.length);
console.log(`${areas.length} areas`);

// Every area, every run: the extract is on disk. What an area had before is
// replaced by what the extract has now.
const prevFile = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const previous = prevFile.pois || [];
// What a landmarks fetch asks for; when that changes, every area is fetched again.
const KINDS_VERSION = LANDMARKS ? 2 : 1; // 2: viewpoints and snow parks
const fetchedAt = { ...((prevFile.version || 1) === KINDS_VERSION ? prevFile.fetched || {} : {}) };
// The day the extract was made (tools/osm-extract.sh notes it next to the
// file; a restored cache gives the file a new date): the output only changes
// when the data does.
const today = existsSync(`${OSM}.date`) ? readFileSync(`${OSM}.date`, 'utf8').trim() : statSync(OSM).mtime.toISOString().slice(0, 10);
const pois = new Map();
const done = [];

const wanted = LANDMARKS
  ? t => (t.natural === 'peak' && t.name) || (/^(town|village|hamlet)$/.test(t.place || '') && t.name) || t.tourism === 'viewpoint' || t['piste:type'] === 'snow_park'
  : t => t.name && (/^(restaurant|cafe|fast_food|bar|pub|biergarten)$/.test(t.amenity || '') || t.tourism === 'alpine_hut');
const elements = (await osmElements(OSM, areas.map(a => a.bbox))).filter(e => wanted(e.tags || {}));
console.log(`${elements.length} ${LANDMARKS ? 'landmarks' : 'places to eat'} in the extract around the areas`);

for (const area of areas) {
  let kept = 0;
  for (const e of elements) {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null || pois.has(`${e.type}/${e.id}`) || !inBox(area.bbox, [lat, lon])) continue;
    const t = e.tags || {};
    if (LANDMARKS) {
      pois.set(`${e.type}/${e.id}`, {
        id: `${e.type}/${e.id}`, ...(t.name ? { name: t.name } : {}),
        ...(t.natural ? { natural: t.natural } : t.place ? { place: t.place } : t.tourism === 'viewpoint' ? { tourism: 'viewpoint' } : { piste: 'snow_park' }),
        lat: +lat.toFixed(5), lon: +lon.toFixed(5),
        ...(t.ele && !isNaN(parseFloat(t.ele)) ? { ele: Math.round(parseFloat(t.ele)) } : {}),
      });
      kept++;
      continue;
    }
    if (!nearArea(area, [lat, lon])) continue;
    pois.set(`${e.type}/${e.id}`, {
      id: `${e.type}/${e.id}`, name: t.name, amenity: t.amenity || null, tourism: t.tourism || null,
      lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      ...(t.ele && !isNaN(parseFloat(t.ele)) ? { ele: Math.round(parseFloat(t.ele)) } : {}),
      ...(t.opening_hours ? { opening_hours: t.opening_hours } : {}),
      ...(t.website || t['contact:website'] ? { website: t.website || t['contact:website'] } : {}),
      ...(t.phone || t['contact:phone'] ? { phone: t.phone || t['contact:phone'] } : {}),
    });
    kept++;
  }
  fetchedAt[area.id] = today;
  done.push(area);
}
console.log(`${pois.size} ${LANDMARKS ? 'kept' : 'on the piste'} in ${done.length} areas`);

// Places of the areas fetched now replace what they had; every other area
// keeps its places from before.
const kept = previous.filter(p => !done.some(a => inBox(a.bbox, [p.lat, p.lon])));
kept.forEach(p => { if (!pois.has(p.id)) pois.set(p.id, p); });
const list = [...pois.values()].sort((a, b) => a.id.localeCompare(b.id));
const fetched = Object.fromEntries(Object.entries(fetchedAt).filter(([id]) => areas.some(a => a.id === id)).sort());
mkdirSync(dirname(OUT), { recursive: true });
if (JSON.stringify(previous) === JSON.stringify(list) && JSON.stringify(prevFile.fetched || {}) === JSON.stringify(fetched) && (prevFile.version || 1) === KINDS_VERSION) {
  console.log('unchanged');
} else {
  writeFileSync(OUT, JSON.stringify({ updated: today, version: KINDS_VERSION, count: list.length, fetched, pois: list }) + '\n');
  const covered = Object.keys(fetched).length;
  console.log(`written ${list.length} places to ${OUT}; ${covered}/${areas.length} areas`);
}

// The hand-curated areas are not built: their landmarks go into their file.
for (const { file, area } of curated) {
  const plaatsen = landmarksFor(list, area);
  const plekken = poisFor(list, area);
  if (JSON.stringify(area.plaatsen || []) === JSON.stringify(plaatsen) && JSON.stringify(area.plekken || []) === JSON.stringify(plekken)) continue;
  area.plaatsen = plaatsen;
  area.plekken = plekken;
  writeFileSync(file, JSON.stringify(area, null, 2) + '\n');
  console.log(`${file}: ${plaatsen.length} landmarks, ${plekken.length} viewpoints and snow parks`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function inBox([s, w, n, e], p) {
  return p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e;
}

function nearArea(area, p) {
  if (!inBox(area.bbox, p)) return false;
  if (area.tops.some(t => distM(p, t) <= KEEP_TOP_M)) return true;
  return area.lines.some(line => line.some((q, i) => i > 0 && segDistM(p, line[i - 1], q) <= KEEP_RUN_M));
}

function distM(a, b) {
  const kx = 111320 * Math.cos(a[0] * Math.PI / 180), ky = 110540;
  return Math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * ky);
}

function segDistM(p, a, b) {
  const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
