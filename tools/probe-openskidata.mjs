// One-off probe (temporary): download the OpenSkiData GeoJSON files, report
// their size and shape, and keep every feature of KitzSki for local testing.
// Feature files are streamed line by line: they are far too big to parse whole.
import { createWriteStream, createReadStream, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const UA = 'SkiRouter/1.0 (github.com/WillemvanOs/SkiRouter)';
const BASES = ['https://tiles.openskimap.org/geojson', 'https://openskidata.org/data', 'https://tiles.skimap.org/geojson'];
mkdirSync('probe', { recursive: true });
mkdirSync('/tmp/osd', { recursive: true });
const log = [];
const say = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };

async function download(name) {
  for (const base of BASES) {
    for (const suffix of ['', '.gz']) {
      const url = `${base}/${name}${suffix}`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        say(`${url} -> ${res.status} ${res.headers.get('content-length') || '?'} bytes`);
        if (!res.ok) continue;
        const file = `/tmp/osd/${name}${suffix}`;
        await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
        say(`  saved ${file}: ${statSync(file).size} bytes`);
        return { file, gz: suffix === '.gz', url };
      } catch (err) { say(`${url} -> ${err.message}`); }
    }
  }
  return null;
}

async function* features(d) {
  let input = createReadStream(d.file);
  if (d.gz) { const { createGunzip } = await import('node:zlib'); input = input.pipe(createGunzip()); }
  const rl = createInterface({ input, crlfDelay: Infinity });
  let lines = 0;
  for await (let line of rl) {
    lines++;
    line = line.trim();
    if (!line.startsWith('{"type":"Feature"')) {
      if (lines <= 3) say(`  line ${lines}: ${line.slice(0, 200)}`);
      continue;
    }
    if (line.endsWith(',')) line = line.slice(0, -1);
    yield JSON.parse(line);
  }
  say(`  ${lines} lines`);
}

const areas = await download('ski_areas.geojson');
let kitz = [];
if (areas) {
  let n = 0;
  for await (const f of features(areas)) {
    if (n++ === 0) say('ski area sample:', JSON.stringify(f).slice(0, 1500));
    const name = JSON.stringify(f.properties?.name || '') + JSON.stringify(f.properties?.places || f.properties?.location || '');
    if (/kitzb|kitzski|kirchberg/i.test(name)) { kitz.push(f); say('KitzSki candidate:', JSON.stringify({ id: f.properties.id, name: f.properties.name, type: f.geometry?.type, stats: f.properties.statistics }).slice(0, 800)); }
  }
  say(`ski areas: ${n}`);
  writeFileSync('probe/kitzski-areas.json', JSON.stringify(kitz, null, 1));
}
const ids = new Set(kitz.map(f => f.properties.id));
for (const name of ['lifts.geojson', 'runs.geojson']) {
  const d = await download(name);
  if (!d) continue;
  const keep = [];
  let n = 0;
  for await (const f of features(d)) {
    if (n++ === 0) say(`${name} sample:`, JSON.stringify(f).slice(0, 2000));
    const sa = (f.properties?.skiAreas || []).map(a => a.properties?.id ?? a.id ?? a);
    if (sa.some(id => ids.has(id))) keep.push(f);
  }
  say(`${name}: ${n} features, ${keep.length} in KitzSki`);
  writeFileSync(`probe/kitzski-${name}`, JSON.stringify({ type: 'FeatureCollection', features: keep }));
}
writeFileSync('probe/log.txt', log.join('\n') + '\n');
