// Route map: a flat, plain map of the ski area with the route on it.
//
// No map tiles: the area's own data is drawn on a light background, so the
// map works offline and stays easy to read. Every piste of the area is a
// faint line in its colour and every lift a faint grey line; the route is
// drawn on top, thick with a white edge, and every step has a numbered dot
// (the step you are at is bigger and yellow). Pistes follow their mapped
// course (pisteLijnen), cut to the part the route uses; lifts are straight
// lines between their stations. Leaflet (vendor/leaflet, BSD-2) is loaded
// the first time the map is opened.

const MAP_COLOURS = { blauw: '#1e6fd9', rood: '#d63b2f', zwart: '#1d1d1f', skiroute: '#e08a00' };
const MAP_LIFT_COLOUR = '#1a3a5c';
let leafletLoading = null;
let routeMap = null;       // the Leaflet map, kept while the page lives
let routeMapLayer = null;  // everything drawn on it for the current route
let routeMapMarkers = [];  // numbered dot per step, in step order
let routeMapGps = null;    // { watch, marker } while showing your position
const routeViews = { quick: 'list', day: 'list' }; // List or Map, per planner

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletLoading) {
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'vendor/leaflet/leaflet.js';
      js.onload = resolve;
      js.onerror = () => { leafletLoading = null; reject(new Error('Leaflet could not be loaded')); };
      document.head.appendChild(js);
    });
  }
  return leafletLoading;
}

const toLatLng = p => [p[0], p[1]];

function nearestIndex(line, p) {
  let best = 0, bestD = Infinity;
  line.forEach((q, i) => { const d = distanceM(p, q); if (d < bestD) { bestD = d; best = i; } });
  return { i: best, d: bestD };
}

// The part of a piste's mapped course between two points (either may be
// missing), or null when the piste has no course in the data.
function pisteSegment(nr, from, to) {
  const lines = currentArea?.pisteLijnen?.[nr];
  if (!lines?.length) return null;
  let best = null;
  for (const line of lines) {
    if (line.length < 2) continue;
    const a = from ? nearestIndex(line, from) : { i: 0, d: 0 };
    const b = to ? nearestIndex(line, to) : { i: line.length - 1, d: 0 };
    const score = a.d + b.d;
    if (!best || score < best.score) best = { score, line, i: a.i, j: b.i };
  }
  if (!best) return null;
  const { line, i, j } = best;
  const seg = i <= j ? line.slice(i, j + 1) : line.slice(j, i + 1).reverse();
  return seg.length >= 2 ? seg : null;
}

// Where two pistes meet: the point of `nr` closest to piste `next`.
function pisteJunction(nr, next) {
  const a = currentArea?.pisteLijnen?.[nr], b = currentArea?.pisteLijnen?.[next];
  if (!a || !b) return null;
  let best = null;
  for (const la of a) for (const p of la) for (const lb of b) for (let k = 0; k < lb.length; k += 2) {
    const d = distanceM(p, lb[k]);
    if (!best || d < best.d) best = { d, p };
  }
  return best?.p || null;
}

// The route as drawable pieces, numbered like the step list (transfers have
// no number of their own). A day plan's route also holds its lunch, as
// { lunch: restaurant }: not numbered, but tickable like a step. `item` is
// the piece's place among the tickable steps.
function routePieces(path) {
  const pos = stationPositions();
  const pieces = [];
  let cursor = pos[path.find(e => !e.lunch)?.from] || null;
  let number = 0, item = 0;
  // Where the mapped course of the next step starts away from where the last
  // one ended (a connecting path that is not mapped as a piste), a dotted
  // line keeps the route in one piece.
  const bridge = p => {
    if (cursor && distanceM(cursor, p) > 25) pieces.push({ kind: 'link', edge: { type: 'transfer' }, latlngs: [cursor, p], number: null, gap: true });
  };
  path.forEach(edge => {
    if (edge.lunch) {
      const r = edge.lunch;
      const at = r.lat != null && r.lon != null ? [r.lat, r.lon] : cursor;
      if (at) pieces.push({ kind: 'lunch', edge: { type: 'lunch', name: r.naam }, latlngs: [at], number: null, item });
      item++;
      return;
    }
    if (edge.type === 'transfer' || isConnection(edge)) {
      const a = cursor || pos[edge.from], b = pos[edge.to];
      const counted = edge.type !== 'transfer';
      if (a && b) pieces.push({ kind: 'link', edge, latlngs: [a, b], number: counted ? ++number : null, item: counted ? item : null });
      else if (counted) ++number;
      if (counted) item++;
      cursor = b || cursor;
      return;
    }
    if (edge.type !== 'piste') {
      const a = pos[edge.from], b = pos[edge.to];
      ++number;
      if (a) bridge(a);
      if (a && b) pieces.push({ kind: 'lift', edge, latlngs: [a, b], number, item });
      item++;
      cursor = b || cursor;
      return;
    }
    const parts = splitTrajecten(edge);
    parts.forEach((part, k) => {
      ++number;
      const target = pos[part.to] || (parts[k + 1] ? pisteJunction(part.pisteNr, parts[k + 1].pisteNr) : pos[edge.to]);
      const seg = pisteSegment(part.pisteNr, cursor, target);
      if (seg) { bridge(seg[0]); pieces.push({ kind: 'piste', edge: part, latlngs: seg, number, item }); }
      else if (cursor && target) pieces.push({ kind: 'link', edge: part, latlngs: [cursor, target], number, item, unknown: true });
      item++;
      cursor = seg ? seg[seg.length - 1] : target || cursor;
    });
  });
  return pieces;
}

