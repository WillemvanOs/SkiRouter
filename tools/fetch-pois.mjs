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
// boxes, one batch at a time with a pause in between. A run stops after
// BUDGET_MIN minutes and saves what it has; the next run carries on with the
// areas fetched longest ago. Runs daily in GitHub Actions
// (.github/workflows/pois.yml); areas fetched in the last few days are skipped.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc, []));
const AREAS_DIR = args.areas || 'build/europe/areas';
const OUT = args.out || 'data/pois/europe.json';
const BATCH = Number(process.env.BATCH || 6);           // bounding boxes per Overpass query (halved when one times out)
const PAUSE_MS = 3000;     // between queries
const PAD = 0.004;         // ~400 m around an area's lifts and runs
const KEEP_RUN_M = 100;    // keep a place this close to a run's course…
const KEEP_TOP_M = 130;    // …or to a top station (the build applies the exact rules)
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const FRESH_DAYS = 6;      // an area fetched this recently is skipped
const BUDGET_MIN = Number(process.env.BUDGET_MIN || 80); // then stop and save what we have
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

// Batches of nearby areas, one Overpass query each. The public Overpass
// servers are often busy, so a run does what it can within BUDGET_MIN and
// saves it: areas never fetched (or fetched longest ago) go first, and the
// next run carries on from there. A batch that keeps failing is split in
// halves, down to single areas; an area that still fails keeps the places it
// had before.
const prevFile = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const previous = prevFile.pois || [];
const fetchedAt = { ...(prevFile.fetched || {}) };
const today = new Date().toISOString().slice(0, 10);
const fresh = id => fetchedAt[id] && (Date.now() - Date.parse(fetchedAt[id])) / 864e5 < FRESH_DAYS;
const deadline = Date.now() + BUDGET_MIN * 60e3;
const todo = areas.filter(a => !fresh(a.id))
  .sort((a, b) => (fetchedAt[a.id] || '').localeCompare(fetchedAt[b.id] || '') || a.bbox[1] - b.bbox[1]);
console.log(`${todo.length} to fetch (${areas.length - todo.length} fetched in the last ${FRESH_DAYS} days)`);
const pois = new Map();
const done = [];
const failed = [];
const batches = [];
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
for (let b = 0; b < batches.length; b++) {
  if (Date.now() > deadline) { console.log(`Time is up: ${batches.length - b} batches left for the next run.`); break; }
  await fetchBatch(batches[b], `${b + 1}/${batches.length}`);
}
for (const area of failed) console.log(`- ${area.id}: not fetched, keeps its previous places`);

async function fetchBatch(batch, label) {
  const boxes = batch.map(a => a.bbox.map(v => v.toFixed(4)).join(','));
  const query = `[out:json][timeout:90];(${boxes.map(b =>
    `nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|biergarten)$"]["name"](${b});nwr["tourism"="alpine_hut"]["name"](${b});`).join('')});out tags center;`;
  let data;
  try {
    data = await overpass(query, 2);
  } catch (err) {
    if (batch.length > 1 && Date.now() < deadline) {
      console.log(`batch ${label}: ${err.message}; splitting it`);
      const half = Math.ceil(batch.length / 2);
      await fetchBatch(batch.slice(0, half), `${label}a`);
      await fetchBatch(batch.slice(half), `${label}b`);
    } else {
      console.log(`batch ${label} (${batch.map(a => a.id).join(', ')}): ${err.message}; skipped`);
      failed.push(...batch);
    }
    return;
  }
  batch.forEach(a => { fetchedAt[a.id] = today; done.push(a); });
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
  console.log(`batch ${label}: ${(data.elements || []).length} places, ${kept} on the piste`);
  await new Promise(r => setTimeout(r, PAUSE_MS));
}

// Places of the areas fetched now replace what they had; every other area
// keeps its places from before.
const kept = previous.filter(p => !done.some(a => inBox(a.bbox, [p.lat, p.lon])));
kept.forEach(p => { if (!pois.has(p.id)) pois.set(p.id, p); });
const list = [...pois.values()].sort((a, b) => a.id.localeCompare(b.id));
const fetched = Object.fromEntries(Object.entries(fetchedAt).filter(([id]) => areas.some(a => a.id === id)).sort());
mkdirSync(dirname(OUT), { recursive: true });
if (JSON.stringify(previous) === JSON.stringify(list) && JSON.stringify(prevFile.fetched || {}) === JSON.stringify(fetched)) {
  console.log('unchanged');
} else {
  writeFileSync(OUT, JSON.stringify({ updated: today, count: list.length, fetched, pois: list }) + '\n');
  const covered = Object.keys(fetched).length;
  console.log(`written ${list.length} places to ${OUT}; ${covered}/${areas.length} areas fetched so far${failed.length ? `, ${failed.length} failed this run` : ''}`);
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

async function overpass(query, attempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`  overpass failed (${err.message}), retrying…`);
      await new Promise(r => setTimeout(r, 8000));
    }
  }
  throw lastErr;
}
