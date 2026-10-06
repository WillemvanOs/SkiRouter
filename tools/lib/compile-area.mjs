// Compiles one ski area from map geometry (lifts and runs as lines, with
// elevation where known) into the app's area format (format 2).
//
// The app plans on a small graph: the bottom and top station of every lift,
// lifts going up, and descents from the top of one lift to the bottom of
// another. This module works those descents out once, at build time, from the
// run network itself, so the app does not have to:
//
//   1. Runs are oriented downhill (by elevation) and split into a network at
//      every junction: where runs share a point, where a run starts or ends
//      on another run, and where a lift station sits next to a run.
//   2. From the top of every lift, a shortest-path search down that network
//      finds every lift bottom you can ski to, with the runs on the way.
//      It runs once per difficulty ceiling (blue only, up to red, up to
//      black, everything) and once per run leaving the top, so the app gets
//      the easy way down as well as the alternatives.
//   3. Each descent is stored as its parts (run number + metres), in order.
//
// Input (from a loader such as tools/lib/openskidata.mjs):
//   { lifts: [{ id, ref, name, type, coords: [[lon, lat, ele?], …], duration?,
//               bottomName?, topName? }],
//     runs:  [{ id, ref, name, difficulty, coords: [[lon, lat, ele?], …] }] }
// with difficulty one of 'blauw' | 'rood' | 'zwart' | 'skiroute'.

const RUN_M_PER_MIN    = 200; // same average as the app's pisteTijd()
const DENSIFY_M        = 20;  // extra points along runs, so junctions can sit anywhere
const SHARED_M         = 6;   // points this close on two runs: the runs meet here
const RUN_END_SNAP_M   = 30;  // a run starting/ending this close to another run joins it
const STATION_SNAP_M   = 80;  // a run this close to a lift station can be reached from it
const STATION_FAR_M    = 200; // …or this close when no run is nearer
const STATION_ELE_M    = 25;  // …unless it is this much above a bottom / below a top
const WALK_M           = 500; // stations this close (and level) get a walk between them
const WALK_ELE_M       = 30;
const WALK_M_PER_MIN   = 60;  // in ski boots
const FLAT_RUN_M       = 4;   // runs with less drop than this can be skied both ways
const TRANSFER_M       = 150; // two stations this close (and level): walk across (transfer)
const TRANSFER_NO_ELE_M = 80; // …this close when their elevation is unknown
const TRANSFER_ELE_M   = 30;  // at most this much higher or lower
const CONNECTOR_DROP_M = 150; // a long lift climbing less than this links two summits:
const CONNECTOR_MIN_M  = 1000; // it runs both ways as a normal lift (like the 3S Bahn)
const TINY_PART_M      = 60;  // run pieces shorter than this always fold into a neighbour
const UNNAMED_PART_M   = 300; // …and unnamed connectors shorter than this
const SHORT_PART_M     = 150; // shorter run pieces fold into their neighbour when no harder
const MAX_PER_PAIR     = 4;   // alternatives kept per lift top → lift bottom

const DIFF_ORDER = ['blauw', 'rood', 'zwart', 'skiroute'];
const CEILINGS = [['blauw'], ['blauw', 'rood'], ['blauw', 'rood', 'zwart'], DIFF_ORDER];

// Lift speeds in m/s, for lifts without a mapped duration.
const LIFT_SPEED = {
  cable_car: 8, funicular: 8, gondola: 5, mixed_lift: 5, chair_lift: 3.5,
  't-bar': 3, 'j-bar': 3, platter: 3, drag_lift: 3, rope_tow: 2, magic_carpet: 0.8,
};
const PRACTICE_LIFTS = new Set(['magic_carpet']);
const RIDE_DOWN = new Set(['gondola', 'mixed_lift', 'cable_car', 'funicular']);