function pisteColourOf(nr) {
  const piste = (currentArea?.pistes || []).find(p => p.pisteNr === nr);
  return MAP_COLOURS[piste?.kleur] || '#8a99ab';
}

function stepLabel(piece) {
  const e = piece.edge;
  if (piece.kind === 'lunch') return `Lunch · ${e.name}`;
  if (piece.kind === 'lift') return `${piece.number} · ${[liftCode(e.liftNr), e.name].filter(Boolean).join(' ')}`;
  if (piece.kind === 'piste') return `${piece.number} · ${pisteLabel(e.pisteNr)}${e.name && !String(e.name).startsWith('Piste ') ? ` (${e.name})` : ''}`;
  if (e.type === 'transfer') return 'Short walk';
  return `${piece.number ?? ''} · ${tagLabel(e)}`;
}

// The point halfway along a line, where its step number goes.
function halfway(latlngs) {
  const total = latlngs.slice(1).reduce((sum, p, i) => sum + distanceM(latlngs[i], p), 0);
  let walked = 0;
  for (let i = 1; i < latlngs.length; i++) {
    const d = distanceM(latlngs[i - 1], latlngs[i]);
    if (walked + d >= total / 2) {
      const t = d ? (total / 2 - walked) / d : 0;
      return [latlngs[i - 1][0] + t * (latlngs[i][0] - latlngs[i - 1][0]), latlngs[i - 1][1] + t * (latlngs[i][1] - latlngs[i - 1][1])];
    }
    walked += d;
  }
  return latlngs[0];
}

// Draw the map for a route (`path` as planned, transfers included) into `el`.
// `opts.owner` names the planner the map belongs to ('quick' or 'day'), so
// ticking steps in the other one leaves it alone; `opts.fromName` and
// `opts.toName` label the start and the finish.
let routeMapOwner = null;
async function renderRouteMap(el, path, done = 0, opts = {}) {
  await loadLeaflet();
  routeMapOwner = opts.owner || 'quick';
  if (!routeMap || routeMap.getContainer() !== el) {
    routeMap?.remove();
    routeMap = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 9, maxZoom: 18, zoomSnap: 0.5 });
    routeMap.attributionControl.setPrefix('').addAttribution('© OpenStreetMap contributors');
    addGpsControl(routeMap);
  }
  routeMapLayer?.remove();
  routeMapLayer = L.layerGroup().addTo(routeMap);
  routeMapMarkers = [];
  const renderer = L.canvas({ padding: 0.5 });

  // The whole area, faint: pistes in their colour, lifts grey.
  Object.entries(currentArea?.pisteLijnen || {}).forEach(([nr, lines]) => {
    const colour = pisteColourOf(nr);
    lines.forEach(line => {
      L.polyline(line.map(toLatLng), { renderer, color: colour, weight: 2, opacity: 0.22, interactive: true })
        .bindPopup(escapeHtml(pisteLabel(nr) + ((currentArea.pistes || []).find(p => p.pisteNr === nr)?.naam ? ` · ${(currentArea.pistes || []).find(p => p.pisteNr === nr).naam}` : '')))
        .addTo(routeMapLayer);
    });
  });
  (currentArea?.liften || []).forEach(l => {
    if (!l.coordOnder || !l.coordBoven) return;
    L.polyline([l.coordOnder, l.coordBoven], { renderer, color: '#8a99ab', weight: 1.5, opacity: 0.35 })
      .bindPopup(escapeHtml([liftCode(l.liftNr), l.naam].filter(Boolean).join(' ')))
      .addTo(routeMapLayer);
  });

  // The route on top: a white edge, then the colour.
  const pieces = routePieces(path);
  const bounds = [];
  pieces.forEach(piece => {
    if (piece.kind === 'lunch') { bounds.push(...piece.latlngs); return; }
    const colour = piece.kind === 'lift' ? MAP_LIFT_COLOUR : piece.kind === 'piste' ? pisteColourOf(piece.edge.pisteNr) : '#6a7d92';
    if (piece.gap) {
      L.polyline(piece.latlngs, { renderer, color: '#6a7d92', weight: 3, opacity: 0.9, dashArray: '2 6', interactive: false }).addTo(routeMapLayer);
      bounds.push(...piece.latlngs);
      return;
    }
    const dashed = piece.kind === 'link';
    L.polyline(piece.latlngs, { renderer, color: '#fff', weight: 10, opacity: 0.95, interactive: false }).addTo(routeMapLayer);
    L.polyline(piece.latlngs, { renderer, color: colour, weight: 6, opacity: 1, dashArray: dashed ? '6 8' : null })
      .bindPopup(escapeHtml(stepLabel(piece))).addTo(routeMapLayer);
    bounds.push(...piece.latlngs);
  });
  // Numbered dots halfway along each step (🍽 for lunch), drawn last so they
  // stay on top.
  pieces.filter(p => p.item != null).forEach(piece => {
    const html = piece.kind === 'lunch' ? '<span class="map-step map-lunch">🍽</span>' : `<span class="map-step">${piece.number}</span>`;
    const marker = L.marker(halfway(piece.latlngs), {
      icon: L.divIcon({ className: 'map-step-icon', html, iconSize: [26, 26], iconAnchor: [13, 13] }),
      keyboard: false,
    }).bindPopup(escapeHtml(stepLabel(piece))).addTo(routeMapLayer);
    routeMapMarkers[piece.item] = marker;
  });
  const drawn = pieces.filter(p => p.kind !== 'lunch');
  const first = drawn[0]?.latlngs[0], last = drawn[drawn.length - 1]?.latlngs.slice(-1)[0];
  if (first) {
    L.marker(first, { icon: L.divIcon({ className: 'map-step-icon', html: '<span class="map-start"></span>', iconSize: [16, 16], iconAnchor: [8, 8] }) })
      .bindPopup(escapeHtml(opts.fromName || 'Start')).addTo(routeMapLayer);
  }
  if (last) {
    L.marker(last, { icon: L.divIcon({ className: 'map-step-icon', html: '<span class="map-flag">🏁</span>', iconSize: [28, 28], iconAnchor: [6, 26] }) })
      .bindPopup(escapeHtml(opts.toName || 'Destination')).addTo(routeMapLayer);
  }
  routeMap.invalidateSize();
  if (bounds.length) routeMap.fitBounds(L.latLngBounds(bounds), { padding: [28, 28] });
  else if (first) routeMap.setView(first, 14);
  routeMap.off('zoomend', declutterSteps).on('zoomend', declutterSteps);
  // After the view is set: only then do the markers have their elements.
  updateRouteMapProgress(done, routeMapOwner);
}

