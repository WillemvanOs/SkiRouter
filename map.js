// Route map: the route on a plain map of the ski area, drawn the way a paper
// piste map is.
//
// No map tiles: the area's own data is drawn on a light background, so the
// map works offline and stays easy to read.
// - Like a piste map, the valley is at the bottom and the mountain at the top:
//   the map is turned so that the lifts, on average, go up the screen. The
//   compass shows where north is; tap it for north up instead.
// - The whole area is drawn faintly. The route is drawn on top: pistes thick
//   in their colour, lifts as thin dark lines with a dot at each station, and
//   arrows along the way. The lifts and pistes of the route carry their
//   number, as on a piste map: lifts in a dark box, pistes in a circle of their
//   colour.
// - The map follows you: it shows the step you are at (yellow) and the next
//   three in full colour, the rest of the route lighter and the steps done in
//   grey. "Whole route" shows all of it.
// - Towns, villages and peaks (`plaatsen`, from OpenStreetMap) help you find
//   your way. Labels that would overlap are hidden, the least important first;
//   zooming in brings them back.
// Leaflet (vendor/leaflet, BSD-2) is loaded the first time the map is opened.

const MAP_COLOURS = { groen: '#22a050', blauw: '#1e6fd9', rood: '#d63b2f', zwart: '#1d1d1f', skiroute: '#e08a00' };
const MAP_LIFT_COLOUR = '#1a3a5c';
const MAP_DONE_COLOUR = '#a3afbd';
const MAP_LINK_COLOUR = '#6a7d92';
const MAP_FOCUS_STEPS = 4;      // the step you are at and the next three
const MAP_ARROW_EVERY_PX = 80;  // arrows along the route, this far apart on screen
const MAP_NORTH_KEY = 'skirouter:mapNorthUp';

let leafletLoading = null;
let routeMap = null;       // the Leaflet map, kept while the page lives
let routeMapKey = null;    // the area and orientation it was made for
let routeMapLayer = null;  // everything drawn on it for the current route
let routeArrowLayer = null;
let routeMapPieces = [];   // the route, as drawn (see routePieces)
let routeMapLabels = [];   // every label, for hiding the ones that overlap
let routeMapMarkers = [];  // the label of each tickable step, in step order
let routeMapBounds = null; // the whole route
let routeMapDone = 0;      // steps ticked
let routeMapFollow = true; // showing the step you are at (false: the whole route)
let routeMapLast = null;   // what was drawn last, to draw it again turned
let routeMapOwner = null;  // 'quick' or 'day'
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

// ── Orientation ──────────────────────────────────────────────────────────────

function mapNorthUp() {
  try { return localStorage.getItem(MAP_NORTH_KEY) === '1'; } catch { return false; }
}

// How far to turn the map so the mountain is up: lifts go uphill, so their
// summed direction (bottom to top, weighted by length) should point up the
// screen. When they point every which way (lifts all around a valley), the
// map stays north up. In steps of 5°.
function uphillTurn() {
  let sx = 0, sy = 0, total = 0;
  (currentArea?.liften || []).forEach(l => {
    if (!l.coordOnder || !l.coordBoven) return;
    const kx = 111320 * Math.cos(l.coordOnder[0] * Math.PI / 180);
    const dx = (l.coordBoven[1] - l.coordOnder[1]) * kx, dy = (l.coordBoven[0] - l.coordOnder[0]) * 110540;
    sx += dx; sy += dy; total += Math.hypot(dx, dy);
  });
  if (!total || Math.hypot(sx, sy) / total < 0.2) return 0;
  const step = Math.PI / 36;
  return Math.round((Math.PI / 2 - Math.atan2(sy, sx)) / step) * step;
}

function areaCentre() {
  const pts = (currentArea?.liften || []).flatMap(l => [l.coordOnder, l.coordBoven]).filter(Boolean);
  if (!pts.length) return [47, 11];
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

// A flat map in metres around the area, turned by `turn` (radians,
// anticlockwise). Zoom 0 is 1 pixel per metre.
function turnedCrs([lat0, lon0], turn) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const c = Math.cos(turn), s = Math.sin(turn);
  const projection = {
    project(ll) {
      const x = (ll.lng - lon0) * kx, y = (ll.lat - lat0) * ky;
      return L.point(x * c - y * s, x * s + y * c);
    },
    unproject(p) {
      const x = p.x * c + p.y * s, y = -p.x * s + p.y * c;
      return L.latLng(lat0 + y / ky, lon0 + x / kx);
    },
    bounds: L.bounds([-1e6, -1e6], [1e6, 1e6]),
  };
  return L.extend({}, L.CRS.Simple, {
    projection,
    transformation: new L.Transformation(1, 0, -1, 0),
    distance: (a, b) => distanceM([a.lat, a.lng], [b.lat, b.lng]),
  });
}

