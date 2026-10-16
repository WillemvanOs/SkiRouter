// Landmarks for the route map: named peaks and the towns and villages in and
// around a ski area, as a paper piste map shows them. They come from
// OpenStreetMap (tools/fetch-pois.mjs --kind landmarks, into
// data/pois/landmarks.json); landmarksFor picks an area's own.
//
// An area's landmarks (`plaatsen`): [{ n: name, k: 'peak'|'town'|'village'|'hamlet', lat, lon, ele? }]
// and its places to go (`plekken`): [{ id, n?: name, k: 'viewpoint'|'snowpark', lat, lon, ele? }]

export const LANDMARK_PAD = 0.015;  // ~1.5 km around an area's lifts and runs
const MAX_PEAKS = 25;
const MAX_PLACES = 20;
const HAMLET_NEAR_M = 1200;         // a hamlet only when a lift starts or ends this close
const PEAK_IN_AREA_M = 600;         // a peak this close to a lift station or a run is in the area
const PEAK_SAME_M = 400;            // peaks this close together are one (the highest is kept)
const PLACE_RANK = { town: 0, village: 1, hamlet: 2 };
const POI_IN_AREA_M = 300;          // a viewpoint or snow park this close to a lift station or a run
const MAX_VIEWPOINTS = 20;
const MAX_SNOWPARKS = 10;

// The points of an area (format 2: liften + pisteLijnen) that set its extent.
export function areaPoints(area) {
  return [
    ...(area.liften || []).flatMap(l => [l.coordOnder, l.coordBoven]),
    ...Object.values(area.pisteLijnen || {}).flat(2),
  ].filter(Boolean);
}

export function boxOf(points, pad) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [lat, lon] of points) {
    if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return [s - pad, w - pad, n + pad, e + pad];
}

const inBox = ([s, w, n, e], lat, lon) => lat >= s && lat <= n && lon >= w && lon <= e;

function distM(a, b) {
  const kx = 111320 * Math.cos(a[0] * Math.PI / 180), ky = 110540;
  return Math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * ky);
}

// The landmarks of one area, from the fetched list: the named peaks in the
// area (at a lift or a run; the highest first), then the highest around it,
// and the towns and villages, plus hamlets where a lift starts or ends.
export function landmarksFor(all, area) {
  const points = areaPoints(area);
  if (!points.length) return [];
  const box = boxOf(points, LANDMARK_PAD);
  const stations = (area.liften || []).flatMap(l => [l.coordOnder, l.coordBoven]).filter(Boolean);
  const mid = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  const inside = all.filter(p => inBox(box, p.lat, p.lon));
  const near = [...stations, ...Object.values(area.pisteLijnen || {}).flat().flatMap(line => line.filter((q, i) => i % 3 === 0))];
  const inArea = p => near.some(q => distM(q, [p.lat, p.lon]) <= PEAK_IN_AREA_M);
  const peaks = [];
  inside.filter(p => p.natural === 'peak')
    .map(p => ({ p, in: inArea(p) }))
    .sort((a, b) => b.in - a.in || (b.p.ele ?? -1) - (a.p.ele ?? -1))
    .forEach(({ p }) => {
      if (peaks.length < MAX_PEAKS && !peaks.some(q => distM([q.lat, q.lon], [p.lat, p.lon]) <= PEAK_SAME_M)) peaks.push(p);
    });
  const places = inside.filter(p => p.place in PLACE_RANK)
    .filter(p => p.place !== 'hamlet' || stations.some(s => distM(s, [p.lat, p.lon]) <= HAMLET_NEAR_M))
    .sort((a, b) => PLACE_RANK[a.place] - PLACE_RANK[b.place] || distM(mid, [a.lat, a.lon]) - distM(mid, [b.lat, b.lon]))
    .slice(0, MAX_PLACES);
  return [...places, ...peaks].map(p => ({
    n: p.name, k: p.natural === 'peak' ? 'peak' : p.place, lat: p.lat, lon: p.lon,
    ...(p.ele != null ? { ele: p.ele } : {}),
  }));
}

// Places to go in an area: viewpoints and snow parks at a lift or a run
// (named ones first), for the station picker and the day planner's stops.
export function poisFor(all, area) {
  const points = areaPoints(area);
  if (!points.length) return [];
  const box = boxOf(points, LANDMARK_PAD);
  const stations = (area.liften || []).flatMap(l => [l.coordOnder, l.coordBoven]).filter(Boolean);
  const near = [...stations, ...Object.values(area.pisteLijnen || {}).flat().flatMap(line => line.filter((q, i) => i % 2 === 0))];
  const inArea = p => near.some(q => distM(q, [p.lat, p.lon]) <= POI_IN_AREA_M);
  const pick = (kind, max) => all
    .filter(p => kind(p) && inBox(box, p.lat, p.lon) && inArea(p))
    .sort((a, b) => !!b.name - !!a.name || (b.ele ?? -1) - (a.ele ?? -1))
    .slice(0, max);
  return [
    ...pick(p => p.tourism === 'viewpoint', MAX_VIEWPOINTS).map(p => ({ k: 'viewpoint', p })),
    ...pick(p => p.piste === 'snow_park', MAX_SNOWPARKS).map(p => ({ k: 'snowpark', p })),
  ].map(({ k, p }) => ({
    id: p.id, ...(p.name ? { n: p.name } : {}), k, lat: p.lat, lon: p.lon,
    ...(p.ele != null ? { ele: p.ele } : {}),
  }));
}
