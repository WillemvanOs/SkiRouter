// ── Data ────────────────────────────────────────────────────────────────────
//
// This app understands exactly one dataset shape: the skimap-reader
// protocol's export — top-level `liften` + `pistes`, connected by lift
// codes (not place names): a piste's `beginBovenBij` names the lifts whose
// top it starts at, and `bereikbareLiften` names every lift whose bottom it
// eventually reaches — already flattened through any `komtLangs` (passes a
// station without ending there), `splitstNaar` (forks, but the piste itself
// carries on) and `gaatOverIn` (the marked number changes into another
// piste) chains, so this app reads `bereikbareLiften` directly rather than
// re-deriving it. `beginPlaats`/`eindPlaats`/`vertrektBij`/`komtAanBij` are
// free text for descriptions only — nothing is matched on them.
//
// buildFromSkimapData() below builds everything the planner needs —
// per-lift top/bottom nodes, the routing graph, and the lift list for the
// picker — directly from `liften`/`pistes` each time an area loads.

let STATIONS     = {}; // nodeId ("<liftNr>-boven"/"-onder") -> { name, alt: null }
let LIFTS        = []; // [{ nr, name, sector, type, echteLift, dal: nodeId, berg: nodeId }] — for the picker
let SECTOR_ORDER = [];
let GRAPH        = {};

const SIDE_ICONS = { dal: '⬇', berg: '⬆' };

// A piste's descent time in minutes: use it when given, otherwise estimate
// from length at ~12 km/h (200 m/min) — a rough but steady average across
// this app's own historical tijd/km data, regardless of difficulty.
function pisteTijd(piste) {
  if (piste.tijd != null) return piste.tijd;
  if (piste.lengteM != null) return Math.round(piste.lengteM / 200);
  return 0;
}

// Altitude is never known from this format. Render nothing instead of
// "undefinedm"/"nullm" wherever a station's alt would otherwise be shown.
function formatAlt(alt) {
  return alt != null ? `${alt}m` : '';
}

// ── Graph ────────────────────────────────────────────────────────────────────

// Lift types you may also ride down in.
const RIDE_DOWN_TYPES = new Set(['gondola', 'mixed_lift', 'cable_car', 'funicular']);
// Extra routing cost of riding a lift down, so a route only does it when no
// piste gets you there (the time shown stays the real ride time).
const RIDE_DOWN_PENALTY = 60;

