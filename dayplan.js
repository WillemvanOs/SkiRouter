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
  relaxed: { label: 'Relaxed', piste: 1.7, wait: 7 },
  normal:  { label: 'Normal',  piste: 1.3, wait: 5 },
  sporty:  { label: 'Sporty',  piste: 1.0, wait: 3 },
};
const DAY_TRANSFER_MIN  = 2;   // walking between two stations
const DAY_PRACTICE_MIN  = 1;   // magic carpets: no queue to speak of
const DAY_RUNS          = 400; // randomised walks per plan
const DAY_LATE_SLACK    = 10;  // minutes past "back by" a walk may plan for
const DAY_MAX_OPTIONS   = 3;
const DAY_LUNCH_RUNS    = 30;  // morning walks per restaurant
const DAY_LUNCH_PM_RUNS = 15;  // afternoon walks per kept morning
const DAY_LUNCH_STOPS   = 16;  // lunch stops tried at most when no restaurant is chosen
const DAY_LUNCH_FIT_MIN = 15;  // arriving this close to lunchtime is "perfect"
const DAY_ALONG_WINDOW  = 60;  // "also on your route" around lunchtime, ± minutes
const DAY_MOUNTAIN_ELE  = 1100; // a restaurant this high is on the mountain
const DAY_DIFF_LEVELS   = ['blauw', 'rood', 'zwart', 'skiroute'];

let dayDiff    = new Set(DAY_DIFF_LEVELS);
let dayPace    = 'normal';
let dayBus     = true;   // may the plan use the ski bus
let dayOptions = [];
let dayCtx     = null;
let dayGraph   = {}; // the routing graph (GRAPH, ride-down edges included)
let dayMoves   = {}; // per node, the edges this plan may take, with their cost (see prepareDayMoves)
let dayTracker = null; // ticking off the shown option's steps
let dayShown   = 0;    // index of the option on screen

// ── Tabs ─────────────────────────────────────────────────────────────────────

