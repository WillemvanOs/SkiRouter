// Enriches every ski area dataset in data/areas.json with data from
// OpenStreetMap that the day planner needs:
//   - restaurants: named restaurants, cafés, bars and huts near a lift
//     station or a piste, linked to the graph node or piste they sit at.
//   - liften[].openingstijden: the lift's opening_hours tag, when mapped.
//   - liften[].coordOnder / coordBoven: [lat, lon] of the bottom/top station,
//     used to work out walking/bus times for `verbindingen`.
//   - liften[].bushalte: the nearest named bus stop to the bottom station.
//   - pisteLijnen: { pisteNr: [[[lat, lon], …], …] } — each piste's course,
//     thinned to a point every ~60 m, for "where am I" (GPS) in the app.
//
// The data comes from our own OpenStreetMap extract (tools/osm-extract.sh,
// read by tools/lib/osm-local.mjs), not the public Overpass API. Runs in
// GitHub Actions (.github/workflows/osm-enrich.yml). No dependencies: Node 20+.
//
//   tools/osm-extract.sh build/osm.geojsonseq
//   node tools/osm-enrich.mjs --osm build/osm.geojsonseq

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { osmElements } from './lib/osm-local.mjs';

const OSM = process.argv[process.argv.indexOf('--osm') + 1];
if (!process.argv.includes('--osm') || !existsSync(OSM)) throw new Error('--osm <extract.geojsonseq> is needed (tools/osm-extract.sh makes it)');
const AREA_PAD = 0.01; // around the area's lift stations and runs
// A place counts as "on the piste" when it is this close to a piste's course
// (OSM maps a piste's centre line, so a wide piste reaches further than this):
const PISTE_RADIUS_M     = 80;
const HUT_PISTE_RADIUS_M = 100; // a mountain hut may sit a little further off
const TOP_STATION_M      = 130; // …or at the top station of a lift
const STATION_LINK_M     = 130; // this close to a station, lunch is "at" that station
const NETWORK_RADIUS_M   = 1500; // piste ways further than this from every lift
                                 // station belong to a neighbouring ski area
const FOOD = /^(restaurant|cafe|fast_food|bar|pub|biergarten)$/;