// Numbers that would sit on top of each other at this zoom: show the
// current step's, then lunch, then the others in order, and hide what
// overlaps. Zooming in brings them back.
function declutterSteps() {
  if (!routeMap || !routeMap._loaded) return; // no view yet (before fitBounds)
  const rank = i => {
    const el = routeMapMarkers[i].getElement()?.querySelector('.map-step');
    return el?.classList.contains('is-current') ? 0 : el?.classList.contains('map-lunch') ? 1 : 2;
  };
  const order = routeMapMarkers.map((m, i) => i).filter(i => routeMapMarkers[i]);
  order.sort((a, b) => rank(a) - rank(b) || a - b);
  const placed = [];
  order.forEach(i => {
    const marker = routeMapMarkers[i];
    const pt = routeMap.latLngToContainerPoint(marker.getLatLng());
    const clash = placed.some(q => Math.hypot(q.x - pt.x, q.y - pt.y) < 24);
    const el = marker.getElement();
    if (el) el.style.visibility = clash ? 'hidden' : '';
    if (!clash) placed.push(pt);
  });
}

// The step you are at is big and yellow, steps done are faded.
function updateRouteMapProgress(done, owner) {
  if (owner !== routeMapOwner) return;
  routeMapMarkers.forEach((marker, i) => {
    const el = marker?.getElement()?.querySelector('.map-step');
    if (!el) return;
    el.classList.toggle('is-current', i === done);
    el.classList.toggle('is-done', i < done);
    if (i === done) marker.setZIndexOffset(1000); else marker.setZIndexOffset(0);
  });
  declutterSteps();
}

// 📍 button: show (and follow) where you are; tap again to stop.
function addGpsControl(map) {
  const Control = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'map-gps-btn');
      btn.type = 'button';
      btn.textContent = '📍';
      btn.title = 'Show my location';
      btn.setAttribute('aria-label', 'Show my location');
      L.DomEvent.disableClickPropagation(btn);
      btn.addEventListener('click', () => toggleMapGps(map, btn));
      return btn;
    },
  });
  new Control().addTo(map);
}

function toggleMapGps(map, btn) {
  if (routeMapGps) { stopMapGps(); btn.classList.remove('on'); return; }
  if (!navigator.geolocation) return;
  btn.classList.add('on');
  let first = true;
  const watch = navigator.geolocation.watchPosition(pos => {
    const here = [pos.coords.latitude, pos.coords.longitude];
    if (!routeMapGps) return;
    if (!routeMapGps.marker) {
      routeMapGps.marker = L.circleMarker(here, { radius: 8, color: '#fff', weight: 3, fillColor: '#2f80ed', fillOpacity: 1 }).addTo(map);
    } else routeMapGps.marker.setLatLng(here);
    if (first) { first = false; map.panTo(here); }
  }, () => { stopMapGps(); btn.classList.remove('on'); }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  routeMapGps = { watch, marker: null };
}

function stopMapGps() {
  if (!routeMapGps) return;
  navigator.geolocation.clearWatch(routeMapGps.watch);
  routeMapGps.marker?.remove();
  routeMapGps = null;
}
