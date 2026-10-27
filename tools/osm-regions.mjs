// Which Geofabrik extracts hold our ski areas: for every area the smallest
// region (Tirol rather than Austria, Rhône-Alpes rather than France) that
// contains its corners and centre, so tools/osm-extract.sh downloads as
// little as it can. Prints one .osm.pbf URL per line.
//
//   node tools/osm-regions.mjs --index index-v1.json [--areas build/europe/areas]
//
// index-v1.json is Geofabrik's list of regions with their outlines
// (https://download.geofabrik.de/index-v1.json).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { areaPoints, boxOf } from './lib/landmarks.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc, []));
const AREAS_DIR = args.areas || 'build/europe/areas';
const CURATED = 'data/areas.json';
const PAD = 0.02; // ~2 km around an area: its villages and peaks as well

const index = JSON.parse(readFileSync(args.index || 'index-v1.json', 'utf8'));
const regions = index.features
  .filter(f => f.geometry && f.properties?.urls?.pbf)
  .map(f => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let s = 90, w = 180, n = -90, e = -180;
    polys.forEach(p => p[0].forEach(([lon, lat]) => { if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon; }));
    return { id: f.properties.id, parent: f.properties.parent || null, url: f.properties.urls.pbf, polys, box: [s, w, n, e], size: (n - s) * (e - w) };
  });

const areas = [
  ...(existsSync(AREAS_DIR) ? readdirSync(AREAS_DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(`${AREAS_DIR}/${f}`, 'utf8'))) : []),
  ...(existsSync(CURATED) ? JSON.parse(readFileSync(CURATED, 'utf8')).filter(m => m.file && existsSync(m.file)).map(m => JSON.parse(readFileSync(m.file, 'utf8'))) : []),
];

const chosen = new Map();
let missing = 0;
for (const area of areas) {
  const points = areaPoints(area);
  if (!points.length) continue;
  const [s, w, n, e] = boxOf(points, PAD);
  for (const [lat, lon] of [[s, w], [s, e], [n, w], [n, e], [(s + n) / 2, (w + e) / 2]]) {
    const best = regions
      .filter(r => lat >= r.box[0] && lat <= r.box[2] && lon >= r.box[1] && lon <= r.box[3] && r.polys.some(p => inPolygon(lon, lat, p)))
      .sort((a, b) => a.size - b.size)[0];
    if (best) chosen.set(best.id, best);
    else { missing++; console.error(`no Geofabrik region for ${area.id} at ${lat.toFixed(3)},${lon.toFixed(3)}`); }
  }
}

// A region whose parent is chosen as well is in the parent's file already.
const ancestors = r => { const list = []; for (let p = r.parent; p; p = regions.find(x => x.id === p)?.parent) list.push(p); return list; };
const urls = [...chosen.values()].filter(r => !ancestors(r).some(a => chosen.has(a))).map(r => r.url).sort();
console.error(`${areas.length} areas in ${urls.length} Geofabrik regions${missing ? `, ${missing} points outside every region` : ''}`);
console.log(urls.join('\n'));

// Even-odd rule over a polygon's rings (the first is the outline, the rest holes).
function inPolygon(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
