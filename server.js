import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR      = path.join(__dirname, 'data');
const REGISTRY_PATH = path.join(DATA_DIR, 'areas.json');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// ── Helpers ──────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isValidId(id) {
  return typeof id === 'string' && id.length >= 2 && id.length <= 50 && ID_PATTERN.test(id);
}

function areaFilePath(id) {
  // isValidId() must be checked by the caller before this is used — it
  // guarantees `id` only contains [a-z0-9-], so this can't escape DATA_DIR.
  return path.join(DATA_DIR, `${id}.json`);
}

async function readRegistry() {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeRegistry(areas) {
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(areas, null, 2) + '\n', 'utf8');
}

/**
 * Validates a dataset against the one shape this app accepts: the
 * skimap-reader protocol's export — top-level `liften` + `pistes`, linked
 * by lift codes (`beginBovenBij`, `bereikbareLiften`/`eindigtBij`,
 * `komtLangs`, `aansluitendeLiften`) and piste codes (`gaatOverIn`,
 * `splitstNaar`), not by place name. Returns an array of human-readable
 * error strings; empty means acceptable.
 */
function validateDataset(dataset) {
  const errors = [];
  if (!dataset || typeof dataset !== 'object') {
    return ['The dataset must be a JSON object.'];
  }

  if (!Array.isArray(dataset.liften)) {
    errors.push('"liften" is missing or is not an array.');
  } else if (dataset.liften.length === 0) {
    errors.push('"liften" contains no lifts.');
  }
  if (!Array.isArray(dataset.pistes)) {
    errors.push('"pistes" is missing or is not an array.');
  }

  if (errors.length) return errors; // no point checking entries if the top-level shape is already broken

  dataset.liften.forEach((lift, i) => {
    if (!lift || typeof lift !== 'object') { errors.push(`liften[${i}] is not an object.`); return; }
    const label = lift.liftNr || `#${i}`;
    if (!lift.liftNr)      errors.push(`liften[${i}] is missing "liftNr".`);
    if (!lift.vertrektBij) errors.push(`lift ${label} is missing "vertrektBij".`);
    if (!lift.komtAanBij)  errors.push(`lift ${label} is missing "komtAanBij".`);
  });

  const liftNrs = new Set(dataset.liften.map(l => l && l.liftNr).filter(Boolean));
  dataset.liften.forEach(lift => {
    (lift?.aansluitendeLiften || []).forEach(nr => {
      if (!liftNrs.has(nr)) errors.push(`lift ${lift.liftNr} has an aansluitendeLift ("${nr}") that does not exist.`);
    });
  });

  dataset.pistes.forEach((piste, i) => {
    if (!piste || typeof piste !== 'object') { errors.push(`pistes[${i}] is not an object.`); return; }
    const label = piste.pisteNr || `#${i}`;
    if (!piste.pisteNr) errors.push(`pistes[${i}] is missing "pisteNr".`);
    if (piste.tijd == null && piste.lengteM == null) errors.push(`piste ${label} is missing both "tijd" and "lengteM".`);
    // beginBovenBij/bereikbareLiften mogen leeg zijn (bv. een piste die start
    // op een dalstation zonder gekoppelde lift) — zo'n piste levert dan
    // gewoon geen route-edge op, dat is geen datafout. Wel valideren als
    // array áls het veld aanwezig is.
    if (piste.beginBovenBij !== undefined && !Array.isArray(piste.beginBovenBij)) {
      errors.push(`piste ${label}: "beginBovenBij" must be an array.`);
    }
    if (piste.bereikbareLiften !== undefined && !Array.isArray(piste.bereikbareLiften)) {
      errors.push(`piste ${label}: "bereikbareLiften" must be an array.`);
    }
    if (piste.eindigtBij !== undefined && !Array.isArray(piste.eindigtBij)) {
      errors.push(`piste ${label}: "eindigtBij" must be an array.`);
    }
  });

  const pisteNrs = new Set(dataset.pistes.map(p => p && p.pisteNr).filter(Boolean));
  dataset.pistes.forEach(piste => {
    if (!piste) return;
    (piste.beginBovenBij || []).forEach(nr => {
      if (!liftNrs.has(nr)) errors.push(`piste ${piste.pisteNr} has a beginBovenBij lift ("${nr}") that does not exist.`);
    });
    (piste.bereikbareLiften || piste.eindigtBij || []).forEach(nr => {
      if (!liftNrs.has(nr)) errors.push(`piste ${piste.pisteNr} has a reachable lift ("${nr}") that does not exist.`);
    });
    (piste.komtLangs || []).forEach(nr => {
      if (!liftNrs.has(nr)) errors.push(`piste ${piste.pisteNr} has a komtLangs lift ("${nr}") that does not exist.`);
    });
    (piste.gaatOverIn || []).forEach(nr => {
      if (!pisteNrs.has(nr)) errors.push(`piste ${piste.pisteNr} has a gaatOverIn ("${nr}") that does not exist.`);
    });
    (piste.splitstNaar || []).forEach(nr => {
      if (!pisteNrs.has(nr)) errors.push(`piste ${piste.pisteNr} has a splitstNaar ("${nr}") that does not exist.`);
    });
  });

  return errors;
}

