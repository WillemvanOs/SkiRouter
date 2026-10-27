// A curated area (data/<id>.json) onto the network compiled from OpenSkiData
// (data/build/<id>.json, format 2), keeping what was curated by hand.
//
//   node tools/curated-from-build.mjs --build data/build/kitzski.json --curated data/kitzski-osm.json
//
// Format 1 listed per piste "the lifts whose top it starts at" and "every lift
// whose bottom it reaches", with one length for all of them: a route over
// several pistes came out as one piste of a few hundred metres, and positions
// were partly wrong. The compiled network has every way down from each lift
// top as the pistes on the way, measured along them.
//
// From the build: lifts (positions, types, ride times), pistes, descents
// (afdalingen), transfers (overstappen), walks, piste lines and stats.
// Kept from the curated file: id, name, subtitle, source, places (plaatsen,
// plekken), bus links, restaurants, and per lift its station names and bus
// stop where the lift is where the curated file had it.

import { readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc, []));
if (!args.build || !args.curated) {
  console.error('usage: node tools/curated-from-build.mjs --build data/build/<id>.json --curated data/<id>.json');
  process.exit(1);
}

const SAME_PLACE_M = 300;    // a lift this close to where the curated file had it is the same lift
const FOOD_PISTE_M = 120;    // a restaurant linked to a piste: this close to its course
const FOOD_STATION_M = 250;  // …or to its station

const build = JSON.parse(readFileSync(args.build, 'utf8'));
const curated = JSON.parse(readFileSync(args.curated, 'utf8'));
if (!Array.isArray(build.afdalingen)) throw new Error(`${args.build} is not format 2 (no afdalingen)`);

const distanceM = ([lat1, lon1], [lat2, lon2]) => {
  const R = 6371000, rad = Math.PI / 180;
  const h = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const near = (a, b, m) => a && b && distanceM(a, b) <= m;

// ── Lifts ───────────────────────────────────────────────────────────────────
const old = new Map(curated.liften.map(l => [l.liftNr, l]));
const moved = [];
const liften = build.liften.map(lift => {
  const was = old.get(lift.liftNr);
  if (!was) return lift;
  const out = { ...lift };
  const bottomSame = near(was.coordOnder, lift.coordOnder, SAME_PLACE_M);
  const topSame = near(was.coordBoven, lift.coordBoven, SAME_PLACE_M);
  if (bottomSame && was.vertrektBij) out.vertrektBij = was.vertrektBij;
  if (topSame && was.komtAanBij) out.komtAanBij = was.komtAanBij;
  if (bottomSame && was.bushalte) out.bushalte = was.bushalte;
  if (was.naam && was.naam !== was.liftNr) out.naam = was.naam;
  if (!bottomSame || !topSame) moved.push(lift.liftNr);
  return out;
});
const liftByNr = new Map(liften.map(l => [l.liftNr, l]));

// ── Bus links (walks come from the build) ───────────────────────────────────
const key = v => `${v.van}|${v.naar}|${v.soort}`;
const verbindingen = [...build.verbindingen || []];
for (const v of curated.verbindingen || []) {
  if (v.soort === 'lopen' || verbindingen.some(w => key(w) === key(v))) continue;
  verbindingen.push(v);
}

// ── Restaurants: still where they are linked? ───────────────────────────────
const lines = build.pisteLijnen || {};
const pisteDistance = (nr, p) => Math.min(Infinity, ...(lines[nr] || []).flat().map(q => distanceM(p, q)));
const stationAt = id => {
  const nr = id.replace(/-(onder|boven)$/, ''), lift = liftByNr.get(nr);
  return lift && (id.endsWith('-onder') ? lift.coordOnder : lift.coordBoven);
};
const nearestPiste = at => {
  let best = null;
  for (const nr of Object.keys(lines)) {
    const d = pisteDistance(nr, at);
    if (d <= FOOD_PISTE_M && (!best || d < best.d)) best = { nr, d };
  }
  return best;
};
const nearestStation = at => {
  let best = null;
  for (const lift of liften) {
    for (const [side, c] of [['onder', lift.coordOnder], ['boven', lift.coordBoven]]) {
      const d = c ? distanceM(at, c) : Infinity;
      if (d <= FOOD_STATION_M && (!best || d < best.d)) best = { id: `${lift.liftNr}-${side}`, d };
    }
  }
  return best;
};
// A restaurant keeps its station or piste when it is still next to it;
// otherwise it is linked again by where it is, or left out (not on the piste).
let relinked = 0, dropped = 0;
const restaurants = (curated.restaurants || []).flatMap(r => {
  const at = r.lat != null && r.lon != null ? [r.lat, r.lon] : null;
  if (!at) return [r];
  const out = { ...r };
  let changed = false;
  if (out.station && !near(at, stationAt(out.station), FOOD_STATION_M)) { delete out.station; changed = true; }
  if (out.piste && pisteDistance(out.piste, at) > FOOD_PISTE_M) { delete out.piste; changed = true; }
  if (changed && !out.station && !out.piste) {
    const station = nearestStation(at), piste = nearestPiste(at);
    if (station) out.station = station.id;
    else if (piste) { out.piste = piste.nr; out.afstandM = Math.round(piste.d); }
  }
  if (!out.station && !out.piste) { dropped++; return []; }
  if (changed) relinked++;
  return [out];
});

const area = {
  format: 2,
  id: curated.id,
  name: curated.name,
  subtitle: curated.subtitle,
  bron: `${curated.bron || ''}; network: ${build.bron || 'OpenSkiData build'}`.replace(/^; /, ''),
  stats: build.stats,
  liften,
  pistes: build.pistes,
  afdalingen: build.afdalingen,
  overstappen: build.overstappen || [],
  verbindingen,
  restaurants,
  pisteLijnen: build.pisteLijnen,
  plaatsen: curated.plaatsen || build.plaatsen,
  plekken: curated.plekken || build.plekken,
};
writeFileSync(args.curated, JSON.stringify(area, null, 2) + '\n');
console.log(`${args.curated}: ${liften.length} lifts (${moved.length} at another place than before: ${moved.join(' ') || '—'}), `
  + `${build.pistes.length} pistes, ${build.afdalingen.length} descents, ${verbindingen.length} links, `
  + `${restaurants.length} restaurants (${relinked} linked again, ${dropped} no longer on a piste)`);
