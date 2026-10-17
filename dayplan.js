// Day planner: plan a whole ski day up front — start somewhere at a time,
// ski roughly N km, and be back at a station by a given time.
//
// Loaded before app.js; uses its graph (GRAPH, STATIONS, LIFTS) and helpers
// (pisteKleuren, splitTrajecten, stepElement, …) only when called.
//
// How a day is built: many randomised walks over the lift/piste graph, each
// preferring pistes not skied yet that day (a favourite may come back, but
// less likely each time). Every step is checked against the minimum time
// still needed to reach the end station, so a walk can never strand you.
// Once the distance target is (nearly) met, the walk takes the quickest way
// back. The best few distinct walks are offered as options.
//
// With a lunch break the day is two such walks: start → restaurant, arriving
// around lunchtime, then restaurant → end. Every restaurant on the mountain
// that fits is tried (or only the one picked), and the best days win.
//
// Times are a guideline: lift ride + a pace-dependent wait, piste time scaled
// by pace. Seeded randomness keeps the same inputs giving the same plan.

const DAY_KEY_PREFIX  = 'skiplanner:dayplan:';
const DAY_TAB_KEY     = 'skiplanner:tab';
// Piste times in the data are pure skiing at ~12 km/h; a real day has short
// stops on the way down, so even "normal" stretches them.
const DAY_PACES = {
  relaxed: { label: 'Relaxed', piste: 1.7, wait: 7, who: 'Easy cruising with stops for photos and breathers, or skiing with children.' },
  normal:  { label: 'Normal',  piste: 1.3, wait: 5, who: 'A steady day with the odd short stop.' },
  sporty:  { label: 'Sporty',  piste: 1.0, wait: 3, who: 'Skiing the runs in one go, little queueing.' },
};
const PISTE_KMH = 12; // piste times in the data: 200 m a minute
const DAY_TRANSFER_MIN  = 2;   // walking between two stations
const DAY_PRACTICE_MIN  = 1;   // magic carpets: no queue to speak of
const DAY_RUNS          = 400; // randomised walks per plan
const DAY_LATE_SLACK    = 10;  // minutes past "back by" a walk may plan for
const DAY_MAX_OPTIONS   = 3;
const DAY_OPTION_OVERLAP = 0.6; // options sharing more of their pistes are the same route
const DAY_LUNCH_RUNS    = 30;  // morning walks per restaurant
const DAY_LUNCH_PM_RUNS = 15;  // afternoon walks per kept morning
const DAY_LUNCH_STOPS   = 16;  // lunch stops tried at most when no restaurant is chosen
const DAY_LUNCH_FIT_MIN = 15;  // arriving this close to lunchtime is "perfect"
const DAY_ALONG_WINDOW  = 60;  // "also on your route" around lunchtime, ± minutes
const DAY_MOUNTAIN_ELE  = 1100; // a restaurant this high is on the mountain
const DAY_STOP_RUNS     = 240;  // walks per option with stops, shared out over its legs
const DAY_DIFF_LEVELS   = ['groen', 'blauw', 'rood', 'zwart', 'skiroute']; // as DIFF_LEVELS (app.js)

let dayDiff    = new Set(DAY_DIFF_LEVELS);
let dayPace    = 'normal';
let dayBus     = true;   // may the plan use the ski bus
let dayDrag    = true;   // drag lifts welcome (false: only when there is no other way)
let dayOptions = [];
let dayCtx     = null;
let dayGraph   = {}; // the routing graph (GRAPH, ride-down edges included)
let dayMoves   = {}; // per node, the edges this plan may take, with their cost (see prepareDayMoves)
let dayTracker = null; // ticking off the shown option's steps
let dayShown   = 0;    // index of the option on screen
let dayDone    = 0;    // steps ticked, for the map's current step
let dayStops   = [];   // stops on the way, in order: { id, kind, name, station, sub }

// ── Tabs ─────────────────────────────────────────────────────────────────────

function showTab(tab) {
  document.getElementById('tab-quick').style.display = tab === 'quick' ? 'block' : 'none';
  document.getElementById('tab-day').style.display   = tab === 'day'   ? 'block' : 'none';
  document.getElementById('tabbtn-quick').classList.toggle('on', tab === 'quick');
  document.getElementById('tabbtn-day').classList.toggle('on', tab === 'day');
  try { localStorage.setItem(DAY_TAB_KEY, tab); } catch {}
  // One map for both planners: draw it again in the one now on screen.
  leaveRouteMap();
  if (routeViews[tab] === 'map') drawPlannerMap(tab);
}

// ── Form ─────────────────────────────────────────────────────────────────────

// Called by resetPlanner() whenever an area is (re)loaded.
function resetDayPlan() {
  resetSide('dstart');
  resetSide('dend');
  dayOptions = [];
  document.getElementById('day-result').classList.remove('visible');
  document.getElementById('day-err').classList.remove('visible');

  const saved = loadDayInputs();
  document.getElementById('day-t0').value = saved.t0 || '09:00';
  document.getElementById('day-t1').value = saved.t1 || '16:00';
  document.getElementById('day-km').value = saved.km || 25;
  renderTimeSummary();
  if (!restorePlace('dstart', saved.startPlace)) restoreStation('dstart', saved.start);
  // The end field starts folded away ('Start & end'), unless a day that ends
  // elsewhere is being followed right now: then its end station comes back.
  if (dayInProgress() && !restorePlace('dend', saved.endPlace)) restoreStation('dend', saved.end);

  // Lunch is one of the stops. Areas without known mountain restaurants
  // (many built from OpenSkiData) plan without it: no lunch to add.
  // Saved before lunch was a stop: lunch (when on) after the other stops.
  document.getElementById('day-lunch-t').value   = saved.lunchT || '13:00';
  document.getElementById('day-lunch-min').value = saved.lunchMin || 60;
  renderLunchChoices(saved.lunchAt);
  const ids = saved.stops || [];
  dayStops = ids.map(stopById).filter(Boolean);
  if (!saved.stops && saved.lunch !== false) dayStops.push(lunchStop());
  if (!mountainRestaurants().length) dayStops = dayStops.filter(s => s.kind !== 'lunch');
  renderDayStops();
  restoreDayProgress();

  let tab = 'quick';
  try { tab = localStorage.getItem(DAY_TAB_KEY) || 'quick'; } catch {}
  showTab(tab === 'day' ? 'day' : 'quick');
}

// Reopened during the day: plan the same day again (planning is seeded, so
// it comes out identical) and show the option being followed, ticks and all.
function dayInProgress() {
  const saved = loadProgress('day');
  return !!saved && saved.done > 0 && saved.done < saved.total;
}

function restoreDayProgress() {
  dayTracker = null;
  const saved = loadProgress('day');
  if (!dayInProgress() || !selected.dstart) return;
  planDay({ silent: true });
  if (dayOptions.length && saved.option > 0 && saved.option < dayOptions.length) renderDayOption(saved.option);
}

// ── Stops ────────────────────────────────────────────────────────────────────
//
// Places to pass during the day, in order, besides lunch: a lift to ride, a
// restaurant, viewpoint, snow park, village or peak (picked like a start or
// destination). The day is planned in legs from stop to stop.

// Lunch: a stop with a time (and length, and where); its fields are the
// lunch inputs, shown in its row.
function lunchStop() {
  return { id: 'lunch', kind: 'lunch', name: 'Lunch', station: null, sub: '' };
}

function hasLunch() {
  return dayStops.some(s => s.kind === 'lunch');
}

// Lunch on or off. Added after the other stops; ↑ moves it earlier.
function setLunch(on) {
  if (on && !hasLunch()) dayStops.push(lunchStop());
  if (!on) dayStops = dayStops.filter(s => s.kind !== 'lunch');
  renderDayStops();
}

// The lunch box as the rest of the code knows it (on = lunch in the stops).
function toggleLunch() {
  setLunch(document.getElementById('day-lunch').checked);
}

function liftStop(lift) {
  return { id: `lift:${lift.nr}`, kind: 'lift', name: [liftCode(lift.nr), lift.name].filter(Boolean).join(' '), station: lift.berg, sub: 'ride it to the top' };
}

function placeStop(place) {
  const at = placeStation(place);
  return at && { id: place.id, kind: place.kind, name: place.name, station: at.id, sub: placeSub(place, at) };
}

function stopById(id) {
  if (id === 'lunch') return lunchStop();
  if (id?.startsWith('lift:')) {
    const lift = LIFTS.find(l => l.nr === id.slice(5));
    return lift ? liftStop(lift) : null;
  }
  const place = findPlace(id);
  return place ? placeStop(place) : null;
}