function pruneUndefined(obj) {
  const out = {};
  Object.entries(obj || {}).forEach(([k, v]) => { if (v !== undefined) out[k] = v; });
  return out;
}

function toRegistryEntry(id, meta, areaFile) {
  return {
    id,
    name: meta.name || areaFile.name || id,
    subtitle: meta.subtitle ?? areaFile.subtitle ?? '',
    file: `data/${id}.json`,
  };
}

// ── API: areas ───────────────────────────────────────────────────────────────

app.get('/api/areas', async (req, res) => {
  res.json(await readRegistry());
});

// Create a new area (id must not already exist).
app.post('/api/areas', async (req, res) => {
  const { id, name, subtitle, stats, dataset } = req.body || {};

  if (!isValidId(id)) {
    return res.status(400).json({ error: 'Invalid id: use only lowercase letters, digits and hyphens (2-50 characters).' });
  }
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Name is required.' });
  }

  const datasetErrors = validateDataset(dataset);
  if (datasetErrors.length) {
    return res.status(400).json({ error: 'Invalid dataset.', details: datasetErrors });
  }

  const areas = await readRegistry();
  if (areas.some(a => a.id === id)) {
    return res.status(409).json({ error: `Area "${id}" already exists. Use the replace action to update it.` });
  }

  // Spread the raw skimap-reader export as-is (liften, pistes, and whatever
  // provenance fields it carries — gebied, versie, bron, protocol,
  // openVragen, backlog, ...), then layer the admin-curated fields on top.
  const areaFile = {
    ...dataset,
    id,
    name,
    subtitle: subtitle || '',
    stats: { liften: dataset.liften.length, ...pruneUndefined(stats) },
  };

  await fs.writeFile(areaFilePath(id), JSON.stringify(areaFile, null, 2) + '\n', 'utf8');
  areas.push(toRegistryEntry(id, { name, subtitle }, areaFile));
  await writeRegistry(areas);

  res.status(201).json({ ok: true, id });
});

// Replace the dataset (and optionally metadata) of an existing area.
app.put('/api/areas/:id', async (req, res) => {
  const { id } = req.params;
  const { name, subtitle, stats, dataset } = req.body || {};

  if (!isValidId(id)) {
    return res.status(400).json({ error: 'Invalid id.' });
  }

  const areas = await readRegistry();
  const index = areas.findIndex(a => a.id === id);
  if (index === -1) {
    return res.status(404).json({ error: `Area "${id}" does not exist.` });
  }

  const datasetErrors = validateDataset(dataset);
  if (datasetErrors.length) {
    return res.status(400).json({ error: 'Invalid dataset.', details: datasetErrors });
  }

  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(areaFilePath(id), 'utf8'));
  } catch { /* file missing or unreadable — fall back to registry values below */ }

  const areaFile = {
    ...dataset,
    id,
    // A dataset-only replace shouldn't silently rename the area — prefer
    // whatever curated name/subtitle it already has over the dataset's own
    // "gebied" string.
    name: name || existing.name || areas[index].name || dataset.gebied || id,
    subtitle: subtitle ?? existing.subtitle ?? areas[index].subtitle ?? '',
    stats: { liften: dataset.liften.length, ...existing.stats, ...pruneUndefined(stats) },
  };

  await fs.writeFile(areaFilePath(id), JSON.stringify(areaFile, null, 2) + '\n', 'utf8');
  areas[index] = toRegistryEntry(id, { name: areaFile.name, subtitle: areaFile.subtitle }, areaFile);
  await writeRegistry(areas);

  res.json({ ok: true, id });
});

app.delete('/api/areas/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    return res.status(400).json({ error: 'Invalid id.' });
  }

  const areas = await readRegistry();
  const index = areas.findIndex(a => a.id === id);
  if (index === -1) {
    return res.status(404).json({ error: `Area "${id}" does not exist.` });
  }

  areas.splice(index, 1);
  await writeRegistry(areas);
  await fs.rm(areaFilePath(id), { force: true });

  res.json({ ok: true, id });
});

app.listen(port, () => {
  console.log(`Ski Router running on http://localhost:${port}`);
});