// ── The route as pieces ──────────────────────────────────────────────────────

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
// the piece's place among the tickable steps; `step` is the tickable step a
// piece belongs to (for a short walk or a gap: the step that follows it).
function routePieces(path) {
  const pos = stationPositions();
  const pieces = [];
  let cursor = pos[path.find(e => !e.lunch)?.from] || null;
  let number = 0, item = 0;
  // Where the mapped course of the next step starts away from where the last
  // one ended (a connecting path that is not mapped as a piste), a dotted
  // line keeps the route in one piece.
  const bridge = p => {
    if (cursor && distanceM(cursor, p) > 25) pieces.push({ kind: 'link', edge: { type: 'transfer' }, latlngs: [cursor, p], number: null, item: null, step: item, gap: true });
  };
  path.forEach(edge => {
    if (edge.stop) {
      // A stop of the day plan: at its station, not a step to tick.
      const at = pos[edge.stop.station] || cursor;
      if (at) pieces.push({ kind: 'stop', edge: { type: 'stop', name: edge.stop.name, place: edge.stop.kind }, latlngs: [at], number: null, item: null, step: item });
      return;
    }
    if (edge.lunch) {
      const r = edge.lunch;
      const at = r.lat != null && r.lon != null ? [r.lat, r.lon] : cursor;
      if (at) pieces.push({ kind: 'lunch', edge: { type: 'lunch', name: r.naam }, latlngs: [at], number: null, item, step: item });
      item++;
      return;
    }
    if (edge.type === 'transfer' || isConnection(edge)) {
      const a = cursor || pos[edge.from], b = pos[edge.to];
      const counted = edge.type !== 'transfer';
      if (a && b) pieces.push({ kind: 'link', edge, latlngs: [a, b], number: counted ? ++number : null, item: counted ? item : null, step: item });
      else if (counted) ++number;
      if (counted) item++;
      cursor = b || cursor;
      return;
    }
    if (edge.type !== 'piste') {
      const a = pos[edge.from], b = pos[edge.to];
      ++number;
      if (a) bridge(a);
      if (a && b) pieces.push({ kind: 'lift', edge, latlngs: [a, b], number, item, step: item });
      item++;
      cursor = b || cursor;
      return;
    }
    const parts = splitTrajecten(edge);
    parts.forEach((part, k) => {
      ++number;
      const target = pos[part.to] || (parts[k + 1] ? pisteJunction(part.pisteNr, parts[k + 1].pisteNr) : pos[edge.to]);
      const seg = pisteSegment(part.pisteNr, cursor, target);
      if (seg) { bridge(seg[0]); pieces.push({ kind: 'piste', edge: part, latlngs: seg, number, item, step: item }); }
      else if (cursor && target) pieces.push({ kind: 'link', edge: part, latlngs: [cursor, target], number, item, step: item, unknown: true });
      item++;
      cursor = seg ? seg[seg.length - 1] : target || cursor;
    });
  });
  return pieces;
}

function pisteOf(nr) {
  return (currentArea?.pistes || []).find(p => p.pisteNr === nr);
}

function pisteColourOf(nr) {
  return MAP_COLOURS[pisteOf(nr)?.kleur] || '#8a99ab';
}

// A number as on a piste map; runs without one go by their name.
const hasOwnNumber = nr => nr && !String(nr).startsWith('~') && String(nr).length <= 4;