function addDayStop(stop) {
  closeSheet();
  if (!stop || dayStops.some(s => s.id === stop.id)) return;
  dayStops.push(stop);
  renderDayStops();
}

function removeDayStop(i) {
  dayStops.splice(i, 1);
  renderDayStops();
}

// The folded time & distance line: "09:00–16:00 · 25 km".
function renderTimeSummary() {
  const t0 = document.getElementById('day-t0').value, t1 = document.getElementById('day-t1').value;
  const km = document.getElementById('day-km').value;
  document.getElementById('time-summary').textContent = `${t0 || '?'}–${t1 || '?'} · ${km || '?'} km`;
}

function renderDayStops() {
  const el = document.getElementById('day-stops');
  if (!el) return;
  // The lunch fields live in the lunch row; out of the way while redrawing.
  const fields = document.getElementById('lunch-fields');
  document.getElementById('lunch-holder').appendChild(fields);
  const lunchT = document.getElementById('day-lunch-t').value;
  // No order to set: the plan passes the stops in the order that fits best.
  el.innerHTML = dayStops.map((stop, i) => `
    <div class="stop-row${stop.kind === 'lunch' ? ' stop-lunch' : ''}">
      <span class="lift-ico ico-place">${PLACE_ICONS[stop.kind] || ICONS.start}</span>
      <span class="stop-name">${escapeHtml(stop.name)}<span class="place-sub">${escapeHtml(stop.kind === 'lunch' ? `around ${lunchT}` : stop.sub)}</span></span>
      <button type="button" class="stop-btn" onclick="removeDayStop(${i})" aria-label="Remove this stop">✕</button>
    </div>${stop.kind === 'lunch' ? '<div class="lunch-slot"></div>' : ''}`).join('');
  const slot = el.querySelector('.lunch-slot');
  if (slot) slot.appendChild(fields);
  const lunch = hasLunch();
  document.getElementById('day-lunch').checked = lunch;
  document.getElementById('lunch-add').style.display = lunch || !mountainRestaurants().length ? 'none' : '';
  const places = dayStops.filter(s => s.kind !== 'lunch').length;
  document.getElementById('stops-summary').textContent = [
    places ? `${places} stop${places > 1 ? 's' : ''}` : '',
    lunch ? `lunch ${lunchT}` : '',
  ].filter(Boolean).join(' · ') || 'None';
}


function renderLunchChoices(selectedId) {
  const select = document.getElementById('day-lunch-at');
  select.innerHTML = '<option value="">Best fit on my route</option>';
  mountainRestaurants().forEach(r => {
    const option = document.createElement('option');
    option.value = r.id;
    option.textContent = `${r.naam} · ${restaurantWhere(r)}`;
    select.appendChild(option);
  });
  select.value = mountainRestaurants().some(r => r.id === selectedId) ? selectedId : '';
}

// Pace is one of the preferences (⚙); `save` false only shows it.
function setDayPace(pace, save = true) {
  if (!DAY_PACES[pace]) pace = 'normal';
  dayPace = pace;
  Object.keys(DAY_PACES).forEach(p => document.getElementById('pace-' + p).classList.toggle('on', p === pace));
  renderPaceInfo();
  if (save && prefs.pace !== pace) {
    prefs.pace = pace;
    storePrefs();
    renderPrefs();
  }
}

// What each pace means, under the switch: how fast down the runs and how
// long a queue at each lift, the chosen one first in bold.
function renderPaceInfo() {
  const el = document.getElementById('pace-info');
  if (!el) return;
  el.innerHTML = Object.entries(DAY_PACES).map(([key, p]) => `
    <div class="pace-info-row${key === dayPace ? ' on' : ''}">
      <strong>${p.label}</strong>
      <span>~${Math.round(PISTE_KMH / p.piste)} km/h on average down the runs${p.piste > 1 ? ` (piste times ×${p.piste})` : ''} · ~${p.wait} min queueing per lift. ${p.who}</span>
    </div>`).join('');
}

function dayStorageKey() {
  return DAY_KEY_PREFIX + (currentArea?.id || '');
}

function loadDayInputs() {
  try { return JSON.parse(localStorage.getItem(dayStorageKey())) || {}; } catch { return {}; }
}

function saveDayInputs(inputs) {
  try { localStorage.setItem(dayStorageKey(), JSON.stringify(inputs)); } catch {}
}

// ── Time helpers ─────────────────────────────────────────────────────────────

function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(value || '');
  return m ? +m[1] * 60 + +m[2] : null;
}

