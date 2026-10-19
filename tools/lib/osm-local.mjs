// OpenStreetMap from our own extract instead of the public Overpass API.
//
// tools/osm-extract.sh downloads the Geofabrik regions with ski areas, keeps
// only what SkiRouter uses (places to eat, huts, peaks, villages,
// viewpoints, snow parks, lifts, pistes and bus stops) and exports that as
// GeoJSON, one feature per line (osmium export -f geojsonseq). osmElements
// reads it back as Overpass-style elements, so the scripts that used
// Overpass work on it unchanged:
//   { type: 'node', id, tags, lat, lon }
//   { type: 'way' | 'relation', id, tags, center: { lat, lon }, geometry: [{ lat, lon }, …] }
// (`center` is the middle of the bounding box, as Overpass's `out center`.)

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const TYPES = { n: 'node', w: 'way', r: 'relation', a: 'area' };
const CELL = 0.5; // degrees: the grid that finds the boxes a point may be in

// Every element whose position lies in one of `boxes` ([south, west, north,
// east]); a way's or relation's position is its centre, or any point of its
// line when `anyPoint` (a piste that only passes through the box).
export async function osmElements(file, boxes, { anyPoint = false } = {}) {
  const grid = new Map();
  boxes.forEach(([s, w, n, e], i) => {
    for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++) {
      for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++) {
        const key = `${y}:${x}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
    }
  });
  const inBoxes = (lat, lon) => (grid.get(`${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`) || [])
    .some(i => { const [s, w, n, e] = boxes[i]; return lat >= s && lat <= n && lon >= w && lon <= e; });

  const out = new Map(); // by type/id: regions overlap, so an object can come twice
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const raw of lines) {
    const line = raw.replace(/^\x1e/, '').trim(); // osmium may start a record with RS
    if (!line) continue;
    const element = toElement(JSON.parse(line));
    if (!element || out.has(`${element.type}/${element.id}`)) continue;
    const pos = element.type === 'node' ? element : element.center;
    const hit = inBoxes(pos.lat, pos.lon)
      || (anyPoint && element.geometry?.some(p => inBoxes(p.lat, p.lon)));
    if (hit) out.set(`${element.type}/${element.id}`, element);
  }
  return [...out.values()];
}

// One GeoJSON feature from osmium export (--add-unique-id=type_id) as an
// Overpass-style element.
export function toElement(feature) {
  const m = /^([nwra])(\d+)$/.exec(String(feature.id ?? ''));
  const g = feature.geometry;
  if (!m || !g) return null;
  const tags = feature.properties || {};
  let type = TYPES[m[1]], id = Number(m[2]);
  // osmium also exports every closed way again as an area, with id 2 × the
  // way's (the way itself is there already), and a multipolygon relation as
  // an area with id 2 × the relation's + 1.
  if (type === 'area') {
    if (id % 2 === 0) return null;
    type = 'relation';
    id = (id - 1) / 2;
  }
  if (g.type === 'Point') return { type, id, tags, lat: g.coordinates[1], lon: g.coordinates[0] };
  // A line, or the outer ring of an area (a hut drawn as a building).
  const coords = g.type === 'LineString' ? g.coordinates
    : g.type === 'Polygon' ? g.coordinates[0]
    : g.type === 'MultiPolygon' ? g.coordinates[0][0]
    : g.type === 'MultiLineString' ? g.coordinates.flat()
    : null;
  if (!coords?.length) return null;
  let s = 90, w = 180, n = -90, e = -180;
  coords.forEach(([lon, lat]) => { if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon; });
  return {
    type, id, tags,
    center: { lat: (s + n) / 2, lon: (w + e) / 2 },
    geometry: coords.map(([lon, lat]) => ({ lat, lon })),
  };
}
