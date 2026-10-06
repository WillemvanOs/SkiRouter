// Reads the OpenSkiData GeoJSON downloads (ski_areas, lifts, runs) — the
// processed OpenStreetMap ski data behind OpenSkiMap, with elevation on every
// coordinate and every lift and run already assigned to its ski area — and
// turns them into compile-area.mjs input, grouped per ski area.
//
// The feature files are large (all ski areas worldwide), so they are streamed
// one feature per line rather than parsed whole.

import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const UA = 'SkiRouter/1.0 (github.com/WillemvanOs/SkiRouter)';
export const OSD_BASE = process.env.OSD_BASE || 'https://tiles.openskimap.org/geojson';

// Download name.geojson into dir, unless a fresh copy is there already.
export async function download(name, dir, maxAgeH = 20) {
  const file = `${dir}/${name}`;
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAgeH * 3600e3) return file;
  const res = await fetch(`${OSD_BASE}/${name}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${OSD_BASE}/${name}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  return file;
}

// Every Feature in a GeoJSON file written one feature per line.
export async function* readFeatures(file) {
  let input = createReadStream(file);
  if (file.endsWith('.gz')) input = input.pipe(createGunzip());
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (let line of rl) {
    line = line.trim();
    if (!line.startsWith('{') || !line.includes('"Feature"')) continue;
    if (line.endsWith(',')) line = line.slice(0, -1);
    try { yield JSON.parse(line); } catch { /* not a feature line */ }
  }
}

// The ski area ids a lift or run belongs to.
export function skiAreaIds(feature) {
  return (feature.properties?.skiAreas || [])
    .map(a => a?.properties?.id ?? a?.id ?? (typeof a === 'string' ? a : null))
    .filter(Boolean);
}

const LIFT_TYPES = {
  cable_car: 'cable_car', gondola: 'gondola', mixed_lift: 'mixed_lift', funicular: 'funicular',
  chair_lift: 'chair_lift', drag_lift: 'drag_lift', 't-bar': 't-bar', 'j-bar': 'j-bar',
  platter: 'platter', rope_tow: 'rope_tow', magic_carpet: 'magic_carpet',
};

// OpenSkiData difficulty (+ grooming) -> the app's colours (European convention).
export function runDifficulty(p) {
  if (p.grooming === 'backcountry') return 'skiroute';
  switch (p.difficulty) {
    case 'novice': case 'easy': return 'blauw';
    case 'intermediate': return 'rood';
    case 'advanced': case 'expert': return 'zwart';
    case 'freeride': case 'extreme': return 'skiroute';
    default: return null;
  }
}

const usable = p => !p.status || p.status === 'operating';

function lines(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return []; // piste areas (polygons) are not part of the network
}

export function toLift(feature) {
  const p = feature.properties || {};
  const type = LIFT_TYPES[p.liftType];
  if (!type || !usable(p)) return null;
  const coords = lines(feature.geometry)[0];
  if (!coords || coords.length < 2) return null;
  const stationName = s => s?.properties?.name || s?.name || null;
  const stations = p.stations || [];
  return {
    id: p.id,
    ref: p.ref || null,
    name: p.name || null,
    type,
    coords,
    duration: typeof p.duration === 'number' ? p.duration : null,
    bottomName: stationName(stations[0]),
    topName: stations.length > 1 ? stationName(stations[stations.length - 1]) : null,
  };
}

export function toRuns(feature) {
  const p = feature.properties || {};
  if (!(p.uses || []).includes('downhill') || !usable(p)) return [];
  const difficulty = runDifficulty(p);
  if (!difficulty) return [];
  return lines(feature.geometry)
    .filter(c => c.length >= 2)
    .map((coords, i) => ({ id: `${p.id}${i ? `/${i}` : ''}`, ref: p.ref || null, name: p.name || null, difficulty, coords }));
}