function formatClock(minutes) {
  const m = Math.round(minutes);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// "45 min", "2 h 05".
function formatDuration(minutes) {
  const m = Math.round(minutes);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

// Every plain "HH:MM-HH:MM" range in an OSM opening_hours value, in minutes.
// Days of the week and seasons are ignored: this is a guideline.
function clockRanges(openingstijden) {
  return [...(openingstijden || '').matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)]
    .map(r => [+r[1] * 60 + +r[2], +r[3] * 60 + +r[4]]);
}

// A lift's daily operating window (the last range wins). Null when unknown.
function liftWindow(openingstijden) {
  const ranges = clockRanges(openingstijden);
  return ranges.length ? ranges[ranges.length - 1] : null;
}

// Open at minute `t`, or no usable hours mapped (then assume open).
function openAt(openingstijden, t) {
  const ranges = clockRanges(openingstijden);
  return !ranges.length || ranges.some(([from, to]) => t >= from && t <= to);
}

// ── Restaurants ──────────────────────────────────────────────────────────────

// Restaurants you can ski to: at a top station, on a piste, a hut, or high
// enough up. Leaves out the cafés and bars down in the villages.
function mountainRestaurants() {
  return (currentArea?.restaurants || []).filter(r => {
    if (r.station && !STATIONS[r.station]) return false;
    if (r.piste) return true;
    return r.station?.endsWith('-boven') || r.soort === 'hut' || (r.hoogte || 0) >= DAY_MOUNTAIN_ELE;
  });
}

function restaurantWhere(r) {
  if (r.piste) return `on ${pisteLabel(r.piste)}`;
  const lift = LIFTS.find(l => l.dal === r.station || l.berg === r.station);
  if (!lift) return STATIONS[r.station]?.name || '';
  return `${lift.berg === r.station ? 'top' : 'bottom'} of ${[liftCode(lift.nr), lift.name].filter(Boolean).join(' ')}`;
}

// "piste 21", or the run's name when it has no number of its own (areas
// built from map data use the name, or a generated "~n", as its key).
function pisteLabel(nr) {
  const piste = (currentArea?.pistes || []).find(p => p.pisteNr === nr);
  if (nr && !nr.startsWith('~') && nr.length <= 4) return `piste ${nr}`;
  return piste?.naam ? `the ${piste.naam} piste` : 'the piste';
}

// ── Cost model ───────────────────────────────────────────────────────────────

function dayCost(edge, pace) {
  if (edge.type === 'piste')    return Math.max(1, Math.round((edge.tijd || 0) * pace.piste));
  if (edge.type === 'transfer') return DAY_TRANSFER_MIN;
  if (isConnection(edge))       return edge.tijd || 0;
  return (edge.tijd || 0) + (edge.echteLift === false ? DAY_PRACTICE_MIN : pace.wait);
}

// May the plan take this edge at all (the bus switch, lifts avoided by hand)…
function dayUsable(edge) {
  if (edge.type === 'bus') return dayBus;
  return !isAvoided(edge);
}

// …and is it one you want: a piste in a picked colour, a drag lift only when
// they are welcome. The plan skis only these; the others (UNWANTED_PENALTY)
// only on the way back when there is no other way.
function dayAllowed(edge) {
  return dayUsable(edge) && !unwantedEdge(edge, dayDiff, dayDrag);
}

// What counts as "the same piste" for variety. Areas built from map data give
// runs without a number a key of their own per stretch ("~12", "~13"), so
// three stretches of the "Village" run looked like three different pistes and
// a day could lap them back to back. Those go by their name instead, unless
// the name is a made-up one ("Blue run").
const GENERIC_RUN_NAME = /^((green|blue|red|black) run|ski route|piste)\b/i;
function pisteKey(edge) {
  const nr = String(edge.pisteNr || '');
  const numbered = nr && !nr.startsWith('~') && nr.length <= 4;
  if (!numbered && edge.name && !GENERIC_RUN_NAME.test(edge.name)) return `name|${edge.name.toLowerCase()}`;
  return `${edge.pisteNr}|${edge.name}`;
}

// The pistes a piste edge skis, one key each. A descent through several
// marked runs ("31, 52": piste 31 into 52) counts for each of them, so the
// same slope reached a slightly different way is not "new" again.
const pisteKeysCache = new WeakMap();
function pisteKeys(edge) {
  let keys = pisteKeysCache.get(edge);
  if (!keys) {
    keys = [...new Set(splitTrajecten(edge).map(pisteKey))];
    pisteKeysCache.set(edge, keys);
  }
  return keys;
}

// The km of a piste edge worth skiing given today's plan so far: each part
// counts by how often its piste was skied already, so a long run that starts
// on an often-skied beginner slope is still mostly new.
const pistePartsCache = new WeakMap();
function freshKm(usage, edge) {
  let parts = pistePartsCache.get(edge);
  if (!parts) {
    const split = splitTrajecten(edge);
    const total = edge.km || 0;
    const sum = split.reduce((a, p) => a + (p.km || 0), 0);
    // Parts without a length share the edge's km evenly.
    parts = split.map(p => ({ key: pisteKey(p), km: sum > 0 ? total * (p.km || 0) / sum : total / split.length }));
    pistePartsCache.set(edge, parts);
  }
  let km = 0;
  for (const part of parts) km += part.km * novelty(usage.get(part.key) || 0);
  return km;
}

function countPistes(usage, edge) {
  pisteKeys(edge).forEach(key => usage.set(key, (usage.get(key) || 0) + 1));
}

// How attractive a piste is given how often it was skied today already.
function novelty(timesSkied) {
  return [1, 0.35, 0.12][timesSkied] ?? 0.04;
}

// Quickest time (and the next edge to take) from every node to `endId`.
function costsToEnd(endId, pace) {
  const reverse = {};
  // The way home may use what you would rather not, at a high price: only
  // when nothing else gets you back.
  Object.values(dayGraph).forEach(edges => edges.forEach(edge => {
    if (dayUsable(edge)) (reverse[edge.to] = reverse[edge.to] || []).push(edge);
  }));

  // Route on cost (riding a lift down only when nothing else gets you
  // there), but report the real time of that way home in `dist`.
  const cost = { [endId]: 0 };
  const next = {};
  const done = new Set();
  const queue = new MinHeap();
  queue.push(0, endId);
  while (queue.size) {
    const id = queue.pop();
    if (done.has(id)) continue;
    done.add(id);
    (reverse[id] || []).forEach(edge => {
      const c = cost[id] + dayCost(edge, pace) + (edge.descent ? RIDE_DOWN_PENALTY : 0) + (isConnection(edge) ? CONNECTION_PENALTY : 0)
        + (unwantedEdge(edge, dayDiff, dayDrag) ? UNWANTED_PENALTY : 0);
      if (c < (cost[edge.from] ?? Infinity)) {
        cost[edge.from] = c;
        next[edge.from] = edge;
        queue.push(c, edge.from);
      }
    });
  }

  // Real minutes and piste km along that way home, so a walk can stop in time.
  const dist = {};
  const homeKm = {};
  function home(node) {
    if (dist[node] != null) return;
    dist[node] = 0; homeKm[node] = 0; // guard against cycles while computing
    const edge = next[node];
    if (!edge) return;
    home(edge.to);
    dist[node]   = dayCost(edge, pace) + dist[edge.to];
    homeKm[node] = (edge.type === 'piste' ? edge.km || 0 : 0) + homeKm[edge.to];
  }
  Object.keys(cost).forEach(home);

  return { dist, next, homeKm };
}

// The edges a plan may take from each node, with their cost and piste key
// worked out once: a walk weighs them many thousands of times, and big areas
// have top stations with well over a hundred ways down.
function prepareDayMoves(pace) {
  dayMoves = {};
  Object.entries(dayGraph).forEach(([node, edges]) => {
    dayMoves[node] = edges.filter(dayAllowed).map(edge => ({
      edge,
      cost: dayCost(edge, pace),
      piste: edge.type === 'piste',
      transfer: edge.type === 'transfer',

      km: edge.km || 0,
      memo: [], // lookahead answers for the current step, per depth
      step: -1,
    }));
  });
}

// Best km-per-minute reachable by taking `move` and up to `depth` more
// non-piste moves to reach a piste. Returns the gain and the time it takes.
// Answers are kept for one step of a walk (`step`; the usage is the same
// throughout it), since the same edges come up again and again.
function lookahead(move, usage, depth, step) {
  const cost = move.cost;
  if (move.piste) return { gain: freshKm(usage, move.edge), cost };
  if (depth === 0) return { gain: 0, cost };
  if (move.step === step && move.memo[depth]) return move.memo[depth];

  let best = { gain: 0, cost };
  let bestRate = 0;
  const next = dayMoves[move.edge.to] || [];
  for (let i = 0; i < next.length; i++) {
    const nextMove = next[i];
    if (move.transfer && nextMove.transfer) continue;
    const ahead = lookahead(nextMove, usage, depth - 1, step);
    const rate = ahead.gain / (cost + ahead.cost);
    if (rate > bestRate) { bestRate = rate; best = { gain: ahead.gain, cost: cost + ahead.cost }; }
  }
  if (move.step !== step) { move.step = step; move.memo = []; }
  move.memo[depth] = best;
  return best;
}
let lookaheadStep = 0;

// Priority queue for the shortest-path searches (here and in app.js): the
// large European areas have thousands of edges, too many to sort each step.
class MinHeap {
  constructor() { this.keys = []; this.items = []; }
  get size() { return this.keys.length; }
  push(key, item) {
    const { keys, items } = this;
    let i = keys.length;
    keys.push(key); items.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p]; items[i] = items[p]; i = p;
    }
    keys[i] = key; items[i] = item;
  }
  pop() {
    const { keys, items } = this;
    const top = items[0];
    const key = keys.pop(), item = items.pop();
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c]; items[i] = items[c]; i = c;
      }
      keys[i] = key; items[i] = item;
    }
    return top;
  }
}

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ── Walks ────────────────────────────────────────────────────────────────────

function liftOpenAt(edge, t, ctx) {
  if (!edge.liftNr || edge.type === 'piste' || edge.type === 'transfer') return true;
  const hours = ctx.liftWindows[edge.liftNr];
  return !hours || (t >= hours[0] && t <= hours[1]);
}

// One walk from ctx.startId to ctx.endId. `initialUsage` carries the pistes
// already skied earlier that day (the morning, for an afternoon walk).
function dayWalk(ctx, random, initialUsage) {
  const { startId, endId, t0, t1, targetKm, pace, home } = ctx;
  const steps = [];
  const usage = new Map(initialUsage || []);
  const liftRides = new Map(); // rides per lift today: laps on one lift get less likely
  let node = startId, t = t0, km = 0, prevEdge = null;

  function take(edge) {
    steps.push({ edge, t });
    t += dayCost(edge, pace);
    node = edge.to;
    prevEdge = edge;
    if (edge.liftNr && edge.type !== 'piste' && !isConnection(edge)) liftRides.set(edge.liftNr, (liftRides.get(edge.liftNr) || 0) + 1);
    if (edge.type === 'piste') {
      km += edge.km || 0;
      countPistes(usage, edge);
    }
  }

  for (let guard = 0; guard < 400; guard++) {
    // `fillUntil`: keep skiing past the distance target until about then
    // (a morning that should reach the restaurant around lunchtime).
    const kmDone = km + (home.homeKm[node] || 0) >= targetKm * 0.97;
    if (kmDone && !(ctx.fillUntil && t + (home.dist[node] || 0) < ctx.fillUntil)) break;

    const candidates = [];
    const step = ++lookaheadStep;
    (dayMoves[node] || []).forEach(move => {
      const { edge, cost } = move;
      if (move.transfer && prevEdge?.type === 'transfer') return;
      const rest = home.dist[edge.to];
      if (rest == null || t + cost + rest > t1 + DAY_LATE_SLACK) return;
      if (!liftOpenAt(edge, t, ctx)) return;
      const ahead = lookahead(move, usage, 3, step);
      let weight = (ahead.gain + 0.01) / ahead.cost;
      if (edge.echteLift === false) weight *= 0.2;
      if (edge.liftNr && !move.piste) weight *= [1, 0.7, 0.35, 0.15][liftRides.get(edge.liftNr) || 0] ?? 0.08;
      if (edge.descent) weight *= 0.3;
      // A walk is a last resort: you came to ski. Never two in a row, and
      // only when the lifts and runs here really do not suit.
      if (edge.type === 'walk') {
        if (isConnection(prevEdge || {}) || prevEdge?.type === 'transfer') return;
        weight *= 0.02;
      } else if (isConnection(edge)) weight *= 0.3;
      candidates.push({ edge, weight: weight ** 3 });
    });
    if (!candidates.length) break;

    const total = candidates.reduce((sum, c) => sum + c.weight, 0);
    let pick = random() * total;
    const chosen = candidates.find(c => (pick -= c.weight) <= 0) || candidates[candidates.length - 1];
    take(chosen.edge);
  }

  // Head back the quickest way.
  for (let guard = 0; node !== endId && guard < 200; guard++) {
    const edge = home.next[node];
    if (!edge) return null;
    take(edge);
  }
  if (node !== endId) return null;

  return { steps, km, end: t, usage };
}