function buildFromSkimapData(area) {
  const stations = {};
  const liften = area.liften || [];
  const pistes = area.pistes || [];
  const liftByNr = new Map(liften.map(l => [l.liftNr, l]));

  const graph = {};
  function addEdge(edge) {
    if (!graph[edge.from]) graph[edge.from] = [];
    graph[edge.from].push(edge);
  }

  const lifts = [];
  const sectorOrder = [];
  const seenSectors = new Set();

  liften.forEach(lift => {
    if (!lift.liftNr) return;
    const bottomId = `${lift.liftNr}-onder`;
    const topId    = `${lift.liftNr}-boven`;
    stations[bottomId] = { name: lift.vertrektBij || lift.liftNr, alt: null };
    stations[topId]    = { name: lift.komtAanBij  || lift.liftNr, alt: null };

    addEdge({
      from: bottomId, to: topId,
      type: lift.type || 'gondola',
      echteLift: lift.echteLift !== false,
      liftNr: lift.liftNr,
      name: lift.naam || lift.liftNr,
      tijd: lift.tijd || 0,
    });

    // Gondolas and cable cars can also be ridden down: the only way back to a
    // valley station that no piste reaches (e.g. G8 Panoramabahn). Never for
    // chairlifts, drag lifts or carpets.
    if (lift.echteLift !== false && RIDE_DOWN_TYPES.has(lift.type)) {
      addEdge({
        from: topId, to: bottomId,
        type: lift.type,
        echteLift: true,
        descent: true,
        liftNr: lift.liftNr,
        name: lift.naam || lift.liftNr,
        tijd: lift.tijd || 0,
      });
    }

    const sector = lift.komtAanBij || 'Other';
    if (!seenSectors.has(sector)) { seenSectors.add(sector); sectorOrder.push(sector); }

    lifts.push({
      nr: lift.liftNr,
      name: lift.naam || lift.liftNr,
      sector,
      type: lift.type || 'gondola',
      echteLift: lift.echteLift !== false,
      dal: bottomId,
      berg: topId,
    });
  });

  pistes.forEach(piste => {
    if (!piste.pisteNr) return;
    const beginLifts = piste.beginBovenBij || [];
    const reachLifts = piste.bereikbareLiften || piste.eindigtBij || [];
    if (!beginLifts.length || !reachLifts.length) return;

    const tijd = pisteTijd(piste);
    const km   = piste.lengteM != null ? piste.lengteM / 1000 : undefined;

    beginLifts.forEach(fromNr => {
      if (!liftByNr.has(fromNr)) return;
      reachLifts.forEach(toNr => {
        if (!liftByNr.has(toNr)) return;
        addEdge({
          from: `${fromNr}-boven`,
          to: `${toNr}-onder`,
          type: 'piste',
          diff: piste.kleur,
          pisteNr: piste.pisteNr,
          name: piste.naam || `Piste ${piste.pisteNr}`,
          trajecten: piste.trajecten || null,
          tijd, km,
        });
      });
    });
  });

  // aansluitendeLiften: reachable from the top of this lift without a
  // marked piste (e.g. a short walk between two stations at the same spot).
  const seenTransfers = new Set();
  liften.forEach(lift => {
    (lift.aansluitendeLiften || []).forEach(otherNr => {
      if (!liftByNr.has(otherNr) || otherNr === lift.liftNr) return;
      const a = `${lift.liftNr}-boven`;
      const b = `${otherNr}-onder`;
      const key = [a, b].sort().join('|');
      if (seenTransfers.has(key)) return;
      seenTransfers.add(key);
      addEdge({ from: a, to: b, type: 'transfer', name: 'Transfer', tijd: 0 });
      addEdge({ from: b, to: a, type: 'transfer', name: 'Transfer', tijd: 0 });
    });
  });

  STATIONS     = stations;
  LIFTS        = lifts;
  SECTOR_ORDER = sectorOrder;
  GRAPH        = graph;
}

// ── Area loading ─────────────────────────────────────────────────────────────
//
// The app starts with a gebied-picker (see index.html #area-picker). Picking
// an area fetches data/<area>.json, builds the routing graph from its
// liften/pistes, and only then reveals the route planner UI.

const AREA_REGISTRY_URL = 'data/areas.json';
const LAST_AREA_KEY      = 'skiplanner:lastArea';

let currentArea = null;

async function initApp() {
  const listEl = document.getElementById('area-list');
  try {
    const response = await fetch(AREA_REGISTRY_URL);
    if (!response.ok) throw new Error(`${response.status}`);
    const areas = await response.json();
    renderAreaList(areas);

    const lastAreaId = localStorage.getItem(LAST_AREA_KEY);
    const lastArea    = areas.find(a => a.id === lastAreaId);
    if (lastArea) await selectArea(lastArea);
  } catch (err) {
    console.error('Could not load the ski area list:', err);
    listEl.innerHTML = '<div class="area-error">⚠ The ski area list could not be loaded.</div>';
  }
}

function renderAreaList(areas) {
  const listEl = document.getElementById('area-list');
  listEl.innerHTML = '';

  if (!areas.length) {
    listEl.innerHTML = '<div class="area-error">No ski areas available yet.</div>';
    return;
  }

  areas.forEach(area => {
    const btn = document.createElement('button');
    btn.className = 'area-btn';
    btn.innerHTML = `
      <span class="area-btn-name">🏔 ${area.name}</span>
      <span class="area-btn-sub">${area.subtitle || ''}</span>
    `;
    btn.addEventListener('click', () => selectArea(area));
    listEl.appendChild(btn);
  });
}

