// Fetches the current status and operating hours of every lift from the ski
// area's own website and writes them to a small file next to the area data
// (e.g. data/kitzski-osm-liftstatus.json), keyed by our lift numbers.
//
// Runs every 30 minutes in GitHub Actions (.github/workflows/lift-status.yml).
// The file is only rewritten when a lift's status or hours actually change,
// so an unchanged run commits (and redeploys) nothing.
//
// Configure an area in data/areas.json:
//   "liftstatus": {
//     "file":   "data/kitzski-osm-liftstatus.json",
//     "bron":   "micado-skigebietemanager",
//     "base":   "https://www.kitzski.at",
//     "client": "https://sgm.kitzski.at",
//     "region": "kitzski"
//   }
//
//   node tools/lift-status.mjs

import { readFile, writeFile } from 'node:fs/promises';

const UA = 'SkiRouter/1.0 (github.com/WillemvanOs/SkiRouter)';

// Sources, by the "bron" in an area's liftstatus config. Each returns
// { sourceUpdate, facilities: [{ id, open, hours, from, to, weekdays, text }] }.
const SOURCES = {
  // Micado "SkigebieteManager" lift list, as used by kitzski.at's own lift status page.
  async 'micado-skigebietemanager'(cfg) {
    const params = new URLSearchParams({
      api: 'SkigebieteManager/Micado.SkigebieteManager.Plugin.FacilityApi/ListFacilities.api',
      client: cfg.client, lang: 'de', region: cfg.region, season: 'winter', type: 'lift',
    });
    const res = await fetch(`${cfg.base}/webapi/micadoweb?${params}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      sourceUpdate: data.meta?.lastUpdate || null,
      facilities: (data.facilities || []).map(f => ({
        id: f.identifier,
        open: f.status === 1,
        hours: normaliseHours(f.operatingTimePeriod || f.openingHours),
        from: (f.operatingDateFrom || '').slice(0, 10) || null,
        to: (f.operatingDateTo || '').slice(0, 10) || null,
        weekdays: f.operatingWeekdays ?? null,
        text: f.operatingText || '',
      })),
    };
  },
};

// "08:30 - 17:00" -> "08:30-17:00"; anything without a time range -> null.
function normaliseHours(value) {
  const m = /(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/.exec(value || '');
  if (!m) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(m[1])}:${m[2]}-${pad(m[3])}:${m[4]}`;
}

async function updateArea(meta) {
  const cfg = meta.liftstatus;
  const source = SOURCES[cfg.bron];
  if (!source) throw new Error(`unknown liftstatus source "${cfg.bron}"`);
  const area = JSON.parse(await readFile(meta.file, 'utf8'));
  const { sourceUpdate, facilities } = await source(cfg);
  const byId = new Map(facilities.map(f => [f.id, f]));

  // Our lift numbers sometimes split one facility: F1a/F1b are F1, D9r is D9.
  const lifts = {};
  let matched = 0;
  for (const lift of area.liften || []) {
    const f = byId.get(lift.liftNr) || byId.get(lift.liftNr.replace(/[a-z]+$/, ''));
    if (!f) continue;
    matched++;
    const { id, ...status } = f;
    lifts[lift.liftNr] = status;
  }
  const open = Object.values(lifts).filter(l => l.open).length;
  console.log(`- ${meta.id}: ${facilities.length} facilities, ${matched}/${(area.liften || []).length} lifts matched, ${open} open (source update ${sourceUpdate})`);
  if (!matched) throw new Error('no lifts matched — has the source changed?');

  let previous = null;
  try { previous = JSON.parse(await readFile(cfg.file, 'utf8')); } catch {}
  if (previous && JSON.stringify(previous.lifts) === JSON.stringify(lifts)) {
    console.log('  unchanged');
    return false;
  }
  const out = {
    bron: new URL(cfg.base).hostname,
    sourceUpdate,
    changed: new Date().toISOString(),
    lifts,
  };
  await writeFile(cfg.file, JSON.stringify(out, null, 2) + '\n');
  console.log(`  written ${cfg.file}`);
  return true;
}

const areas = JSON.parse(await readFile('data/areas.json', 'utf8'));
let failed = false;
for (const meta of areas.filter(a => a.liftstatus)) {
  try { await updateArea(meta); } catch (err) {
    failed = true;
    console.error(`- ${meta.id}: ${err.message}`);
  }
}
if (failed) process.exitCode = 1;
