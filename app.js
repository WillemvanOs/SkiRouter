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
// Extra routing cost of a bus or walk, so skiing wins when it is about as quick.
const CONNECTION_PENALTY = 10;
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

  if (Array.isArray(area.afdalingen)) addDescents(area, liftByNr, addEdge);
  else pistes.forEach(piste => {
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

  // verbindingen: a ski bus or a walk between two stations that no lift or
  // piste links (e.g. Hahnenkammbahn ↔ Hornbahn through Kitzbühel).
  (area.verbindingen || []).forEach(v => {
    if (!stations[v.van] || !stations[v.naar]) return;
    const edge = {
      type: v.soort === 'lopen' ? 'walk' : 'bus',
      name: v.naam || (v.soort === 'lopen' ? 'Walk' : 'Ski bus'),
      info: v.info || '',
      tijd: v.tijd || 0,
    };
    // The nearest bus stop of a bottom station, from the OSM enrichment.
    const stopAt = id => id.endsWith('-onder') ? liftByNr.get(id.slice(0, -'-onder'.length))?.bushalte?.naam : undefined;
    addEdge({ ...edge, from: v.van, to: v.naar, stopFrom: stopAt(v.van), stopTo: stopAt(v.naar) });
    if (v.beideRichtingen !== false) addEdge({ ...edge, from: v.naar, to: v.van, stopFrom: stopAt(v.naar), stopTo: stopAt(v.van) });
  });

  // aansluitendeLiften: reachable from the top of this lift without a
  // marked piste (e.g. a short walk between two stations at the same spot).
  // Format 2 lists such pairs of stations as `overstappen`.
  const seenTransfers = new Set();
  const addTransfer = (a, b) => {
    if (!stations[a] || !stations[b] || a === b) return;
    const key = [a, b].sort().join('|');
    if (seenTransfers.has(key)) return;
    seenTransfers.add(key);
    addEdge({ from: a, to: b, type: 'transfer', name: 'Transfer', tijd: 0 });
    addEdge({ from: b, to: a, type: 'transfer', name: 'Transfer', tijd: 0 });
  };
  liften.forEach(lift => {
    (lift.aansluitendeLiften || []).forEach(otherNr => {
      if (!liftByNr.has(otherNr) || otherNr === lift.liftNr) return;
      addTransfer(`${lift.liftNr}-boven`, `${otherNr}-onder`);
    });
  });
  (area.overstappen || []).forEach(([a, b]) => addTransfer(a, b));

  STATIONS     = stations;
  LIFTS        = lifts;
  SECTOR_ORDER = sectorOrder;
  GRAPH        = graph;
}

// Format 2 (built by tools/build-areas.mjs): the descents are worked out at
// build time from the run network. Each `afdalingen` entry goes from the top
// of lift `van` to the bottom of lift `naar` along `delen` — [pisteNr,
// metres] in order — with every piste's name and colour in `pistes`.
function addDescents(area, liftByNr, addEdge) {
  const info = new Map((area.pistes || []).map(p => [p.pisteNr, p]));
  area.afdalingen.forEach(({ van, naar, delen }) => {
    if (!liftByNr.has(van) || !liftByNr.has(naar) || !delen?.length) return;
    // A third element is the colour of a short, harder stretch folded into
    // this part (a connector): not a step of its own, but the filter sees it.
    const parts = delen.map(([pisteNr, metres, ookKleur]) => {
      const piste = info.get(pisteNr) || {};
      return {
        pisteNr,
        naam: piste.naam || `Piste ${pisteNr}`,
        kleur: piste.kleur,
        ookKleur: ookKleur || null,
        lengteM: metres,
        tijd: Math.max(1, Math.round(metres / 200)),
      };
    });
    const metres = parts.reduce((sum, p) => sum + p.lengteM, 0);
    addEdge({
      from: `${van}-boven`,
      to: `${naar}-onder`,
      type: 'piste',
      diff: parts[0].kleur,
      pisteNr: parts[0].pisteNr,
      name: parts[0].naam,
      ookKleur: parts[0].ookKleur,
      trajecten: parts.length > 1 ? parts : null,
      tijd: parts.reduce((sum, p) => sum + p.tijd, 0),
      km: Math.round(metres / 10) / 100,
    });
  });
}

// ── Area loading ─────────────────────────────────────────────────────────────
//
// The app starts with a gebied-picker (see index.html #area-picker). Picking
// an area fetches data/<area>.json, builds the routing graph from its
// liften/pistes, and only then reveals the route planner UI.

const AREA_REGISTRY_URL = 'data/areas.json';         // hand-curated areas (KitzSki)
const EUROPE_INDEX_URL  = 'data/europe/index.json';  // every European area, built at deploy
const LAST_AREA_KEY      = 'skiplanner:lastArea';
const FAVOURITE_AREAS_KEY = 'skiplanner:favouriteAreas';
const openCountries = new Set(); // countries unfolded in the picker, kept open when it redraws

let currentArea = null;
let AREAS = [];          // every area the picker can show: { id, name, file, country, region, places, … }
let areaHere = null;     // [lat, lon] once "near me" has found the user

const COUNTRY_NAMES = {
  AD: 'Andorra', AM: 'Armenia', AT: 'Austria', AZ: 'Azerbaijan', BA: 'Bosnia and Herzegovina', BG: 'Bulgaria',
  CH: 'Switzerland', CZ: 'Czechia', DE: 'Germany', ES: 'Spain', FI: 'Finland', FR: 'France', GB: 'United Kingdom',
  GE: 'Georgia', GR: 'Greece', IS: 'Iceland', IT: 'Italy', LI: 'Liechtenstein', ME: 'Montenegro', MK: 'North Macedonia',
  NO: 'Norway', PL: 'Poland', RO: 'Romania', RS: 'Serbia', RU: 'Russia', SE: 'Sweden', SI: 'Slovenia', SK: 'Slovakia',
  TR: 'Turkey', UA: 'Ukraine',
};
const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
const countryName = code => { try { return regionNames?.of(code) || COUNTRY_NAMES[code] || code || ''; } catch { return COUNTRY_NAMES[code] || code || ''; } };

// Other names people search by, for regions the map data names in English.
const SEARCH_ALIASES = {
  tirol: 'tyrol', sudtirol: 'south tyrol', 'alto adige': 'south tyrol', wallis: 'valais',
  graubunden: 'grisons', karnten: 'carinthia', steiermark: 'styria', salzburgerland: 'salzburg',
  savoie: 'savoy', piemonte: 'piedmont', lombardia: 'lombardy', bayern: 'bavaria',
};

async function initApp() {
  const listEl = document.getElementById('area-list');
  // The curated list is needed; the Europe index is a bonus (offline, or a
  // deploy whose Europe build failed, still leaves the curated areas).
  const [curated, europe] = await Promise.all([
    fetch(AREA_REGISTRY_URL).then(r => r.ok ? r.json() : Promise.reject(new Error(r.status))).catch(err => { console.error(err); return null; }),
    fetch(EUROPE_INDEX_URL).then(r => r.ok ? r.json() : []).catch(() => []),
  ]);
  if (!curated && !europe.length) {
    listEl.innerHTML = '<div class="area-error">⚠ The ski area list could not be loaded.</div>';
    return;
  }
  AREAS = [
    ...(curated || []).map(a => ({ ...a, curated: true })),
    ...europe.filter(e => !(curated || []).some(c => c.id === e.id)),
  ];
  renderAreaList();

  const lastAreaId = localStorage.getItem(LAST_AREA_KEY);
  const lastArea   = AREAS.find(a => a.id === lastAreaId);
  if (lastArea) await selectArea(lastArea);
}

// Favourite ski areas: marked with ☆ in the picker, listed on top.
function favouriteAreaIds() {
  try { return JSON.parse(localStorage.getItem(FAVOURITE_AREAS_KEY)) || []; } catch { return []; }
}

function isFavourite(id) {
  return favouriteAreaIds().includes(id);
}

function toggleFavourite(id) {
  const ids = favouriteAreaIds();
  const next = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
  try { localStorage.setItem(FAVOURITE_AREAS_KEY, JSON.stringify(next)); } catch {}
  renderAreaList();
}

const fold = text => (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// How well an area matches the search: 3 name starts with it, 2 a word in
// the name does, 1 the name, region, village or country contains it.
function areaMatch(area, query) {
  const alias = Object.entries(SEARCH_ALIASES).find(([k]) => k.startsWith(query) && query.length >= 4)?.[1];
  if (alias && alias !== query) return Math.max(areaMatch(area, alias), plainMatch(area, query));
  return plainMatch(area, query);
}

function plainMatch(area, query) {
  const name = fold(area.name);
  if (name.startsWith(query)) return 3;
  if (name.split(/[^a-z0-9]+/).some(w => w.startsWith(query))) return 2;
  const rest = [area.region, ...(area.places || []), countryName(area.country), area.subtitle].map(fold);
  return name.includes(query) || rest.some(t => t.includes(query)) ? 1 : 0;
}

function renderAreaList() {
  const listEl = document.getElementById('area-list');
  const query = fold(document.getElementById('area-search')?.value.trim());
  listEl.innerHTML = '';
  if (!AREAS.length) {
    listEl.innerHTML = '<div class="area-error">No ski areas available yet.</div>';
    return;
  }
  const section = (title, areas) => {
    if (!areas.length) return;
    const label = document.createElement('div');
    label.className = 'area-group';
    label.textContent = title;
    listEl.appendChild(label);
    areas.forEach(a => listEl.appendChild(areaButton(a)));
  };

  if (query) {
    const hits = AREAS.map(a => ({ a, m: areaMatch(a, query) })).filter(h => h.m)
      .sort((x, y) => y.m - x.m || (y.a.pistesKm || 0) - (x.a.pistesKm || 0)).slice(0, 40).map(h => h.a);
    if (!hits.length) listEl.innerHTML = '<div class="area-loading">No ski area found. Try a village or region.</div>';
    else section(`${hits.length === 40 ? 'First 40 matches' : `${hits.length} found`}`, hits);
    return;
  }

  const favourites = favouriteAreaIds().map(id => AREAS.find(a => a.id === id)).filter(Boolean)
    .sort((x, y) => x.name.localeCompare(y.name));
  if (favourites.length) section('★ Favourites', favourites);
  else {
    const hint = document.createElement('div');
    hint.className = 'area-hint';
    hint.textContent = 'Tap ☆ next to a ski area to keep it here, on top.';
    listEl.appendChild(hint);
  }
  if (areaHere) {
    const near = AREAS.filter(a => a.centre).map(a => ({ a, d: distanceM(areaHere, a.centre) }))
      .sort((x, y) => x.d - y.d).slice(0, 8).filter(n => n.d < 300000);
    section('Near you', near.map(n => ({ ...n.a, distance: n.d })));
  }
  // A folded group (tap to open), kept open across redraws.
  const foldGroup = (key, title, areas) => {
    const box = document.createElement('details');
    box.className = 'area-country';
    box.innerHTML = `<summary><span>${title}</span><span class="area-count">${areas.length}</span></summary>`;
    box.addEventListener('toggle', () => {
      if (box.open) openCountries.add(key); else openCountries.delete(key);
      if (!box.open || box.dataset.filled) return;
      box.dataset.filled = '1';
      [...areas].sort((x, y) => x.name.localeCompare(y.name)).forEach(a => box.appendChild(areaButton(a)));
    });
    listEl.appendChild(box);
    if (openCountries.has(key)) box.open = true;
  };

  // Every area by country, folded away: tap a country to open it.
  const byCountry = new Map();
  AREAS.forEach(a => {
    if (!byCountry.has(a.country)) byCountry.set(a.country, []);
    byCountry.get(a.country).push(a);
  });
  if (!byCountry.size) return;
  const label = document.createElement('div');
  label.className = 'area-group';
  label.textContent = 'All ski areas';
  listEl.appendChild(label);
  [...byCountry].sort((x, y) => y[1].length - x[1].length).forEach(([code, areas]) => foldGroup(code, countryName(code), areas));
}

// A lift number to show: the mapped one (A1, D9). Lifts without a number
// in the map data get a generated code (L12, OEF-3) that means nothing to a
// skier, so for those only the name is shown.
function liftCode(nr) {
  return /^(L\d+|OEF-\d+)(r|-\d+)?$/.test(nr || '') ? '' : (nr || '');
}

// Text from map data goes into the page as text, never as HTML.
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One ski area in the picker: the area itself (tap to open it) and a star
// to make it a favourite.
function areaButton(area) {
  const row = document.createElement('div');
  row.className = 'area-row';
  const btn = document.createElement('button');
  btn.className = 'area-btn';
  const where = area.curated ? (area.subtitle || '') : [area.region, countryName(area.country)].filter(Boolean).join(', ');
  const facts = [
    area.pistesKm ? `${area.pistesKm} km` : '',
    area.liften ? `${area.liften} lifts` : '',
    area.distance != null ? `${Math.round(area.distance / 1000)} km away` : '',
  ].filter(Boolean).join(' · ');
  btn.innerHTML = `
    <span class="area-btn-name">🏔 ${escapeHtml(area.name)}</span>
    <span class="area-btn-sub">${escapeHtml(where)}</span>
    ${facts ? `<span class="area-btn-facts">${facts}</span>` : ''}
    ${area.liftstatus ? '<span class="area-btn-live">● Live lift status</span>' : '<span class="area-btn-nolive">○ No live lift status</span>'}
    ${area.status === 'deels' ? '<span class="area-btn-warn">⚠ Not all lifts are connected</span>' : ''}
  `;
  btn.addEventListener('click', () => selectArea(area));
  const fav = isFavourite(area.id);
  const star = document.createElement('button');
  star.type = 'button';
  star.className = `area-fav${fav ? ' on' : ''}`;
  star.textContent = fav ? '★' : '☆';
  star.setAttribute('aria-pressed', String(fav));
  star.setAttribute('aria-label', `${fav ? 'Remove' : 'Add'} ${area.name} ${fav ? 'from' : 'to'} favourites`);
  star.addEventListener('click', () => toggleFavourite(area.id));
  row.append(btn, star);
  return row;
}

// "Ski areas near me": sort by distance from where the user is.
function findAreasNearMe() {
  const btn = document.getElementById('area-near-btn');
  if (!navigator.geolocation) { btn.textContent = '📍 Location is not available on this device'; return; }
  btn.textContent = '📍 Finding you…';
  navigator.geolocation.getCurrentPosition(pos => {
    areaHere = [pos.coords.latitude, pos.coords.longitude];
    btn.textContent = '📍 Ski areas near me';
    document.getElementById('area-search').value = '';
    renderAreaList();
  }, err => {
    btn.textContent = err.code === err.PERMISSION_DENIED
      ? '📍 Location access is off — allow it in your settings'
      : '📍 Could not find your location — try again';
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
}

async function selectArea(areaMeta) {
  const listEl = document.getElementById('area-list');
  try {
    const response = await fetch(areaMeta.file);
    if (!response.ok) throw new Error(`${response.status}`);
    const area = await response.json();

    buildFromSkimapData(area);
    currentArea = area;
    await loadLiftStatus(areaMeta);

    localStorage.setItem(LAST_AREA_KEY, areaMeta.id);
    applyAreaToHeader(area);
    resetPlanner();

    document.getElementById('area-picker').style.display   = 'none';
    document.getElementById('planner-cards').style.display = 'block';
  } catch (err) {
    console.error(`Could not load area "${areaMeta.id}":`, err);
    const note = document.createElement('div');
    note.className = 'area-error';
    note.textContent = `⚠ "${areaMeta.name}" could not be loaded${navigator.onLine ? '' : ' — you are offline and it was not opened before'}.`;
    listEl.prepend(note);
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
  renderHeaderLiftStatus();
  document.getElementById('area-switch-btn').style.display  = 'inline-flex';
  document.body.classList.add('in-planner'); // smaller logo and button above the planner
}

// The area picker is a screen of its own: nothing about an area at the top.
function clearAreaHeader() {
  document.getElementById('header-tagline').textContent = 'Choose a ski area to get started';
  ['header-stats', 'header-live', 'area-switch-btn'].forEach(id => { document.getElementById(id).style.display = 'none'; });
  document.body.classList.remove('in-planner');
}

// Under the area's facts: whether it has live lift status, and how fresh.
function renderHeaderLiftStatus() {
  const el = document.getElementById('header-live');
  if (!el) return;
  el.style.display = currentArea ? 'block' : 'none';
  const stale = liftStatusMeta && LIFT_STATUS && liftStatusStale();
  el.className = `header-live ${!liftStatusMeta ? 'not-live' : stale || !LIFT_STATUS ? 'is-stale' : 'is-live'}`;
  el.textContent = !liftStatusMeta ? '○ No live lift status'
    : !LIFT_STATUS ? '● Live lift status · not available right now'
    : stale ? `● Lift status from ${liftStatusAge().replace(/^updated /, '')} · not yet updated today`
    : `● Live lift status · ${liftStatusAge()}`;
}

function showAreaPicker() {
  document.getElementById('area-search').value = '';
  renderAreaList();
  clearAreaHeader();
  const back = document.getElementById('area-back-btn');
  back.style.display = currentArea ? 'block' : 'none';
  back.textContent = currentArea ? `← Back to ${currentArea.name}` : '';
  document.getElementById('planner-cards').style.display = 'none';
  document.getElementById('area-picker').style.display   = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Back from the area picker to the area that was open, as it was.
function backToArea() {
  if (!currentArea) return;
  applyAreaToHeader(currentArea);
  document.getElementById('area-picker').style.display   = 'none';
  document.getElementById('planner-cards').style.display = 'block';
}

function resetPlanner() {
  resetSide('from');
  resetSide('to');
  document.getElementById('result').classList.remove('visible');
  document.getElementById('err').classList.remove('visible');
  allowedDiff = new Set(DIFF_LEVELS);
  renderQuickDiff();
  document.getElementById('q-bus').checked = true;
  document.querySelectorAll('.bus-row').forEach(row => { row.style.display = areaHasBus() ? 'flex' : 'none'; });
  loadAvoided();
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
    renderQuickDiff();
  }
  document.getElementById('q-bus').checked = saved.bus !== false;
  planRoute({ silent: true });
}

// The area has a ski bus link (`verbindingen`): only then is there a switch.
function areaHasBus() {
  return (currentArea?.verbindingen || []).some(v => v.soort !== 'lopen');
}

// The ski bus switch of a planner; on when the area has no bus at all.
function busAllowed(id) {
  const box = document.getElementById(id);
  return !box || box.checked;
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
  lockPageScroll();
  fitSheetToScreen();
  // Focus right away, still inside the tap: iPhones only bring up the
  // keyboard for a focus that happens during the tap itself, not after a delay.
  document.getElementById('sheet-search').focus({ preventScroll: true });
}

function closeSheet() {
  const sheet = document.getElementById('sheet');
  document.getElementById('overlay').style.display = 'none';
  sheet.style.display = 'none';
  sheet.classList.remove('keyboard-open');
  sheet.style.top = sheet.style.maxHeight = '';
  sheetPinned = false;
  unlockPageScroll();
  activeSide = null;
}

// While the picker is open the page behind it stays put, so a swipe scrolls
// only the list. iPhones ignore overflow: hidden on the body for touch
// scrolling, so the body is fixed in place at its current scroll position.
let lockedScrollY = null;
function lockPageScroll() {
  if (lockedScrollY !== null) return;
  lockedScrollY = window.scrollY;
  Object.assign(document.body.style, { position: 'fixed', top: `-${lockedScrollY}px`, left: '0', right: '0' });
}
function unlockPageScroll() {
  if (lockedScrollY === null) return;
  Object.assign(document.body.style, { position: '', top: '', left: '', right: '' });
  window.scrollTo(0, lockedScrollY);
  lockedScrollY = null;
}

// Keep the results above the on-screen keyboard. On iPhones the keyboard
// covers the bottom of the page without resizing it, so while it is open the
// sheet is pinned to the top of the part still visible (visualViewport) and
// sized to fit it.
let sheetPinned = false;   // pinned to the top since the keyboard first came up
let sheetTouched = false;  // a finger is on the sheet
function fitSheetToScreen() {
  const sheet = document.getElementById('sheet');
  const vv = window.visualViewport;
  if (!vv || sheet.style.display === 'none') return;
  // Never move or shrink the list under a finger: an iPhone drops the scroll
  // when it does. The keyboard closing at the start of a swipe is handled
  // once the finger lets go.
  if (sheetTouched) return;
  const layoutHeight = document.documentElement.clientHeight;
  // Once pinned to the top the sheet stays there (only growing when the
  // keyboard goes away), so the list never jumps from top to bottom.
  if (vv.height < layoutHeight - 80) sheetPinned = true;
  sheet.classList.toggle('keyboard-open', sheetPinned);
  sheet.style.top       = sheetPinned ? `${Math.round(vv.offsetTop)}px` : '';
  sheet.style.maxHeight = sheetPinned ? `${Math.round(vv.height)}px` : '';
}
window.visualViewport?.addEventListener('resize', fitSheetToScreen);
window.visualViewport?.addEventListener('scroll', fitSheetToScreen);
window.addEventListener('resize', fitSheetToScreen);
// The keyboard slides in after focus; check again once it is there.
function sheetSearchFocus() {
  [100, 350, 700].forEach(ms => setTimeout(fitSheetToScreen, ms));
}

// Scrolling the list closes the keyboard, so more of the list can be seen.
document.getElementById('sheet-list').addEventListener('touchmove', () => {
  const search = document.getElementById('sheet-search');
  if (document.activeElement === search) search.blur();
}, { passive: true });

document.getElementById('sheet').addEventListener('touchstart', () => { sheetTouched = true; }, { passive: true });
['touchend', 'touchcancel'].forEach(type => document.getElementById('sheet').addEventListener(type, () => {
  sheetTouched = false;
  setTimeout(fitSheetToScreen, 50);
}, { passive: true }));

// A swipe on the sheet outside the list (title, search field) moves nothing.
document.getElementById('sheet').addEventListener('touchmove', event => {
  if (!event.target.closest('.sheet-list')) event.preventDefault();
}, { passive: false });

// Enter / Go in the search: pick the only lift left, or the lift whose number
// was typed ("a1"); otherwise close the keyboard so the whole list can be
// seen. A form submit, because that is what the iPhone "Go" key reliably fires.
function sheetSearchSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('sheet-search');
  const items = [...document.querySelectorAll('#sheet-list .station-item')];
  const query = input.value.trim().toLowerCase();
  const byNr = items.filter(item => item.querySelector('.station-item-nr')?.textContent.toLowerCase() === query);
  if (items.length === 1) items[0].click();
  else if (byNr.length === 1) byNr[0].click();
  else input.blur();
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

  if (!query && (activeSide === 'from' || activeSide === 'dstart')) {
    const gps = document.createElement('button');
    gps.className = 'gps-btn';
    gps.id = 'gps-btn';
    gps.innerHTML = '<span>📍</span><span>Use my location</span><span class="gps-status" id="gps-status"></span>';
    gps.addEventListener('click', locateMe);
    list.appendChild(gps);
  }

  orderedSectors.forEach(sector => {
    const label = document.createElement('div');
    label.className = 'group-label';
    label.textContent = sector;
    list.appendChild(label);

    sectors[sector].forEach(lift => {
      // One row per lift; picking it chooses the bottom station. The top is
      // one tap away on the chosen field (see setChosenSide).
      const btn = document.createElement('button');
      btn.className = 'station-item';
      btn.innerHTML = `
        ${liftIcon(lift)}
        <span class="station-item-nr">${liftCode(lift.nr)}</span>
        <span class="station-item-name">${lift.name}</span>
        ${liftStatusHtml(lift.nr)}
      `;
      btn.addEventListener('click', () => pickStation(lift.dal, lift, 'dal'));
      list.appendChild(btn);
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
  document.getElementById(`${routeSide}-nr`).textContent           = liftCode(lift.nr);
  document.getElementById(`${routeSide}-liftname`).textContent     = lift.name;
  setChosenSide(routeSide);
  if (routeSide === 'dend') setEndField(true);
}

// Bottom / Top switch on a chosen lift: the bottom station is picked by
// default, a tap on Top moves the start or destination to the top station.
function setChosenSide(routeSide) {
  const s = selected[routeSide];
  const el = document.getElementById(`${routeSide}-side`);
  el.innerHTML = ['dal', 'berg'].map(dalBerg => `
    <button type="button" class="side-opt${s.side === dalBerg ? ' active' : ''}" data-side="${dalBerg}"
      aria-pressed="${s.side === dalBerg}">${SIDE_ICONS[dalBerg]} ${dalBerg === 'dal' ? 'Bottom' : 'Top'}</button>`).join('');
  el.querySelectorAll('.side-opt').forEach(btn => btn.addEventListener('click', event => {
    event.stopPropagation(); // the chosen field itself opens the picker
    const dalBerg = btn.dataset.side;
    if (dalBerg === s.side) return;
    const stationId = s.lift[dalBerg];
    selected[routeSide] = { ...s, id: stationId, ...STATIONS[stationId], side: dalBerg };
    setChosenSide(routeSide);
  }));
}

// Point at the station fields left empty: a red edge, scrolled into view.
function markMissing(sides) {
  sides.forEach(side => document.getElementById(`${side}-box`).classList.add('field-error'));
  if (sides.length) document.getElementById(`${sides[0]}-box`).scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetSide(side) {
  selected[side] = null;
  document.getElementById(`${side}-box`).classList.remove('field-error');
  document.getElementById(`${side}-box`).style.display    = 'flex';
  document.getElementById(`${side}-chosen`).style.display = 'none';
  if (side === 'dend') setEndField(false);
}

// The day plan starts and ends at the same station. 'End somewhere else'
// adds an extra field for another end station; 'Same as start' (or clearing
// it) takes the field away again.
function setEndField(show) {
  document.getElementById('end-field').style.display = show ? 'block' : 'none';
  document.getElementById('end-add').style.display   = show ? 'none' : 'inline-flex';
  document.getElementById('dstart-label').textContent = show ? 'Start – lift station' : 'Start & end – lift station';
}

function swapSides() {
  if (selected.from?.gps) {
    showError('err', 'Your location can only be a starting point.');
    return;
  }
  const tmp = selected.from;
  selected.from = selected.to;
  selected.to   = tmp;

  ['from', 'to'].forEach(side => {
    if (!selected[side]) { resetSide(side); return; }
    const s = selected[side];
    document.getElementById(`${side}-box`).style.display    = 'none';
    document.getElementById(`${side}-chosen`).style.display = 'flex';
    document.getElementById(`${side}-icon`).innerHTML       = s.gps ? GPS_ICON : liftIcon(s.lift);
    document.getElementById(`${side}-nr`).textContent       = s.gps ? s.liftNr : liftCode(s.liftNr);
    document.getElementById(`${side}-liftname`).textContent = s.liftName;
    if (s.gps) document.getElementById(`${side}-side`).textContent = '';
    else setChosenSide(side);
  });
}

// ── Difficulty filter ────────────────────────────────────────────────────────

function setDiff(value) {
  if (value === 'all') {
    allowedDiff = allowedDiff.size === DIFF_LEVELS.length ? new Set() : new Set(DIFF_LEVELS);
  } else {
    allowedDiff.has(value) ? allowedDiff.delete(value) : allowedDiff.add(value);
  }
  renderQuickDiff();
}

function renderQuickDiff() {
  DIFF_LEVELS.forEach(d => document.getElementById('d-' + d).classList.toggle('on', allowedDiff.has(d)));
  document.getElementById('d-all').classList.toggle('on', allowedDiff.size === DIFF_LEVELS.length);
  document.getElementById('d-summary').textContent = diffSummary(allowedDiff);
}

// "All", "None" or e.g. "Blue · Red": the collapsed difficulty setting.
const DIFF_NAMES = { blauw: 'Blue', rood: 'Red', zwart: 'Black', skiroute: 'Ski route' };
function diffSummary(set) {
  if (set.size === DIFF_LEVELS.length) return 'All';
  if (!set.size) return 'None';
  return DIFF_LEVELS.filter(d => set.has(d)).map(d => DIFF_NAMES[d]).join(' · ');
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
  const queue   = new MinHeap();
  queue.push(0, startId);

  while (queue.size) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === endId) break;

    (GRAPH[current] || []).forEach(edge => {
      if (edge.type === 'piste' && pisteKleuren(edge).some(k => !allowedDiff.has(k))) return;
      if (edge.type === 'bus' && !busAllowed('q-bus')) return;
      if (isAvoided(edge)) return;
      const newCost = dist[current] + (edge.tijd || 0)
        + (edge.descent ? RIDE_DOWN_PENALTY : 0)
        + (isConnection(edge) ? CONNECTION_PENALTY : 0);
      if (newCost < dist[edge.to]) {
        dist[edge.to]     = newCost;
        prev[edge.to]     = current;
        prevEdge[edge.to] = edge;
        queue.push(newCost, edge.to);
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
  bus:              '🚌',
  walk:             '🚶',
};

const LIFT_TYPE_LABEL = { gondola: 'Gondola', mixed_lift: 'Gondola', cable_car: 'Cable car', funicular: 'Funicular', chair_lift: 'Chairlift' };

// Drag lifts (t-bar, platter, j-bar, rope tow) get the T-bar pictogram.
// Any other non-`echteLift` (magic carpets) is a generic "oefenlift".
// A ski bus or walk between stations (from the area's `verbindingen`).
function isConnection(edge) {
  return edge.type === 'bus' || edge.type === 'walk';
}

function stepClass(edge) {
  if (edge.type === 'piste')    return 'piste-' + (edge.diff || 'rood');
  if (edge.type === 'transfer') return 'transfer';
  if (isConnection(edge))       return edge.type;
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
  if (edge.type === 'bus')   return 'Ski bus';
  if (edge.type === 'walk')  return 'Walk';
  if (edge.type === 'piste') return { blauw: 'Blue ●', rood: 'Red ●', zwart: 'Black ●', skiroute: 'Ski route ●' }[edge.diff] || 'Piste';
  if (DRAG_LIFT_LABEL[edge.type]) return DRAG_LIFT_LABEL[edge.type];
  if (edge.echteLift === false) return 'Practice lift';
  return LIFT_TYPE_LABEL[edge.type] || 'Lift';
}

function showError(id, message) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.classList.add('visible');
}

function planRoute(options = {}) {
  const errorEl  = document.getElementById('err');
  const resultEl = document.getElementById('result');
  errorEl.classList.remove('visible');

  if (!selected.from || !selected.to) {
    errorEl.textContent = 'Select a starting point and a destination.';
    errorEl.classList.add('visible');
    markMissing(['from', 'to'].filter(side => !selected[side]));
    return;
  }
  if (selected.from.id === selected.to.id) {
    errorEl.textContent = 'Starting point and destination are the same.';
    errorEl.classList.add('visible');
    return;
  }

  const result = dijkstra(selected.from.id, selected.to.id);
  if (!result || !result.path.length) {
    errorEl.textContent = avoidedLifts.size
      ? `No route without the lifts you avoid (${[...avoidedLifts].join(', ')}). Remove one from the list, or also select red or black.`
      : busAllowed('q-bus')
        ? 'No route found. Try also selecting red or black.'
        : 'No route without the ski bus. Switch the ski bus on, or also select red or black.';
    errorEl.classList.add('visible');
    resultEl.classList.remove('visible');
    return;
  }

  renderRoute(result);
  resultEl.classList.add('visible');
  if (!options.silent) resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Back from a planned route to its planner, with every setting as it was.
function backToPlanner(cardId) {
  document.getElementById(cardId).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// A piste edge with `trajecten` runs through several marked numbers (74a
// that carries on as 75): every part's colour must pass the filter.
// Cached per edge: the day planner asks this many thousands of times.
const pisteKleurenCache = new WeakMap();
function pisteKleuren(edge) {
  let kleuren = pisteKleurenCache.get(edge);
  if (!kleuren) {
    const parts = edge.trajecten || [{ kleur: edge.diff, ookKleur: edge.ookKleur }];
    kleuren = parts.flatMap(t => [t.kleur, t.ookKleur]).filter(Boolean);
    pisteKleurenCache.set(edge, kleuren);
  }
  return kleuren;
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
    ookKleur: t.ookKleur || null,
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

  document.getElementById('p-steps').textContent = `${visibleSteps.length} step${visibleSteps.length === 1 ? '' : 's'}`;
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

  // Closed lifts first, above the steps, as in the day plan.
  document.getElementById('q-closed').innerHTML = closedWarning(visibleSteps);
  document.getElementById('tip').innerHTML = getTip();

  const signature = [selected.from.id, ...visibleSteps.map(e => e.liftNr || e.pisteNr), selected.to.id].join('>');
  makeCheckable(stepsEl, 'quick', signature, quickStatus, {
    from: selected.from.id, to: selected.to.id, diff: [...allowedDiff], bus: busAllowed('q-bus'),
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
  const km = edge.km ? Math.round(edge.km * 10) / 10 : 0;
  const facts = [km ? `${km || 0.1} km` : '', edge.tijd ? `~${edge.tijd} min` : ''].filter(Boolean).join(' · ');
  const clockHtml = clock ? `<span class="step-clock">${clock}</span>` : '';

  if (edge.type === 'piste') {
    // Piste: the number sits inside a sign in the difficulty colour, like on the mountain.
    const diff = edge.diff || 'rood';
    const nr = String(edge.pisteNr || '');
    // Unnumbered runs use their name (or a generated "~n" key) as pisteNr:
    // the sign then shows a skier instead.
    const short = nr.replace(/\s+/g, '').length <= 3 && !nr.startsWith('~');
    div.className = `step step-piste piste-${diff}`;
    div.innerHTML = `
      <span class="step-number">${index + 1}</span>
      <div class="piste-sign sign-${diff}${short ? (nr.replace(/\s+/g, '').length === 3 ? ' sign-long' : '') : ' sign-noname'}" aria-label="Piste ${escapeHtml(nr)}"><span>${short ? escapeHtml(nr.replace(/\s+/g, '')) : '⛷'}</span></div>
      <div class="step-info">
        <div class="step-kind kind-${diff}">${PISTE_KIND[diff] || 'Piste'}</div>
        <div class="step-name">${edge.name}</div>
        ${facts ? `<div class="step-sub">${facts}</div>` : ''}
      </div>
    `;
  } else if (isConnection(edge)) {
    // Bus or walk between two stations: from → to, with any practical info.
    const from = STATIONS[edge.from]?.name || '';
    const to   = STATIONS[edge.to]?.name || '';
    div.className = 'step step-connection';
    div.innerHTML = `
      <span class="step-number">${index + 1}</span>
      <div class="step-icon ico-${edge.type}">${STEP_ICONS[edge.type]}</div>
      <div class="step-info">
        <div class="step-kind kind-connection">${tagLabel(edge)}${edge.tijd ? ` · ~${edge.tijd} min` : ''}</div>
        <div class="step-name">${from} → ${to}</div>
        ${edge.type === 'bus' && edge.stopFrom && edge.stopTo ? `<div class="step-sub">🚏 ${edge.stopFrom} → ${edge.stopTo}</div>` : ''}
        ${edge.info ? `<div class="step-sub">${edge.info}</div>` : ''}
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
        <div class="step-actions">${liftStatusHtml(edge.liftNr)}<button class="avoid-btn" type="button" data-avoid="${edge.liftNr}" aria-label="Avoid ${edge.liftNr}">⊘ Avoid</button></div>
        <div class="step-title"><span class="lift-code">${liftCode(edge.liftNr)}</span><span class="step-name">${edge.name}</span></div>
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

function closedWarning(steps = []) {
  const closed = closedLiftsOn(steps);
  return closed.length
    ? `<div class="closed-warning">⚠ ${closedLabel()}: ${closed.map(e => `${e.liftNr} ${e.name}`).join(', ')}. ${avoidClosedButton(closed)}</div>`
    : '';
}

function getTip() {
  return '💡 <strong>Tip:</strong> ' + (LIFT_STATUS
    ? `Lift status ${LIFT_STATUS.live ? 'live ' : ''}from ${LIFT_STATUS.bron}, ${liftStatusAge()}. Things can change during the day.`
    : 'Check the current opening times of your ski area before you set off.');
}

// ── Avoiding lifts ───────────────────────────────────────────────────────────
//
// Any lift can be skipped by hand, open or closed: '⊘ Avoid' on a lift step
// (or 'Avoid these' at the closed-lifts warning) adds it to a list per area,
// both planners route around it, and the route is planned again. The list
// shows as chips in the planner cards; ✕ takes a lift off it.

const AVOID_KEY_PREFIX = 'skiplanner:avoid:';
let avoidedLifts = new Set();

function avoidKey() {
  return AVOID_KEY_PREFIX + (currentArea?.id || '');
}

function loadAvoided() {
  try { avoidedLifts = new Set(JSON.parse(localStorage.getItem(avoidKey())) || []); } catch { avoidedLifts = new Set(); }
  renderAvoided();
}

function saveAvoided() {
  try { localStorage.setItem(avoidKey(), JSON.stringify([...avoidedLifts])); } catch {}
}

// A lift ride (up, or down in a gondola) on the avoid list.
function isAvoided(edge) {
  return !!edge.liftNr && edge.type !== 'piste' && !isConnection(edge) && avoidedLifts.has(edge.liftNr);
}

function avoidClosedButton(closed) {
  return `<button class="avoid-closed-btn" type="button" data-avoid="${closed.map(e => e.liftNr).join(',')}">⊘ Avoid ${closed.length > 1 ? 'these' : 'it'}</button>`;
}

function renderAvoided() {
  const nrs = [...avoidedLifts].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  ['q-avoid', 'day-avoid'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = nrs.length ? 'flex' : 'none';
    el.innerHTML = nrs.length
      ? '<span class="avoid-label">🚫 Avoiding</span>' + nrs.map(nr => {
          const lift = LIFTS.find(l => l.nr === nr);
          return `<button class="avoid-chip" type="button" onclick="unavoidLift('${nr}')" aria-label="Stop avoiding ${escapeHtml(lift?.name || nr)}">${[liftCode(nr), lift?.name].filter(Boolean).join(' ')} ✕</button>`;
        }).join('')
      : '';
  });
}

function unavoidLift(nr) {
  avoidedLifts.delete(nr);
  saveAvoided();
  renderAvoided();
}

// Add lifts to the list and plan the route again without them. A day being
// followed is replanned from the next step; otherwise the whole day.
function avoidLifts(nrs, planner) {
  nrs.filter(Boolean).forEach(nr => avoidedLifts.add(nr));
  saveAvoided();
  renderAvoided();
  if (planner === 'day') {
    if (dayTracker && dayTracker.done > 0 && dayTracker.done < dayTracker.items.length) replanFromHere();
    else planDay();
    if (document.getElementById('day-err').classList.contains('visible')) backToPlanner('day-card');
  } else {
    planRoute();
    if (document.getElementById('err').classList.contains('visible')) backToPlanner('quick-card');
  }
}

// One listener per result card, in the capture phase so the tap on 'Avoid'
// does not also tick the step off.
[['result', 'quick'], ['day-result', 'day']].forEach(([id, planner]) => {
  document.getElementById(id).addEventListener('click', event => {
    const btn = event.target.closest('[data-avoid]');
    if (!btn) return;
    event.stopPropagation();
    event.preventDefault();
    avoidLifts(btn.dataset.avoid.split(','), planner);
  }, true);
});

// ── Lift status (open/closed, operating hours) ───────────────────────────────
//
// Fetched every 30 minutes from the ski area's website by
// tools/lift-status.mjs into data/<area>-liftstatus.json (see areas.json).

let LIFT_STATUS = null; // { bron, sourceUpdate, changed, lifts: { A1: { open, hours, from, to, … } } }

// Live from the area's own API, straight from the browser (kitzski.at sends
// 'Access-Control-Allow-Origin: *'). Falls back to the last live result kept
// on the phone, then to the file GitHub Actions refreshes in data/.
const LIFT_STATUS_LIVE_KEY = 'skiplanner:liftstatus:';
const LIFT_STATUS_REFRESH_MS = 5 * 60 * 1000;
const LIFT_STATUS_TIMEOUT_MS = 8000;
let liftStatusMeta = null; // the area's liftstatus config from areas.json

async function loadLiftStatus(areaMeta) {
  LIFT_STATUS = null;
  liftStatusMeta = areaMeta.liftstatus || null;
  if (!liftStatusMeta) return;
  // Newest of the published file and the last live result on this phone.
  let fromFile = null;
  try {
    const response = await fetch(liftStatusMeta.file, liftStatusMeta.europe ? { cache: 'no-store', signal: AbortSignal.timeout(LIFT_STATUS_TIMEOUT_MS) } : {});
    if (response.ok) fromFile = await response.json();
  } catch {}
  let fromPhone = null;
  try { fromPhone = JSON.parse(localStorage.getItem(LIFT_STATUS_LIVE_KEY + areaMeta.id)); } catch {}
  LIFT_STATUS = [fromFile, fromPhone].filter(Boolean).map(europeLiftStatus)
    .sort((a, b) => String(b.sourceUpdate || '').localeCompare(String(a.sourceUpdate || '')))[0] || null;
  // A European area's file is on GitHub, not on this site, so the service
  // worker does not keep it: the phone does, for offline use.
  if (liftStatusMeta.europe && fromFile) {
    try { localStorage.setItem(LIFT_STATUS_LIVE_KEY + areaMeta.id, JSON.stringify(fromFile)); } catch {}
  }
  // Then live, without holding up the first screen.
  refreshLiftStatusLive();
}

// A European area's status file (tools/liftstatus-europe.mjs) has the
// source's own lift names; match them to this area's lifts by name
// (liftmatch.js). Other status files are keyed by lift number already.
function europeLiftStatus(data) {
  if (!Array.isArray(data?.lifts)) return data;
  const matched = matchLifts(currentArea?.liften || [], data.lifts);
  const lifts = {};
  Object.entries(matched).forEach(([nr, i]) => {
    const s = data.lifts[i];
    lifts[nr] = { open: !!s.open, hours: s.hours || null, text: s.text || '' };
  });
  return { bron: data.bron, sourceUpdate: data.sourceUpdate, lifts };
}

// Fetch the live status; on success redraw whatever route is on screen.
async function refreshLiftStatusLive() {
  const cfg = liftStatusMeta;
  const areaId = currentArea?.id;
  if (!cfg || !navigator.onLine) return;
  if (cfg.europe) return refreshEuropeLiftStatus(cfg, areaId);
  if (cfg.bron !== 'micado-skigebietemanager') return;
  try {
    const params = new URLSearchParams({ client: cfg.client, lang: 'de', region: cfg.region, season: 'winter', type: 'lift' });
    const url = `${cfg.base}/micadoapi/SkigebieteManager/Micado.SkigebieteManager.Plugin.FacilityApi/ListFacilities.api?${params}`;
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(LIFT_STATUS_TIMEOUT_MS) });
    if (!response.ok) return;
    const data = await response.json();
    if (currentArea?.id !== areaId) return; // switched area meanwhile
    const live = liveLiftStatus(data, cfg);
    if (!Object.keys(live.lifts).length) return;
    LIFT_STATUS = live;
    try { localStorage.setItem(LIFT_STATUS_LIVE_KEY + areaId, JSON.stringify(live)); } catch {}
    redrawLiftStatus();
  } catch (err) {
    console.warn('Live lift status unavailable:', err);
  }
}

// A European area: fetch its status file again (GitHub Actions writes it
// every 30 minutes); redraw when it is newer than what is shown.
async function refreshEuropeLiftStatus(cfg, areaId) {
  try {
    const response = await fetch(cfg.file, { cache: 'no-store', signal: AbortSignal.timeout(LIFT_STATUS_TIMEOUT_MS) });
    if (!response.ok) return;
    const data = await response.json();
    if (currentArea?.id !== areaId || !Array.isArray(data.lifts)) return;
    if (LIFT_STATUS && String(data.sourceUpdate || '') <= String(LIFT_STATUS.sourceUpdate || '')) return;
    LIFT_STATUS = europeLiftStatus(data);
    try { localStorage.setItem(LIFT_STATUS_LIVE_KEY + areaId, JSON.stringify(data)); } catch {}
    redrawLiftStatus();
  } catch (err) {
    console.warn('Lift status unavailable:', err);
  }
}

// The Micado lift list in the same shape as data/<area>-liftstatus.json
// (tools/lift-status.mjs does the same on the server side).
function liveLiftStatus(data, cfg) {
  const hours = value => {
    const m = /(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/.exec(value || '');
    return m ? `${m[1].padStart(2, '0')}:${m[2]}-${m[3].padStart(2, '0')}:${m[4]}` : null;
  };
  const byId = new Map((data.facilities || []).map(f => [f.identifier, f]));
  const lifts = {};
  (currentArea.liften || []).forEach(lift => {
    const f = byId.get(lift.liftNr) || byId.get(lift.liftNr.replace(/[a-z]+$/, ''));
    if (!f) return;
    lifts[lift.liftNr] = {
      open: f.status === 1,
      hours: hours(f.operatingTimePeriod || f.openingHours),
      from: (f.operatingDateFrom || '').slice(0, 10) || null,
      to: (f.operatingDateTo || '').slice(0, 10) || null,
      weekdays: f.operatingWeekdays ?? null,
      text: f.operatingText || '',
    };
  });
  return { bron: new URL(cfg.base).hostname, sourceUpdate: data.meta?.lastUpdate || null, live: true, lifts };
}

// New status in: redraw an open station list and any route or day on screen.
function redrawLiftStatus() {
  renderHeaderLiftStatus();
  if (document.getElementById('sheet').style.display !== 'none') renderSheet();
  if (document.getElementById('result').classList.contains('visible') && selected.from && selected.to) planRoute({ silent: true });
  if (document.getElementById('day-result').classList.contains('visible') && dayOptions.length) renderDayOption(dayShown);
}

// Keep it fresh while the app is open on the mountain.
setInterval(() => {
  if (document.visibilityState === 'visible') refreshLiftStatusLive();
}, LIFT_STATUS_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshLiftStatusLive();
});

function liftStatus(liftNr) {
  return LIFT_STATUS?.lifts?.[liftNr] || null;
}

// "open 08:30–17:00", "closed" — or '' when the area has no status data.
function liftStatusLabel(liftNr) {
  const s = liftStatus(liftNr);
  if (!s) return '';
  if (!s.open) return 'closed';
  return s.hours ? `open ${s.hours.replace('-', '–')}` : 'open';
}

function liftStatusHtml(liftNr) {
  const label = liftStatusLabel(liftNr);
  if (!label) return '';
  const open = liftStatus(liftNr).open;
  return `<span class="lift-status ${open ? 'is-open' : 'is-closed'}">${open ? '●' : '○'} ${label}</span>`;
}

// A status from an earlier day says nothing about today's lifts.
function liftStatusStale() {
  const t = LIFT_STATUS?.sourceUpdate ? new Date(LIFT_STATUS.sourceUpdate) : null;
  return !!t && !isNaN(t) && t.toDateString() !== new Date().toDateString();
}

// "Closed right now", or, with an old status, when it was last known closed.
function closedLabel() {
  return liftStatusStale() ? `Closed at the last update (${liftStatusAge().replace(/^updated /, '')})` : 'Closed right now';
}

// When the status was last checked against the source, in words.
function liftStatusAge() {
  const t = LIFT_STATUS?.sourceUpdate ? new Date(LIFT_STATUS.sourceUpdate) : null;
  if (!t || isNaN(t)) return 'recently updated';
  const sameDay = t.toDateString() === new Date().toDateString();
  const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `updated ${time}` : `updated ${t.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

// Real lifts (not ride-down, bus or piste) on a route that are closed now.
function closedLiftsOn(steps) {
  const seen = new Set();
  return steps.filter(e => e && e.liftNr && e.type !== 'piste' && !e.descent && !isConnection(e))
    .filter(e => { const s = liftStatus(e.liftNr); return s && !s.open; })
    .filter(e => !seen.has(e.liftNr) && seen.add(e.liftNr));
}

// ── Where am I (GPS) ─────────────────────────────────────────────────────────
//
// "Use my location" adds a temporary start node to the graph: a short walk
// to every lift station close by, and — when you stand on a piste — the
// rest of that run down to wherever it ends. Positions come from the OSM
// enrichment (liften[].coordOnder/coordBoven, pisteLijnen).

const GPS_NODE           = 'gps';
const GPS_ICON           = '<span class="lift-ico ico-gps">📍</span>';
const GPS_STATION_RADIUS = 300; // walk to a lift station this close (m)
const GPS_PISTE_RADIUS   = 80;  // this close to a piste's course: you are on it (m)
const GPS_WALK_M_PER_MIN = 60;  // walking in ski boots
const GPS_POOR_ACCURACY  = 150; // warn above this (m)
const GPS_MAX_DISTANCE   = 5000; // further than this: not in this ski area (m)

function distanceM([lat1, lon1], [lat2, lon2]) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Distance from point p to segment a–b in metres (flat projection, fine at this scale).
function distanceToSegmentM(p, a, b) {
  const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
  const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function stationPositions() {
  const positions = {};
  (currentArea?.liften || []).forEach(l => {
    if (l.coordOnder && STATIONS[`${l.liftNr}-onder`]) positions[`${l.liftNr}-onder`] = l.coordOnder;
    if (l.coordBoven && STATIONS[`${l.liftNr}-boven`]) positions[`${l.liftNr}-boven`] = l.coordBoven;
  });
  return positions;
}

function nearestPiste(here) {
  let best = null;
  Object.entries(currentArea?.pisteLijnen || {}).forEach(([nr, lines]) => {
    lines.forEach(line => {
      for (let i = 1; i < line.length; i++) {
        const d = distanceToSegmentM(here, line[i - 1], line[i]);
        if (!best || d < best.d) best = { nr, d };
      }
    });
  });
  return best;
}

function setGpsStatus(text) {
  const el = document.getElementById('gps-status');
  if (el) el.textContent = text;
}

function locateMe() {
  const side = activeSide;
  if (!navigator.geolocation) { setGpsStatus('Location is not available on this device.'); return; }
  setGpsStatus('Finding you…');
  navigator.geolocation.getCurrentPosition(
    pos => placeMe(side, [pos.coords.latitude, pos.coords.longitude], pos.coords.accuracy),
    err => setGpsStatus(err.code === err.PERMISSION_DENIED
      ? 'Location access is off — allow it for this site in your settings.'
      : 'Could not find your location. Try again outside or pick a station.'),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
}

function placeMe(side, here, accuracy) {
  delete STATIONS[GPS_NODE];
  delete GRAPH[GPS_NODE];

  const positions = stationPositions();
  const near = Object.entries(positions)
    .map(([id, pos]) => ({ id, d: distanceM(here, pos) }))
    .sort((a, b) => a.d - b.d);
  if (!near.length) { setGpsStatus('This ski area has no station positions yet.'); return; }

  const edges = near.filter(n => n.d <= GPS_STATION_RADIUS).map(n => ({
    from: GPS_NODE, to: n.id, type: 'walk', name: 'Walk',
    info: `About ${Math.round(n.d / 10) * 10} m from where you are.`,
    tijd: Math.max(1, Math.round(n.d / GPS_WALK_M_PER_MIN)),
  }));

  // On a piste: carry on to wherever that run ends (about half of it left).
  const piste = nearestPiste(here);
  const onPiste = piste && piste.d <= GPS_PISTE_RADIUS ? piste.nr : null;
  if (onPiste) {
    Object.values(GRAPH).flat().forEach(edge => {
      if (edge.type !== 'piste' || edge.from === GPS_NODE) return;
      const part = edge.trajecten ? edge.trajecten.find(t => t.pisteNr === onPiste) : (edge.pisteNr === onPiste ? edge : null);
      if (!part) return;
      edges.push({
        ...edge,
        from: GPS_NODE,
        trajecten: null,
        pisteNr: onPiste,
        diff: part.kleur || edge.diff,
        name: `${part.naam || edge.name} (rest of the run)`,
        tijd: Math.max(1, Math.ceil((edge.tijd || 0) / 2)),
        km: edge.km != null ? Math.round(edge.km * 50) / 100 : undefined,
      });
    });
  }

  const accuracyNote = accuracy > GPS_POOR_ACCURACY ? ` · ⚠ ±${Math.round(accuracy)} m` : '';
  // Nearest station of a real lift (not a magic carpet), for the fallback.
  const nearest = near.find(n => LIFTS.find(l => l.dal === n.id || l.berg === n.id)?.echteLift);
  if (!edges.length && (!nearest || nearest.d > GPS_MAX_DISTANCE)) {
    const km = (near[0].d / 1000).toFixed(near[0].d > 20000 ? 0 : 1);
    setGpsStatus(`You are about ${km} km from ${currentArea.name} — pick a station instead.`);
    return;
  }
  closeSheet();

  if (!edges.length) {
    // Further away: start at the nearest lift station, and say how far it is.
    const lift = LIFTS.find(l => l.dal === nearest.id || l.berg === nearest.id);
    activeSide = side;
    pickStation(nearest.id, lift, lift.dal === nearest.id ? 'dal' : 'berg');
    const km = nearest.d >= 1000 ? `${(nearest.d / 1000).toFixed(1)} km` : `${Math.round(nearest.d)} m`;
    document.getElementById(`${side}-side`).textContent = `📍 ${km} away${accuracyNote}`;
    return;
  }

  const label = onPiste
    ? `My location · on ${pisteLabel(onPiste)}`
    : `My location · near ${STATIONS[near[0].id].name}`;
  STATIONS[GPS_NODE] = { name: label, alt: null };
  GRAPH[GPS_NODE] = edges;

  selected[side] = { id: GPS_NODE, name: label, alt: null, gps: true, liftNr: 'GPS', liftName: label };
  document.getElementById(`${side}-box`).style.display    = 'none';
  document.getElementById(`${side}-chosen`).style.display = 'flex';
  document.getElementById(`${side}-icon`).innerHTML       = GPS_ICON;
  document.getElementById(`${side}-nr`).textContent       = 'GPS';
  document.getElementById(`${side}-liftname`).textContent = onPiste ? `On ${pisteLabel(onPiste)}` : `Near ${STATIONS[near[0].id].name}`;
  document.getElementById(`${side}-side`).textContent     = `±${Math.round(accuracy)} m${accuracyNote ? ' ⚠' : ''}`;
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

function clearProgress(kind) {
  try { localStorage.removeItem(progressKey(kind)); } catch {}
}

// The plan button: a fresh route, so nothing ticked yet, even when it is the
// same route as last time.
function planRouteClicked() {
  clearProgress('quick');
  planRoute();
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