async function selectArea(areaMeta) {
  const listEl = document.getElementById('area-list');
  try {
    const response = await fetch(areaMeta.file);
    if (!response.ok) throw new Error(`${response.status}`);
    const area = await response.json();

    buildFromSkimapData(area);
    currentArea = area;

    localStorage.setItem(LAST_AREA_KEY, area.id);
    applyAreaToHeader(area);
    resetPlanner();

    document.getElementById('area-picker').style.display   = 'none';
    document.getElementById('planner-cards').style.display = 'block';
  } catch (err) {
    console.error(`Could not load area "${areaMeta.id}":`, err);
    listEl.innerHTML = `<div class="area-error">⚠ "${areaMeta.name}" could not be loaded.</div>` + listEl.innerHTML;
  }
}

function applyAreaToHeader(area) {
  document.getElementById('header-tagline').textContent = area.subtitle
    ? `${area.name} · ${area.subtitle}`
    : area.name;

  const stats = area.stats || {};
  document.getElementById('stat-km').textContent      = stats.pistesKm != null ? `${stats.pistesKm} km` : '—';
  document.getElementById('stat-liften').textContent  = stats.liften  != null ? `${stats.liften}`       : '—';
  document.getElementById('stat-hoogte').textContent  = stats.hoogte  || '—';
  document.getElementById('header-stats').style.display     = 'flex';
  document.getElementById('area-switch-btn').style.display  = 'inline-flex';
}

function showAreaPicker() {
  document.getElementById('planner-cards').style.display = 'none';
  document.getElementById('area-picker').style.display   = 'block';
  document.getElementById('area-picker').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetPlanner() {
  resetSide('from');
  resetSide('to');
  document.getElementById('result').classList.remove('visible');
  document.getElementById('err').classList.remove('visible');
  allowedDiff = new Set(DIFF_LEVELS);
  DIFF_LEVELS.forEach(d => document.getElementById('d-' + d).classList.add('on'));
  document.getElementById('d-all').classList.add('on');
  restoreQuickRoute();
  resetDayPlan();
}

// Reopened halfway down the mountain: bring back the route being followed.
function restoreQuickRoute() {
  const saved = loadProgress('quick');
  if (!saved || !(saved.done > 0) || saved.done >= saved.total) return;
  if (!STATIONS[saved.from] || !STATIONS[saved.to]) return;
  restoreStation('from', saved.from);
  restoreStation('to', saved.to);
  if (Array.isArray(saved.diff)) {
    allowedDiff = new Set(saved.diff.filter(d => DIFF_LEVELS.includes(d)));
    DIFF_LEVELS.forEach(d => document.getElementById('d-' + d).classList.toggle('on', allowedDiff.has(d)));
    document.getElementById('d-all').classList.toggle('on', allowedDiff.size === DIFF_LEVELS.length);
  }
  planRoute({ silent: true });
}

// ── State ────────────────────────────────────────────────────────────────────

const DIFF_LEVELS = ['blauw', 'rood', 'zwart', 'skiroute'];

let activeSide = null;
const selected = { from: null, to: null };
let allowedDiff = new Set(DIFF_LEVELS);

// ── Sheet (station picker) ───────────────────────────────────────────────────

function openSheet(side) {
  activeSide = side;
  document.getElementById('sheet-title').textContent =
    side === 'from' || side === 'dstart' ? 'Choose starting point' : 'Choose destination';
  document.getElementById('sheet-search').value = '';
  renderSheet();
  document.getElementById('overlay').style.display = 'block';
  document.getElementById('sheet').style.display = 'flex';
  setTimeout(() => document.getElementById('sheet-search').focus(), 100);
}

function closeSheet() {
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('sheet').style.display = 'none';
  activeSide = null;
}

function renderSheet() {
  const query = document.getElementById('sheet-search').value.toLowerCase();
  const list = document.getElementById('sheet-list');
  list.innerHTML = '';

  const sectors = {};
  LIFTS.forEach(lift => {
    const dalStation  = STATIONS[lift.dal];
    const bergStation = STATIONS[lift.berg];
    const matches =
      !query ||
      lift.nr.toLowerCase().includes(query) ||
      lift.name.toLowerCase().includes(query) ||
      lift.sector.toLowerCase().includes(query) ||
      dalStation?.name.toLowerCase().includes(query) ||
      bergStation?.name.toLowerCase().includes(query);
    if (!matches) return;
    (sectors[lift.sector] = sectors[lift.sector] || []).push(lift);
  });

  const orderedSectors = [
    ...SECTOR_ORDER.filter(s => sectors[s]),
    ...Object.keys(sectors).filter(s => !SECTOR_ORDER.includes(s)),
  ];

  orderedSectors.forEach(sector => {
    const label = document.createElement('div');
    label.className = 'group-label';
    label.textContent = sector;
    list.appendChild(label);

    sectors[sector].forEach(lift => {
      // Derive dal/berg from this lift's own endpoints rather than a global
      // station.side — a place can be the dal side of one lift and the berg
      // side of another (a shared hub), so "side" only makes sense per lift.
      [['dal', lift.dal], ['berg', lift.berg]].forEach(([dalBerg, stationId]) => {
        const station = STATIONS[stationId];
        if (!station) return;
        const btn = document.createElement('button');
        btn.className = 'station-item';
        btn.innerHTML = `
          ${liftIcon(lift)}
          <span class="station-item-nr">${lift.nr}</span>
          <span class="station-item-name">${lift.name}</span>
          <span class="station-item-side">${SIDE_ICONS[dalBerg]} ${dalBerg === 'dal' ? 'Bottom' : 'Top'}</span>
          ${station.alt != null ? `<span class="station-item-alt">${formatAlt(station.alt)}</span>` : ''}
        `;
        btn.addEventListener('click', () => pickStation(stationId, lift, dalBerg));
        list.appendChild(btn);
      });
    });
  });

  if (!list.children.length) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:#aaa">No stations found</div>';
  }
}