export function compileArea(input, meta = {}) {
  const proj = projection([...input.lifts, ...input.runs]);

  // ── Lifts and their stations ──────────────────────────────────────────────
  const lifts = assignLiftNumbers(input.lifts.filter(l => LIFT_SPEED[l.type] && l.coords.length >= 2));
  const stations = []; // { id, liftNr, side: 'onder'|'boven', x, y, e }
  for (const lift of lifts) {
    const a = proj(lift.coords[0]), b = proj(lift.coords[lift.coords.length - 1]);
    // Aerialways are drawn bottom → top; trust elevation when it says otherwise.
    const flip = a.e != null && b.e != null && a.e > b.e + 5;
    const [bottom, top] = flip ? [b, a] : [a, b];
    lift.bottom = bottom; lift.top = top;
    lift.bottomC = flip ? lift.coords[lift.coords.length - 1] : lift.coords[0];
    lift.topC = flip ? lift.coords[0] : lift.coords[lift.coords.length - 1];
    lift.lengthM = polylineLength(lift.coords.map(proj));
    stations.push({ id: `${lift.liftNr}-onder`, liftNr: lift.liftNr, side: 'onder', ...bottom });
    stations.push({ id: `${lift.liftNr}-boven`, liftNr: lift.liftNr, side: 'boven', ...top });
  }
  // Lifts linking two summits run both ways: add the return trip as a lift of
  // its own ("D9r"), as the app has no penalty for those (unlike riding down).
  for (const lift of [...lifts]) {
    const climb = lift.bottom.e != null && lift.top.e != null ? lift.top.e - lift.bottom.e : null;
    if (!RIDE_DOWN.has(lift.type) || climb == null || climb >= CONNECTOR_DROP_M || lift.lengthM < CONNECTOR_MIN_M) continue;
    const back = { ...lift, liftNr: `${lift.liftNr}r`, bottom: lift.top, top: lift.bottom, bottomC: lift.topC, topC: lift.bottomC,
      bottomName: lift.topName, topName: lift.bottomName, connector: true };
    lift.connector = true;
    lifts.push(back);
    stations.push({ id: `${back.liftNr}-onder`, liftNr: back.liftNr, side: 'onder', ...back.bottom });
    stations.push({ id: `${back.liftNr}-boven`, liftNr: back.liftNr, side: 'boven', ...back.top });
  }

  // ── Runs: oriented downhill, densified ────────────────────────────────────
  const runs = input.runs.filter(r => r.coords.length >= 2 && DIFF_ORDER.includes(r.difficulty)).map(r => {
    let pts = r.coords.map(proj);
    const first = pts[0].e, last = pts[pts.length - 1].e;
    if (first != null && last != null && last > first) pts = pts.reverse();
    const drop = first != null && last != null ? Math.abs(first - last) : null;
    return { ...r, pts: densify(pts, DENSIFY_M), flat: drop != null && drop < FLAT_RUN_M };
  });
  const runKeys = assignRunKeys(runs);

  // ── Network: every densified point is a vertex; junctions become nodes ────
  const V = []; // { x, y, e, run, i }
  runs.forEach((run, r) => run.pts.forEach((p, i) => { run.pts[i].v = V.length; V.push({ ...p, run: r, i }); }));
  const grid = new Grid(25);
  V.forEach((v, id) => grid.add(v.x, v.y, id));
  const uf = new UnionFind(V.length);
  const junction = new Uint8Array(V.length);

  // Runs meeting at a shared point (OSM ways sharing a node, or overlapping).
  V.forEach((v, id) => {
    for (const other of grid.near(v.x, v.y, SHARED_M)) {
      if (V[other].run !== v.run && dist(v, V[other]) <= SHARED_M) {
        uf.union(id, other); junction[id] = junction[other] = 1;
      }
    }
  });
  // A run starting or ending on another run joins it there.
  runs.forEach((run, r) => {
    for (const end of [run.pts[0], run.pts[run.pts.length - 1]]) {
      junction[end.v] = 1;
      const hit = nearestOtherRun(grid, V, end, r, RUN_END_SNAP_M);
      if (hit != null) { uf.union(end.v, hit); junction[hit] = 1; }
    }
  });
  // Lift stations: the nearest point of every run close by.
  const attach = { top: new Map(), bottom: new Map() }; // station id -> Set(vertex)
  const diagnostics = {}; // station id -> why no run is attached (for the report)
  const nearRuns = (s, radius) => {
    const perRun = new Map();
    for (const id of grid.near(s.x, s.y, radius)) {
      const v = V[id], d = dist(v, s);
      if (d > radius) continue;
      if (s.e != null && v.e != null) {
        if (s.side === 'boven' && v.e > s.e + STATION_ELE_M) continue; // run starts well above this top
        if (s.side === 'onder' && v.e < s.e - STATION_ELE_M) continue; // run passes well below this bottom
      }
      if (!perRun.has(v.run) || d < perRun.get(v.run).d) perRun.set(v.run, { id, d });
    }
    return perRun;
  };
  for (const s of stations) {
    // A station in a village can sit a short walk from the piste: when no run
    // passes close by, look a little further.
    let perRun = nearRuns(s, STATION_SNAP_M);
    if (!perRun.size) perRun = nearRuns(s, STATION_FAR_M);
    const set = new Set([...perRun.values()].map(h => { junction[h.id] = 1; return h.id; }));
    (s.side === 'boven' ? attach.top : attach.bottom).set(s.id, set);
    if (!set.size) {
      // For the report: how far off is the nearest run, and was it only the
      // elevation check that kept it out?
      let near = null;
      for (const id of grid.near(s.x, s.y, 500)) {
        const d = dist(V[id], s);
        if (d <= 500 && (!near || d < near.d)) near = { d, e: V[id].e };
      }
      diagnostics[s.id] = near
        ? `${s.side === 'boven' ? 'top' : 'bottom'}: nearest run ${Math.round(near.d)} m${near.d <= STATION_SNAP_M ? ' (filtered by elevation)' : ''}`
        : `${s.side === 'boven' ? 'top' : 'bottom'}: no run within 500 m`;
    }
  }

  // Edges between consecutive junctions along each run.
  const out = new Map(); // node -> [{ to, len, run }]
  const addEdge = (from, to, len, run) => {
    if (from === to) return;
    if (!out.has(from)) out.set(from, []);
    out.get(from).push({ to, len, run });
  };
  runs.forEach((run, r) => {
    let prev = run.pts[0], len = 0;
    for (let i = 1; i < run.pts.length; i++) {
      len += dist(run.pts[i - 1], run.pts[i]);
      if (!junction[run.pts[i].v] && i < run.pts.length - 1) continue;
      const a = uf.find(prev.v), b = uf.find(run.pts[i].v);
      addEdge(a, b, len, r);
      if (run.flat) addEdge(b, a, len, r);
      prev = run.pts[i]; len = 0;
    }
  });
  const bottomAt = new Map(); // node -> [station id]
  for (const [sid, set] of attach.bottom) {
    for (const v of set) {
      const n = uf.find(v);
      if (!bottomAt.has(n)) bottomAt.set(n, []);
      bottomAt.get(n).push(sid);
    }
  }

  // ── Descents from every lift top ──────────────────────────────────────────
  const descents = new Map(); // "A1>B2" -> [{ parts, len }]
  for (const lift of lifts) {
    const topId = `${lift.liftNr}-boven`;
    const starts = [...(attach.top.get(topId) || [])].map(v => ({ node: uf.find(v), run: V[v].run }));
    if (!starts.length) continue;
    const searches = [
      ...CEILINGS.map(allowed => ({ allowed, starts })),
      // One search per run leaving this top, so each way down is offered.
      ...[...new Set(starts.map(s => s.run))].map(run => ({ allowed: DIFF_ORDER, starts: starts.filter(s => s.run === run), firstRun: run })),
    ];
    for (const search of searches) {
      const allowed = new Set(search.allowed);
      const reached = shortestDescents(out, search.starts.map(s => s.node), bottomAt,
        e => allowed.has(runs[e.run].difficulty), search.firstRun);
      for (const [bottomId, path] of reached) {
        const bottomNr = bottomId.slice(0, -'-onder'.length);
        const parts = toParts(path, runs, runKeys);
        if (!parts.length) continue;
        const key = `${lift.liftNr}>${bottomNr}`;
        if (!descents.has(key)) descents.set(key, []);
        const list = descents.get(key);
        const sig = parts.map(p => p[0]).join('|');
        if (!list.some(d => d.sig === sig)) list.push({ sig, parts, len: parts.reduce((s, p) => s + p[1], 0) });
      }
    }
  }
  const afdalingen = [];
  for (const [key, list] of descents) {
    const [van, naar] = key.split('>');
    list.sort((a, b) => a.len - b.len).slice(0, MAX_PER_PAIR)
      .forEach(d => afdalingen.push({ van, naar, delen: d.parts }));
  }

  // ── Transfers between stations next to each other ─────────────────────────
  const overstappen = [];
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i], b = stations[j];
      if (a.liftNr === b.liftNr) continue;
      const level = a.e != null && b.e != null;
      if (dist(a, b) > (level ? TRANSFER_M : TRANSFER_NO_ELE_M)) continue;
      if (level && Math.abs(a.e - b.e) > TRANSFER_ELE_M) continue;
      overstappen.push([a.id, b.id]);
    }
  }

  // Walks between stations a little further apart on the same level, e.g.
  // two valley stations in one village.
  const lopen = [];
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i], b = stations[j];
      if (a.liftNr === b.liftNr || a.e == null || b.e == null || Math.abs(a.e - b.e) > WALK_ELE_M) continue;
      const d = dist(a, b);
      if (d > WALK_M || overstappen.some(([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id))) continue;
      lopen.push({ van: a.id, naar: b.id, soort: 'lopen', tijd: Math.max(2, Math.round(d / WALK_M_PER_MIN)),
        naam: 'Walk', info: `About ${Math.round(d / 10) * 10} m on foot.` });
    }
  }

  // ── Output ────────────────────────────────────────────────────────────────
  const round5 = p => [+p[1].toFixed(5), +p[0].toFixed(5)]; // [lon, lat] -> [lat, lon]
  const liften = lifts.map(l => {
    const tijd = l.duration ? Math.max(1, Math.round(l.duration / 60))
      : Math.max(1, Math.round(l.lengthM / LIFT_SPEED[l.type] / 60) + 1);
    return {
      liftNr: l.liftNr,
      naam: l.name || l.liftNr,
      type: l.type,
      echteLift: !PRACTICE_LIFTS.has(l.type),
      tijd,
      vertrektBij: stationName(l, l.bottomName, 'Bottom'),
      komtAanBij: stationName(l, l.topName, 'Top'),
      coordOnder: round5(l.bottomC),
      coordBoven: round5(l.topC),
    };
  });

  const pisteInfo = new Map();
  runs.forEach((run, r) => {
    const key = runKeys[r];
    const info = pisteInfo.get(key) || { pisteNr: key, naam: run.name || defaultRunName(run, key), kleur: run.difficulty, lengteM: 0 };
    info.lengteM += Math.round(polylineLength(run.pts));
    if (DIFF_ORDER.indexOf(run.difficulty) > DIFF_ORDER.indexOf(info.kleur)) info.kleur = run.difficulty;
    pisteInfo.set(key, info);
  });
  const pisteLijnen = {};
  runs.forEach((run, r) => {
    const pts = thin(run.pts, 60).map(p => proj.back(p));
    (pisteLijnen[runKeys[r]] = pisteLijnen[runKeys[r]] || []).push(pts.map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]));
  });

  const eles = [...lifts.flatMap(l => [l.bottom.e, l.top.e])].filter(e => e != null);
  const realLifts = liften.filter(l => l.echteLift).length;
  const pistesKm = Math.round([...pisteInfo.values()].reduce((s, p) => s + p.lengteM, 0) / 1000);

  const area = {
    format: 2,
    id: meta.id,
    name: meta.name,
    subtitle: meta.subtitle || '',
    bron: meta.bron || '',
    stats: {
      liften: realLifts,
      pistesKm,
      hoogte: eles.length ? `${Math.round(Math.min(...eles))}–${Math.round(Math.max(...eles))} m` : null,
    },
    liften,
    pistes: [...pisteInfo.values()],
    afdalingen,
    overstappen,
    verbindingen: lopen,
    restaurants: [],
    pisteLijnen,
  };
  cleanText(area);
  return { area, report: validate(area), diagnostics };
}