// The variety part of a day's score: unique pistes up, many repeats and
// magic carpets down.
function varietyScore(walk) {
  let repeats = 0;
  walk.usage.forEach(count => { repeats += Math.max(0, count - 2); });
  // Laps on one lift: a few are fine, a dozen on the same baby lift is not.
  const rides = new Map();
  walk.steps.forEach(s => {
    if (s.edge?.liftNr && s.edge.type !== 'piste' && !isConnection(s.edge)) rides.set(s.edge.liftNr, (rides.get(s.edge.liftNr) || 0) + 1);
  });
  let laps = 0;
  rides.forEach(count => { laps += Math.max(0, count - 3); });
  const practiceLifts = walk.steps.filter(s => s.edge && s.edge.echteLift === false && s.edge.type !== 'piste' && s.edge.type !== 'transfer').length;
  return 0.8 * walk.usage.size - 3 * repeats - 3 * laps - 2 * practiceLifts;
}

function scoreDay(walk, ctx) {
  const kmError = Math.abs(walk.km - ctx.targetKm) / ctx.targetKm;
  return -120 * kmError - 4 * Math.max(0, walk.end - ctx.t1) + varietyScore(walk);
}

function overlap(a, b) {
  const keysA = new Set(a.usage.keys());
  const keysB = new Set(b.usage.keys());
  let shared = 0;
  keysA.forEach(k => { if (keysB.has(k)) shared++; });
  return shared / Math.max(1, Math.min(keysA.size, keysB.size));
}

// Top `count` walks that differ enough from each other.
function distinctBest(walks, count, isDistinct) {
  const sorted = [...walks].sort((a, b) => b.score - a.score);
  const picked = [];
  for (const walk of sorted) {
    if (picked.every(p => isDistinct(p, walk))) picked.push(walk);
    if (picked.length === count) break;
  }
  return picked;
}

// ── Lunch ────────────────────────────────────────────────────────────────────

// Where a day can stop for lunch. Restaurants at the same station (or on
// the same piste edge) share one stop, so their walks are computed once.
// A station restaurant is a graph node; one on a piste is reached by skiing
// that piste, so the stop sits halfway down the quickest way down that
// includes it. In big areas a piste is part of many ways down, and one
// stop each would make the lunch day far too slow to plan; only a single
// chosen restaurant gets every way down past it.
function lunchStops(restaurants) {
  const stops = new Map();
  const add = (key, node, piste, r) => {
    if (!stops.has(key)) stops.set(key, { key, node, piste, pisteNr: r.piste || null, restaurants: [] });
    stops.get(key).restaurants.push(r);
  };
  const everyWay = restaurants.length === 1;
  const byPiste = new Map();
  Object.values(dayGraph).flat().forEach(edge => {
    if (edge.type !== 'piste' || edge.from === GPS_NODE || !dayAllowed(edge)) return;
    const nrs = edge.trajecten ? edge.trajecten.map(t => t.pisteNr) : [edge.pisteNr];
    new Set(nrs).forEach(nr => {
      const list = byPiste.get(nr) || [];
      if (everyWay) { if (!list.some(e => e.from === edge.from)) list.push(edge); }
      else if (!list.length || (edge.tijd || 0) < (list[0].tijd || 0)) list[0] = edge;
      byPiste.set(nr, list);
    });
  });
  restaurants.forEach(r => {
    if (r.station) { add(r.station, r.station, null, r); return; }
    (byPiste.get(r.piste) || []).forEach(edge => add(`${edge.from}>${edge.to}|${r.piste}`, edge.from, edge, r));
  });
  return [...stops.values()];
}

// Quickest time from `startId` to every node, for picking lunch stops.
function costsFromStart(startId, pace) {
  const cost = { [startId]: 0 };
  const done = new Set();
  const queue = new MinHeap();
  queue.push(0, startId);
  while (queue.size) {
    const id = queue.pop();
    if (done.has(id)) continue;
    done.add(id);
    (dayGraph[id] || []).forEach(edge => {
      if (!dayAllowed(edge)) return;
      const c = cost[id] + dayCost(edge, pace);
      if (c < (cost[edge.to] ?? Infinity)) { cost[edge.to] = c; queue.push(c, edge.to); }
    });
  }
  return cost;
}

