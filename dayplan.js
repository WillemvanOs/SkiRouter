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
// Lifts you can also ride down (to get home from a ridge or another valley).
const DAY_DESCENT_TYPES = new Set(['gondola', 'mixed_lift', 'cable_car', 'funicular']);
const DAY_TRANSFER_MIN  = 2;   // walking between two stations
const DAY_PRACTICE_MIN  = 1;   // magic carpets: no queue to speak of
const DAY_RUNS          = 400; // randomised walks per plan
const DAY_LATE_SLACK    = 10;  // minutes past "back by" a walk may plan for
const DAY_MAX_OPTIONS   = 3;
const DAY_DIFF_LEVELS   = ['blauw', 'rood', 'zwart', 'skiroute'];

let dayDiff    = new Set(DAY_DIFF_LEVELS);
let dayPace    = 'normal';
let dayOptions = [];
let dayCtx     = null;
let dayGraph   = {}; // GRAPH plus ride-down edges, built per plan

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
  restoreDayStation('dstart', saved.start);
  restoreDayStation('dend', saved.end);

  let tab = 'quick';
  try { tab = localStorage.getItem(DAY_TAB_KEY) || 'quick'; } catch {}
  showTab(tab === 'day' ? 'day' : 'quick');
}

function restoreDayStation(side, stationId) {
  if (!stationId || !STATIONS[stationId]) return;
  const lift = LIFTS.find(l => l.dal === stationId || l.berg === stationId);
  if (!lift) return;
  const previous = activeSide;
  activeSide = side;
  pickStation(stationId, lift, lift.dal === stationId ? 'dal' : 'berg');
  activeSide = previous;
}