function showTab(tab) {
  document.getElementById('tab-quick').style.display = tab === 'quick' ? 'block' : 'none';
  document.getElementById('tab-day').style.display   = tab === 'day'   ? 'block' : 'none';
  document.getElementById('tabbtn-quick').classList.toggle('on', tab === 'quick');
  document.getElementById('tabbtn-day').classList.toggle('on', tab === 'day');
  try { localStorage.setItem(DAY_TAB_KEY, tab); } catch {}
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
  setDayPace(DAY_PACES[saved.pace] ? saved.pace : 'normal');
  dayDiff = new Set(Array.isArray(saved.diff) ? saved.diff.filter(d => DAY_DIFF_LEVELS.includes(d)) : DAY_DIFF_LEVELS);
  renderDayDiff();
  restoreStation('dstart', saved.start);
  // The end field starts folded away ('Start & end'), unless a day that ends
  // elsewhere is being followed right now: then its end station comes back.
  if (dayInProgress()) restoreStation('dend', saved.end);

  document.getElementById('day-bus').checked         = saved.bus !== false;
  // Areas without known mountain restaurants (most built from OpenSkiData
  // so far) plan without lunch: the lunch box is not shown at all.
  const hasFood = mountainRestaurants().length > 0;
  document.getElementById('lunch-setting').style.display = hasFood ? '' : 'none';
  document.getElementById('day-lunch').checked       = hasFood && saved.lunch !== false;
  document.getElementById('day-lunch-t').value       = saved.lunchT || '13:00';
  document.getElementById('day-lunch-min').value     = saved.lunchMin || 60;
  renderLunchChoices(saved.lunchAt);
  toggleLunch();
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

function toggleLunch() {
  document.getElementById('lunch-fields').style.display = document.getElementById('day-lunch').checked ? 'grid' : 'none';
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

function setDayPace(pace) {
  dayPace = pace;
  Object.keys(DAY_PACES).forEach(p => document.getElementById('pace-' + p).classList.toggle('on', p === pace));
  document.getElementById('pace-summary').textContent = DAY_PACES[pace].label;
}

function setDayDiff(value) {
  if (value === 'all') {
    dayDiff = dayDiff.size === DAY_DIFF_LEVELS.length ? new Set() : new Set(DAY_DIFF_LEVELS);
  } else {
    dayDiff.has(value) ? dayDiff.delete(value) : dayDiff.add(value);
  }
  renderDayDiff();
}

function renderDayDiff() {
  DAY_DIFF_LEVELS.forEach(d => document.getElementById('dd-' + d).classList.toggle('on', dayDiff.has(d)));
  document.getElementById('dd-all').classList.toggle('on', dayDiff.size === DAY_DIFF_LEVELS.length);
  document.getElementById('dd-summary').textContent = diffSummary(dayDiff);
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

function dayAllowed(edge) {
  if (edge.type === 'bus') return dayBus;
  if (isAvoided(edge)) return false;
  return edge.type !== 'piste' || pisteKleuren(edge).every(k => dayDiff.has(k));
}

function pisteKey(edge) {
  return `${edge.pisteNr}|${edge.name}`;
}

// How attractive a piste is given how often it was skied today already.
function novelty(timesSkied) {
  return [1, 0.35, 0.12][timesSkied] ?? 0.04;
}

// Quickest time (and the next edge to take) from every node to `endId`.
function costsToEnd(endId, pace) {
  const reverse = {};
  Object.values(dayGraph).forEach(edges => edges.forEach(edge => {
    if (dayAllowed(edge)) (reverse[edge.to] = reverse[edge.to] || []).push(edge);
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
      const c = cost[id] + dayCost(edge, pace) + (edge.descent ? RIDE_DOWN_PENALTY : 0) + (isConnection(edge) ? CONNECTION_PENALTY : 0);
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
      key: edge.type === 'piste' ? pisteKey(edge) : null,
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
  if (move.piste) return { gain: move.km * novelty(usage.get(move.key) || 0), cost };
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
  let node = startId, t = t0, km = 0, prevEdge = null;

  function take(edge) {
    steps.push({ edge, t });
    t += dayCost(edge, pace);
    node = edge.to;
    prevEdge = edge;
    if (edge.type === 'piste') {
      km += edge.km || 0;
      usage.set(pisteKey(edge), (usage.get(pisteKey(edge)) || 0) + 1);
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
      if (edge.descent) weight *= 0.3;
      if (isConnection(edge)) weight *= 0.3;
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
  const practiceLifts = walk.steps.filter(s => s.edge && s.edge.echteLift === false && s.edge.type !== 'piste' && s.edge.type !== 'transfer').length;
  return 0.8 * walk.usage.size - 3 * repeats - 2 * practiceLifts;
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
      usage.set(pisteKey(part), (usage.get(pisteKey(part)) || 0) + 1);
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
  dayBus = busAllowed('day-bus');

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
    t0: document.getElementById('day-t0').value, t1: document.getElementById('day-t1').value,
    km: targetKm, pace: dayPace, diff: [...dayDiff],
    lunch: withLunch, lunchT: document.getElementById('day-lunch-t').value, lunchMin, lunchAt, bus: dayBus,
  });

  const pace = DAY_PACES[dayPace];
  dayGraph = GRAPH;
  prepareDayMoves(pace);
  const home = costsToEnd(end.id, pace);
  if (home.dist[start.id] == null) {
    return fail(dayBus
      ? (avoidedLifts.size
        ? `The end station cannot be reached without the lifts you avoid (${[...avoidedLifts].join(', ')}). Remove one from the list, or also select red or black.`
        : 'The end station cannot be reached from the start with these difficulties. Try also selecting red or black.')
      : 'The end station cannot be reached without the ski bus. Switch the ski bus on, or also select red or black.');
  }
  if (t0 + home.dist[start.id] > t1) return fail(`Getting back alone takes about ${home.dist[start.id]} min, which does not fit before ${formatClock(t1)}.`);

  // Operating hours: today's from the lift status feed, else OSM's.
  const liftWindows = {};
  (currentArea.liften || []).forEach(l => {
    const live = liftStatus(l.liftNr);
    const w = liftWindow(live?.open && live.hours ? live.hours : l.openingstijden);
    if (w) liftWindows[l.liftNr] = w;
  });

  dayCtx = { startId: start.id, endId: end.id, t0, t1, targetKm, pace, home, liftWindows, lunchT, lunchMin, withLunch };
  const random = seededRandom(hashString(JSON.stringify([
    start.id, end.id, t0, t1, targetKm, dayPace, [...dayDiff].sort(), withLunch, lunchT, lunchMin, lunchAt,
    ...(dayBus ? [] : ['no-bus']),
    ...[...avoidedLifts].sort(),
  ])));

  if (withLunch) {
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
    // Different lunch stops first, so the options are real alternatives.
    dayOptions = distinctBest(days, DAY_MAX_OPTIONS, (a, b) => a.lunch.stop !== b.lunch.stop && a.lunch.restaurant.id !== b.lunch.restaurant.id);
    if (dayOptions.length < DAY_MAX_OPTIONS) {
      distinctBest(days, DAY_MAX_OPTIONS, (a, b) => overlap(a, b) < 0.6).forEach(d => {
        if (dayOptions.length < DAY_MAX_OPTIONS && !dayOptions.includes(d) && dayOptions.every(o => overlap(o, d) < 0.6)) dayOptions.push(d);
      });
    }
  } else {
    const walks = [];
    for (let i = 0; i < DAY_RUNS; i++) {
      const walk = dayWalk(dayCtx, random);
      if (walk) walks.push({ ...walk, score: scoreDay(walk, dayCtx) });
    }
    if (!walks.some(w => w.km > 0)) return fail('No day plan found. Try a longer time window, another end station or more difficulties.');
    dayOptions = distinctBest(walks, DAY_MAX_OPTIONS, (a, b) => overlap(a, b) < 0.6);
  }

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

function dayNotes(walk, ctx) {
  const notes = [];
  const closed = closedLiftsOn(walk.steps.map(s => s.edge));
  if (closed.length) {
    notes.push(`⚠ ${closedLabel()}: ${closed.map(e => `${e.liftNr} ${e.name}`).join(', ')}${liftStatusStale() ? '' : ` (lift status ${liftStatusAge()})`}. ${avoidClosedButton(closed)}`);
  }
  const kmShort = ctx.targetKm - walk.km;
  if (kmShort > ctx.targetKm * 0.1) {
    notes.push(`⏱ About ${walk.km.toFixed(0)} km fits between ${formatClock(ctx.t0)} and ${formatClock(ctx.t1)} at this pace — start earlier, stay later or pick a faster pace for more.`);
  }

  if (walk.lunch) {
    const { restaurant, arrive } = walk.lunch;
    const off = Math.round(arrive - ctx.lunchT);
    if (Math.abs(off) <= DAY_LUNCH_FIT_MIN) {
      notes.push(`🍽 <strong>${restaurant.naam}</strong> is right on this route: you get there around ${formatClock(arrive)}.`);
    } else if (off < 0 && walk.km >= ctx.targetKm * 0.97) {
      notes.push(`🍽 Your ${ctx.targetKm} km fit easily: you reach <strong>${restaurant.naam}</strong> around ${formatClock(arrive)}. Take it easy, start later or ski a few more km.`);
    } else {
      notes.push(`🍽 Lunch at <strong>${restaurant.naam}</strong> around ${formatClock(arrive)}, ${Math.abs(off)} min ${off < 0 ? 'early' : 'late'} — the best fit with this route.`);
    }
    if (restaurant.openingstijden) notes.push(`🕐 ${restaurant.naam}: ${restaurant.openingstijden}`);
  }

  // Other places to eat or warm up along the way, around lunchtime.
  if (ctx.lunchT != null) {
    const others = restaurantsAlong(walk)
      .filter(p => p.restaurant.id !== walk.lunch?.restaurant.id)
      .filter(p => Math.abs(p.t - ctx.lunchT) <= DAY_ALONG_WINDOW && openAt(p.restaurant.openingstijden, p.t))
      .sort((a, b) => Math.abs(a.t - ctx.lunchT) - Math.abs(b.t - ctx.lunchT))
      .slice(0, 3);
    if (others.length) {
      const list = others.map(p => `${p.restaurant.naam} (${formatClock(p.t)})`).join(', ');
      notes.push(walk.lunch ? `🏠 Also on your route around lunchtime: ${list}.` : `🍽 On your route around lunchtime: ${list}.`);
    }
  }

  if (walk.end > ctx.t1) {
    notes.push(`⚠ Back around ${formatClock(walk.end)}, a little after ${formatClock(ctx.t1)}.`);
  } else if (ctx.t1 - walk.end >= 45) {
    notes.push(`☕ Done around ${formatClock(walk.end)}: ${Math.round(ctx.t1 - walk.end)} min to spare for breaks or extra runs.`);
  }
  const names = new Map(walk.steps.filter(s => s.edge?.type === 'piste').map(s => [pisteKey(s.edge), s.edge]));
  walk.usage.forEach((count, key) => {
    const piste = names.get(key);
    if (piste && count >= 3) notes.push(`🔁 ${piste.name} (${piste.pisteNr}) is on the plan ${count}× — few alternatives with these difficulties.`);
  });
  walk.steps.forEach(({ edge, t }) => {
    const w = edge?.liftNr && edge.type !== 'piste' ? ctx.liftWindows[edge.liftNr] : null;
    if (w && t > w[1]) notes.push(`⚠ ${edge.liftNr} ${edge.name} closes at ${formatClock(w[1])}; this plan reaches it at ${formatClock(t)}.`);
  });
  return notes;
}

function renderDayOption(index) {
  const walk = dayOptions[index];
  const ctx  = dayCtx;
  const pace = ctx.pace;
  dayShown = index;

  const optionsEl = document.getElementById('day-options');
  optionsEl.innerHTML = '';
  if (dayOptions.length > 1) {
    dayOptions.forEach((option, i) => {
      const btn = document.createElement('button');
      btn.className = 'day-opt' + (i === index ? ' on' : '');
      const lunch = option.lunch ? `<span class="day-opt-lunch">🍽 ${option.lunch.restaurant.naam}</span>` : '';
      btn.innerHTML = `<strong>Option ${i + 1}</strong>${lunch}<span>${option.km.toFixed(1)} km · back ${formatClock(option.end)}</span>`;
      btn.addEventListener('click', () => renderDayOption(i));
      optionsEl.appendChild(btn);
    });
  }

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
  const startStation = STATIONS[ctx.startId];
  addWaypoint(stepsEl, startStation.name, startStation.alt, '📍', `Start · ${formatClock(ctx.t0)}`, 0);

  // Each tickable step records when it is planned to start (data-t), where
  // you stand when it is next (data-at, for "replan from here") and its km.
  let number = 0;
  walk.steps.forEach((step, stepIndex) => {
    if (step.lunch) {
      const r = step.lunch;
      const where = step.onPiste ? `halfway down ${pisteLabel(r.piste)}` : restaurantWhere(r);
      addWaypoint(stepsEl, `Lunch · ${r.naam}`, null, '🍽',
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
  addWaypoint(stepsEl, endStation.name, endStation.alt, '🏁', `Back · ${formatClock(walk.end)}`, Math.min(number, 30) * 30);

  document.getElementById('day-tip').innerHTML =
    `💡 <strong>Guideline times:</strong> ${pace.label.toLowerCase()} pace — about ${pace.wait} min queueing per lift, ` +
    `piste times ×${pace.piste}. Short breaks are not included; check the last lift times locally. ` +
    `Restaurants come from OpenStreetMap and may be missing or closed.` +
    (LIFT_STATUS ? ` Lift hours ${LIFT_STATUS.live ? 'live ' : ''}from ${LIFT_STATUS.bron}, ${liftStatusAge()}.` : '');

  const signature = [ctx.startId, ctx.t0, ...walk.steps.map(s => s.lunch ? `L:${s.lunch.id}` : s.edge.liftNr || s.edge.pisteNr || s.edge.type), ctx.endId].join('>');
  dayTracker = makeCheckable(stepsEl, 'day', signature, dayStatus, { option: index });
}

// ── Following the plan ───────────────────────────────────────────────────────

const DAY_ON_TIME_MIN = 5;

// Ahead or behind: the clock now against when the next step was planned.
// Late warning: projected return later than "back by" by more than this.
const DAY_LATE_WARN_MIN = 10;
let dayLateBuzzed = null; // the plan we already vibrated for

// Ahead or behind: the clock now against when the next step was planned.
// When the delay carried to the end of the day means getting back clearly
// after "back by", warn — in the progress area and in the sticky bar — and
// offer to replan the rest of the day.
function dayStatus(done, items) {
  const total = items.length;
  const walk  = dayOptions[dayShown];
  const now   = nowMinutes();
  const inDay = now >= dayCtx.t0 - 60 && now <= dayCtx.t1 + 120;
  const started = done > 0 || now >= dayCtx.t0;
  const delta = done < total && inDay && started ? Math.round(now - +items[done].dataset.t) : null;
  const backAt = delta != null ? walk.end + Math.max(0, delta) : null;
  const late = backAt != null ? Math.round(backAt - dayCtx.t1) : 0;
  const isLate = late > DAY_LATE_WARN_MIN;

  let text;
  if (done === total) {
    text = '🏁 All done — what a day!';
  } else if (delta == null) {
    text = done === 0 ? 'Tap a step once you have done it to see if you are on time.' : `${done} of ${total} done`;
  } else {
    const prefix = done ? `${done} of ${total} done · ` : '';
    if (Math.abs(delta) <= DAY_ON_TIME_MIN) text = `${prefix}✅ on schedule`;
    else if (delta > 0)                     text = `${prefix}⏱ ${delta} min behind`;
    else                                    text = `${prefix}⚡ ${-delta} min ahead`;
  }

  const replan = !isLate && done > 0 && done < total
    ? '<button class="replan-btn" type="button" onclick="replanFromHere()">↻ Replan from here</button>'
    : '';
  renderProgress('dp-progress', done, total, text, replan);

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

  restoreStation('dstart', next.dataset.at);
  if (!selected.dend && dayCtx.endId !== next.dataset.at) restoreStation('dend', dayCtx.endId);
  document.getElementById('day-t0').value = formatClock(startT);
  document.getElementById('day-km').value = Math.max(1, Math.round(dayCtx.targetKm - kmDone));
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
