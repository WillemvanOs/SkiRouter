// Enriches every ski area dataset in data/areas.json with data from
// OpenStreetMap that the day planner needs:
//   - restaurants: named restaurants, cafés, bars and huts near a lift
//     station or a piste, linked to the graph node or piste they sit at.
//   - liften[].openingstijden: the lift's opening_hours tag, when mapped.
//   - liften[].coordOnder / coordBoven: [lat, lon] of the bottom/top station,
//     used to work out walking/bus times for `verbindingen`.
//   - liften[].bushalte: the nearest named bus stop to the bottom station.
//
// Runs in GitHub Actions (.github/workflows/osm-enrich.yml), which has open
// internet access. No dependencies: Node 20+ only.
//
//   node tools/osm-enrich.mjs

import { readFile, writeFile } from 'node:fs/promises';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const STATION_RADIUS_M = 350;  // a hut this close to a lift station "is at" it
const PISTE_RADIUS_M   = 120;  // otherwise: this close to a piste "is on" it
const FOOD = /^(restaurant|cafe|fast_food|bar|pub|biergarten)$/;

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS_URLS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SkiRouter/1.0 (github.com/WillemvanOs/SkiRouter)' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastErr = err;
        console.warn(`  overpass failed (${err.message}), retrying…`);
        await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

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
  if (tags.tourism === 'alpine_hut' || /hutte|huette|alm\b|alm$/i.test(tags.name || '')) return 'hut';
  return tags.amenity;
}

async function enrichArea(meta) {
  const path = meta.file;
  const area = JSON.parse(await readFile(path, 'utf8'));
  const relMatch = /relatie (\d+)/.exec(area.bron || '');
  if (!relMatch) { console.log(`- ${area.id}: no OSM relation in "bron", skipped`); return; }
  const relId = relMatch[1];
  console.log(`- ${area.id}: OSM relation ${relId}`);

  const bb = (await overpass(`[out:json][timeout:60];rel(${relId});out bb;`)).elements[0]?.bounds;
  if (!bb) throw new Error(`relation ${relId} has no bounds`);
  const pad = 0.01;
  const bbox = `${bb.minlat - pad},${bb.minlon - pad},${bb.maxlat + pad},${bb.maxlon + pad}`;

  const data = await overpass(`[out:json][timeout:180][bbox:${bbox}];
    way[aerialway]; out tags geom;
    way["piste:type"="downhill"]; out tags geom;
    nwr[amenity~"^(restaurant|cafe|fast_food|bar|pub|biergarten)$"][name]; out tags center;
    nwr[tourism=alpine_hut][name]; out tags center;
    node[highway=bus_stop][name]; out;`);

  const aerialways = data.elements.filter(e => e.type === 'way' && e.tags?.aerialway && e.geometry?.length >= 2);
  const pisteWays  = data.elements.filter(e => e.type === 'way' && e.tags?.['piste:type'] === 'downhill' && e.geometry?.length >= 2);
  const busStops   = data.elements.filter(e => e.type === 'node' && e.tags?.highway === 'bus_stop');
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

    let best = null;
    for (const s of stations) {
      const d = distM(pos, s.pos);
      if (d <= STATION_RADIUS_M && (!best || d < best.d)) best = { d, station: s.id };
    }
    if (!best) {
      for (const w of pisteWays) {
        const nr = pisteNrOf(w);
        if (!nr) continue;
        for (let i = 1; i < w.geometry.length; i++) {
          const d = distToSegM(pos, w.geometry[i - 1], w.geometry[i]);
          if (d <= PISTE_RADIUS_M && (!best || d < best.d)) best = { d, piste: nr };
        }
      }
    }
    if (!best) continue;

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
  console.log(`  ${restaurants.length} restaurants linked (${restaurants.filter(r => r.station).length} at a station, ${restaurants.filter(r => r.piste).length} on a piste)`);

  await writeFile(path, JSON.stringify(area, null, 2) + '\n');
}

const areas = JSON.parse(await readFile('data/areas.json', 'utf8'));
for (const meta of areas) await enrichArea(meta);