function shortName(name, max = 14) {
  const text = String(name || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stepLabel(piece) {
  const e = piece.edge;
  const step = piece.number ? `Step ${piece.number} · ` : '';
  if (piece.kind === 'lunch') return `Lunch · ${e.name}`;
  if (piece.kind === 'stop') return `Stop · ${e.name}`;
  if (piece.kind === 'lift') return `${step}${[liftCode(e.liftNr), e.name].filter(Boolean).join(' ')}`;
  if (e.pisteNr) {
    const name = hasOwnNumber(e.pisteNr) ? pisteOf(e.pisteNr)?.naam : null;
    return `${step}${pisteLabel(e.pisteNr)}${name ? ` (${name})` : ''}`;
  }
  if (e.type === 'transfer') return 'Short walk';
  return `${step}${tagLabel(e)}`;
}

// The label a step carries on the map.
function stepTagHtml(piece) {
  const e = piece.edge;
  if (piece.kind === 'lunch') return `<span class="map-tag map-lunch">${ICONS.restaurant}</span>`;
  if (piece.kind === 'lift') {
    return `<span class="map-tag map-lift">${escapeHtml(liftCode(e.liftNr) || shortName(e.name) || '▲')}</span>`;
  }
  if (e.pisteNr) {
    const own = hasOwnNumber(e.pisteNr);
    const text = own ? e.pisteNr : shortName(pisteOf(e.pisteNr)?.naam) || '•';
    return `<span class="map-tag map-piste${own ? '' : ' is-name'}" style="background:${pisteColourOf(e.pisteNr)}">${escapeHtml(text)}</span>`;
  }
  return `<span class="map-tag map-link">${e.type === 'bus' ? ICONS.bus : ICONS.walk}</span>`;
}

// The point halfway along a line, where its label goes.
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

// A label: centred on its point, sized by its text.
function labelMarker(latlng, html, interactive = false) {
  return L.marker(latlng, {
    icon: L.divIcon({ className: 'map-label', html, iconSize: null }),
    keyboard: false, interactive,
  });
}

// ── Drawing ──────────────────────────────────────────────────────────────────

// Draw the map for a route (`path` as planned, transfers included) into `el`.
// `opts.owner` names the planner the map belongs to ('quick' or 'day'), so
// ticking steps in the other one leaves it alone; `opts.fromName` and
// `opts.toName` label the start and the finish.
async function renderRouteMap(el, path, done = 0, opts = {}) {
  await loadLeaflet();
  routeMapLast = { el, path, opts };
  const turn = mapNorthUp() ? 0 : uphillTurn();
  const key = `${currentArea?.id}|${turn}`;
  if (!routeMap || routeMap.getContainer() !== el || routeMapKey !== key) {
    leaveRouteMap();
    routeMap?.remove();
    routeMap = L.map(el, {
      crs: turnedCrs(areaCentre(), turn),
      zoomControl: true, attributionControl: true,
      minZoom: -9, maxZoom: 2, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
    });
    routeMap.attributionControl.setPrefix('').addAttribution('© OpenStreetMap contributors');
    routeMap.createPane('arrows').style.zIndex = 450; // above the lines, below the labels
    addMapControls(routeMap, turn);
    routeMap.on('zoomend', drawArrows).on('moveend', declutterSoon);
    routeMapKey = key;
  }
  routeMapOwner = opts.owner || 'quick';
  routeMapLayer?.remove();
  routeArrowLayer?.remove();
  routeMapLayer = L.layerGroup().addTo(routeMap);
  routeArrowLayer = L.layerGroup().addTo(routeMap);
  routeMapLabels = [];
  routeMapMarkers = [];
  const renderer = L.canvas({ padding: 0.5 });

  // The whole area, faint: pistes in their colour, lifts grey.
  Object.entries(currentArea?.pisteLijnen || {}).forEach(([nr, lines]) => {
    const colour = pisteColourOf(nr);
    const name = pisteLabel(nr) + (pisteOf(nr)?.naam && hasOwnNumber(nr) ? ` · ${pisteOf(nr).naam}` : '');
    lines.forEach(line => {
      L.polyline(line.map(toLatLng), { renderer, color: colour, weight: 2, opacity: 0.17 })
        .bindPopup(escapeHtml(name)).addTo(routeMapLayer);
    });
  });
  (currentArea?.liften || []).forEach(l => {
    if (!l.coordOnder || !l.coordBoven) return;
    L.polyline([l.coordOnder, l.coordBoven], { renderer, color: '#8a99ab', weight: 1.5, opacity: 0.3 })
      .bindPopup(escapeHtml([liftCode(l.liftNr), l.naam].filter(Boolean).join(' '))).addTo(routeMapLayer);
  });

  // Towns, villages and peaks.
  // Peaks come in the area first (tools/lib/landmarks.mjs): their order is their rank.
  (currentArea?.plaatsen || []).forEach((p, i) => {
    const peak = p.k === 'peak';
    const html = peak
      ? `<span class="map-tag map-peak">▲ ${escapeHtml(p.n)}${p.ele ? ` <small>${p.ele}</small>` : ''}</span>`
      : `<span class="map-tag map-place is-${p.k}">${escapeHtml(p.n)}</span>`;
    const rank = peak ? 7 + i / 1000 : { town: 4, village: 6, hamlet: 9 }[p.k] ?? 9;
    routeMapLabels.push({ marker: labelMarker([p.lat, p.lon], html).addTo(routeMapLayer), rank: () => rank });
  });

  // The route on top.
  const pieces = routePieces(path);
  routeMapPieces = pieces;
  const bounds = [];
  pieces.forEach(piece => {
    bounds.push(...piece.latlngs);
    if (piece.kind === 'lunch' || piece.kind === 'stop') return;
    if (!piece.gap) piece.casing = L.polyline(piece.latlngs, { renderer, color: '#fff', interactive: false }).addTo(routeMapLayer);
    piece.line = L.polyline(piece.latlngs, { renderer, interactive: !piece.gap }).addTo(routeMapLayer);
    if (!piece.gap) piece.line.bindPopup(escapeHtml(stepLabel(piece)));
    if (piece.kind === 'lift') {
      piece.dots = piece.latlngs.map(p => L.circleMarker(p, { renderer, radius: 4, color: MAP_LIFT_COLOUR, weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(routeMapLayer));
    }
  });
  // Labels (lift and piste numbers, lunch), drawn last so they stay on top.
  pieces.filter(p => p.item != null).forEach(piece => {
    const marker = labelMarker(halfway(piece.latlngs), stepTagHtml(piece), true)
      .bindPopup(escapeHtml(stepLabel(piece))).addTo(routeMapLayer);
    piece.label = marker;
    routeMapMarkers[piece.item] = marker;
    routeMapLabels.push({ marker, rank: () => stepRank(piece), step: true });
  });

  // Stops of the day plan.
  pieces.filter(p => p.kind === 'stop').forEach(piece => {
    const html = `<span class="map-tag map-lunch map-stop">${PLACE_ICONS[piece.edge.place] || ICONS.start}</span>`;
    const marker = labelMarker(piece.latlngs[0], html, true).bindPopup(escapeHtml(stepLabel(piece))).addTo(routeMapLayer);
    routeMapLabels.push({ marker, rank: () => 1.5, step: true });
  });

  // Start and finish.
  const drawn = pieces.filter(p => p.kind !== 'lunch' && p.kind !== 'stop');
  const first = drawn[0]?.latlngs[0], last = drawn[drawn.length - 1]?.latlngs.slice(-1)[0];
  const roundTrip = first && last && (distanceM(first, last) < 60 || (opts.fromName && opts.fromName === opts.toName));
  if (first) {
    L.marker(first, { icon: L.divIcon({ className: 'map-step-icon', html: '<span class="map-start"></span>', iconSize: [16, 16], iconAnchor: [8, 8] }) })
      .bindPopup(escapeHtml(opts.fromName || 'Start')).addTo(routeMapLayer);
    const html = `<span class="map-tag map-end"><b>${roundTrip ? 'Start & finish' : 'Start'}</b> ${escapeHtml(shortName(opts.fromName, 24))}</span>`;
    routeMapLabels.push({ marker: labelMarker(first, html).addTo(routeMapLayer), rank: () => 3 });
  }
  if (last) {
    L.marker(last, { icon: L.divIcon({ className: 'map-step-icon', html: `<span class="map-flag">${ICONS.finish}</span>`, iconSize: [28, 28], iconAnchor: [6, 26] }) })
      .bindPopup(escapeHtml(opts.toName || 'Destination')).addTo(routeMapLayer);
    if (!roundTrip) {
      const html = `<span class="map-tag map-end"><b>Finish</b> ${escapeHtml(shortName(opts.toName, 24))}</span>`;
      routeMapLabels.push({ marker: labelMarker(last, html).addTo(routeMapLayer), rank: () => 3 });
    }
  }

  routeMapBounds = bounds.length ? L.latLngBounds(bounds) : null;
  routeMap.invalidateSize();
  // A first view, so the map has its size and zoom; then the step you are at.
  if (routeMapBounds) routeMap.fitBounds(routeMapBounds, { padding: [28, 28], animate: false });
  else routeMap.setView(first || areaCentre(), -3);
  updateFollowButton();
  updateRouteMapProgress(done, routeMapOwner, { animate: false });
}

// Where a piece is in the day: done, the step you are at or one of the next
// three (focus), or later.
function pieceState(piece) {
  if (piece.step < routeMapDone) return 'done';
  return piece.step < routeMapDone + MAP_FOCUS_STEPS ? 'focus' : 'later';
}

// Which labels stay when they overlap: lower first.
function stepRank(piece) {
  if (piece.item === routeMapDone) return 0;
  if (piece.kind === 'lunch') return 1;
  const state = pieceState(piece);
  return state === 'focus' ? 2 : state === 'later' ? 5 : 8;
}

function styleRoute() {
  routeMapPieces.forEach(piece => {
    if (!piece.line) return;
    const state = pieceState(piece);
    const lift = piece.kind === 'lift';
    const colour = state === 'done' ? MAP_DONE_COLOUR
      : lift ? MAP_LIFT_COLOUR
      : piece.edge.pisteNr ? pisteColourOf(piece.edge.pisteNr) : MAP_LINK_COLOUR;
    const weight = state === 'done' ? (lift ? 2.5 : 4) : state === 'focus' ? (lift ? 4 : 7) : (lift ? 3 : 5);
    const opacity = state === 'later' ? 0.55 : state === 'done' ? 0.7 : 1;
    if (piece.gap) {
      piece.line.setStyle({ color: state === 'done' ? MAP_DONE_COLOUR : MAP_LINK_COLOUR, weight: 3, opacity: 0.9 * opacity, dashArray: '2 6' });
    } else {
      piece.casing.setStyle({ weight: weight + (lift ? 4 : 5), opacity: state === 'done' ? 0 : 0.95 * opacity });
      piece.line.setStyle({ color: colour, weight, opacity, dashArray: piece.kind === 'link' ? '6 8' : null });
    }
    (piece.dots || []).forEach(d => d.setStyle({ color: state === 'done' ? MAP_DONE_COLOUR : MAP_LIFT_COLOUR, opacity, fillOpacity: opacity }));
  });
  routeMapPieces.forEach(piece => {
    const tag = piece.label?.getElement()?.querySelector('.map-tag');
    if (!tag) return;
    const state = pieceState(piece);
    tag.classList.toggle('is-current', piece.item === routeMapDone);
    tag.classList.toggle('is-done', state === 'done');
    tag.classList.toggle('is-later', state === 'later');
  });
  // The steps to come on top of the ones done, the next ones on top of all.
  ['later', 'focus'].forEach(state => routeMapPieces.forEach(piece => {
    if (!piece.line || pieceState(piece) !== state) return;
    piece.casing?.bringToFront();
    piece.line.bringToFront();
    (piece.dots || []).forEach(d => d.bringToFront());
  }));
  routeMapMarkers.forEach((marker, i) => marker?.setZIndexOffset(i === routeMapDone ? 1000 : 0));
}

// Ticked a step: restyle, and follow along when following.
function updateRouteMapProgress(done, owner, { animate = true } = {}) {
  if (!routeMap || owner !== routeMapOwner) return;
  routeMapDone = done;
  styleRoute();
  if (routeMapFollow) showFocus(animate);
  drawArrows();
  declutterLabels();
}

// The step you are at and the next three, or the whole route when all is done.
function focusBounds() {
  const pts = routeMapPieces.filter(p => !p.gap && pieceState(p) === 'focus').flatMap(p => p.latlngs);
  return pts.length ? L.latLngBounds(pts) : routeMapBounds;
}

function showFocus(animate = true) {
  const bounds = focusBounds();
  if (!bounds) return;
  const opts = { padding: [44, 44], maxZoom: -0.5 };
  if (animate) routeMap.flyToBounds(bounds, { ...opts, duration: 0.6 });
  else routeMap.fitBounds(bounds, { ...opts, animate: false });
}

function showWholeRoute(animate = true) {
  if (routeMapBounds) routeMap.fitBounds(routeMapBounds, { padding: [28, 28], animate });
}

// Arrows along the route still to come, about every 80 pixels.
function drawArrows() {
  if (!routeMap || !routeMap._loaded || !routeArrowLayer) return;
  routeArrowLayer.clearLayers();
  let count = 0;
  routeMapPieces.forEach(piece => {
    if (!piece.line || piece.gap || pieceState(piece) === 'done' || count > 400) return;
    const pts = piece.latlngs.map(p => routeMap.latLngToLayerPoint(p));
    const total = pts.slice(1).reduce((s, p, i) => s + p.distanceTo(pts[i]), 0);
    if (total < 36) return;
    const every = Math.max(MAP_ARROW_EVERY_PX, total / 6);
    let next = total < every ? total / 2 : every / 2;
    let walked = 0;
    for (let i = 1; i < pts.length && count <= 400; i++) {
      const a = pts[i - 1], b = pts[i], d = a.distanceTo(b);
      while (d && next <= walked + d) {
        const t = (next - walked) / d;
        const at = routeMap.layerPointToLatLng(L.point(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)));
        const deg = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        L.marker(at, {
          icon: L.divIcon({ className: 'map-arrow-icon', iconSize: [14, 14], iconAnchor: [7, 7],
            html: `<svg class="map-arrow${pieceState(piece) === 'later' ? ' is-later' : ''}" viewBox="0 0 14 14" width="14" height="14" style="transform:rotate(${deg.toFixed(0)}deg)"><path d="M4.5 3 L9.5 7 L4.5 11"/></svg>` }),
          interactive: false, keyboard: false, pane: 'arrows',
        }).addTo(routeArrowLayer);
        count++;
        next += every;
      }
      walked += d;
    }
  });
}

// After a move or zoom, once Leaflet's zoom animation has settled (labels
// measured halfway through it are in the wrong place).
let declutterTimer = null;
function declutterSoon() {
  clearTimeout(declutterTimer);
  declutterTimer = setTimeout(declutterLabels, 300);
}

// Labels that would sit on top of each other at this zoom: keep the most
// important (the step you are at, lunch, the next steps, start and finish,
// towns, the rest of the route, villages, peaks, steps done, hamlets) and
// hide what overlaps. Zooming in brings them back.
function declutterLabels() {
  declutter(routeMap, routeMapLabels);
}

function declutter(map, labels) {
  if (!map || !map._loaded) return; // no view yet
  const box = map.getContainer().getBoundingClientRect();
  const placed = [];
  labels
    .map((label, i) => ({ label, rank: label.rank(), i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .forEach(({ label }) => {
      const icon = label.marker.getElement();
      const tag = icon?.firstElementChild;
      if (!tag) return;
      const r = tag.getBoundingClientRect();
      const onScreen = r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
      // A name cut off by the edge reads wrong ("CHBERG"): hide it until you pan.
      const cut = !label.step && onScreen && (r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom);
      const clash = cut || (onScreen && placed.some(q => r.left < q.right + 3 && r.right > q.left - 3 && r.top < q.bottom + 3 && r.bottom > q.top - 3));
      icon.style.visibility = clash ? 'hidden' : '';
      if (onScreen && !clash) placed.push(r);
    });
}

// ── Controls ─────────────────────────────────────────────────────────────────

function mapButton(map, position, className, html, title, onClick) {
  const Control = L.Control.extend({
    options: { position },
    onAdd() {
      const btn = L.DomUtil.create('button', `map-btn ${className}`);
      btn.type = 'button';
      btn.innerHTML = html;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      L.DomEvent.disableClickPropagation(btn);
      btn.addEventListener('click', () => onClick(btn));
      return btn;
    },
  });
  new Control().addTo(map);
}

function addMapControls(map, turn) {
  mapButton(map, 'topleft', 'map-full-btn', '⛶', 'Full screen', btn => toggleMapFull(btn));
  mapButton(map, 'topright', 'map-gps-btn', ICONS.gps, 'Show my location', btn => toggleMapGps(map, btn));
  // The compass: its needle points north. Tap for north up, or back.
  const deg = -turn * 180 / Math.PI;
  mapButton(map, 'topright', 'map-compass-btn',
    `<svg viewBox="0 0 24 24" width="24" height="24" style="transform:rotate(${deg.toFixed(0)}deg)"><path d="M12 3 L16 12 L12 10.5 L8 12 Z" fill="#d63b2f"/><path d="M12 21 L8 12 L12 13.5 L16 12 Z" fill="#8a99ab"/></svg>` +
      `<span class="map-compass-n" style="left:${(50 + 36 * Math.sin(deg * Math.PI / 180)).toFixed(0)}%;top:${(50 - 36 * Math.cos(deg * Math.PI / 180)).toFixed(0)}%">N</span>`,
    mapNorthUp() ? 'North up: tap to turn the map like a piste map' : turn ? 'Turned like a piste map: tap for north up' : 'North up',
    () => {
      try { localStorage.setItem(MAP_NORTH_KEY, mapNorthUp() ? '0' : '1'); } catch {}
      if (routeMapLast) renderRouteMap(routeMapLast.el, routeMapLast.path, routeMapDone, routeMapLast.opts);
    });
  mapButton(map, 'bottomleft', 'map-follow-btn', '', '', () => {
    routeMapFollow = !routeMapFollow;
    if (routeMapFollow) showFocus(); else showWholeRoute();
    updateFollowButton();
  });
}

function updateFollowButton() {
  const btn = routeMap?.getContainer().querySelector('.map-follow-btn');
  if (!btn) return;
  btn.textContent = routeMapFollow ? '⤢ Whole route' : '◎ My step';
  btn.title = routeMapFollow ? 'Show the whole route' : 'Show the step you are at';
  btn.setAttribute('aria-label', btn.title);
}

// Full screen: the map over the whole page (also on iPhone, which has no
// full screen for page elements). ✕ or Escape closes it.
let routeMapHome = null; // where the map sits on the page while full screen

function toggleMapFull(btn, on) {
  const el = routeMap?.getContainer();
  if (!el) return;
  on = on ?? !el.classList.contains('is-full');
  // On top of the page, outside the result card (whose animation would
  // otherwise keep a fixed map inside it).
  if (on && !routeMapHome) {
    routeMapHome = document.createComment('route map');
    el.replaceWith(routeMapHome);
    document.body.appendChild(el);
  } else if (!on && routeMapHome) {
    routeMapHome.replaceWith(el);
    routeMapHome = null;
  }
  el.classList.toggle('is-full', on);
  document.body.classList.toggle('map-full', on);
  btn = btn || el.querySelector('.map-full-btn');
  if (btn) {
    btn.textContent = on ? '✕' : '⛶';
    btn.title = on ? 'Close full screen' : 'Full screen';
    btn.setAttribute('aria-label', btn.title);
  }
  setTimeout(() => {
    if (!routeMap) return;
    routeMap.invalidateSize();
    if (routeMapFollow) showFocus(false); else showWholeRoute(false);
  }, 50);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('map-full')) toggleMapFull(null, false);
});

// Leaving the map (list view, other tab): stop following your position and
// close full screen.
function leaveRouteMap() {
  stopMapGps();
  if (document.body.classList.contains('map-full')) toggleMapFull(null, false);
}

// 📍 button: show (and follow) where you are; tap again to stop.
function toggleMapGps(map, btn) {
  if (routeMapGps) { stopMapGps(); return; }
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
  }, () => stopMapGps(), { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  routeMapGps = { watch, marker: null };
}

function stopMapGps() {
  if (!routeMapGps) return;
  navigator.geolocation.clearWatch(routeMapGps.watch);
  routeMapGps.marker?.remove();
  routeMapGps = null;
  routeMap?.getContainer().querySelector('.map-gps-btn')?.classList.remove('on');
}

// ── Picking on the map ───────────────────────────────────────────────────────
//
// The station picker can show the area as a map instead of a list (🗺 Map):
// every lift with its code, and the places of the list on screen (points of
// interest, or villages and peaks). A tap on a lift asks bottom or top (or,
// for a day plan stop, to ride it); a tap on a place picks it. Same plain map
// as the route map: no tiles, turned like a piste map unless north up.

let pickerMap = null;
let pickerMapKey = null;
let pickerLayer = null;
let pickerLabels = [];
let pickerDeclutterTimer = null;

// `onLift(lift, dalBerg)` and `onPlace(place)` pick; `stopMode` asks to ride
// a lift instead of bottom or top.
async function renderPickerMap(el, kind, { onLift, onPlace, stopMode }) {
  await loadLeaflet();
  const turn = mapNorthUp() ? 0 : uphillTurn();
  const key = `${currentArea?.id}|${turn}`;
  if (!pickerMap || pickerMapKey !== key) {
    pickerMap?.remove();
    pickerMap = L.map(el, {
      crs: turnedCrs(areaCentre(), turn), zoomControl: true, attributionControl: true,
      minZoom: -9, maxZoom: 2, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
    });
    pickerMap.attributionControl.setPrefix('').addAttribution('© OpenStreetMap contributors');
    pickerMap.on('moveend', () => {
      clearTimeout(pickerDeclutterTimer);
      pickerDeclutterTimer = setTimeout(() => declutter(pickerMap, pickerLabels), 300);
    });
    pickerMapKey = key;
  }
  pickerLayer?.remove();
  pickerLayer = L.layerGroup().addTo(pickerMap);
  pickerLabels = [];
  const renderer = L.canvas({ padding: 0.5, tolerance: 12 }); // lines easy to hit with a finger

  // The pistes faint, for orientation.
  Object.entries(currentArea?.pisteLijnen || {}).forEach(([nr, lines]) => {
    lines.forEach(line => L.polyline(line.map(toLatLng), { renderer, color: pisteColourOf(nr), weight: 2, opacity: 0.25, interactive: false }).addTo(pickerLayer));
  });
  // Villages and peaks as names, unless they are what is being picked.
  if (kind !== 'towns') {
    (currentArea?.plaatsen || []).forEach((p, i) => {
      const html = p.k === 'peak'
        ? `<span class="map-tag map-peak">▲ ${escapeHtml(p.n)}</span>`
        : `<span class="map-tag map-place is-${p.k}">${escapeHtml(p.n)}</span>`;
      pickerLabels.push({ marker: labelMarker([p.lat, p.lon], html).addTo(pickerLayer), rank: () => 8 + i / 1000 });
    });
  }

  // Every lift: a line to tap, a dot at each station and its code.
  const bounds = [];
  LIFTS.forEach(lift => {
    const l = (currentArea?.liften || []).find(x => x.liftNr === lift.nr);
    if (!l?.coordOnder || !l?.coordBoven) return;
    const pts = [l.coordOnder, l.coordBoven];
    bounds.push(...pts);
    const dim = kind !== 'lifts';
    L.polyline(pts, { renderer, color: '#fff', weight: 8, opacity: dim ? 0.5 : 0.9, interactive: false }).addTo(pickerLayer);
    // While places are picked the lifts are only for orientation: not
    // tappable, so a tap near a place never picks a lift by mistake.
    const line = L.polyline(pts, { renderer, color: MAP_LIFT_COLOUR, weight: 4, opacity: dim ? 0.45 : 1, interactive: !dim }).addTo(pickerLayer);
    pts.forEach(p => L.circleMarker(p, { renderer, radius: 4, color: MAP_LIFT_COLOUR, weight: 2, fillColor: '#fff', fillOpacity: 1, opacity: dim ? 0.45 : 1, interactive: false }).addTo(pickerLayer));
    if (dim) return;
    const name = [liftCode(lift.nr), lift.name].filter(Boolean).join(' ');
    const popup = stopMode
      ? `<div class="pick-pop"><strong>${escapeHtml(name)}</strong><button type="button" data-pick="ride">🚡 Ride this lift</button></div>`
      : `<div class="pick-pop"><strong>${escapeHtml(name)}</strong>
          <button type="button" data-pick="dal">⬇ Bottom · ${escapeHtml(shortName(STATIONS[lift.dal]?.name, 28))}</button>
          <button type="button" data-pick="berg">⬆ Top · ${escapeHtml(shortName(STATIONS[lift.berg]?.name, 28))}</button></div>`;
    const choose = which => onLift(lift, which === 'berg' ? 'berg' : 'dal');
    line.bindPopup(popup, { closeButton: false }).on('popupopen', e => {
      e.popup.getElement().querySelectorAll('[data-pick]').forEach(btn => btn.addEventListener('click', () => choose(btn.dataset.pick)));
    });
    const tag = labelMarker(halfway(pts), `<span class="map-tag map-lift">${escapeHtml(liftCode(lift.nr) || shortName(lift.name, 12))}</span>`, true)
      .on('click', () => line.openPopup(halfway(pts))).addTo(pickerLayer);
    pickerLabels.push({ marker: tag, rank: () => 2 });
  });

  // The places of the list on screen, to tap.
  if (kind !== 'lifts') {
    areaPlaces(kind).forEach(place => {
      if (place.lat == null || !placeStation(place)) return;
      const icon = `<span class="map-tag map-lunch pick-place">${PLACE_ICONS[place.kind] || ICONS.start}</span>`;
      const marker = labelMarker([place.lat, place.lon], icon, true).addTo(pickerLayer);
      marker.bindTooltip(escapeHtml(place.name), { direction: 'top', offset: [0, -14] });
      marker.on('click', () => onPlace(place));
      pickerLabels.push({ marker, rank: () => 1 });
      bounds.push([place.lat, place.lon]);
    });
  }

  pickerMap.invalidateSize();
  if (bounds.length) pickerMap.fitBounds(L.latLngBounds(bounds), { padding: [20, 20], animate: false });
  else pickerMap.setView(areaCentre(), -3);
  declutter(pickerMap, pickerLabels);
}