function setDayPace(pace) {
  dayPace = pace;
  Object.keys(DAY_PACES).forEach(p => document.getElementById('pace-' + p).classList.toggle('on', p === pace));
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

// A lift's daily operating window from an OSM opening_hours value, when it
// has a plain "HH:MM-HH:MM" range (the last one wins). Null when unknown.
function liftWindow(openingstijden) {
  const ranges = [...(openingstijden || '').matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
  if (!ranges.length) return null;
  const r = ranges[ranges.length - 1];
  return [+r[1] * 60 + +r[2], +r[3] * 60 + +r[4]];
}

// ── Cost model ───────────────────────────────────────────────────────────────

function dayCost(edge, pace) {
  if (edge.type === 'piste')    return Math.max(1, Math.round((edge.tijd || 0) * pace.piste));
  if (edge.type === 'transfer') return DAY_TRANSFER_MIN;
  return (edge.tijd || 0) + (edge.echteLift === false ? DAY_PRACTICE_MIN : pace.wait);
}

function dayAllowed(edge) {
  return edge.type !== 'piste' || pisteKleuren(edge).every(k => dayDiff.has(k));
}

function pisteKey(edge) {
  return `${edge.pisteNr}|${edge.name}`;
}

// How attractive a piste is given how often it was skied today already.
function novelty(timesSkied) {
  return [1, 0.35, 0.12][timesSkied] ?? 0.04;
}

// The routing graph plus a ride-down edge for every gondola/cable car, so a
// day can end in a valley that has no piste down to it.
function buildDayGraph() {
  const graph = {};
  Object.entries(GRAPH).forEach(([from, edges]) => { graph[from] = [...edges]; });
  Object.values(GRAPH).flat().forEach(edge => {
    if (!edge.liftNr || edge.descent || !DAY_DESCENT_TYPES.has(edge.type)) return;
    (graph[edge.to] = graph[edge.to] || []).push({
      ...edge, from: edge.to, to: edge.from, descent: true, name: `${edge.name} (ride down)`,
    });
  });
  return graph;
}

// Quickest time (and the next edge to take) from every node to `endId`.
function costsToEnd(endId, pace) {
  const reverse = {};
  Object.values(dayGraph).forEach(edges => edges.forEach(edge => {
    if (dayAllowed(edge)) (reverse[edge.to] = reverse[edge.to] || []).push(edge);
  }));

  const dist = { [endId]: 0 };
  const next = {};
  const done = new Set();
  const queue = [{ id: endId, cost: 0 }];
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const { id } = queue.shift();
    if (done.has(id)) continue;
    done.add(id);
    (reverse[id] || []).forEach(edge => {
      const cost = dist[id] + dayCost(edge, pace);
      if (cost < (dist[edge.from] ?? Infinity)) {
        dist[edge.from] = cost;
        next[edge.from] = edge;
        queue.push({ id: edge.from, cost });
      }
    });
  }

  // Piste km along the quickest way home, so a walk can stop in time.
  const homeKm = {};
  function kmHome(node) {
    if (homeKm[node] != null) return homeKm[node];
    homeKm[node] = 0; // guard against cycles while computing
    const edge = next[node];
    homeKm[node] = edge ? (edge.type === 'piste' ? edge.km || 0 : 0) + kmHome(edge.to) : 0;
    return homeKm[node];
  }
  Object.keys(dist).forEach(kmHome);

  return { dist, next, homeKm };
}

// Best km-per-minute reachable by taking `edge` and up to `depth` more
// non-piste moves to reach a piste. Returns the gain and the time it takes.
function lookahead(edge, usage, depth, pace) {
  const cost = dayCost(edge, pace);
  if (edge.type === 'piste') return { gain: (edge.km || 0) * novelty(usage.get(pisteKey(edge)) || 0), cost };
  if (depth === 0) return { gain: 0, cost };

  let best = { gain: 0, cost };
  let bestRate = 0;
  (dayGraph[edge.to] || []).forEach(nextEdge => {
    if (!dayAllowed(nextEdge) || (edge.type === 'transfer' && nextEdge.type === 'transfer')) return;
    const ahead = lookahead(nextEdge, usage, depth - 1, pace);
    const rate = ahead.gain / (cost + ahead.cost);
    if (rate > bestRate) { bestRate = rate; best = { gain: ahead.gain, cost: cost + ahead.cost }; }
  });
  return best;
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

function dayWalk(ctx, random) {
  const { startId, endId, t0, t1, targetKm, pace, home } = ctx;
  const steps = [];
  const usage = new Map();
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
    if (km + (home.homeKm[node] || 0) >= targetKm * 0.97) break;

    const candidates = [];
    (dayGraph[node] || []).forEach(edge => {
      if (!dayAllowed(edge)) return;
      if (edge.type === 'transfer' && prevEdge?.type === 'transfer') return;
      const cost = dayCost(edge, pace);
      const rest = home.dist[edge.to];
      if (rest == null || t + cost + rest > t1 + DAY_LATE_SLACK) return;
      if (!liftOpenAt(edge, t, ctx)) return;
      const ahead = lookahead(edge, usage, 3, pace);
      let weight = (ahead.gain + 0.01) / ahead.cost;
      if (edge.echteLift === false) weight *= 0.2;
      if (edge.descent) weight *= 0.3;
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

function scoreDay(walk, ctx) {
  const kmError = Math.abs(walk.km - ctx.targetKm) / ctx.targetKm;
  let repeats = 0;
  walk.usage.forEach(count => { repeats += Math.max(0, count - 2); });
  const practiceLifts = walk.steps.filter(s => s.edge.echteLift === false && s.edge.type !== 'piste' && s.edge.type !== 'transfer').length;
  return -120 * kmError
    - 4 * Math.max(0, walk.end - ctx.t1)
    + 0.8 * walk.usage.size
    - 3 * repeats
    - 2 * practiceLifts;
}

function overlap(a, b) {
  const keysA = new Set(a.usage.keys());
  const keysB = new Set(b.usage.keys());
  let shared = 0;
  keysA.forEach(k => { if (keysB.has(k)) shared++; });
  return shared / Math.max(1, Math.min(keysA.size, keysB.size));
}

// ── Planning ─────────────────────────────────────────────────────────────────

function planDay() {
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

  if (!start)                       return fail('Choose where your day starts.');
  if (t0 == null || t1 == null)     return fail('Enter a start time and a time to be back.');
  if (t1 - t0 < 30)                 return fail('"Back by" must be at least half an hour after the start.');
  if (!(targetKm > 0))              return fail('Enter how many kilometres you want to ski.');
  if (!dayDiff.size)                return fail('Select at least one piste difficulty.');

  saveDayInputs({
    start: start.id, end: selected.dend?.id || null,
    t0: document.getElementById('day-t0').value, t1: document.getElementById('day-t1').value,
    km: targetKm, pace: dayPace, diff: [...dayDiff],
  });

  const pace = DAY_PACES[dayPace];
  dayGraph = buildDayGraph();
  const home = costsToEnd(end.id, pace);
  if (home.dist[start.id] == null) return fail('The end station cannot be reached from the start with these difficulties. Try also selecting red or black.');
  if (t0 + home.dist[start.id] > t1) return fail(`Getting back alone takes about ${home.dist[start.id]} min, which does not fit before ${formatClock(t1)}.`);

  const liftWindows = {};
  (currentArea.liften || []).forEach(l => {
    const w = liftWindow(l.openingstijden);
    if (w) liftWindows[l.liftNr] = w;
  });

  dayCtx = { startId: start.id, endId: end.id, t0, t1, targetKm, pace, home, liftWindows };
  const random = seededRandom(hashString(JSON.stringify([start.id, end.id, t0, t1, targetKm, dayPace, [...dayDiff].sort()])));

  const walks = [];
  for (let i = 0; i < DAY_RUNS; i++) {
    const walk = dayWalk(dayCtx, random);
    if (walk) walks.push({ ...walk, score: scoreDay(walk, dayCtx) });
  }
  if (!walks.some(w => w.km > 0)) return fail('No day plan found. Try a longer time window, another end station or more difficulties.');

  walks.sort((a, b) => b.score - a.score);
  dayOptions = [];
  for (const walk of walks) {
    if (dayOptions.every(o => overlap(o, walk) < 0.6)) dayOptions.push(walk);
    if (dayOptions.length === DAY_MAX_OPTIONS) break;
  }

  renderDayOption(0);
  resultEl.classList.add('visible');
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Rendering ────────────────────────────────────────────────────────────────

function dayNotes(walk, ctx) {
  const notes = [];
  const kmShort = ctx.targetKm - walk.km;
  if (kmShort > ctx.targetKm * 0.1) {
    notes.push(`⏱ About ${walk.km.toFixed(0)} km fits between ${formatClock(ctx.t0)} and ${formatClock(ctx.t1)} at this pace — start earlier, stay later or pick a faster pace for more.`);
  }
  if (walk.end > ctx.t1) {
    notes.push(`⚠ Back around ${formatClock(walk.end)}, a little after ${formatClock(ctx.t1)}.`);
  } else if (ctx.t1 - walk.end >= 45) {
    notes.push(`☕ Done around ${formatClock(walk.end)}: ${Math.round(ctx.t1 - walk.end)} min to spare for breaks or extra runs.`);
  }
  const names = new Map(walk.steps.filter(s => s.edge.type === 'piste').map(s => [pisteKey(s.edge), s.edge]));
  walk.usage.forEach((count, key) => {
    const piste = names.get(key);
    if (count >= 3) notes.push(`🔁 ${piste.name} (${piste.pisteNr}) is on the plan ${count}× — few alternatives with these difficulties.`);
  });
  walk.steps.forEach(({ edge, t }) => {
    const w = edge.liftNr && edge.type !== 'piste' ? ctx.liftWindows[edge.liftNr] : null;
    if (w && t > w[1]) notes.push(`⚠ ${edge.liftNr} ${edge.name} closes at ${formatClock(w[1])}; this plan reaches it at ${formatClock(t)}.`);
  });
  return notes;
}

function renderDayOption(index) {
  const walk = dayOptions[index];
  const ctx  = dayCtx;
  const pace = ctx.pace;

  const optionsEl = document.getElementById('day-options');
  optionsEl.innerHTML = '';
  if (dayOptions.length > 1) {
    dayOptions.forEach((option, i) => {
      const btn = document.createElement('button');
      btn.className = 'day-opt' + (i === index ? ' on' : '');
      btn.innerHTML = `<strong>Option ${i + 1}</strong><span>${option.km.toFixed(1)} km · back ${formatClock(option.end)}</span>`;
      btn.addEventListener('click', () => renderDayOption(i));
      optionsEl.appendChild(btn);
    });
  }

  const lifts = walk.steps.filter(s => s.edge.type !== 'piste' && s.edge.type !== 'transfer').length;
  document.getElementById('dp-km').textContent    = `${walk.km.toFixed(1)} km`;
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

  let number = 0;
  walk.steps.forEach(({ edge, t }) => {
    if (edge.type === 'transfer') return;
    // A piste through several numbered parts: spread its time over the parts.
    const parts = splitTrajecten(edge);
    const partTotal = parts.reduce((sum, p) => sum + (p.tijd || 0), 0) || 1;
    let partT = t;
    parts.forEach(part => {
      const div = stepElement(part, number, formatClock(partT));
      div.style.animationDelay = `${Math.min(number, 30) * 30}ms`;
      stepsEl.appendChild(div);
      number++;
      partT += dayCost(edge, pace) * (part.tijd || 0) / partTotal;
    });
  });

  const endStation = STATIONS[ctx.endId];
  addWaypoint(stepsEl, endStation.name, endStation.alt, '🏁', `Back · ${formatClock(walk.end)}`, Math.min(number, 30) * 30);

  document.getElementById('day-tip').innerHTML =
    `💡 <strong>Guideline times:</strong> ${pace.label.toLowerCase()} pace — about ${pace.wait} min queueing per lift, ` +
    `piste times ×${pace.piste}. Breaks are not included; check the last lift times locally.`;
}