// Without a chosen restaurant, a big area has far more lunch stops than can
// be tried. Keep the ones you can reach by lunchtime and get home from, and
// of those a fixed sample (same inputs, same sample), huts and stops with
// several places first.
function pickLunchStops(stops, ctx, random) {
  if (stops.length <= DAY_LUNCH_STOPS) return stops;
  const from = costsFromStart(ctx.startId, ctx.pace);
  return stops
    .filter(s => from[s.node] != null && ctx.t0 + from[s.node] <= ctx.lunchT + 30 && ctx.home.dist[s.piste ? s.piste.to : s.node] != null)
    .map(s => ({ s, rank: random() + 0.3 * Math.min(2, s.restaurants.length - 1) + (s.restaurants.some(r => r.soort === 'hut') ? 0.3 : 0) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, DAY_LUNCH_STOPS)
    .map(x => x.s);
}

// Best few full days (morning + lunch + afternoon) through one lunch stop,
// one per restaurant there that is open when you arrive.
function daysVia(stop, ctx, random) {
  const { pace, lunchT, lunchMin, t0, t1 } = ctx;
  const morningHome = costsToEnd(stop.node, pace);
  if (morningHome.dist[ctx.startId] == null) return [];

  // A piste restaurant sits halfway down its own numbered part of the run.
  // When the run is a chain (25 → 25b), the parts before and including it
  // come before lunch and the rest after: `before` / `after` are the minutes
  // of skiing on either side of the stop.
  const parts = stop.piste ? splitTrajecten(stop.piste).map(p => ({ ...p, chainEnd: stop.piste.to })) : [];
  let k = parts.findIndex(p => p.pisteNr === stop.pisteNr);
  if (k < 0) k = parts.length - 1;
  const partMin = parts.map(p => dayCost(p, pace));
  const sum = list => list.reduce((a, b) => a + b, 0);
  const before = parts.length ? sum(partMin.slice(0, k)) + partMin[k] / 2 : 0;
  const after  = parts.length ? sum(partMin.slice(k + 1)) + partMin[k] / 2 : 0;
  const afterStart = stop.piste ? stop.piste.to : stop.node;
  if (ctx.home.dist[afterStart] == null) return [];

  // Split the distance by skiing time before and after lunch.
  const amMin = Math.max(0, lunchT - t0);
  const pmMin = Math.max(0, t1 - lunchT - lunchMin);
  const amKm  = ctx.targetKm * amMin / Math.max(1, amMin + pmMin);

  const amEnd = lunchT - before;
  if (t0 + morningHome.dist[ctx.startId] > amEnd + 45) return [];
  const amCtx     = { ...ctx, endId: stop.node, t1: amEnd, targetKm: Math.max(0.1, amKm), home: morningHome };
  const amFillCtx = { ...amCtx, fillUntil: amEnd - DAY_LUNCH_FIT_MIN };
  const lunchPenalty = arrive => 0.5 * Math.max(0, Math.abs(arrive - lunchT) - DAY_LUNCH_FIT_MIN);

  // Half the mornings stop at their share of the distance, half keep skiing
  // until lunchtime; the score decides which matters more for this day.
  const mornings = [];
  for (let i = 0; i < DAY_LUNCH_RUNS; i++) {
    const walk = dayWalk(i % 2 ? amFillCtx : amCtx, random);
    if (!walk) continue;
    walk.fills = i % 2 === 1;
    const arrive = walk.end + before;
    if (!stop.restaurants.some(r => openAt(r.openingstijden, arrive))) continue;
    walk.score = scoreDay(walk, amCtx) - lunchPenalty(arrive);
    mornings.push(walk);
  }

  const days = [];
  // The best morning of each kind goes on to the afternoon.
  [false, true].flatMap(fills => distinctBest(mornings.filter(m => m.fills === fills), 1, () => true)).forEach(morning => {
    const arrive = morning.end + before;
    const leave  = arrive + lunchMin;
    const usage  = new Map(morning.usage);
    let km = morning.km;
    // The run with the restaurant, split around the lunch stop.
    const beforeSteps = [], afterSteps = [];
    let t = morning.end;
    parts.forEach((part, i) => {
      if (i === k + 1) t = leave + partMin[k] / 2;
      (i <= k ? beforeSteps : afterSteps).push({ edge: part, t });
      t += partMin[i];
      countPistes(usage, part);
      km += part.km || 0;
    });

    const pmCtx = { ...ctx, startId: afterStart, t0: leave + after, targetKm: Math.max(0.1, ctx.targetKm - km) };
    let best = null;
    for (let i = 0; i < DAY_LUNCH_PM_RUNS; i++) {
      const afternoon = dayWalk(pmCtx, random, usage);
      if (!afternoon) continue;
      const day = { steps: afternoon.steps, km: km + afternoon.km, end: afternoon.end, usage: afternoon.usage };
      day.score = scoreDay({ ...day, steps: [...morning.steps, ...afternoon.steps] }, ctx) - lunchPenalty(arrive);
      if (!best || day.score > best.score) best = day;
    }
    if (!best) return;

    stop.restaurants.filter(r => openAt(r.openingstijden, arrive)).forEach(r => {
      days.push({
        steps: [...morning.steps, ...beforeSteps, { lunch: r, t: arrive, until: leave, onPiste: !!stop.piste }, ...afterSteps, ...best.steps],
        km: best.km,
        end: best.end,
        usage: best.usage,
        lunch: { restaurant: r, arrive, leave, stop: stop.key },
        score: best.score + (r.soort === 'hut' ? 1 : 0),
      });
    });
  });
  return days;
}

// ── Stops: a day in legs ─────────────────────────────────────────────────────
//
// start → stop 1 → stop 2 → … → end, the stops in the order that is quickest
// to get past them all (not the order they were added in). Each leg gets the
// quickest time between its ends plus a share of the time left (longer legs
// a bigger share), and the same share of the distance. Lunch is a stop with
// a time: it goes in the leg that is under way around that time, the time
// before lunch shared out over the legs before it, the time after over the
// legs after. That leg is planned like a lunch day of its own. Legs are
// planned one after another, each starting when the last one ended and
// knowing what was skied already; the three options avoid each other leg by
// leg.
const STOP_ORDER_EXACT = 7; // up to this many stops every order is tried

function orderStops(ctx, stops) {
  if (stops.length < 2) return stops;
  const tables = new Map();
  const cost = (a, b) => {
    if (a === b) return 0;
    if (!tables.has(b)) tables.set(b, costsToEnd(b, ctx.pace).dist);
    return tables.get(b)[a] ?? Infinity;
  };
  const length = order => {
    let total = 0, at = ctx.startId;
    order.forEach(s => { total += cost(at, s.station); at = s.station; });
    return total + cost(at, ctx.endId);
  };
  let best = stops, bestLength = length(stops);
  if (stops.length <= STOP_ORDER_EXACT) {
    const permute = (done, rest) => {
      if (!rest.length) {
        const l = length(done);
        if (l < bestLength) { best = done; bestLength = l; }
        return;
      }
      rest.forEach((s, i) => permute([...done, s], [...rest.slice(0, i), ...rest.slice(i + 1)]));
    };
    permute([], stops);
  } else {
    // Many stops: the nearest next each time, then swap pairs while it helps.
    const rest = [...stops];
    let order = [], at = ctx.startId;
    while (rest.length) {
      rest.sort((a, b) => cost(at, a.station) - cost(at, b.station));
      at = rest[0].station;
      order.push(rest.shift());
    }
    let better = true;
    while (better) {
      better = false;
      for (let i = 0; i < order.length - 1; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const flipped = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
          if (length(flipped) < length(order) - 0.5) { order = flipped; better = true; }
        }
      }
    }
    if (length(order) < bestLength) best = order;
  }
  return best;
}

function planWithStops(ctx, random, allStops, lunchAt) {
  const { pace } = ctx;
  const stops = orderStops(ctx, allStops.filter(s => s.kind !== 'lunch'));
  const withLunch = ctx.withLunch && allStops.some(s => s.kind === 'lunch');
  const legs = [];
  let from = ctx.startId;
  [...stops, null].forEach(stop => {
    const to = stop ? stop.station : ctx.endId;
    legs.push({ from, to, stop });
    from = to;
  });
  for (const leg of legs) {
    leg.home = costsToEnd(leg.to, pace);
    leg.base = leg.from === leg.to ? 0 : leg.home.dist[leg.from];
    if (leg.base == null) {
      return { error: leg.stop
        ? `${leg.stop.name} cannot be reached on this day. Remove it or change your preferences.`
        : 'The end station cannot be reached from the last stop.' };
    }
  }
  const lunchMin = ctx.withLunch ? ctx.lunchMin : 0;
  const avail = ctx.t1 - ctx.t0 - lunchMin;
  const baseSum = legs.reduce((sum, l) => sum + l.base, 0);
  if (baseSum > avail) return { error: `Getting past all stops alone takes about ${Math.round(baseSum)} min, which does not fit before ${formatClock(ctx.t1)}.` };

  // A leg that starts and ends at the same station (a stop right at the
  // start) gets no time of its own, unless it is the whole day.
  const moving = legs.filter(l => l.from !== l.to || legs.length === 1);
  if (!moving.length) moving.push(legs[legs.length - 1]);
  const weight = l => moving.includes(l) ? l.base + 20 : 0;
  const weights = legs.reduce((sum, l) => sum + weight(l), 0);
  legs.forEach(l => { l.km = ctx.targetKm * weight(l) / weights; });

  // Lunch in the leg that is under way around lunchtime, among the legs
  // where the stops before and after it fit around its time.
  const sumOf = (list, f) => list.reduce((sum, l) => sum + f(l), 0);
  const amTime = ctx.lunchT - ctx.t0, pmTime = ctx.t1 - ctx.lunchT - lunchMin;
  const amBaseAt = k => sumOf(legs.slice(0, k), l => l.base) + legs[k].base / 2;
  const pmBaseAt = k => sumOf(legs.slice(k + 1), l => l.base) + legs[k].base / 2;
  const fits = k => amBaseAt(k) <= amTime && pmBaseAt(k) <= pmTime;
  const lunchShare = amTime / Math.max(1, avail);
  const offLunch = k => Math.abs((sumOf(legs.slice(0, k), weight) + weight(legs[k]) / 2) / weights - lunchShare);
  let lunchLeg = -1;
  if (withLunch) {
    const all = legs.map((l, k) => k);
    const fitting = all.filter(fits);
    lunchLeg = (fitting.length ? fitting : all).sort((a, b) => offLunch(a) - offLunch(b))[0];
  }
  const notes = [];

  if (lunchLeg < 0) {
    const free = avail - baseSum;
    let t = ctx.t0;
    legs.forEach(l => {
      l.t0 = t;
      l.t1 = t + l.base + free * weight(l) / weights;
      t = l.t1;
    });
  } else {
    // Before lunch: the legs before it and the first half of its own leg
    // share the time up to lunch; after lunch the rest.
    const L = legs[lunchLeg];
    const before = legs.slice(0, lunchLeg), after = legs.slice(lunchLeg + 1);
    const amBase = amBaseAt(lunchLeg), pmBase = pmBaseAt(lunchLeg);
    if (amBase > amTime) return { error: `The stops before lunch take about ${Math.round(amBase)} min: lunch at ${formatClock(ctx.lunchT)} is too early. Pick a later lunch time or fewer stops.` };
    if (pmBase > pmTime) return { error: `The stops after lunch take about ${Math.round(pmBase)} min, which does not fit before ${formatClock(ctx.t1)}. Pick an earlier lunch time or fewer stops.` };
    const amW = sumOf(before, weight) + weight(L) / 2 || 1, pmW = sumOf(after, weight) + weight(L) / 2 || 1;
    let t = ctx.t0;
    before.forEach(l => { l.t0 = t; l.t1 = t + l.base + (amTime - amBase) * weight(l) / amW; t = l.t1; });
    L.t0 = t;
    L.t1 = ctx.lunchT + lunchMin + L.base / 2 + (pmTime - pmBase) * (weight(L) / 2) / pmW;
    t = L.t1;
    after.forEach(l => { l.t0 = t; l.t1 = t + l.base + (pmTime - pmBase) * weight(l) / pmW; t = l.t1; });
  }

  // Lunch: the best days through a restaurant within the lunch leg.
  if (lunchLeg >= 0) {
    const l = legs[lunchLeg];
    const lunchT = Math.min(Math.max(ctx.lunchT, l.t0 + 15), l.t1 - lunchMin - 15);
    const lctx = { ...ctx, startId: l.from, endId: l.to, t0: l.t0, t1: l.t1, targetKm: Math.max(0.1, l.km), home: l.home, lunchT };
    const restaurants = lunchAt ? mountainRestaurants().filter(r => r.id === lunchAt) : mountainRestaurants();
    l.lunchDays = pickLunchStops(lunchStops(restaurants), lctx, random).flatMap(stop => daysVia(stop, lctx, random))
      .sort((a, b) => b.score - a.score);
    if (!l.lunchDays.length) return { error: 'No restaurant fits around lunchtime between your stops. Try another lunch time or other stops, or remove lunch.' };
  }

  const perLeg = Math.max(20, Math.ceil(DAY_STOP_RUNS / moving.length));
  const options = [];
  for (let k = 0; k < DAY_MAX_OPTIONS; k++) {
    let usage = new Map();
    const steps = [];
    const legWalks = [];
    let km = 0, end = ctx.t0, lunch = null;
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      const before = options.map(o => o.legWalks[i]).filter(Boolean);
      const distinct = w => before.every(p => p !== w && overlap(p, w) < DAY_OPTION_OVERLAP);
      let walk;
      if (i === lunchLeg) {
        walk = l.lunchDays.find(d => distinct(d) && before.every(p => p.lunch?.restaurant.id !== d.lunch.restaurant.id))
          || l.lunchDays.find(distinct) || l.lunchDays[0];
        usage = new Map([...usage, ...walk.usage].map(([key]) => [key, (usage.get(key) || 0) + (walk.usage.get(key) || 0)]));
      } else if (!moving.includes(l)) {
        walk = { steps: [], km: 0, end, usage };
      } else {
        // From when the leg before ended; legs before lunch keep clear of it.
        const legEnd = i < lunchLeg ? l.t1 - DAY_LATE_SLACK : l.t1;
        const lctx = { ...ctx, startId: l.from, endId: l.to, t0: Math.max(end, l.t0 - 30), t1: Math.max(legEnd, end + l.base), targetKm: Math.max(0.1, l.km), home: l.home };
        const walks = [];
        for (let r = 0; r < perLeg; r++) {
          const w = dayWalk(lctx, random, usage);
          if (w) { w.score = scoreDay(w, lctx); walks.push(w); }
        }
        walks.sort((a, b) => b.score - a.score);
        walk = walks.find(distinct) || walks[0];
        if (walk) usage = walk.usage;
      }
      if (!walk) return options.length ? { options, notes } : { error: 'No day plan found past these stops. Try a longer day or fewer stops.' };
      legWalks.push(walk);
      steps.push(...walk.steps);
      km += walk.km;
      end = Math.max(end, walk.end);
      if (walk.lunch) lunch = walk.lunch;
      if (l.stop) steps.push({ stop: l.stop, t: end });
    }
    const day = { steps, km, end, usage, lunch, legWalks };
    day.score = scoreDay(day, ctx);
    options.push(day);
  }
  return { options, notes };
}