// Small lift-type pictogram for the station picker and the chosen start/destination,
// the same icon the route steps use.
function liftIcon(lift) {
  const cls = stepClass({ type: lift.type, echteLift: lift.echteLift });
  return `<span class="lift-ico ico-${cls}" title="${tagLabel({ type: lift.type, echteLift: lift.echteLift })}">${STEP_ICONS[cls] || '🚡'}</span>`;
}

function pickStation(stationId, lift, dalBerg) {
  const routeSide = activeSide; // 'from' or 'to' — not to be confused with dalBerg ('dal'/'berg')
  const station   = STATIONS[stationId];
  selected[routeSide] = { id: stationId, ...station, side: dalBerg, liftNr: lift.nr, liftName: lift.name, lift };
  closeSheet();

  document.getElementById(`${routeSide}-box`).style.display        = 'none';
  document.getElementById(`${routeSide}-chosen`).style.display     = 'flex';
  document.getElementById(`${routeSide}-icon`).innerHTML           = liftIcon(lift);
  document.getElementById(`${routeSide}-nr`).textContent           = lift.nr;
  document.getElementById(`${routeSide}-liftname`).textContent     = lift.name;
  document.getElementById(`${routeSide}-side`).textContent         = `${SIDE_ICONS[dalBerg]} ${dalBerg === 'dal' ? 'Bottom' : 'Top'}`;
}

function resetSide(side) {
  selected[side] = null;
  document.getElementById(`${side}-box`).style.display    = 'flex';
  document.getElementById(`${side}-chosen`).style.display = 'none';
}

function swapSides() {
  const tmp = selected.from;
  selected.from = selected.to;
  selected.to   = tmp;

  ['from', 'to'].forEach(side => {
    if (!selected[side]) { resetSide(side); return; }
    const s = selected[side];
    document.getElementById(`${side}-box`).style.display    = 'none';
    document.getElementById(`${side}-chosen`).style.display = 'flex';
    document.getElementById(`${side}-icon`).innerHTML       = liftIcon(s.lift);
    document.getElementById(`${side}-nr`).textContent       = s.liftNr;
    document.getElementById(`${side}-liftname`).textContent = s.liftName;
    document.getElementById(`${side}-side`).textContent     = `${SIDE_ICONS[s.side]} ${s.side === 'dal' ? 'Bottom' : 'Top'}`;
  });
}

// ── Difficulty filter ────────────────────────────────────────────────────────

