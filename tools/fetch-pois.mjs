// Fetches mountain restaurants, cafés, bars and huts from OpenStreetMap for
// every built ski area, and keeps the ones on or next to a piste, or at a top
// station, in data/pois/europe.json. tools/build-areas.mjs links them to the
// lift stations and runs of each area (see linkRestaurants in
// tools/lib/compile-area.mjs).
//
//   node tools/build-areas.mjs --europe --out build/europe
//   node tools/fetch-pois.mjs [--areas build/europe/areas] [--out data/pois/europe.json]
//
// The Overpass API is free and shared: areas are asked in batches of bounding
// boxes, one batch at a time with a pause in between, so a full run is a few
// dozen queries. Runs weekly in GitHub Actions (.github/workflows/pois.yml).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc, []));
const AREAS_DIR = args.areas || 'build/europe/areas';
const OUT = args.out || 'data/pois/europe.json';
const BATCH = 12;          // bounding boxes per Overpass query
const PAUSE_MS = 3000;     // between queries
const PAD = 0.004;         // ~400 m around an area's lifts and runs
const KEEP_RUN_M = 100;    // keep a place this close to a run's course…
const KEEP_TOP_M = 130;    // …or to a top station (the build applies the exact rules)
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = 'SkiRouter/1.0 (github.com/WillemvanOs/SkiRouter)';

// Every built area: its bounding box, run courses and top stations.
const areas = readdirSync(AREAS_DIR).filter(f => f.endsWith('.json')).map(f => {
  const a = JSON.parse(readFileSync(`${AREAS_DIR}/${f}`, 'utf8'));
  const pts = [
    ...a.liften.flatMap(l => [l.coordOnder, l.coordBoven]),
    ...Object.values(a.pisteLijnen || {}).flat(2),
  ].filter(Boolean);
  const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
  return {
    id: a.id,
    bbox: [Math.min(...lats) - PAD, Math.min(...lons) - PAD, Math.max(...lats) + PAD, Math.max(...lons) + PAD],
    lines: Object.values(a.pisteLijnen || {}).flat(),
    tops: a.liften.map(l => l.coordBoven).filter(Boolean),
  };
}).filter(a => a.lines.length);
console.log(`${areas.length} areas`);

// Batches of nearby areas (sorted west to east), one Overpass query each.
areas.sort((a, b) => a.bbox[1] - b.bbox[1]);
const pois = new Map();
for (let i = 0; i < areas.length; i += BATCH) {
  const batch = areas.slice(i, i + BATCH);
  const boxes = batch.map(a => a.bbox.map(v => v.toFixed(4)).join(','));
  const query = `[out:json][timeout:300];(${boxes.map(b =>
    `nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|biergarten)$"]["name"](${b});nwr["tourism"="alpine_hut"]["name"](${b});`).join('')});out tags center;`;
  const data = await overpass(query);
  let kept = 0;
  for (const e of data.elements || []) {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null || pois.has(`${e.type}/${e.id}`)) continue;
    if (!batch.some(a => nearArea(a, [lat, lon]))) continue;
    const t = e.tags || {};
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
  console.log(`batch ${i / BATCH + 1}/${Math.ceil(areas.length / BATCH)}: ${(data.elements || []).length} places, ${kept} on the piste`);
  await new Promise(r => setTimeout(r, PAUSE_MS));
}

const list = [...pois.values()].sort((a, b) => a.id.localeCompare(b.id));
mkdirSync(dirname(OUT), { recursive: true });
const before = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')).pois : null;
if (before && JSON.stringify(before) === JSON.stringify(list)) {
  console.log('unchanged');
} else {
  writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), count: list.length, pois: list }) + '\n');
  console.log(`written ${list.length} places to ${OUT}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function nearArea(area, p) {
  const [s, w, n, e] = area.bbox;
  if (p[0] < s || p[0] > n || p[1] < w || p[1] > e) return false;
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

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(330000),
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`  overpass failed (${err.message}), retrying…`);
      await new Promise(r => setTimeout(r, 15000 * (attempt + 1)));
    }
  }
  throw lastErr;
}