// ── Planning ─────────────────────────────────────────────────────────────────

// The planning button shows it is working, then planning runs on the next
// frame so that state is painted first (a lunch day can take a moment).
// A fresh plan starts with nothing ticked, even when it is the same day as before.
function planDayClicked(button) {
  clearProgress('day');
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'PLANNING…';
  setTimeout(() => {
    try { planDay(); } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }, 30);
}

function planDay(options = {}) {
  const errorEl  = document.getElementById('day-err');
  const resultEl = document.getElementById('day-result');
  errorEl.classList.remove('visible');
  const fail = message => {
    errorEl.textContent = message;
    errorEl.classList.add('visible');
    resultEl.classList.remove('visible');
  };

  const start = selected.dstart;
  const end   = selected.dend || selected.dstart;
  const t0 = parseClock(document.getElementById('day-t0').value);
  const t1 = parseClock(document.getElementById('day-t1').value);
  const targetKm = parseFloat(document.getElementById('day-km').value);
  const withLunch = document.getElementById('day-lunch').checked;
  const lunchT   = parseClock(document.getElementById('day-lunch-t').value);
  const lunchMin = parseFloat(document.getElementById('day-lunch-min').value) || 0;
  const lunchAt  = document.getElementById('day-lunch-at').value;
  dayBus = busAllowed('pref-bus');
  dayDrag = dragAllowed('pref-drag');

  if (!start) { markMissing(['dstart']); return fail('Choose where your day starts.'); }
  if (t0 == null || t1 == null)     return fail('Enter a start time and a time to be back.');
  if (t1 - t0 < 30)                 return fail('"Back by" must be at least half an hour after the start.');
  if (!(targetKm > 0))              return fail('Enter how many kilometres you want to ski.');
  if (!dayDiff.size)                return fail('Select at least one piste difficulty.');
  if (withLunch && (lunchT == null || lunchT <= t0 || lunchT + lunchMin >= t1)) {
    return fail('Lunch has to fit between the start and the time to be back.');
  }

  saveDayInputs({
    start: start.id, end: selected.dend?.id || null,
    startPlace: start.place?.id || null, endPlace: selected.dend?.place?.id || null,
    stops: dayStops.map(s => s.id),
    t0: document.getElementById('day-t0').value, t1: document.getElementById('day-t1').value,
    km: targetKm, pace: dayPace, diff: [...dayDiff],
    lunch: withLunch, lunchT: document.getElementById('day-lunch-t').value, lunchMin, lunchAt, bus: dayBus, drag: dayDrag,
  });

  const pace = DAY_PACES[dayPace];
  dayGraph = GRAPH;
  prepareDayMoves(pace);
  const home = costsToEnd(end.id, pace);
  if (home.dist[start.id] == null) {
    return fail(dayBus
      ? (avoidedLifts.size || avoidedPistes.size
        ? `The end station cannot be reached without the lifts and pistes you avoid. Remove one from the list.`
        : 'The end station cannot be reached from the start.')
      : 'The end station cannot be reached without the ski bus. Switch the ski bus on in ⚙ Preferences.');
  }
  if (t0 + home.dist[start.id] > t1) return fail(`Getting back alone takes about ${home.dist[start.id]} min, which does not fit before ${formatClock(t1)}.`);

  // Operating hours: today's from the lift status feed, else OSM's.
  const liftWindows = {};
  (currentArea.liften || []).forEach(l => {
    const live = liftStatus(l.liftNr);
    const w = liftWindow(live?.open && live.hours ? live.hours : l.openingstijden);
    if (w) liftWindows[l.liftNr] = w;
  });

  dayCtx = { startId: start.id, endId: end.id, startName: start.name, endName: end.name, t0, t1, targetKm, pace, home, liftWindows, lunchT, lunchMin, withLunch };
  const random = seededRandom(hashString(JSON.stringify([
    start.id, end.id, t0, t1, targetKm, dayPace, [...dayDiff].sort(), withLunch, lunchT, lunchMin, lunchAt,
    ...(dayBus ? [] : ['no-bus']),
    ...(dayDrag ? [] : ['no-drag']),
    ...dayStops.map(s => s.id),
    ...[...avoidedLifts].sort(),
    ...[...avoidedPistes].sort().map(nr => `piste:${nr}`),
  ])));

  if (dayStops.some(s => s.kind !== 'lunch')) {
    const planned = planWithStops(dayCtx, random, dayStops, lunchAt);
    if (planned.error) return fail(planned.error);
    dayOptions = planned.options;
  } else if (withLunch) {
    const restaurants = lunchAt ? mountainRestaurants().filter(r => r.id === lunchAt) : mountainRestaurants();
    const stops = lunchStops(restaurants);
    const days = pickLunchStops(stops, dayCtx, random).flatMap(stop => daysVia(stop, dayCtx, random));
    if (!days.length) {
      if (lunchAt && !stops.some(stop => costsToEnd(stop.node, pace).dist[start.id] != null && home.dist[stop.piste ? stop.piste.to : stop.node] != null)) {
        return fail('That restaurant cannot be reached from your start (and back) with these difficulties. Pick another one or "Best fit".');
      }
      return fail(lunchAt
        ? 'That restaurant does not fit in this day around that lunch time. Try another time, another restaurant or "Best fit".'
        : 'No restaurant fits this day. Try a different lunch time or more difficulties.');
    }
    // Another lunch spot on another route first; then other routes.
    dayOptions = distinctBest(days, DAY_MAX_OPTIONS, (a, b) => a.lunch.stop !== b.lunch.stop && a.lunch.restaurant.id !== b.lunch.restaurant.id && overlap(a, b) < DAY_OPTION_OVERLAP);
    if (dayOptions.length < DAY_MAX_OPTIONS) {
      distinctBest(days, DAY_MAX_OPTIONS, (a, b) => overlap(a, b) < DAY_OPTION_OVERLAP).forEach(d => {
        if (dayOptions.length < DAY_MAX_OPTIONS && !dayOptions.includes(d) && dayOptions.every(o => overlap(o, d) < DAY_OPTION_OVERLAP)) dayOptions.push(d);
      });
    }
  } else {
    const walks = [];
    for (let i = 0; i < DAY_RUNS; i++) {
      const walk = dayWalk(dayCtx, random);
      if (walk) walks.push({ ...walk, score: scoreDay(walk, dayCtx) });
    }
    if (!walks.some(w => w.km > 0)) return fail('No day plan found. Try a longer time window, another end station or more difficulties.');
    dayOptions = distinctBest(walks, DAY_MAX_OPTIONS, (a, b) => overlap(a, b) < DAY_OPTION_OVERLAP);
  }

  // Only routes that really differ: an option much like one before it goes.
  dayOptions = dayOptions.filter((d, i) => dayOptions.slice(0, i).every(o => overlap(o, d) < DAY_OPTION_OVERLAP));
  dayOptionsOpen = !options.silent; // a day being followed comes back folded
  renderDayOption(0);
  resultEl.classList.add('visible');
  if (!options.silent) resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Rendering ────────────────────────────────────────────────────────────────

// Mountain restaurants this day passes, with the time you are there.
function restaurantsAlong(walk) {
  const byStation = new Map();
  const byPiste   = new Map();
  mountainRestaurants().forEach(r => {
    const map = r.station ? byStation : byPiste;
    const key = r.station || r.piste;
    (map.get(key) || map.set(key, []).get(key)).push(r);
  });

  const passed = new Map();
  const note = (r, t) => { if (!passed.has(r.id)) passed.set(r.id, { restaurant: r, t }); };
  walk.steps.forEach(step => {
    if (!step.edge) return;
    (byStation.get(step.edge.from) || []).forEach(r => note(r, step.t));
    if (step.edge.type === 'piste') {
      const nrs = step.edge.trajecten ? step.edge.trajecten.map(t => t.pisteNr) : [step.edge.pisteNr];
      nrs.forEach(nr => (byPiste.get(nr) || []).forEach(r => note(r, step.t)));
    }
  });
  return [...passed.values()];
}

// Only what the steps cannot say: that the distance does not fit the time.
// Closed lifts, lift hours, lunch and the stops show at the steps themselves.
function dayNotes(walk, ctx) {
  const notes = [];
  const kmShort = ctx.targetKm - walk.km;
  if (kmShort > ctx.targetKm * 0.1) {
    notes.push(`⏱ About ${walk.km.toFixed(0)} km fits between ${formatClock(ctx.t0)} and ${formatClock(ctx.t1)} at this pace, not ${ctx.targetKm} — start earlier, stay later or pick a faster pace for more.`);
  } else if (walk.end > ctx.t1 + 10) {
    notes.push(`⏱ ${ctx.targetKm} km takes until about ${formatClock(walk.end)}, after ${formatClock(ctx.t1)} — ski fewer km, start earlier or pick a faster pace.`);
  }
  return notes;
}

function renderDayOption(index) {
  const walk = dayOptions[index];
  const ctx  = dayCtx;
  const pace = ctx.pace;
  dayShown = index;

  renderDayOptions();

  const lifts = walk.steps.filter(s => s.edge && s.edge.type !== 'piste' && s.edge.type !== 'transfer' && !isConnection(s.edge)).length;
  document.getElementById('dp-km').textContent     = `${walk.km.toFixed(1)} km`;
  document.getElementById('dp-pistes').textContent = `${walk.usage.size} pistes`;
  document.getElementById('dp-lifts').textContent  = `${lifts} lifts`;
  document.getElementById('dp-end').textContent    = `back ${formatClock(walk.end)}`;

  const notesEl = document.getElementById('day-notes');
  const notes = dayNotes(walk, ctx);
  notesEl.innerHTML = notes.map(n => `<div class="day-note">${n}</div>`).join('');
  notesEl.style.display = notes.length ? 'block' : 'none';

  const stepsEl = document.getElementById('day-steps');
  stepsEl.innerHTML = '';
  stepsEl.classList.remove('no-entry');
  const startStation = STATIONS[ctx.startId];
  addWaypoint(stepsEl, escapeHtml(ctx.startName || startStation.name), startStation.alt, ICONS.start, `Start · ${formatClock(ctx.t0)}`, 0);

  // Each tickable step records when it is planned to start (data-t), where
  // you stand when it is next (data-at, for "replan from here") and its km.
  let number = 0;
  walk.steps.forEach((step, stepIndex) => {
    if (step.stop) {
      // A stop you asked for: a waypoint, not a step to tick.
      addWaypoint(stepsEl, escapeHtml(step.stop.name), null, PLACE_ICONS[step.stop.kind] || ICONS.start,
        `Stop · ${formatClock(step.t)} · ${escapeHtml(step.stop.sub)}`, Math.min(number, 30) * 30);
      stepsEl.lastElementChild.classList.add('step-stop');
      stepsEl.lastElementChild.dataset.stopId = step.stop.id;
      return;
    }
    if (step.lunch) {
      const r = step.lunch;
      const where = step.onPiste ? `halfway down ${pisteLabel(r.piste)}` : restaurantWhere(r);
      addWaypoint(stepsEl, `Lunch · ${escapeHtml(r.naam)}`, null, ICONS.restaurant,
        `${formatClock(step.t)}–${formatClock(step.until)} · ${where}`, Math.min(number, 30) * 30);
      const el = stepsEl.lastElementChild;
      el.classList.add('step-lunch', 'checkable');
      el.dataset.t = step.t;
      el.dataset.lunch = String(step.until - step.t);
      el.dataset.at = walk.steps.slice(stepIndex + 1).find(s => s.edge)?.edge.from || ctx.endId;
      return;
    }
    const { edge, t } = step;
    if (edge.type === 'transfer') return;
    // A piste through several numbered parts: spread its time over the parts.
    const parts = splitTrajecten(edge);
    const partTotal = parts.reduce((sum, p) => sum + (p.tijd || 0), 0) || 1;
    let partT = t;
    parts.forEach((part, partIndex) => {
      const next = walk.steps.slice(stepIndex + 1).find(s => s.edge)?.edge;
      const div = stepElement(part, number, formatClock(partT), next);
      div.style.animationDelay = `${Math.min(number, 30) * 30}ms`;
      div.classList.add('checkable');
      div.dataset.t  = partT;
      div.dataset.km = part.type === 'piste' ? part.km || 0 : 0;
      // Halfway down a chain of pistes is not a station: replan from its end.
      div.dataset.at = STATIONS[part.from] ? part.from : (edge.chainEnd || edge.to);
      if (partIndex > 0) div.dataset.finish = dayCost(edge, pace) * parts.slice(partIndex).reduce((sum, p) => sum + (p.tijd || 0), 0) / partTotal;
      else if (!STATIONS[part.from]) div.dataset.finish = dayCost(part, pace); // a chain part after lunch
      stepsEl.appendChild(div);
      number++;
      partT += dayCost(edge, pace) * (part.tijd || 0) / partTotal;
    });
  });

  const endStation = STATIONS[ctx.endId];
  addWaypoint(stepsEl, escapeHtml(ctx.endName || endStation.name), endStation.alt, ICONS.finish, `Back · ${formatClock(walk.end)}`, Math.min(number, 30) * 30);

  const signature = [ctx.startId, ctx.t0, ...walk.steps.map(s => s.stop ? `S:${s.stop.id}` : s.lunch ? `L:${s.lunch.id}` : s.edge.liftNr || s.edge.pisteNr || s.edge.type), ctx.endId].join('>');
  dayTracker = makeCheckable(stepsEl, 'day', signature, dayStatus, { option: index });
  if (routeViews.day === 'map') drawPlannerMap('day');
}

// The options side by side, with what sets them apart; Fold puts them away
// in one line (the chosen one) that opens them again.
let dayOptionsOpen = true;
function renderDayOptions() {
  const optionsEl = document.getElementById('day-options');
  optionsEl.innerHTML = '';
  optionsEl.classList.toggle('is-folded', !dayOptionsOpen);
  if (dayOptions.length < 2) {
    if (dayOptions.length) optionsEl.innerHTML = '<div class="day-opt-caption">One route: no other route with these settings is different enough.</div>';
    return;
  }
  // What sets the options apart: their route, and with lunch at the best fit
  // also where you eat.
  const lunchSpots = new Set(dayOptions.map(o => o.lunch?.restaurant.id).filter(Boolean));
  const ownLunch = lunchSpots.size === dayOptions.length && !document.getElementById('day-lunch-at').value;
  const describe = (option, i) => {
    const lunch = option.lunch && (lunchSpots.size > 1 || !dayOptionsOpen) ? `<span class="day-opt-lunch">🍽 ${escapeHtml(option.lunch.restaurant.naam)}</span>` : '';
    return `<strong>Option ${i + 1}</strong>${lunch}<span>${option.km.toFixed(1)} km · back ${formatClock(option.end)}</span>`;
  };
  if (!dayOptionsOpen) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-opt on day-opt-folded';
    btn.innerHTML = `${describe(dayOptions[dayShown], dayShown)}<span class="day-opt-more">${dayOptions.length} options ▾</span>`;
    btn.addEventListener('click', () => { dayOptionsOpen = true; renderDayOptions(); });
    optionsEl.appendChild(btn);
    return;
  }
  optionsEl.insertAdjacentHTML('beforeend', `<div class="day-opt-caption">${dayOptions.length} different routes${ownLunch
    ? ', each with its own lunch spot (lunch where: best fit on my route)'
    : lunchSpots.size > 1 ? ', lunch spot per option'
    : lunchSpots.size ? `, lunch at ${escapeHtml(dayOptions.find(o => o.lunch).lunch.restaurant.naam)} in each` : ''}</div>`);
  dayOptions.forEach((option, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-opt' + (i === dayShown ? ' on' : '');
    btn.innerHTML = describe(option, i);
    btn.addEventListener('click', () => renderDayOption(i));
    optionsEl.appendChild(btn);
  });
  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'link-btn day-opt-fold';
  fold.textContent = 'Fold ▴';
  fold.addEventListener('click', () => { dayOptionsOpen = false; renderDayOptions(); });
  optionsEl.appendChild(fold);
}