function setDiff(value) {
  if (value === 'all') {
    allowedDiff = allowedDiff.size === DIFF_LEVELS.length ? new Set() : new Set(DIFF_LEVELS);
  } else {
    allowedDiff.has(value) ? allowedDiff.delete(value) : allowedDiff.add(value);
  }
  DIFF_LEVELS.forEach(d => {
    document.getElementById('d-' + d).classList.toggle('on', allowedDiff.has(d));
  });
  document.getElementById('d-all').classList.toggle('on', allowedDiff.size === DIFF_LEVELS.length);
}

// ── Dijkstra routing ─────────────────────────────────────────────────────────

function dijkstra(startId, endId) {
  const dist     = {};
  const prev     = {};
  const prevEdge = {};

  Object.keys(STATIONS).forEach(node => {
    dist[node]     = Infinity;
    prev[node]     = null;
    prevEdge[node] = null;
  });

  dist[startId] = 0;
  const visited = new Set();
  const queue   = [{ id: startId, cost: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const { id: current } = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === endId) break;

    (GRAPH[current] || []).forEach(edge => {
      if (edge.type === 'piste' && pisteKleuren(edge).some(k => !allowedDiff.has(k))) return;
      const newCost = dist[current] + (edge.tijd || 0) + (edge.descent ? RIDE_DOWN_PENALTY : 0);
      if (newCost < dist[edge.to]) {
        dist[edge.to]     = newCost;
        prev[edge.to]     = current;
        prevEdge[edge.to] = edge;
        queue.push({ id: edge.to, cost: newCost });
      }
    });
  }

  if (dist[endId] === Infinity) return null;

  const path = [];
  let cursor = endId;
  while (cursor && prevEdge[cursor]) {
    path.unshift(prevEdge[cursor]);
    cursor = prev[cursor];
  }
  return { path, cost: dist[endId] };
}

// ── Route rendering ──────────────────────────────────────────────────────────

// There is no chairlift emoji (🪑 is just a chair), so draw a pictogram:
// a sloping cable, the hanger curving into the seat, and a skier sitting on
// it with skis on. Solid shapes so it reads as clearly as the emoji icons.
const CHAIRLIFT_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-label="Chairlift" role="img">
  <path d="M2.5 6.2 L21.5 1.5" stroke-width="2"/>
  <path d="M7 5.1 V16.2 Q7 19 9.8 19 H12.5" stroke-width="1.9"/>
  <circle cx="11.4" cy="6.4" r="2" fill="currentColor" stroke="none"/>
  <rect x="9.3" y="9.2" width="3.4" height="7.4" rx="1.7" fill="currentColor" stroke="none"/>
  <path d="M12.3 12.2 L15.6 11" stroke-width="1.8"/>
  <path d="M11.2 15.4 H14.3 L16.6 19.6" stroke-width="3"/>
  <path d="M13.4 22.3 L21.2 18.4 V16.4" stroke-width="1.8"/>
</svg>`;

// Drag lift pictogram in the same style: an upright skier holding the tow
// pole that runs diagonally up to the right, skis on the slope with the tips
// curled up.
const TBAR_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-label="Drag lift" role="img">
  <circle cx="6.4" cy="4.4" r="2.1" fill="currentColor" stroke="none"/>
  <path d="M6.3 8 L6.7 14.2" stroke-width="3.6"/>
  <path d="M7.2 9.4 H13" stroke-width="1.8"/>
  <path d="M21.5 1.8 L9.2 15.6" stroke-width="1.8"/>
  <path d="M6.7 14.2 L11.2 20.3" stroke-width="3"/>
  <path d="M4.2 22.6 L20.3 17.4 L20.7 15.4" stroke-width="1.8"/>
</svg>`;

// OSM drag-lift types: shown with the T-bar pictogram and their own label.
const DRAG_LIFT_LABEL = { 't-bar': 'T-bar', 'j-bar': 'J-bar', platter: 'Platter lift', drag_lift: 'Drag lift', rope_tow: 'Rope tow' };

const STEP_ICONS = {
  gondola:          '🚡',
  mixed_lift:       '🚡',
  cable_car:        '🚠',
  funicular:        '🚞',
  chair_lift:       CHAIRLIFT_ICON,
  draglift:         TBAR_ICON,
  oefenlift:        '🎿',
  'piste-blauw':    '🔵',
  'piste-rood':     '🔴',
  'piste-zwart':    '⚫',
  'piste-skiroute': '🟡',
  transfer:         '🔄',
};