function distM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Distance from point p to segment a–b, in metres (local flat projection).
function distToSegM(p, a, b) {
  const kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 110540;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

function foodKind(tags) {
  if (tags.tourism === 'alpine_hut' || /hütte|hutte|huette|alm\b|alm$|berg-?gasth/i.test(tags.name || '')) return 'hut';
  return tags.amenity;
}

async function enrichArea(meta) {
  const path = meta.file;
  const area = JSON.parse(await readFile(path, 'utf8'));
  // The area: around its lift stations (and runs) as the dataset has them.
  const points = [
    ...(area.liften || []).flatMap(l => [l.coordOnder, l.coordBoven]),
    ...Object.values(area.pisteLijnen || {}).flat(2),
  ].filter(Boolean);
  if (!points.length) { console.log(`- ${area.id}: no station or run positions to place it, skipped`); return; }
  const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
  const box = [Math.min(...lats) - AREA_PAD, Math.min(...lons) - AREA_PAD, Math.max(...lats) + AREA_PAD, Math.max(...lons) + AREA_PAD];
  console.log(`- ${area.id}: ${box.map(v => v.toFixed(3)).join(',')}`);

  // Lines that pass through the box count too (a long piste, a lift).
  const data = { elements: await osmElements(OSM, [box], { anyPoint: true }) };

  const aerialways = data.elements.filter(e => e.type === 'way' && e.tags?.aerialway && e.geometry?.length >= 2);
  const pisteWays  = data.elements.filter(e => e.type === 'way' && e.tags?.['piste:type'] === 'downhill' && e.geometry?.length >= 2);
  const busStops   = data.elements.filter(e => e.type === 'node' && e.tags?.highway === 'bus_stop' && e.tags.name);
  const foods      = data.elements.filter(e => e.tags?.name && (FOOD.test(e.tags.amenity || '') || e.tags.tourism === 'alpine_hut'));
  console.log(`  ${aerialways.length} aerialways, ${pisteWays.length} piste ways, ${foods.length} food places`);

  // Lift stations: OSM aerialways run bottom → top.
  const stations = [];
  let matched = 0;
  for (const lift of area.liften || []) {
    const way = aerialways.find(w => w.tags.ref && w.tags.ref === lift.liftNr)
             || aerialways.find(w => lift.naam && norm(w.tags.name) === norm(lift.naam));
    if (!way) continue;
    matched++;
    const g = way.geometry;
    stations.push({ id: `${lift.liftNr}-onder`, pos: g[0] });
    stations.push({ id: `${lift.liftNr}-boven`, pos: g[g.length - 1] });
    const round = p => [+p.lat.toFixed(5), +p.lon.toFixed(5)];
    lift.coordOnder = round(g[0]);
    lift.coordBoven = round(g[g.length - 1]);
    let stop = null;
    for (const b of busStops) {
      const d = distM(g[0], b);
      if (d <= 400 && (!stop || d < stop.afstandM)) stop = { naam: b.tags.name, afstandM: Math.round(d) };
    }
    if (stop) lift.bushalte = stop; else delete lift.bushalte;
    const oh = way.tags.opening_hours;
    if (oh) lift.openingstijden = oh; else delete lift.openingstijden;
  }
  console.log(`  matched ${matched}/${(area.liften || []).length} lifts to OSM`);

  // Piste ways near this area's lifts (not a neighbouring area's run that
  // happens to carry the same number).
  const networkWays = pisteWays.filter(w => {
    const g = w.geometry;
    return [g[0], g[Math.floor(g.length / 2)], g[g.length - 1]]
      .some(p => stations.some(s => distM(p, s.pos) <= NETWORK_RADIUS_M));
  });
  console.log(`  ${networkWays.length}/${pisteWays.length} piste ways near this area's lifts`);

  const pisteNrs = new Set((area.pistes || []).map(p => p.pisteNr));
  const pistesByName = new Map((area.pistes || []).map(p => [norm(p.naam), p.pisteNr]));
  function pisteNrOf(way) {
    const ref = way.tags['piste:ref'] || way.tags.ref;
    if (ref && pisteNrs.has(ref)) return ref;
    const byName = pistesByName.get(norm(way.tags['piste:name'] || way.tags.name));
    return byName || null;
  }

  const restaurants = [];
  const seen = new Set();
  for (const f of foods) {
    const pos = f.type === 'node' ? { lat: f.lat, lon: f.lon } : f.center;
    if (!pos) continue;

    // Nearest lift station and nearest piste of this ski area.
    let station = null;
    for (const s of stations) {
      const d = distM(pos, s.pos);
      if (!station || d < station.d) station = { d, id: s.id };
    }
    let piste = null;
    for (const w of networkWays) {
      const nr = pisteNrOf(w);
      if (!nr) continue;
      for (let i = 1; i < w.geometry.length; i++) {
        const d = distToSegM(pos, w.geometry[i - 1], w.geometry[i]);
        if (!piste || d < piste.d) piste = { d, nr };
      }
    }
    // Only places on or right next to a piste, or at a top station. Cafés in
    // the villages and places merely near a valley station are left out.
    const onPiste   = piste && piste.d <= PISTE_RADIUS_M;
    const hutNear   = piste && foodKind(f.tags) === 'hut' && piste.d <= HUT_PISTE_RADIUS_M;
    const atTop     = station && station.id.endsWith('-boven') && station.d <= TOP_STATION_M;
    if (!onPiste && !hutNear && !atTop) continue;
    const best = station && station.d <= STATION_LINK_M
      ? { d: station.d, station: station.id }
      : { d: piste.d, piste: piste.nr };

    const key = norm(f.tags.name) + '|' + (best.station || best.piste);
    if (seen.has(key)) continue;
    seen.add(key);

    const r = {
      id: `${f.type}/${f.id}`,
      naam: f.tags.name,
      soort: foodKind(f.tags),
      ...(best.station ? { station: best.station } : { piste: best.piste }),
      afstandM: Math.round(best.d),
      lat: +pos.lat.toFixed(5),
      lon: +pos.lon.toFixed(5),
    };
    if (f.tags.opening_hours) r.openingstijden = f.tags.opening_hours;
    if (f.tags.website || f.tags['contact:website']) r.website = f.tags.website || f.tags['contact:website'];
    if (f.tags.phone || f.tags['contact:phone']) r.telefoon = f.tags.phone || f.tags['contact:phone'];
    if (f.tags.ele) r.hoogte = Math.round(parseFloat(f.tags.ele)) || undefined;
    restaurants.push(r);
  }
  restaurants.sort((a, b) => a.naam.localeCompare(b.naam, 'de'));
  area.restaurants = restaurants;

  // Piste courses for locating a skier on a piste.
  const lines = {};
  for (const w of networkWays) {
    const nr = pisteNrOf(w);
    if (!nr) continue;
    const pts = [];
    for (const p of w.geometry) {
      if (!pts.length || distM(pts[pts.length - 1], p) >= 60) pts.push(p);
    }
    const last = w.geometry[w.geometry.length - 1];
    if (distM(pts[pts.length - 1], last) > 5) pts.push(last);
    (lines[nr] = lines[nr] || []).push(pts.map(p => [+p.lat.toFixed(5), +p.lon.toFixed(5)]));
  }
  area.pisteLijnen = lines;
  console.log(`  piste courses for ${Object.keys(lines).length} piste numbers`);
  console.log(`  ${restaurants.length} restaurants linked (${restaurants.filter(r => r.station).length} at a station, ${restaurants.filter(r => r.piste).length} on a piste)`);

  await writeFile(path, JSON.stringify(area, null, 2) + '\n');
}

const areas = JSON.parse(await readFile('data/areas.json', 'utf8'));
for (const meta of areas) await enrichArea(meta);