// The shown option for the map: lunch included, transfers too.
function dayMapRoute() {
  const walk = dayOptions?.[dayShown];
  if (!walk || !dayCtx) return null;
  return {
    path: walk.steps.map(s => s.stop ? { stop: s.stop } : s.lunch ? { lunch: s.lunch } : s.edge),
    done: dayDone,
    fromName: dayCtx.startName || STATIONS[dayCtx.startId]?.name,
    toName: dayCtx.endName || STATIONS[dayCtx.endId]?.name,
  };
}

// ── Following the plan ───────────────────────────────────────────────────────

const DAY_ON_TIME_MIN = 5;
const DAY_FOLLOW_MIN  = 90; // nothing ticked this long after the first step: not being followed

// Ahead or behind: the clock now against when the next step was planned.
// Late warning: projected return later than "back by" by more than this.
const DAY_LATE_WARN_MIN = 10;
let dayLateBuzzed = null; // the plan we already vibrated for

// Ahead or behind: the clock now against when the next step was planned.
// When the delay carried to the end of the day means getting back clearly
// after "back by", warn — in the progress area and in the sticky bar — and
// offer to replan the rest of the day.
function dayStatus(done, items) {
  dayDone = done;
  if (routeViews.day === 'map') updateRouteMapProgress(done, 'day');
  const total = items.length;
  const walk  = dayOptions[dayShown];
  const now   = nowMinutes();
  const inDay = now >= dayCtx.t0 - 60 && now <= dayCtx.t1 + 120;
  // Nothing ticked and long past the first step: this plan is not being
  // followed right now (looked at later, or planned for another day).
  const started = done > 0 || (now >= dayCtx.t0 && now <= +items[0].dataset.t + DAY_FOLLOW_MIN);
  const delta = done < total && inDay && started ? Math.round(now - +items[done].dataset.t) : null;
  const backAt = delta != null ? walk.end + Math.max(0, delta) : null;
  const late = backAt != null ? Math.round(backAt - dayCtx.t1) : 0;
  const isLate = late > DAY_LATE_WARN_MIN;

  // Always: steps done, and the km and time still to go (as planned, plus
  // any delay); then ahead or behind when the plan is being followed.
  let text;
  if (done === total) {
    text = '🏁 All done — what a day!';
  } else {
    const km = items.slice(done).reduce((sum, item) => sum + (+item.dataset.km || 0), 0);
    const minLeft = Math.max(0, Math.round(walk.end - +items[done].dataset.t + Math.max(0, delta || 0)));
    text = `${done} of ${total} steps · ${km.toFixed(1)} km · ${formatDuration(minLeft)} to go`;
    if (delta != null) {
      if (Math.abs(delta) <= DAY_ON_TIME_MIN) text += ' · ✅ on schedule';
      else if (delta > 0)                     text += ` · ⏱ ${delta} min behind`;
      else                                    text += ` · ⚡ ${-delta} min ahead`;
    }
  }

  // Replanning is in the step menu (hold a step or swipe it left); only
  // running late brings a button of its own (the red bar).
  renderProgress('dp-progress', done, total, text);

  const lateBtn = document.getElementById('dp-late');
  if (isLate) {
    document.getElementById('dp-progress').insertAdjacentHTML('beforeend', `
      <div class="late-warning">
        <div>⚠ At this pace you'll be back around <strong>${formatClock(backAt)}</strong>, ${late} min after ${formatClock(dayCtx.t1)}.${done === 0 ? ' Already skiing? Tick the steps you have done.' : ''}</div>
        <button class="replan-btn replan-urgent" type="button" onclick="replanFromHere()">↻ Replan from here</button>
      </div>`);
    lateBtn.textContent = `⚠ Back ${formatClock(backAt)} · Replan`;
    lateBtn.style.display = 'inline-flex';
    if (dayLateBuzzed !== walk) {
      dayLateBuzzed = walk;
      try { navigator.vibrate?.(200); } catch {}
    }
  } else {
    lateBtn.style.display = 'none';
  }
}