const LIFT_TYPE_LABEL = { gondola: 'Gondola', mixed_lift: 'Gondola', cable_car: 'Cable car', funicular: 'Funicular', chair_lift: 'Chairlift' };

// Drag lifts (t-bar, platter, j-bar, rope tow) get the T-bar pictogram.
// Any other non-`echteLift` (magic carpets) is a generic "oefenlift".
function stepClass(edge) {
  if (edge.type === 'piste')    return 'piste-' + (edge.diff || 'rood');
  if (edge.type === 'transfer') return 'transfer';
  if (DRAG_LIFT_LABEL[edge.type]) return 'draglift';
  return edge.echteLift === false ? 'oefenlift' : edge.type;
}

function tagClass(edge) {
  if (edge.type === 'piste') return { blauw: 'tag-blauw', rood: 'tag-rood', zwart: 'tag-zwart', skiroute: 'tag-skiroute' }[edge.diff] || 'tag-rood';
  if (edge.echteLift === false) return 'tag-stoeltjeslift';
  if (edge.type === 'chair_lift') return 'tag-stoeltjeslift';
  if (edge.type === 'gondola' || edge.type === 'cable_car' || edge.type === 'funicular') return 'tag-gondel';
  return '';
}

function tagLabel(edge) {
  if (edge.type === 'piste') return { blauw: 'Blue ●', rood: 'Red ●', zwart: 'Black ●', skiroute: 'Ski route ●' }[edge.diff] || 'Piste';
  if (DRAG_LIFT_LABEL[edge.type]) return DRAG_LIFT_LABEL[edge.type];
  if (edge.echteLift === false) return 'Practice lift';
  return LIFT_TYPE_LABEL[edge.type] || 'Lift';
}