// Names come from map data and end up on screen: no markup characters.
function cleanText(area) {
  const clean = t => typeof t === 'string' ? t.replace(/[<>"`]/g, '').replace(/\s+/g, ' ').trim() : t;
  area.name = clean(area.name);
  area.subtitle = clean(area.subtitle);
  area.liften.forEach(l => { l.naam = clean(l.naam); l.vertrektBij = clean(l.vertrektBij); l.komtAanBij = clean(l.komtAanBij); });
  area.pistes.forEach(p => { p.naam = clean(p.naam); });
}

// ── Shortest descents ────────────────────────────────────────────────────────

// Dijkstra over the run network from the nodes next to a lift top. Returns
// Map(bottom station id -> [edges]) for every lift bottom reached.
function shortestDescents(out, startNodes, bottomAt, edgeAllowed, firstRun) {
  const dist = new Map(), prev = new Map();
  const heap = new MinHeap();
  for (const n of startNodes) { dist.set(n, 0); heap.push(0, n); }
  const reached = new Map();
  while (heap.size) {
    const [d, n] = heap.pop();
    if (d > (dist.get(n) ?? Infinity)) continue;
    for (const sid of bottomAt.get(n) || []) {
      if (!reached.has(sid) && d > 0) reached.set(sid, n);
    }
    for (const e of out.get(n) || []) {
      if (!edgeAllowed(e)) continue;
      // A "first run" search may only leave its start along that run.
      if (firstRun != null && !prev.has(n) && e.run !== firstRun) continue;
      const nd = d + e.len;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: n, edge: e });
        heap.push(nd, e.to);
      }
    }
  }
  const paths = new Map();
  for (const [sid, node] of reached) {
    const path = [];
    for (let n = node; prev.has(n); n = prev.get(n).from) path.unshift(prev.get(n).edge);
    if (path.length) paths.set(sid, path);
  }
  return paths;
}