// Plan the rest of the day from where you are now: the next step's start,
// from the current time (rounded up to 5 min), with the km still to go.
// Lunch stays in if it is still ahead; next up is lunch itself → eat first.
function replanFromHere() {
  if (!dayTracker) return;
  const { items, done } = dayTracker;
  const next = items[done];
  if (!next) return;
  const walk = dayOptions[dayShown];

  const kmDone = items.slice(0, done).reduce((sum, item) => sum + (+item.dataset.km || 0), 0);
  let startT = nowMinutes() + (+next.dataset.finish || 0);
  const lunchAhead = items.slice(done).some(item => item.dataset.lunch);
  const lunchNext  = !!next.dataset.lunch;
  if (lunchNext) startT += +next.dataset.lunch;
  startT = Math.ceil(startT / 5) * 5;

  // Stops still ahead stay; the ones passed are done.
  const ahead = [...document.querySelectorAll('#day-steps .step-stop')]
    .filter(row => next.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)
    .map(row => row.dataset.stopId);
  dayStops = dayStops.filter(s => ahead.includes(s.id));
  renderDayStops();
  restoreStation('dstart', next.dataset.at);
  if (!selected.dend && dayCtx.endId !== next.dataset.at) restoreStation('dend', dayCtx.endId);
  document.getElementById('day-t0').value = formatClock(startT);
  document.getElementById('day-km').value = Math.max(1, Math.round(dayCtx.targetKm - kmDone));
  renderTimeSummary();
  const lunchBox = document.getElementById('day-lunch');
  if (lunchNext || !lunchAhead) {
    lunchBox.checked = false;
  } else if (walk.lunch) {
    document.getElementById('day-lunch-at').value = walk.lunch.restaurant.id;
  }
  toggleLunch();
  planDay();
  // Not enough time left for a plan: show why, at the form.
  if (document.getElementById('day-err').classList.contains('visible')) backToPlanner('day-card');
}

// Keep "ahead/behind" current while the plan is on screen.
setInterval(() => {
  if (dayTracker && document.getElementById('day-result').classList.contains('visible')) dayTracker.refresh();
}, 60000);