function planRoute(options = {}) {
  const errorEl  = document.getElementById('err');
  const resultEl = document.getElementById('result');
  errorEl.classList.remove('visible');

  if (!selected.from || !selected.to) {
    errorEl.textContent = 'Select a starting point and a destination.';
    errorEl.classList.add('visible');
    return;
  }
  if (selected.from.id === selected.to.id) {
    errorEl.textContent = 'Starting point and destination are the same.';
    errorEl.classList.add('visible');
    return;
  }

  const result = dijkstra(selected.from.id, selected.to.id);
  if (!result || !result.path.length) {
    errorEl.textContent = 'No route found. Try also selecting red or black.';
    errorEl.classList.add('visible');
    resultEl.classList.remove('visible');
    return;
  }

  renderRoute(result);
  resultEl.classList.add('visible');
  if (!options.silent) resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// A piste edge with `trajecten` runs through several marked numbers (74a
// that carries on as 75): every part's colour must pass the filter.
function pisteKleuren(edge) {
  return edge.trajecten ? edge.trajecten.map(t => t.kleur).filter(Boolean) : edge.diff ? [edge.diff] : [];
}

// Show each part of a gaatOverIn chain as its own step, with its own
// number, colour, length and time. The in-between point is not a lift
// station, so it gets a plain-text label instead of a station id.
function splitTrajecten(edge) {
  const parts = edge.trajecten;
  if (!parts || parts.length < 2) return [edge];
  return parts.map((t, i) => ({
    ...edge,
    trajecten: null,
    pisteNr: t.pisteNr,
    diff: t.kleur,
    name: t.naam || `Piste ${t.pisteNr}`,
    tijd: t.tijd,
    km: t.lengteM != null ? t.lengteM / 1000 : undefined,
    from: i === 0 ? edge.from : `Transition ${parts[i - 1].pisteNr} → ${t.pisteNr}`,
    to: i === parts.length - 1 ? edge.to : `Transition ${t.pisteNr} → ${parts[i + 1].pisteNr}`,
  }));
}

const PISTE_KIND = { blauw: 'Blue piste', rood: 'Red piste', zwart: 'Black piste', skiroute: 'Ski route' };

function renderRoute(result) {
  const visibleSteps = result.path.filter(edge => edge.type !== 'transfer').flatMap(splitTrajecten);
  const totalKm      = visibleSteps.reduce((sum, edge) => sum + (edge.km || 0), 0);
  const totalMin     = visibleSteps.reduce((sum, edge) => sum + (edge.tijd || 0), 0);

  document.getElementById('p-steps').textContent = `${visibleSteps.length} steps`;
  document.getElementById('p-km').textContent    = totalKm > 0 ? `approx. ${totalKm.toFixed(1)} km` : '—';
  document.getElementById('p-time').textContent  = `~${totalMin} min`;

  const stepsEl = document.getElementById('steps');
  stepsEl.innerHTML = '';

  addWaypoint(stepsEl, selected.from.name, selected.from.alt, '📍', 'Start', 0);

  visibleSteps.forEach((edge, index) => {
    const div = stepElement(edge, index);
    div.style.animationDelay = `${(index + 1) * 50}ms`;
    div.classList.add('checkable');
    div.dataset.min = edge.tijd || 0;
    stepsEl.appendChild(div);

    const toStation = STATIONS[edge.to];
    const isLast = index === visibleSteps.length - 1;
    if (isLast && toStation) {
      addWaypoint(stepsEl, toStation.name, toStation.alt, '🏁', 'Destination reached!', (index + 1.5) * 50);
    }
  });

  document.getElementById('tip').innerHTML = getTip();

  const signature = [selected.from.id, ...visibleSteps.map(e => e.liftNr || e.pisteNr), selected.to.id].join('>');
  makeCheckable(stepsEl, 'quick', signature, quickStatus, {
    from: selected.from.id, to: selected.to.id, diff: [...allowedDiff],
  });
}

function quickStatus(done, items) {
  const left = items.slice(done).reduce((sum, item) => sum + (+item.dataset.min || 0), 0);
  let text;
  if (done === 0)                 text = 'Tap a step once you have done it.';
  else if (done === items.length) text = '🏁 Destination reached!';
  else                            text = `${done} of ${items.length} steps done · ~${left} min to go`;
  renderProgress('p-progress', done, items.length, text);
}

// One route step (a lift or a piste) as a DOM element. `clock` is an optional
// "09:12"-style time shown in front of the step (used by the day planner).
function stepElement(edge, index, clock) {
  const div   = document.createElement('div');
  const facts = [edge.km ? `${edge.km} km` : '', edge.tijd ? `~${edge.tijd} min` : ''].filter(Boolean).join(' · ');
  const clockHtml = clock ? `<span class="step-clock">${clock}</span>` : '';

  if (edge.type === 'piste') {
    // Piste: the number sits inside a sign in the difficulty colour, like on the mountain.
    const diff = edge.diff || 'rood';
    const nr = String(edge.pisteNr || '');
    const short = nr.length <= 4; // unnumbered runs use their name as pisteNr
    div.className = `step step-piste piste-${diff}`;
    div.innerHTML = `
      <span class="step-number">${index + 1}</span>
      <div class="piste-sign sign-${diff}${short ? '' : ' sign-noname'}" aria-label="Piste ${nr}"><span>${short ? nr : '⛷'}</span></div>
      <div class="step-info">
        <div class="step-kind kind-${diff}">${PISTE_KIND[diff] || 'Piste'}</div>
        <div class="step-name">${edge.name}</div>
        ${facts ? `<div class="step-sub">${facts}</div>` : ''}
      </div>
    `;
  } else {
    // Lift: its own tinted block, with the lift code large next to the pictogram.
    const cls  = stepClass(edge);
    const icon = STEP_ICONS[cls] || '🚡';
    div.className = 'step step-lift';
    div.innerHTML = `
      <span class="step-number">${index + 1}</span>
      <div class="step-icon ico-${cls}">${icon}</div>
      <div class="step-info">
        <div class="step-kind kind-lift">${tagLabel(edge)}${edge.descent ? ' · ride down ↓' : ''}${edge.tijd ? ` · ~${edge.tijd} min` : ''}</div>
        <div class="step-title"><span class="lift-code">${edge.liftNr}</span><span class="step-name">${edge.name}</span></div>
      </div>
    `;
  }
  if (clockHtml) div.querySelector('.step-info').insertAdjacentHTML('afterbegin', clockHtml);
  return div;
}

function addWaypoint(parent, name, alt, icon, subtitle, delay) {
  const altSuffix = formatAlt(alt);
  const div = document.createElement('div');
  div.className = 'step';
  div.style.animationDelay = `${delay}ms`;
  div.innerHTML = `
    <span class="step-number"></span>
    <div class="step-icon ico-waypoint">${icon}</div>
    <div class="step-info">
      <div class="step-name">${name}${altSuffix ? ` <span style="font-size:.75rem;color:#aaa;font-weight:400">${altSuffix}</span>` : ''}</div>
      ${subtitle ? `<div class="step-sub">${subtitle}</div>` : ''}
    </div>
  `;
  parent.appendChild(div);
}

function getTip() {
  // Tips used to be hardcoded per KitzSki piste/lift name. Now that the app
  // is dataset-agnostic, keep this generic until tips become area data.
  return '💡 <strong>Tip:</strong> Check the current opening times of your ski area before you set off.';
}

// ── Progress: ticking off steps ──────────────────────────────────────────────
//
// Both planners mark their steps "checkable". Tapping one marks it and every
// step before it as done (handy when you forgot to tap on the way); tapping
// a done step un-marks it and everything after it. Progress is kept per area
// and planner, tied to the route's signature, so it survives the app being
// closed on the mountain.

const PROGRESS_KEY_PREFIX = 'skiplanner:progress:';

function progressKey(kind) {
  return `${PROGRESS_KEY_PREFIX}${currentArea?.id || ''}:${kind}`;
}

function loadProgress(kind) {
  try { return JSON.parse(localStorage.getItem(progressKey(kind))) || null; } catch { return null; }
}

function saveProgress(kind, data) {
  try { localStorage.setItem(progressKey(kind), JSON.stringify(data)); } catch {}
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Put a station in a picker (from/to/dstart/dend) by station id.
function restoreStation(side, stationId) {
  if (!stationId || !STATIONS[stationId]) return;
  const lift = LIFTS.find(l => l.dal === stationId || l.berg === stationId);
  if (!lift) return;
  const previous = activeSide;
  activeSide = side;
  pickStation(stationId, lift, lift.dal === stationId ? 'dal' : 'berg');
  activeSide = previous;
}

// Make the .checkable steps in `container` tickable. `onChange(done, items)`
// redraws the status line; `extra` is stored alongside the progress.
function makeCheckable(container, kind, signature, onChange, extra = {}) {
  const items = [...container.querySelectorAll('.checkable')];
  const saved = loadProgress(kind);
  let done = saved && saved.signature === signature ? Math.min(saved.done || 0, items.length) : 0;

  function apply(store) {
    items.forEach((item, i) => {
      item.classList.toggle('done', i < done);
      item.classList.toggle('next', i === done);
      item.querySelector('.step-check').setAttribute('aria-pressed', String(i < done));
    });
    if (store) saveProgress(kind, { ...extra, signature, done, total: items.length });
    onChange(done, items);
  }

  // After a tap, bring the next step into view: on a long day you would
  // otherwise scroll past a column of finished steps.
  function showNext() {
    const next = items[done];
    if (next) next.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  items.forEach((item, i) => {
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'step-check';
    check.setAttribute('aria-label', 'Done');
    item.appendChild(check);
    item.addEventListener('click', () => {
      done = i < done ? i : i + 1;
      apply(true);
      showNext();
    });
  });

  apply(false);
  return { get done() { return done; }, items, refresh: () => apply(false) };
}

function renderProgress(id, done, total, text, extraHtml = '') {
  const el = document.getElementById(id);
  el.innerHTML = `
    <div class="progress-bar"><span style="width:${total ? (100 * done / total) : 0}%"></span></div>
    <div class="progress-row"><span class="progress-text">${text}</span>${extraHtml}</div>
  `;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

initApp();

// Offline: the service worker keeps the app and all area data on the device.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Offline mode unavailable:', err));
  });
}