// Edges -> [[runKey, metres], …] (or [runKey, metres, colour] — see below),
// merging consecutive pieces of one run. Minor pieces fold into a
// neighbouring run so the app does not show a step for every few metres:
// unnamed connectors under 300 m, anything under 60 m, and pieces under
// 150 m that are no harder than their neighbour. When a folded piece is
// harder, the neighbour keeps its colour as a third element, so the
// difficulty filter still sees it.
function toParts(path, runs, runKeys) {
  const rank = d => DIFF_ORDER.indexOf(d);
  let parts = [];
  for (const e of path) {
    const key = runKeys[e.run], diff = runs[e.run].difficulty;
    const last = parts[parts.length - 1];
    if (last && last.key === key) last.len += e.len;
    else parts.push({ key, diff, len: e.len, also: null });
  }
  const minor = (p, nb) => p.len < TINY_PART_M
    || (p.key.startsWith('~') && p.len < UNNAMED_PART_M)
    || (p.len < SHORT_PART_M && rank(p.diff) <= rank(nb.diff));
  for (let changed = true; changed && parts.length > 1;) {
    changed = false;
    for (let i = 0; i < parts.length && parts.length > 1; i++) {
      const p = parts[i];
      const prev = parts[i - 1], next = parts[i + 1];
      const nb = !prev ? next : !next ? prev : (next.key.startsWith('~') && !prev.key.startsWith('~')) || prev.len >= next.len ? prev : next;
      if (!minor(p, nb)) continue;
      nb.len += p.len;
      const hardest = [nb.also, p.also, rank(p.diff) > rank(nb.diff) ? p.diff : null].filter(Boolean)
        .sort((x, y) => rank(y) - rank(x))[0] || null;
      if (hardest && rank(hardest) > rank(nb.diff)) nb.also = hardest;
      parts.splice(i, 1);
      changed = true;
      break;
    }
    // Folding can leave two pieces of one run next to each other again.
    const merged = [];
    for (const p of parts) {
      const last = merged[merged.length - 1];
      if (last && last.key === p.key) {
        last.len += p.len;
        if (p.also && (!last.also || rank(p.also) > rank(last.also))) last.also = p.also;
      } else merged.push({ ...p });
    }
    parts = merged;
  }
  return parts.map(p => p.also ? [p.key, Math.round(p.len), p.also] : [p.key, Math.round(p.len)]);
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validate(area) {
  const real = area.liften.filter(l => l.echteLift);
  const nrs = new Set(real.map(l => l.liftNr));
  const topsWithDescent = new Set(area.afdalingen.map(a => a.van));
  const bottomsReached = new Set(area.afdalingen.map(a => a.naar));
  const transfers = area.overstappen || [];
  // Station graph: lift up, descents down, transfers both ways.
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  area.liften.forEach(l => {
    add(`${l.liftNr}-onder`, `${l.liftNr}-boven`);
    // Gondolas and cable cars can be ridden down as well (the app does that too).
    if (l.echteLift && RIDE_DOWN.has(l.type)) add(`${l.liftNr}-boven`, `${l.liftNr}-onder`);
  });
  area.afdalingen.forEach(a => add(`${a.van}-boven`, `${a.naar}-onder`));
  transfers.forEach(([a, b]) => { add(a, b); add(b, a); });
  (area.verbindingen || []).forEach(v => { add(v.van, v.naar); if (v.beideRichtingen !== false) add(v.naar, v.van); });
  const stations = area.liften.filter(l => l.echteLift).map(l => `${l.liftNr}-onder`);
  const biggest = largestMutualGroup(stations, adj);

  const noWayDown = real.filter(l => !topsWithDescent.has(l.liftNr) && !transfers.some(t => t.includes(`${l.liftNr}-boven`)));
  const noWayIn = real.filter(l => !bottomsReached.has(l.liftNr) && !transfers.some(t => t.includes(`${l.liftNr}-onder`)));
  const share = stations.length ? biggest.size / stations.length : 0;
  // Separate parts of the area (no way between them in either direction),
  // with at least 3 lifts: more than one suggests a ski pass of several
  // domains rather than one connected ski area.
  const parts = groups(stations, adj).filter(g => g.size >= 3).map(g => g.size).sort((a, b) => b - a);
  const quality = real.length && share >= 0.9 && noWayDown.length <= Math.max(1, real.length * 0.1) ? 'automatisch' : 'onvolledig';
  return {
    lifts: real.length,
    runs: area.pistes.length,
    pistesKm: area.stats.pistesKm,
    descents: area.afdalingen.length,
    connectedShare: Math.round(share * 100),
    noWayDown: noWayDown.map(l => l.liftNr),
    noWayIn: noWayIn.map(l => l.liftNr),
    outsideMainNetwork: stations.filter(s => !biggest.has(s)).map(s => s.slice(0, -'-onder'.length)),
    domains: parts,
    quality,
  };
}

// Groups of lift bottoms linked in any direction (undirected components).
function groups(stations, adj) {
  const und = new Map();
  const link = (a, b) => { if (!und.has(a)) und.set(a, new Set()); und.get(a).add(b); };
  for (const [a, set] of adj) for (const b of set) { link(a, b); link(b, a); }
  const seen = new Set(), out = [];
  for (const s of stations) {
    if (seen.has(s)) continue;
    const group = new Set(), stack = [s];
    seen.add(s);
    while (stack.length) {
      const n = stack.pop();
      if (n.endsWith('-onder') && stations.includes(n)) group.add(n);
      for (const m of und.get(n) || []) if (!seen.has(m)) { seen.add(m); stack.push(m); }
    }
    out.push(group);
  }
  return out;
}

// Biggest set of lift bottoms that can all reach each other.
function largestMutualGroup(stations, adj) {
  const reach = s => {
    const seen = new Set([s]), stack = [s];
    while (stack.length) for (const n of adj.get(stack.pop()) || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    return seen;
  };
  const reachable = new Map(stations.map(s => [s, reach(s)]));
  let best = new Set();
  const done = new Set();
  for (const s of stations) {
    if (done.has(s)) continue;
    const group = new Set(stations.filter(t => reachable.get(s).has(t) && reachable.get(t).has(s)));
    group.forEach(t => done.add(t));
    if (group.size > best.size) best = group;
  }
  return best;
}

// ── Naming ───────────────────────────────────────────────────────────────────

// Lift numbers: the mapped ref (A1, D9). A ref used by several lifts (two
// sections of one lift) becomes F1a, F1b, …; lifts without a ref get OEF-1…
// (practice lifts) or L1…, so every station id is unique.
function assignLiftNumbers(lifts) {
  const refOf = l => (l.ref || '').trim().replace(/\s+/g, '');
  const count = new Map();
  lifts.forEach(l => { const r = refOf(l); if (r) count.set(r, (count.get(r) || 0) + 1); });
  const seen = new Map();
  let practice = 0, other = 0;
  const taken = new Set();
  return lifts.map(l => {
    const ref = refOf(l);
    let nr;
    if (!ref) nr = PRACTICE_LIFTS.has(l.type) ? `OEF-${++practice}` : `L${++other}`;
    else if (count.get(ref) > 1) {
      const i = seen.get(ref) || 0;
      seen.set(ref, i + 1);
      nr = ref + String.fromCharCode(97 + i); // a, b, c…
    } else nr = ref;
    while (taken.has(nr)) nr += "'";
    taken.add(nr);
    return { ...l, liftNr: nr };
  });
}

// Run keys: the mapped ref (21, 21a), else the name, else a generated one.
// Pieces of one run (same ref and name) share their key.
function assignRunKeys(runs) {
  let n = 0;
  const byLabel = new Map();
  return runs.map(r => {
    const ref = (r.ref || '').trim();
    const label = ref || (r.name || '').trim();
    if (!label) return `~${++n}`;
    const id = `${label}|${r.difficulty}`;
    if (!byLabel.has(id)) {
      const taken = [...byLabel.values()].includes(label);
      byLabel.set(id, taken ? `${label} (${r.difficulty})` : label);
    }
    return byLabel.get(id);
  });
}

// A station's own name, unless it just repeats the lift's name (or is missing):
// then "Bottom station X" / "Top station X".
function stationName(lift, name, side) {
  const own = (name || '').trim();
  const liftName = lift.name || lift.liftNr;
  if (!own || own === liftName || own === lift.bottomName && own === lift.topName) return `${side} station ${liftName}`;
  return own;
}

function defaultRunName(run, key) {
  const kind = { blauw: 'Blue run', rood: 'Red run', zwart: 'Black run', skiroute: 'Ski route' }[run.difficulty];
  return key.startsWith('~') ? kind : `${kind} ${key}`;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

function projection(features) {
  let sumLat = 0, sumLon = 0, n = 0;
  for (const f of features) for (const c of f.coords) { sumLon += c[0]; sumLat += c[1]; n++; }
  const lat0 = n ? sumLat / n : 0, lon0 = n ? sumLon / n : 0;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const cache = new WeakMap();
  const proj = c => {
    if (cache.has(c)) return cache.get(c);
    const p = { x: (c[0] - lon0) * kx, y: (c[1] - lat0) * ky, e: c[2] ?? null };
    cache.set(c, p);
    return p;
  };
  proj.back = p => [p.x / kx + lon0, p.y / ky + lat0];
  return proj;
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function polylineLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

function densify(pts, step) {
  const outPts = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = dist(a, b), k = Math.floor(d / step);
    for (let j = 1; j <= k; j++) {
      const t = j / (k + 1);
      outPts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
        e: a.e != null && b.e != null ? a.e + (b.e - a.e) * t : null });
    }
    outPts.push({ ...b });
  }
  return outPts;
}

function thin(pts, step) {
  const kept = [pts[0]];
  for (const p of pts) if (dist(kept[kept.length - 1], p) >= step) kept.push(p);
  const last = pts[pts.length - 1];
  if (kept[kept.length - 1] !== last && dist(kept[kept.length - 1], last) > 5) kept.push(last);
  return kept;
}

function nearestOtherRun(grid, V, p, run, maxD) {
  let best = null, bestD = maxD;
  for (const id of grid.near(p.x, p.y, maxD)) {
    if (V[id].run === run) continue;
    const d = dist(V[id], p);
    if (d <= bestD) { best = id; bestD = d; }
  }
  return best;
}

class Grid {
  constructor(size) { this.size = size; this.cells = new Map(); }
  key(i, j) { return i * 1e6 + j; }
  add(x, y, id) {
    const k = this.key(Math.floor(x / this.size), Math.floor(y / this.size));
    if (!this.cells.has(k)) this.cells.set(k, []);
    this.cells.get(k).push(id);
  }
  *near(x, y, r) {
    const i0 = Math.floor((x - r) / this.size), i1 = Math.floor((x + r) / this.size);
    const j0 = Math.floor((y - r) / this.size), j1 = Math.floor((y + r) / this.size);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) yield* this.cells.get(this.key(i, j)) || [];
  }
}

class UnionFind {
  constructor(n) { this.p = Int32Array.from({ length: n }, (_, i) => i); }
  find(a) { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[Math.max(a, b)] = Math.min(a, b); }
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}
