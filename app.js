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
let LIFTS        = []; // [{ nr, name, type, echteLift, dal: nodeId, berg: nodeId }] — for the picker
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
// Extra routing cost of a piste in a colour you did not pick, or a drag lift
// when you would rather not: such a route is only taken when there is no
// other way (and the route says so).
const UNWANTED_PENALTY = 120;

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

    lifts.push({
      nr: lift.liftNr,
      name: lift.naam || lift.liftNr,
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
  // Areas built from the run network (afdalingen) keep a walk only where
  // skiing does not get you there, the same rule as tools/lib/compile-area.mjs
  // (keepWalk), also for data built before that rule.
  const descents = Array.isArray(area.afdalingen) ? new Set(area.afdalingen.map(d => `${d.van}>${d.naar}`)) : null;
  const keepWalk = (from, to) => !descents || (!to.endsWith('-boven')
    && (from.endsWith('-onder') || !descents.has(`${from.slice(0, -'-boven'.length)}>${to.slice(0, -'-onder'.length)}`)));
  (area.verbindingen || []).forEach(v => {
    if (!stations[v.van] || !stations[v.naar]) return;
    const walk = v.soort === 'lopen';
    const edge = {
      type: v.soort === 'lopen' ? 'walk' : 'bus',
      name: v.naam || (v.soort === 'lopen' ? 'Walk' : 'Ski bus'),
      info: v.info || '',
      tijd: v.tijd || 0,
    };
    // The nearest bus stop of a bottom station, from the OSM enrichment.
    const stopAt = id => id.endsWith('-onder') ? liftByNr.get(id.slice(0, -'-onder'.length))?.bushalte?.naam : undefined;
    if (!walk || keepWalk(v.van, v.naar)) addEdge({ ...edge, from: v.van, to: v.naar, stopFrom: stopAt(v.van), stopTo: stopAt(v.naar) });
    if (v.beideRichtingen !== false && (!walk || keepWalk(v.naar, v.van))) addEdge({ ...edge, from: v.naar, to: v.van, stopFrom: stopAt(v.naar), stopTo: stopAt(v.van) });
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

const AREA_REGISTRY_URL = 'data/areas.json';         // hand-made areas (from a piste map photo)
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

// Areas with a new id: what this phone kept under the old one (last area,
// favourite, avoided lifts and pistes, day plan, progress) moves along.
// KitzSki was a hand-made file until it was built like every other area.
const RENAMED_AREAS = { 'kitzski-osm': 'kitzski' };
const areaIdNow = id => RENAMED_AREAS[id] || id;

function moveRenamedAreas() {
  try {
    let moved = false;
    for (const [from, to] of Object.entries(RENAMED_AREAS)) {
      if (localStorage.getItem(LAST_AREA_KEY) === from) localStorage.setItem(LAST_AREA_KEY, to);
      const favourites = favouriteAreaIds();
      if (favourites.includes(from)) {
        localStorage.setItem(FAVOURITE_AREAS_KEY, JSON.stringify(favourites.map(areaIdNow)));
        moved = true;
      }
      Object.keys(localStorage).filter(key => key.endsWith(`:${from}`) || key.includes(`:${from}:`)).forEach(key => {
        const next = key.replace(`:${from}`, `:${to}`);
        if (localStorage.getItem(next) == null) localStorage.setItem(next, localStorage.getItem(key));
        localStorage.removeItem(key);
        moved = true;
      });
    }
    if (moved) accountPrefsChanged();
  } catch {}
}

async function initApp() {
  moveRenamedAreas();
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
  accountPrefsChanged();
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
  // Just the name: the compact header above the planner has room for one line.
  document.getElementById('header-tagline').textContent = area.name;

  const stats = area.stats || {};
  document.getElementById('stat-km').textContent      = stats.pistesKm != null ? `${stats.pistesKm} km` : '—';
  document.getElementById('stat-liften').textContent  = stats.liften  != null ? `${stats.liften}`       : '—';
  document.getElementById('stat-hoogte').textContent  = stats.hoogte  || '—';
  document.getElementById('header-stats').style.display     = 'flex';
  renderHeaderLiftStatus();
  document.getElementById('area-switch-btn').style.display  = 'inline-flex';
  document.getElementById('prefs-btn').style.display        = 'inline-flex';
  document.body.classList.add('in-planner'); // smaller logo and button above the planner
}

// The area picker is a screen of its own: nothing about an area at the top.
function clearAreaHeader() {
  document.getElementById('header-tagline').textContent = 'Choose a ski area to get started';
  ['header-stats', 'header-live', 'area-switch-btn', 'prefs-btn'].forEach(id => { document.getElementById(id).style.display = 'none'; });
  document.getElementById('prefs-screen').style.display = 'none';
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
  closeAccount();
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
  // Green only where the area has green runs.
  const hasGreen = (currentArea?.pistes || []).some(p => p.kleur === 'groen');
  document.querySelectorAll('.diff-btn.green').forEach(btn => { btn.style.display = hasGreen ? '' : 'none'; });
  document.querySelectorAll('.bus-row').forEach(row => { row.style.display = areaHasBus() ? 'flex' : 'none'; });
  renderPrefs();
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

// The drag lift switch of a planner (T-bars, platters, rope tows): off means
// "rather not", so they are only used when there is no other way.
function dragAllowed(id) {
  const box = document.getElementById(id);
  return !box || box.checked;
}

function isDragLift(edge) {
  return !!DRAG_LIFT_LABEL[edge.type];
}

// A piste in a colour you did not pick, or a drag lift while you would rather
// not: allowed, but only when there is no other way (UNWANTED_PENALTY).
function unwantedEdge(edge, diff, dragOk) {
  if (edge.type === 'piste') return pisteKleuren(edge).some(k => !diff.has(k));
  return !dragOk && isDragLift(edge);
}

// What a route uses that you would rather not, said once above its steps.
function unwantedWarning(edges, diff, dragOk) {
  const seen = new Set();
  const items = edges.filter(e => e && unwantedEdge(e, diff, dragOk)).filter(e => {
    const key = e.type === 'piste' ? `p${e.pisteNr}` : `l${e.liftNr}`;
    return !seen.has(key) && seen.add(key);
  }).map(e => e.type === 'piste'
    ? `${pisteLabel(e.pisteNr)} (${(DIFF_NAMES[e.diff] || '').toLowerCase()})`
    : `${[liftCode(e.liftNr), e.name].filter(Boolean).join(' ')} (${(DRAG_LIFT_LABEL[e.type] || 'drag lift').toLowerCase()})`);
  return items.length ? `Not possible with only your choices, so this uses ${items.join(' and ')}.` : '';
}

// ── State ────────────────────────────────────────────────────────────────────

// Green: the easiest runs where an area marks them (France, Spain, …).
const DIFF_LEVELS = ['groen', 'blauw', 'rood', 'zwart', 'skiroute'];

let activeSide = null;
const selected = { from: null, to: null };
let allowedDiff = new Set(DIFF_LEVELS);

// ── Sheet (station picker) ───────────────────────────────────────────────────

function openSheet(side) {
  activeSide = side;
  document.getElementById('sheet-title').textContent =
    side === 'stop' ? 'Add a stop'
      : side === 'from' || side === 'dstart' ? 'Choose starting point' : 'Choose destination';
  document.getElementById('sheet-search').value = '';
  setSheetKind('lifts', false);
  document.getElementById('overlay').style.display = 'block';
  document.getElementById('sheet').style.display = 'flex';
  // On screen first: the map needs its size.
  if (sheetView === 'list') renderSheet();
  showSheetView();
  lockPageScroll();
  fitSheetToKeyboard();
  // Focus right away, still inside the tap: iPhones only bring up the
  // keyboard for a focus that happens during the tap itself, not after a delay.
  // Not on the map: the keyboard would cover it.
  if (sheetView === 'list') document.getElementById('sheet-search').focus({ preventScroll: true });
}

function closeSheet() {
  const sheet = document.getElementById('sheet');
  document.getElementById('overlay').style.display = 'none';
  sheet.style.display = 'none';
  sheet.style.transform = '';
  document.getElementById('sheet-list').style.paddingBottom = '';
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

// The on-screen keyboard. The sheet has a fixed height and never changes
// size or place for the keyboard: an iPhone stutters or drops a scroll when
// the list resizes under the finger. The keyboard just covers the bottom of
// the sheet; the list gets room at its end (padding) so every lift can be
// scrolled up above it, and the first swipe on the list puts the keyboard
// away, which uncovers the rest without anything moving.
let sheetTouched = false;  // a finger is on the sheet
function fitSheetToKeyboard() {
  const sheet = document.getElementById('sheet');
  const vv = window.visualViewport;
  if (!vv || sheet.style.display === 'none') return;
  const layoutHeight = document.documentElement.clientHeight;
  const covered = Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop));
  // Extra room at the end only adds space below the last lift: nothing in
  // view moves, so this is safe mid-swipe.
  document.getElementById('sheet-list').style.paddingBottom = covered > 80 ? `${covered + 24}px` : '';
  // Should the browser still have shifted the page to show the search field,
  // follow it (not under a finger: the list would jump).
  if (!sheetTouched) sheet.style.transform = vv.offsetTop > 1 ? `translateY(${Math.round(vv.offsetTop)}px)` : '';
}
window.visualViewport?.addEventListener('resize', fitSheetToKeyboard);
window.visualViewport?.addEventListener('scroll', fitSheetToKeyboard);
window.addEventListener('resize', fitSheetToKeyboard);
// The keyboard slides in and out after focus and blur; check again once it has.
function sheetSearchFocus() {
  [100, 350, 700].forEach(ms => setTimeout(fitSheetToKeyboard, ms));
}

// The first swipe on the list puts the keyboard away (Go does too).
document.getElementById('sheet-list').addEventListener('touchmove', () => {
  const search = document.getElementById('sheet-search');
  if (document.activeElement === search) search.blur();
}, { passive: true });

document.getElementById('sheet').addEventListener('touchstart', () => { sheetTouched = true; }, { passive: true });
['touchend', 'touchcancel'].forEach(type => document.getElementById('sheet').addEventListener(type, () => {
  sheetTouched = false;
  setTimeout(fitSheetToKeyboard, 50);
}, { passive: true }));

// A swipe on the title or the search field moves nothing. Only there: a
// touchmove listener that can cancel the swipe on the list itself would make
// the browser wait for it on every move, and the scroll would lag.
['.sheet-header', '.sheet-search', '.sheet-kinds'].forEach(sel => document.querySelector(`#sheet ${sel}`).addEventListener('touchmove', event => {
  event.preventDefault();
}, { passive: false }));

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

// One list of lifts, without headings: by lift number (A1, A2, A10, B1, …)
// where the area has them, then the lifts without one A to Z by name.
const liftOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// What the picker lists: lifts (the default), points of interest
// (restaurants, viewpoints, snow parks) or villages and peaks.
let sheetKind = 'lifts';
function setSheetKind(kind, render = true) {
  sheetKind = kind;
  document.querySelectorAll('#sheet-kinds .sheet-kind').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.kind === kind);
    btn.setAttribute('aria-pressed', String(btn.dataset.kind === kind));
  });
  document.getElementById('sheet-search').placeholder =
    kind === 'lifts' ? 'Search lift or station…' : kind === 'poi' ? 'Search restaurant, viewpoint, park…' : 'Search village or peak…';
  if (render) renderSheet();
}

// List or map: the picker remembers which one you used last (this visit).
let sheetView = 'list';
function toggleSheetView() {
  sheetView = sheetView === 'list' ? 'map' : 'list';
  if (sheetView === 'map') document.getElementById('sheet-search').blur();
  showSheetView();
}

function showSheetView() {
  const map = sheetView === 'map';
  document.getElementById('sheet-list').style.display = map ? 'none' : '';
  document.getElementById('sheet-map').style.display = map ? 'block' : 'none';
  document.getElementById('sheet-view-btn').textContent = map ? '☰ List' : '🗺 Map';
  // No search on the map: its room goes to the map.
  document.getElementById('sheet-search').style.display = map ? 'none' : '';
  if (map) drawPickerMap();
}

function drawPickerMap() {
  renderPickerMap(document.getElementById('sheet-map'), sheetKind, {
    action: pickActionLabel(), liftCard: liftCardHtml, placeCard: placeCardHtml,
    onLift: lift => activeSide === 'stop' ? addDayStop(liftStop(lift)) : pickStation(lift.dal, lift, 'dal'),
    onPlace: place => activeSide === 'stop' ? addDayStop(placeStop(place)) : pickPlace(place),
  }).catch(err => {
    console.warn(err);
    sheetView = 'list';
    showSheetView();
  });
}

function renderSheet() {
  // Typing a search shows the list (the map has no search).
  if (sheetView === 'map' && document.getElementById('sheet-search').value) { sheetView = 'list'; showSheetView(); }
  if (sheetView === 'map') { drawPickerMap(); return; }
  const query = document.getElementById('sheet-search').value.toLowerCase();
  const list = document.getElementById('sheet-list');
  list.innerHTML = '';

  if (sheetKind !== 'lifts') { renderPlaceList(list, query); return; }

  const lifts = LIFTS.filter(lift => !query ||
    lift.nr.toLowerCase().includes(query) ||
    lift.name.toLowerCase().includes(query) ||
    STATIONS[lift.dal]?.name.toLowerCase().includes(query) ||
    STATIONS[lift.berg]?.name.toLowerCase().includes(query))
    .sort((a, b) => {
      const ca = liftCode(a.nr), cb = liftCode(b.nr);
      if (ca && cb) return liftOrder.compare(ca, cb);
      if (ca || cb) return ca ? -1 : 1;
      return liftOrder.compare(a.name, b.name) || liftOrder.compare(a.nr, b.nr);
    });

  if (!query && (activeSide === 'from' || activeSide === 'dstart')) {
    const gps = document.createElement('button');
    gps.className = 'gps-btn';
    gps.id = 'gps-btn';
    gps.innerHTML = '<span>📍</span><span>Use my location</span><span class="gps-status" id="gps-status"></span>';
    gps.addEventListener('click', locateMe);
    list.appendChild(gps);
  }

  lifts.forEach(lift => {
    // One row per lift; picking it chooses the bottom station. The top is
    // one tap away on the chosen field (see setChosenSide).
    const btn = document.createElement('button');
    btn.className = 'station-item';
    btn.innerHTML = `
      ${liftIcon(lift)}
      <span class="station-item-nr">${liftCode(lift.nr)}</span>
      <span class="station-item-name">${escapeHtml(lift.name)}</span>
      ${liftStatusHtml(lift.nr)}
    `;
    btn.addEventListener('click', () => activeSide === 'stop' ? addDayStop(liftStop(lift)) : pickStation(lift.dal, lift, 'dal'));
    list.appendChild(btn);
  });

  if (!lifts.length) {
    list.insertAdjacentHTML('beforeend', '<div style="padding:24px;text-align:center;color:#aaa">No stations found</div>');
  }
}

// ── Places: points of interest, villages and peaks ───────────────────────────
//
// A place is not on the lift network itself: it goes by the nearest lift
// station (a village by the nearest bottom station), and the route says how
// far that is. Restaurants at a station go by that station.

const PLACE_ICONS = {
  restaurant: ICONS.restaurant, lunch: ICONS.restaurant, viewpoint: ICONS.viewpoint, snowpark: ICONS.snowpark,
  town: ICONS.town, village: ICONS.town, hamlet: ICONS.hamlet, peak: ICONS.peak, lift: ICONS.gondola,
};
const PLACE_GROUPS = {
  poi: [['restaurant', 'Restaurants & huts'], ['viewpoint', 'Viewpoints'], ['snowpark', 'Snow parks']],
  towns: [['town', 'Villages'], ['peak', 'Peaks']],
};

// Every place of one kind of list ('poi' or 'towns') in this area.
function areaPlaces(kind) {
  if (kind === 'poi') {
    return [
      ...(typeof mountainRestaurants === 'function' ? mountainRestaurants() : []).filter(r => r.lat != null || r.station).map(r => ({
        id: `r:${r.id}`, kind: 'restaurant', name: r.naam, lat: r.lat, lon: r.lon, station: r.station || null,
      })),
      ...(currentArea?.plekken || []).map(p => ({
        id: `p:${p.id}`, kind: p.k, name: p.n || (p.k === 'viewpoint' ? 'Viewpoint' : 'Snow park'), lat: p.lat, lon: p.lon, ele: p.ele,
      })),
    ];
  }
  return (currentArea?.plaatsen || []).map(p => ({
    id: `l:${p.k}:${p.n}`, kind: p.k, name: p.n, lat: p.lat, lon: p.lon, ele: p.ele,
  }));
}

function findPlace(id) {
  return [...areaPlaces('poi'), ...areaPlaces('towns')].find(p => p.id === id) || null;
}

const PLACE_MAX_WALK_M = 1500; // a place further from any lift is not in the area

// The stations of the area's main network (the biggest part where every
// station can be reached from every other one, ignoring direction): a place
// goes by one of those, not by a practice lift on its own in the village.
let mainNetwork = { area: null, nodes: null };
function mainNetworkNodes() {
  if (mainNetwork.area === currentArea && mainNetwork.nodes) return mainNetwork.nodes;
  const links = {};
  Object.values(GRAPH).flat().forEach(e => {
    (links[e.from] = links[e.from] || []).push(e.to);
    (links[e.to] = links[e.to] || []).push(e.from);
  });
  let best = new Set();
  const seen = new Set();
  Object.keys(STATIONS).forEach(start => {
    if (seen.has(start)) return;
    const part = new Set([start]);
    const queue = [start];
    seen.add(start);
    while (queue.length) (links[queue.pop()] || []).forEach(n => { if (!seen.has(n)) { seen.add(n); part.add(n); queue.push(n); } });
    if (part.size > best.size) best = part;
  });
  mainNetwork = { area: currentArea, nodes: best };
  return best;
}

// The lift station a place goes by, and how far it is from it.
function placeStation(place) {
  if (place.station && STATIONS[place.station]) return { id: place.station, walkM: 0 };
  if (place.lat == null) return null;
  const valley = place.kind === 'town' || place.kind === 'village' || place.kind === 'hamlet';
  const main = mainNetworkNodes();
  let best = null;
  Object.entries(stationPositions()).forEach(([id, pos]) => {
    if (valley && !id.endsWith('-onder')) return;
    if (!main.has(id)) return;
    const d = distanceM([place.lat, place.lon], pos);
    if (!best || d < best.walkM) best = { id, walkM: Math.round(d) };
  });
  return best && best.walkM <= PLACE_MAX_WALK_M ? best : null;
}

function placeSub(place, station) {
  const lift = LIFTS.find(l => l.dal === station.id || l.berg === station.id);
  const at = lift ? `${lift.berg === station.id ? 'top' : 'bottom'} of ${[liftCode(lift.nr), lift.name].filter(Boolean).join(' ')}` : STATIONS[station.id]?.name || '';
  return station.walkM >= 50 ? `${Math.round(station.walkM / 10) * 10} m from ${at}` : `at ${at}`;
}

function renderPlaceList(list, query) {
  const places = areaPlaces(sheetKind)
    .filter(p => !query || p.name.toLowerCase().includes(query))
    .map(p => ({ ...p, at: placeStation(p) }))
    .filter(p => p.at);
  PLACE_GROUPS[sheetKind].forEach(([group, label]) => {
    const inGroup = places
      .filter(p => group === 'town' ? ['town', 'village', 'hamlet'].includes(p.kind) : p.kind === group)
      .sort((a, b) => liftOrder.compare(a.name, b.name));
    if (!inGroup.length) return;
    list.insertAdjacentHTML('beforeend', `<div class="group-label">${label}</div>`);
    inGroup.forEach(place => {
      const btn = document.createElement('button');
      btn.className = 'station-item place-item';
      btn.innerHTML = `
        <span class="lift-ico ico-place">${PLACE_ICONS[place.kind] || ICONS.start}</span>
        <span class="station-item-name">${escapeHtml(place.name)}${place.kind === 'peak' && place.ele ? ` <small>${place.ele} m</small>` : ''}
          <span class="place-sub">${escapeHtml(placeSub(place, place.at))}</span></span>
      `;
      btn.addEventListener('click', () => activeSide === 'stop' ? addDayStop(placeStop(place)) : pickPlace(place));
      list.appendChild(btn);
    });
  });
  if (!list.children.length) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:#aaa">${query ? 'Nothing found' : sheetKind === 'poi'
      ? 'No points of interest known in this area yet'
      : 'No villages or peaks known in this area yet'}</div>`;
  }
}

// A place as start or destination: routed from or to its station.
function pickPlace(place) {
  const routeSide = activeSide;
  const at = placeStation(place);
  if (!at) return;
  selected[routeSide] = {
    id: at.id, ...STATIONS[at.id], name: place.name, side: null, liftNr: '', liftName: place.name, lift: null,
    place: { id: place.id, kind: place.kind, name: place.name, walkM: at.walkM, sub: placeSub(place, at) },
  };
  closeSheet();
  showChosen(routeSide);
  if (routeSide === 'dend') setEndField(true);
}

// Put a place back by its id (saved day inputs); false when it is unknown.
function restorePlace(side, placeId) {
  const place = placeId && findPlace(placeId);
  if (!place) return false;
  const previous = activeSide;
  activeSide = side;
  pickPlace(place);
  activeSide = previous;
  return true;
}

// The chosen field of a side, for a lift, a place or your location.
function showChosen(side) {
  const s = selected[side];
  if (!s) { resetSide(side); return; }
  document.getElementById(`${side}-box`).style.display    = 'none';
  document.getElementById(`${side}-chosen`).style.display = 'flex';
  document.getElementById(`${side}-icon`).innerHTML       = s.gps ? GPS_ICON
    : s.place ? `<span class="lift-ico ico-place">${PLACE_ICONS[s.place.kind] || ICONS.start}</span>` : liftIcon(s.lift);
  document.getElementById(`${side}-nr`).textContent       = s.gps ? s.liftNr : s.place ? '' : liftCode(s.liftNr);
  document.getElementById(`${side}-liftname`).textContent = s.liftName;
  if (s.gps) document.getElementById(`${side}-side`).textContent = '';
  else if (s.place) {
    // Where it is goes under the name, so a long line never pushes the name out.
    document.getElementById(`${side}-liftname`).innerHTML = `${escapeHtml(s.liftName)}<span class="place-sub">${escapeHtml(s.place.sub)}</span>`;
    document.getElementById(`${side}-side`).textContent = '';
  } else setChosenSide(side);
}

// Small lift-type pictogram for the station picker and the chosen start/destination,
// the same icon the route steps use.
function liftIcon(lift) {
  const cls = stepClass({ type: lift.type, echteLift: lift.echteLift });
  return `<span class="lift-ico ico-${cls}" title="${tagLabel({ type: lift.type, echteLift: lift.echteLift })}">${STEP_ICONS[cls] || ICONS.gondola}</span>`;
}

// What a tap on the picker map shows before anything is picked: what was
// tapped, a few facts, and one button that picks it (map.js adds the button).
const PLACE_KIND_LABEL = { restaurant: 'Restaurant', viewpoint: 'Viewpoint', snowpark: 'Snow park', town: 'Town', village: 'Village', hamlet: 'Hamlet', peak: 'Peak' };

function pickActionLabel() {
  return { from: 'Start here', dstart: 'Start here', to: 'Go here', dend: 'End here', stop: 'Add as stop' }[activeSide] || 'Choose';
}

function liftCardHtml(lift) {
  const data = (currentArea?.liften || []).find(l => l.liftNr === lift.nr);
  const status = liftStatusHtml(lift.nr);
  const facts = [tagLabel({ type: lift.type, echteLift: lift.echteLift }), data?.tijd ? `${data.tijd} min ride` : ''].filter(Boolean).join(' · ');
  const from = activeSide === 'stop' ? '' : `<span class="pick-card-at">From the bottom: ${escapeHtml(shortName(STATIONS[lift.dal]?.name, 34))}</span>`;
  return `<div class="pick-card">${liftIcon(lift)}<span class="pick-card-text">
      <strong>${escapeHtml([liftCode(lift.nr), lift.name].filter(Boolean).join(' '))}</strong>
      <span class="pick-card-facts">${escapeHtml(facts)}</span>
      ${status ? `<span>${status}</span>` : '<span class="pick-card-facts">No opening hours known</span>'}
      ${from}</span></div>`;
}

function placeCardHtml(place) {
  const at = placeStation(place);
  const facts = [PLACE_KIND_LABEL[place.kind] || 'Place', place.ele ? `${place.ele} m` : ''].filter(Boolean).join(' · ');
  return `<div class="pick-card"><span class="lift-ico ico-place">${PLACE_ICONS[place.kind] || ICONS.start}</span><span class="pick-card-text">
      <strong>${escapeHtml(place.name)}</strong>
      <span class="pick-card-facts">${escapeHtml(facts)}</span>
      ${at ? `<span class="pick-card-at">${escapeHtml(placeSub(place, at))}</span>` : ''}</span></div>`;
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
  document.getElementById('dstart-label').textContent = show ? 'Start' : 'Start & end';
}

function swapSides() {
  if (selected.from?.gps) {
    showError('err', 'Your location can only be a starting point.');
    return;
  }
  const tmp = selected.from;
  selected.from = selected.to;
  selected.to   = tmp;

  ['from', 'to'].forEach(showChosen);
}

// ── Preferences ──────────────────────────────────────────────────────────────
//
// Personal preferences, on a screen of their own (⚙) and kept on this phone
// for every ski area: piste colours, pace, drag lifts, ski bus, map north up.
// Both planners use them; each planner card shows them in one line.

const PREFS_KEY = 'skirouter:prefs';
const prefs = { diff: [...DIFF_LEVELS], pace: 'normal', drag: true, bus: true };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch {}
prefs.diff = prefs.diff.filter(d => DIFF_LEVELS.includes(d));
allowedDiff = new Set(prefs.diff);

function storePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
  accountPrefsChanged();
}

// The account's preferences arrived (signed in on this phone, or changed on
// another): read them again and show them.
function reloadLocalPrefs() {
  const stored = { diff: [...DIFF_LEVELS], pace: 'normal', drag: true, bus: true };
  try { Object.assign(stored, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch {}
  Object.assign(prefs, stored);
  prefs.diff = prefs.diff.filter(d => DIFF_LEVELS.includes(d));
  renderPrefs();
  if (currentArea) loadAvoided();
  renderAreaList();
}

function setPrefDiff(value) {
  if (value === 'all') {
    allowedDiff = allowedDiff.size === DIFF_LEVELS.length ? new Set() : new Set(DIFF_LEVELS);
  } else {
    allowedDiff.has(value) ? allowedDiff.delete(value) : allowedDiff.add(value);
  }
  savePrefs();
}

// Read the switches, keep everything and show it.
function savePrefs() {
  prefs.diff = DIFF_LEVELS.filter(d => allowedDiff.has(d));
  prefs.drag = document.getElementById('pref-drag').checked;
  prefs.bus  = document.getElementById('pref-bus').checked;
  storePrefs();
  renderPrefs();
}

function renderPrefs() {
  allowedDiff = new Set(prefs.diff);
  if (typeof dayDiff !== 'undefined') dayDiff = new Set(prefs.diff);
  DIFF_LEVELS.forEach(d => document.getElementById('d-' + d).classList.toggle('on', allowedDiff.has(d)));
  document.getElementById('d-all').classList.toggle('on', allowedDiff.size === DIFF_LEVELS.length);
  document.getElementById('pref-drag').checked = prefs.drag;
  document.getElementById('pref-bus').checked = prefs.bus;
  if (typeof setDayPace === 'function') setDayPace(prefs.pace, false);
}

// The preferences screen: instead of the planner, back with Done.
let prefsChanged = null;
function openPrefs() {
  closeAccount();
  renderPrefs();
  renderAvoided();
  prefsChanged = JSON.stringify(prefs);
  document.getElementById('planner-cards').style.display = 'none';
  document.getElementById('prefs-screen').style.display = 'block';
  window.scrollTo({ top: 0 });
}

// The ⚙ in the header: a second tap closes the screen again.
function togglePrefs() {
  if (document.getElementById('prefs-screen').style.display === 'block') closePrefs();
  else openPrefs();
}

function closePrefs() {
  document.getElementById('prefs-screen').style.display = 'none';
  document.getElementById('planner-cards').style.display = 'block';
  // A route on screen follows the new preferences (a day plan is planned again by hand).
  if (prefsChanged !== JSON.stringify(prefs)
    && document.getElementById('result').classList.contains('visible') && selected.from && selected.to) planRoute({ silent: true });
  window.scrollTo({ top: 0 });
}

const DIFF_NAMES = { groen: 'Green', blauw: 'Blue', rood: 'Red', zwart: 'Black', skiroute: 'Ski route' };

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

    const dragOk = dragAllowed('pref-drag');
    (GRAPH[current] || []).forEach(edge => {
      if (edge.type === 'bus' && !busAllowed('pref-bus')) return;
      if (isAvoided(edge)) return;
      const newCost = dist[current] + (edge.tijd || 0)
        + (edge.descent ? RIDE_DOWN_PENALTY : 0)
        + (isConnection(edge) ? CONNECTION_PENALTY : 0)
        + (unwantedEdge(edge, allowedDiff, dragOk) ? UNWANTED_PENALTY : 0);
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

// The pictograms themselves are in icons.js, one set for the whole app.

// OSM drag-lift types: shown with the T-bar pictogram and their own label.
const DRAG_LIFT_LABEL = { 't-bar': 'T-bar', 'j-bar': 'J-bar', platter: 'Platter lift', drag_lift: 'Drag lift', rope_tow: 'Rope tow' };

const STEP_ICONS = {
  gondola:          ICONS.gondola,
  mixed_lift:       ICONS.gondola,
  cable_car:        ICONS.cable_car,
  funicular:        ICONS.funicular,
  chair_lift:       ICONS.chair_lift,
  draglift:         ICONS.draglift,
  oefenlift:        ICONS.oefenlift,
  'piste-groen':    ICONS.skier,
  'piste-blauw':    ICONS.skier,
  'piste-rood':     ICONS.skier,
  'piste-zwart':    ICONS.skier,
  'piste-skiroute': ICONS.skier,
  transfer:         ICONS.transfer,
  bus:              ICONS.bus,
  walk:             ICONS.walk,
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
  if (edge.type === 'piste') return { groen: 'tag-groen', blauw: 'tag-blauw', rood: 'tag-rood', zwart: 'tag-zwart', skiroute: 'tag-skiroute' }[edge.diff] || 'tag-rood';
  if (edge.echteLift === false) return 'tag-stoeltjeslift';
  if (edge.type === 'chair_lift') return 'tag-stoeltjeslift';
  if (edge.type === 'gondola' || edge.type === 'cable_car' || edge.type === 'funicular') return 'tag-gondel';
  return '';
}

function tagLabel(edge) {
  if (edge.type === 'bus')   return 'Ski bus';
  if (edge.type === 'walk')  return 'Walk';
  if (edge.type === 'piste') return { groen: 'Green ●', blauw: 'Blue ●', rood: 'Red ●', zwart: 'Black ●', skiroute: 'Ski route ●' }[edge.diff] || 'Piste';
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
    errorEl.textContent = avoidedLifts.size || avoidedPistes.size
      ? 'No route without the lifts and pistes you avoid. Remove one from the list.'
      : busAllowed('pref-bus')
        ? 'No route found between these two stations.'
        : 'No route without the ski bus. Switch the ski bus on in ⚙ Preferences.';
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

const PISTE_KIND = { groen: 'Green piste', blauw: 'Blue piste', rood: 'Red piste', zwart: 'Black piste', skiroute: 'Ski route' };

function renderRoute(result) {
  const visibleSteps = result.path.filter(edge => edge.type !== 'transfer').flatMap(splitTrajecten);
  const totalKm      = visibleSteps.reduce((sum, edge) => sum + (edge.km || 0), 0);
  const totalMin     = visibleSteps.reduce((sum, edge) => sum + (edge.tijd || 0), 0);

  document.getElementById('p-steps').textContent = `${visibleSteps.length} step${visibleSteps.length === 1 ? '' : 's'}`;
  document.getElementById('p-km').textContent    = totalKm > 0 ? `approx. ${totalKm.toFixed(1)} km` : '—';
  document.getElementById('p-time').textContent  = `~${totalMin} min`;

  const stepsEl = document.getElementById('steps');
  stepsEl.innerHTML = '';
  stepsEl.classList.remove('no-entry');

  addWaypoint(stepsEl, escapeHtml(selected.from.name), selected.from.alt, selected.from.place ? PLACE_ICONS[selected.from.place.kind] || ICONS.start : ICONS.start,
    selected.from.place ? `Start · ${escapeHtml(selected.from.place.sub)}` : 'Start', 0);

  // What comes after each lift (a transfer included), for the exit hint.
  const nextOf = new Map(result.path.map((edge, i) => [edge, result.path[i + 1]]));

  visibleSteps.forEach((edge, index) => {
    const div = stepElement(edge, index, undefined, nextOf.get(edge));
    div.style.animationDelay = `${(index + 1) * 50}ms`;
    div.classList.add('checkable');
    div.dataset.min = edge.tijd || 0;
    div.dataset.km  = edge.type === 'piste' ? edge.km || 0 : 0;
    stepsEl.appendChild(div);

    // The chosen destination, also when a short walk from the last step leads there.
    const isLast = index === visibleSteps.length - 1;
    if (isLast && selected.to) {
      addWaypoint(stepsEl, escapeHtml(selected.to.name), selected.to.alt, ICONS.finish,
        selected.to.place ? `Destination reached! · ${escapeHtml(selected.to.place.sub)}` : 'Destination reached!', (index + 1.5) * 50);
    }
  });

  // Closed lifts first, above the steps, as in the day plan.
  const unwanted = unwantedWarning(result.path, allowedDiff, dragAllowed('pref-drag'));
  document.getElementById('q-closed').innerHTML =
    (unwanted ? `<div class="closed-warning unwanted-warning">⚠ ${unwanted}</div>` : '') + closedWarning(visibleSteps);
  document.getElementById('tip').innerHTML = getTip();

  // For the map view: the route as planned, transfers included.
  lastQuickPath = result.path;

  const signature = [selected.from.id, ...visibleSteps.map(e => e.liftNr || e.pisteNr), selected.to.id].join('>');
  makeCheckable(stepsEl, 'quick', signature, quickStatus, {
    from: selected.from.id, to: selected.to.id, diff: [...allowedDiff], bus: busAllowed('pref-bus'), drag: dragAllowed('pref-drag'),
  });
  if (routeViews.quick === 'map') drawPlannerMap('quick');
}

// ── List or map ──────────────────────────────────────────────────────────────

let lastQuickPath = null; // the route on screen, for the map
let quickDone = 0;        // steps ticked, for the map's current step

// Each planner has its own List | Map switch (routeViews, in map.js); the
// one map is drawn into the planner on screen.
const MAP_PARTS = {
  quick: { list: 'q-view-list', map: 'q-view-map', el: 'q-map', steps: 'steps' },
  day:   { list: 'd-view-list', map: 'd-view-map', el: 'd-map', steps: 'day-steps' },
};

function showRouteView(view, planner = 'quick') {
  routeViews[planner] = view;
  const ids = MAP_PARTS[planner];
  ['list', 'map'].forEach(v => {
    const btn = document.getElementById(ids[v]);
    btn.classList.toggle('active', v === view);
    btn.setAttribute('aria-pressed', String(v === view));
  });
  document.getElementById(ids.steps).style.display = view === 'map' ? 'none' : '';
  document.getElementById(ids.el).style.display = view === 'map' ? 'block' : 'none';
  if (view === 'map') {
    fitRouteMap(planner);
    drawPlannerMap(planner);
  } else {
    leaveRouteMap();
    showCurrentStep(planner);
  }
}

// The map fills the screen below the sticky bar (Settings, List | Map and
// the progress), whatever the size of the phone: the bar goes to the top
// of the screen and the map takes the rest, so neither scrolls away.
const MAP_GAP_PX = 12; // the sticky bar's margin below it, and room at the bottom
const MAP_SETTLE_MS = [60, 250, 600]; // put the page right again after these
let mapScrollTarget = null;           // where the page should stay, until you scroll

function routeMapTop(el) {
  const sticky = el.closest('.result')?.querySelector('.result-sticky');
  return Math.max(0, el.getBoundingClientRect().top + window.scrollY - (sticky?.offsetHeight || 0) - MAP_GAP_PX);
}

function sizeRouteMap(el) {
  const sticky = el.closest('.result')?.querySelector('.result-sticky');
  if (!sticky || el.classList.contains('is-full')) return false;
  el.style.setProperty('--map-h', `${Math.max(280, Math.round(window.innerHeight - sticky.offsetHeight - 2 * MAP_GAP_PX))}px`);
  return true;
}

function fitRouteMap(planner) {
  const el = document.getElementById(MAP_PARTS[planner].el);
  if (!sizeRouteMap(el)) return;
  // A smooth scroll still running (after ticking a step, or after
  // planning) would carry on to a spot in the hidden list and leave the
  // page at its bottom: stop it, go to the map, and check again shortly.
  window.scrollTo({ top: window.scrollY, behavior: 'instant' });
  mapScrollTarget = routeMapTop(el);
  window.scrollTo({ top: mapScrollTarget, behavior: 'instant' });
  MAP_SETTLE_MS.forEach(ms => setTimeout(() => {
    if (mapScrollTarget == null || routeViews[planner] !== 'map') return;
    mapScrollTarget = routeMapTop(el);
    if (Math.abs(window.scrollY - mapScrollTarget) > 2) window.scrollTo({ top: mapScrollTarget, behavior: 'instant' });
  }, ms));
}

// Your own scrolling wins: stop putting the page back.
['touchstart', 'wheel', 'keydown'].forEach(type => window.addEventListener(type, () => { mapScrollTarget = null; }, { passive: true }));

// Safari's toolbar folding in or out changes the height: the map follows,
// the page stays where it is. Turning the phone fits it all again.
let mapFitTimer = null;
let mapFitWidth = window.innerWidth;
window.addEventListener('resize', () => {
  clearTimeout(mapFitTimer);
  mapFitTimer = setTimeout(() => {
    const turned = window.innerWidth !== mapFitWidth;
    mapFitWidth = window.innerWidth;
    const planner = ['quick', 'day'].find(p => routeViews[p] === 'map' && document.getElementById(MAP_PARTS[p].el).offsetParent);
    if (!planner) return;
    if (turned) fitRouteMap(planner);
    else sizeRouteMap(document.getElementById(MAP_PARTS[planner].el));
    routeMap?.invalidateSize();
  }, 200);
});

// Back in the list: the step you are at in the middle of the screen, the
// steps just done above it, as after ticking one (makeCheckable's
// showNext); the last step once all are done.
function showCurrentStep(planner) {
  const steps = document.getElementById(MAP_PARTS[planner].steps);
  steps.classList.add('no-entry'); // shown again: no fade-in a second time
  const step = steps.querySelector('.checkable.next') || [...steps.querySelectorAll('.checkable')].pop();
  mapScrollTarget = null;
  window.scrollTo({ top: window.scrollY, behavior: 'instant' }); // stop any scroll still running
  if (step) step.scrollIntoView({ behavior: 'instant', block: 'center' });
}

function drawPlannerMap(planner) {
  const el = document.getElementById(MAP_PARTS[planner].el);
  if (planner === 'quick') {
    if (!lastQuickPath) return;
    renderRouteMap(el, lastQuickPath, quickDone, { owner: 'quick', fromName: selected.from?.name, toName: selected.to?.name })
      .catch(err => mapFailed(err, el));
  } else {
    const route = dayMapRoute();
    if (!route) return;
    renderRouteMap(el, route.path, route.done, { owner: 'day', fromName: route.fromName, toName: route.toName })
      .catch(err => mapFailed(err, el));
  }
}

function mapFailed(err, el) {
  console.warn(err);
  // Start the map afresh next time: the message replaces its contents.
  routeMap?.remove();
  routeMap = null;
  el.innerHTML = `<div class="map-error">${window.L
    ? 'The map could not be drawn for this route.'
    : 'The map could not be loaded. Open the app once with a connection.'}</div>`;
}

function quickStatus(done, items) {
  quickDone = done;
  if (routeViews.quick === 'map') updateRouteMapProgress(done, 'quick');
  const left = items.slice(done).reduce((sum, item) => sum + (+item.dataset.min || 0), 0);
  const km = items.slice(done).reduce((sum, item) => sum + (+item.dataset.km || 0), 0);
  // Always: steps done, and the km and time still to go.
  const text = done === items.length ? '🏁 Destination reached!'
    : `${done} of ${items.length} steps · ${km.toFixed(1)} km · ~${left} min to go`;
  renderProgress('p-progress', done, items.length, text);
}

// One route step (a lift or a piste) as a DOM element. `clock` is an optional
// "09:12"-style time shown in front of the step (used by the day planner).
function stepElement(edge, index, clock, next) {
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
      <div class="piste-sign sign-${diff}${short ? (nr.replace(/\s+/g, '').length === 3 ? ' sign-long' : '') : ' sign-noname'}" aria-label="Piste ${escapeHtml(nr)}"><span>${short ? escapeHtml(nr.replace(/\s+/g, '')) : ICONS.skier}</span></div>
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
    const icon = STEP_ICONS[cls] || ICONS.gondola;
    div.className = 'step step-lift';
    div.innerHTML = `
      <span class="step-number">${index + 1}</span>
      <div class="step-icon ico-${cls}">${icon}</div>
      <div class="step-info">
        <div class="step-kind kind-lift">${tagLabel(edge)}${edge.descent ? ' · ride down ↓' : ''}${edge.tijd ? ` · ~${edge.tijd} min` : ''}</div>
        ${liftStatusHtml(edge.liftNr) ? `<div class="step-actions">${liftStatusHtml(edge.liftNr)}</div>` : ''}
        <div class="step-title"><span class="lift-code">${liftCode(edge.liftNr)}</span><span class="step-name">${edge.name}</span></div>
        ${exitHintHtml(edge, next)}
      </div>
    `;
  }
  if (clockHtml) div.querySelector('.step-info').insertAdjacentHTML('afterbegin', clockHtml);
  // What the step menu (swipe left or hold) can avoid.
  if (edge.type === 'piste') div.dataset.pistes = JSON.stringify(edge.trajecten ? edge.trajecten.map(t => t.pisteNr) : [edge.pisteNr]);
  else if (edge.liftNr && !isConnection(edge) && edge.type !== 'transfer') div.dataset.lift = edge.liftNr;
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
// Any lift can be skipped by hand, open or closed: 'Avoid lift' in the step
// menu (hold a step or swipe it left), or 'Avoid these' at the closed-lifts
// warning, adds it to a list per area,
// both planners route around it, and the route is planned again. The list
// shows as chips in the planner cards; ✕ takes a lift off it.

const AVOID_KEY_PREFIX = 'skiplanner:avoid:';
const AVOID_PISTE_KEY_PREFIX = 'skiplanner:avoidpiste:';
let avoidedLifts = new Set();
let avoidedPistes = new Set(); // piste numbers (pisteNr), per area like the lifts

function avoidKey() {
  return AVOID_KEY_PREFIX + (currentArea?.id || '');
}

function loadAvoided() {
  try { avoidedLifts = new Set(JSON.parse(localStorage.getItem(avoidKey())) || []); } catch { avoidedLifts = new Set(); }
  try { avoidedPistes = new Set(JSON.parse(localStorage.getItem(AVOID_PISTE_KEY_PREFIX + (currentArea?.id || ''))) || []); } catch { avoidedPistes = new Set(); }
  renderAvoided();
}

function saveAvoided() {
  try { localStorage.setItem(avoidKey(), JSON.stringify([...avoidedLifts])); } catch {}
  try { localStorage.setItem(AVOID_PISTE_KEY_PREFIX + (currentArea?.id || ''), JSON.stringify([...avoidedPistes])); } catch {}
  accountPrefsChanged();
}

// A lift ride (up, or down in a gondola) on the avoid list, or a run over a
// piste on it (a descent through several pistes: any of them).
function isAvoided(edge) {
  if (edge.type === 'piste') {
    return avoidedPistes.size > 0 && (edge.trajecten ? edge.trajecten.some(t => avoidedPistes.has(t.pisteNr)) : avoidedPistes.has(edge.pisteNr));
  }
  return !!edge.liftNr && !isConnection(edge) && avoidedLifts.has(edge.liftNr);
}

// "24 Jufen", or just the name for a run without a number of its own.
function pisteTitle(nr) {
  const piste = (currentArea?.pistes || []).find(p => p.pisteNr === nr);
  return hasOwnNumber(nr) ? [nr, piste?.naam].filter(Boolean).join(' ') : piste?.naam || nr;
}

function avoidClosedButton(closed) {
  return `<button class="avoid-closed-btn" type="button" data-avoid="${closed.map(e => e.liftNr).join(',')}">⊘ Avoid ${closed.length > 1 ? 'these' : 'it'}</button>`;
}

function renderAvoided() {
  const nrs = [...avoidedLifts].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const pistes = [...avoidedPistes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const any = nrs.length + pistes.length;
  ['q-avoid', 'day-avoid', 'pref-avoid'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = any ? 'flex' : 'none';
    el.innerHTML = any
      ? '<span class="avoid-label">🚫 Avoiding</span>' + nrs.map(nr => {
          const lift = LIFTS.find(l => l.nr === nr);
          return `<button class="avoid-chip" type="button" onclick="unavoidLift('${escapeHtml(nr)}')" aria-label="Stop avoiding ${escapeHtml(lift?.name || nr)}">${escapeHtml([liftCode(nr), lift?.name].filter(Boolean).join(' '))} ✕</button>`;
        }).join('') + pistes.map((nr, i) => `<button class="avoid-chip avoid-chip-piste" type="button" data-unavoid-piste="${i}" aria-label="Stop avoiding piste ${escapeHtml(pisteTitle(nr))}">⛷ ${escapeHtml(pisteTitle(nr))} ✕</button>`).join('')
      : '';
    el.querySelectorAll('[data-unavoid-piste]').forEach(btn => btn.addEventListener('click', () => unavoidPiste(pistes[+btn.dataset.unavoidPiste])));
  });
  const prefList = document.getElementById('pref-avoid');
  if (prefList && !any) {
    prefList.style.display = 'block';
    prefList.innerHTML = '<span class="setting-hint">None</span>';
  }
}

function unavoidLift(nr) {
  avoidedLifts.delete(nr);
  saveAvoided();
  renderAvoided();
}

function unavoidPiste(nr) {
  avoidedPistes.delete(nr);
  saveAvoided();
  renderAvoided();
}

// Add lifts to the list and plan the route again without them. A day being
// followed is replanned from the next step; otherwise the whole day.
function avoidLifts(nrs, planner, pisteNrs = []) {
  nrs.filter(Boolean).forEach(nr => avoidedLifts.add(nr));
  pisteNrs.filter(Boolean).forEach(nr => avoidedPistes.add(nr));
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

// ── Step menu: swipe a step left, or hold it ─────────────────────────────────
//
// Replan from here (day plan), Avoid this lift, Avoid this piste. A tap
// still ticks the step; scrolling up and down is left to the browser
// (touch-action: pan-y on the steps).

const STEP_HOLD_MS  = 500; // held this long: the menu

// A short tick in the hand. Android has navigator.vibrate; iPhone Safari
// does not, but toggling a switch checkbox (iOS 18 and later) gives the
// system's haptic tap, so a hidden one is flipped instead.
let hapticSwitch = null;
function haptic() {
  try {
    if (navigator.vibrate?.(20)) return;
    if (!hapticSwitch) {
      hapticSwitch = document.createElement('label');
      hapticSwitch.setAttribute('aria-hidden', 'true');
      hapticSwitch.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
      hapticSwitch.innerHTML = '<input type="checkbox" switch tabindex="-1">';
      document.body.appendChild(hapticSwitch);
    }
    hapticSwitch.click();
  } catch {}
}
const STEP_SWIPE_PX = 70;  // swiped this far left: the menu
const STEP_MENU_GUARD_MS = 450; // the click from lifting the finger lands here: ignore it
let stepGesture = null;
let stepMenuOpenedAt = 0;
let stepClickSuppressed = false;

function stepMenuOptions(step, planner) {
  const options = [];
  const items = planner === 'day' ? dayTracker?.items : null;
  const index = items ? items.indexOf(step) : -1;
  if (index >= 0) options.push({ label: '↻ Replan from here', run: () => { dayTracker.setDone(index); replanFromHere(); } });
  const lift = step.dataset.lift && LIFTS.find(l => l.nr === step.dataset.lift);
  if (step.dataset.lift) {
    options.push({ label: `⊘ Avoid lift ${[liftCode(step.dataset.lift), lift?.name].filter(Boolean).join(' ')}`, run: () => avoidLifts([step.dataset.lift], planner) });
  }
  if (step.dataset.pistes) {
    const nrs = JSON.parse(step.dataset.pistes).filter(Boolean);
    if (nrs.length) options.push({ label: `⊘ Avoid piste ${nrs.map(pisteTitle).join(', ')}`, run: () => avoidLifts([], planner, nrs) });
  }
  return options;
}

function openStepMenu(step, planner, held = false) {
  const options = stepMenuOptions(step, planner);
  if (!options.length) return;
  let menu = document.getElementById('step-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'step-menu';
    menu.className = 'step-menu';
    // Capture: the click from lifting the finger off the held step lands on
    // the menu that just opened; it must not close it or pick an option.
    menu.addEventListener('click', event => {
      if (Date.now() - stepMenuOpenedAt < STEP_MENU_GUARD_MS) { event.stopPropagation(); event.preventDefault(); return; }
      if (event.target === menu) closeStepMenu();
    }, true);
    document.body.appendChild(menu);
  }
  const title = step.querySelector('.step-title')?.textContent || step.querySelector('.step-name')?.textContent || '';
  menu.innerHTML = `<div class="step-menu-panel" role="menu">
    <div class="step-menu-title">${escapeHtml(title.replace(/\s+/g, ' ').trim())}</div>
    ${options.map((o, i) => `<button type="button" class="step-menu-btn" role="menuitem" data-option="${i}">${escapeHtml(o.label)}</button>`).join('')}
    <button type="button" class="step-menu-btn step-menu-cancel">Cancel</button>
  </div>`;
  menu.querySelectorAll('[data-option]').forEach(btn => btn.addEventListener('click', () => {
    closeStepMenu();
    options[+btn.dataset.option].run();
  }));
  menu.querySelector('.step-menu-cancel').addEventListener('click', closeStepMenu);
  // Only a hold leaves a click to come when the finger lifts; a swipe does not.
  stepMenuOpenedAt = held ? Date.now() : 0;
  menu.classList.add('open');
}

function closeStepMenu() {
  document.getElementById('step-menu')?.classList.remove('open');
}

// After a hold or a swipe, the click that follows must not tick the step.
function suppressStepClick() {
  stepClickSuppressed = true;
  setTimeout(() => { stepClickSuppressed = false; }, 500);
}

[['result', 'quick'], ['day-result', 'day']].forEach(([id, planner]) => {
  const card = document.getElementById(id);
  const end = () => {
    if (!stepGesture) return;
    const { step, dx, swiping, timer } = stepGesture;
    clearTimeout(timer);
    stepGesture = null;
    if (!swiping) return;
    step.classList.remove('swiping');
    step.style.transform = '';
    suppressStepClick();
    if (dx <= -STEP_SWIPE_PX) openStepMenu(step, planner);
  };
  card.addEventListener('pointerdown', event => {
    const step = event.target.closest('.checkable');
    if (!step || event.target.closest('button:not(.step-check)') || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const gesture = { step, x: event.clientX, y: event.clientY, dx: 0, swiping: false };
    gesture.timer = setTimeout(() => {
      if (stepGesture !== gesture || gesture.swiping) return;
      stepGesture = null;
      haptic();
      suppressStepClick();
      openStepMenu(step, planner, true);
    }, STEP_HOLD_MS);
    stepGesture = gesture;
  });
  card.addEventListener('pointermove', event => {
    const g = stepGesture;
    if (!g) return;
    const dx = event.clientX - g.x, dy = event.clientY - g.y;
    if (!g.swiping && Math.hypot(dx, dy) > 10) {
      clearTimeout(g.timer);
      if (dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        g.swiping = true;
        g.step.classList.add('swiping');
      } else { stepGesture = null; return; } // scrolling
    }
    if (g.swiping) {
      g.dx = Math.min(0, dx);
      g.step.style.transform = `translateX(${Math.max(g.dx, -120)}px)`;
    }
  });
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
  card.addEventListener('contextmenu', event => { if (event.target.closest('.checkable')) event.preventDefault(); });
  card.addEventListener('click', event => {
    if (!stepClickSuppressed || !event.target.closest('.checkable')) return;
    event.stopPropagation();
    event.preventDefault();
    stepClickSuppressed = false;
  }, true);
});

// ── Lift status (open/closed, operating hours) ───────────────────────────────
//
// Fetched every 30 minutes from the ski area's provider by
// tools/liftstatus-europe.mjs into a file per area on the `liftstatus`
// branch; the area index says where (`liftstatus.file`).

let LIFT_STATUS = null; // { bron, sourceUpdate, changed, lifts: { A1: { open, hours, from, to, … } } }

// Fetched again while the app is open; the last result is kept on the phone
// for offline use.
const LIFT_STATUS_LIVE_KEY = 'skiplanner:liftstatus:';
const LIFT_STATUS_REFRESH_MS = 5 * 60 * 1000;
const LIFT_STATUS_TIMEOUT_MS = 8000;
let liftStatusMeta = null; // the area's liftstatus entry from the area index

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

// Fetch the status again; on success redraw whatever route is on screen.
async function refreshLiftStatusLive() {
  const cfg = liftStatusMeta;
  if (!cfg?.europe || !navigator.onLine) return;
  return refreshEuropeLiftStatus(cfg, currentArea?.id);
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
const GPS_ICON           = `<span class="lift-ico ico-gps">${ICONS.gps}</span>`;
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

// ── Getting off a lift: left or right? ───────────────────────────────────────
//
// The direction you ride is the line from the station you board to the one
// you leave. Where you go next is the next piste a little way down from
// where it is closest to the exit station (or, when the route goes on with
// another lift, that lift's bottom station); when the piste only starts a
// few hundred metres away, at the end of a connecting path, it is the
// direction of the piste itself. The angle between the two says left,
// right, straight on or back. Both come from the map data, so there is no
// hint when the piste is further away than that.

const EXIT_PISTE_NEAR_M = 150; // a piste this close starts at the station: follow its direction
const EXIT_PISTE_MAX_M  = 500; // further, up to this, a connecting path leads to it: head for it
const EXIT_LOOK_M       = 80;  // how far down the piste to look for its direction

// Compass bearing from a to b in degrees (flat projection).
function bearingDeg(a, b) {
  const kx = Math.cos(a[0] * Math.PI / 180);
  return Math.atan2((b[1] - a[1]) * kx, b[0] - a[0]) * 180 / Math.PI;
}

// The point EXIT_LOOK_M along a line from index i, going one way (+1/-1).
function alongLine(line, i, step) {
  let walked = 0;
  for (let k = i; k + step >= 0 && k + step < line.length; k += step) {
    walked += distanceM(line[k], line[k + step]);
    if (walked >= EXIT_LOOK_M) return line[k + step];
  }
  return i + step >= 0 && i + step < line.length ? line[step > 0 ? line.length - 1 : 0] : null;
}

// Where the next piste heads from the exit station: a point on it, or null.
function pisteHeading(nr, exit, towards) {
  let best = null;
  (currentArea?.pisteLijnen?.[nr] || []).forEach(line => {
    line.forEach((p, i) => {
      const d = distanceM(exit, p);
      if (!best || d < best.d) best = { d, line, i };
    });
  });
  if (!best || best.d > EXIT_PISTE_MAX_M) return null;
  // Not at the station: the way off the lift is towards where the piste is.
  if (best.d > EXIT_PISTE_NEAR_M) return best.line[best.i];
  // The piste may start at the station or pass it: of the two ways along
  // it, take the one towards where this descent ends.
  const options = [alongLine(best.line, best.i, 1), alongLine(best.line, best.i, -1)].filter(Boolean);
  if (!options.length) return null;
  if (options.length === 1 || !towards) return options[0];
  return options.sort((a, b) => distanceM(a, towards) - distanceM(b, towards))[0];
}

// "right", "left", "ahead" or "back" from a lift towards the next step, or null.
function exitSide(liftEdge, next) {
  if (!liftEdge?.liftNr || !next) return null;
  const pos = stationPositions();
  const from = pos[liftEdge.from], exit = pos[liftEdge.to];
  if (!from || !exit || distanceM(from, exit) < 50) return null;
  let target = null;
  if (next.type === 'piste') {
    const nr = next.trajecten?.[0]?.pisteNr ?? next.pisteNr;
    target = pisteHeading(nr, exit, pos[next.chainEnd || next.to]);
  } else if (next.type === 'transfer' || isConnection(next)) {
    target = pos[next.to];
  }
  if (!target || distanceM(exit, target) < 15) return null;
  let angle = bearingDeg(exit, target) - bearingDeg(from, exit);
  angle = ((angle + 540) % 360) - 180; // -180…180, positive is to the right
  if (Math.abs(angle) <= 35) return 'ahead';
  if (Math.abs(angle) >= 145) return 'back';
  return angle > 0 ? 'right' : 'left';
}

// The hint under a lift step: "↱ Off the lift, turn right to piste 21".
function exitHintHtml(liftEdge, next) {
  const side = exitSide(liftEdge, next);
  if (!side) return '';
  const to = next.type === 'piste'
    ? pisteLabel(next.trajecten?.[0]?.pisteNr ?? next.pisteNr)
    : next.type === 'transfer'
      ? (() => { const lift = LIFTS.find(l => l.dal === next.to || l.berg === next.to); return lift ? `lift ${[liftCode(lift.nr), lift.name].filter(Boolean).join(' ')}` : STATIONS[next.to]?.name || 'the next lift'; })()
      : (STATIONS[next.to]?.name || 'the next stop');
  const text = {
    right: ['↱', `turn right to ${to}`],
    left:  ['↰', `turn left to ${to}`],
    ahead: ['↑', `straight on to ${to}`],
    back:  ['↩', `turn around to ${to}`],
  }[side];
  return `<div class="step-exit exit-${side}"><span class="exit-arrow">${text[0]}</span> Off the lift, ${escapeHtml(text[1])}</div>`;
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
  return {
    get done() { return done; }, items, refresh: () => apply(false),
    // Everything before step `n` done (the step menu's Replan from here).
    setDone(n) { done = Math.max(0, Math.min(n, items.length)); apply(true); },
  };
}

function renderProgress(id, done, total, text, extraHtml = '') {
  const el = document.getElementById(id);
  el.innerHTML = `
    <div class="progress-bar"><span style="width:${total ? (100 * done / total) : 0}%"></span></div>
    <div class="progress-row"><span class="progress-text">${text}</span>${extraHtml}</div>
  `;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

initAccount();
initApp();

// Offline: the service worker keeps the app and all area data on the device.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Offline mode unavailable:', err));
  });
}
