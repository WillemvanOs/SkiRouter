// ── Status banner ────────────────────────────────────────────────────────────

function showStatus(message, type = 'info', details = []) {
  const card = document.getElementById('status-card');
  const body = document.getElementById('status-message');
  card.className = type;
  card.style.display = 'block';

  let html = `<div>${message}</div>`;
  if (details.length) {
    html += `<ul>${details.map(d => `<li>${d}</li>`).join('')}</ul>`;
  }
  body.innerHTML = html;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── File reading ─────────────────────────────────────────────────────────────

function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('No file selected.')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch {
        reject(new Error(`"${file.name}" is not valid JSON.`));
      }
    };
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsText(file);
  });
}

// ── API calls ────────────────────────────────────────────────────────────────

async function apiRequest(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Server responded with ${response.status}`);
    err.details = data.details || [];
    throw err;
  }
  return data;
}

// ── Area list ────────────────────────────────────────────────────────────────

async function loadAreas() {
  const listEl = document.getElementById('area-manage-list');
  try {
    const areas = await apiRequest('GET', '/api/areas');
    renderAreaManageList(areas);
  } catch (err) {
    listEl.innerHTML = `<div class="area-error">⚠ Areas could not be loaded: ${err.message}</div>`;
  }
}

function renderAreaManageList(areas) {
  const listEl = document.getElementById('area-manage-list');
  listEl.innerHTML = '';

  if (!areas.length) {
    listEl.innerHTML = '<div class="area-loading">No areas yet. Add one below.</div>';
    return;
  }

  areas.forEach(area => {
    const item = document.createElement('div');
    item.className = 'area-manage-item';
    item.innerHTML = `
      <div class="area-manage-name">🏔 ${area.name}</div>
      <div class="area-manage-sub">${area.subtitle || area.id}</div>
      <div class="area-manage-actions">
        <input type="file" accept="application/json,.json" id="replace-file-${area.id}">
        <button class="btn-small" data-action="replace" data-id="${area.id}">Replace dataset</button>
        <button class="btn-small danger" data-action="delete" data-id="${area.id}">Delete</button>
      </div>
    `;
    listEl.appendChild(item);
  });

  listEl.querySelectorAll('[data-action="replace"]').forEach(btn => {
    btn.addEventListener('click', () => replaceDataset(btn.dataset.id, btn));
  });
  listEl.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteArea(btn.dataset.id, btn));
  });
}

async function replaceDataset(id, triggerBtn) {
  const fileInput = document.getElementById(`replace-file-${id}`);
  const file = fileInput.files[0];
  if (!file) {
    showStatus(`First choose a JSON file to update "${id}".`, 'error');
    return;
  }

  triggerBtn.disabled = true;
  try {
    const dataset = await readJsonFile(file);
    await apiRequest('PUT', `/api/areas/${encodeURIComponent(id)}`, { dataset });
    showStatus(`✅ The dataset of "${id}" has been updated.`, 'success');
    fileInput.value = '';
  } catch (err) {
    showStatus(`⚠ Updating "${id}" failed: ${err.message}`, 'error', err.details || []);
  } finally {
    triggerBtn.disabled = false;
  }
}

async function deleteArea(id, triggerBtn) {
  if (!confirm(`Are you sure you want to delete "${id}"? This cannot be undone.`)) return;

  triggerBtn.disabled = true;
  try {
    await apiRequest('DELETE', `/api/areas/${encodeURIComponent(id)}`);
    showStatus(`🗑 Area "${id}" has been deleted.`, 'success');
    await loadAreas();
  } catch (err) {
    showStatus(`⚠ Deleting "${id}" failed: ${err.message}`, 'error');
    triggerBtn.disabled = false;
  }
}

// ── New area form ────────────────────────────────────────────────────────────

document.getElementById('new-area-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const fd = new FormData(form);

  const id       = fd.get('id').trim().toLowerCase();
  const name     = fd.get('name').trim();
  const subtitle = fd.get('subtitle').trim();
  const pistesKm = fd.get('pistesKm') ? Number(fd.get('pistesKm')) : undefined;
  const liften   = fd.get('liften')   ? Number(fd.get('liften'))   : undefined;
  const hoogte   = fd.get('hoogte').trim();
  const file     = document.getElementById('new-file').files[0];

  submitBtn.disabled = true;
  try {
    const dataset = await readJsonFile(file);
    await apiRequest('POST', '/api/areas', {
      id,
      name,
      subtitle,
      stats: { pistesKm, liften, hoogte: hoogte || undefined },
      dataset,
    });
    showStatus(`✅ Area "${name}" has been added.`, 'success');
    form.reset();
    await loadAreas();
  } catch (err) {
    showStatus(`⚠ Adding failed: ${err.message}`, 'error', err.details || []);
  } finally {
    submitBtn.disabled = false;
  }
});

loadAreas();
