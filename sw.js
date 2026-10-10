// Service worker: keeps the planner and every ski area's data on the device,
// so routes can be planned on the mountain without a signal.
//
// - Install: cache the app shell, the area registry and every area file it
//   lists, and the Europe index. A Europe area is cached when first opened.
// - Same-origin requests: network first (so updates arrive when there is a
//   connection), falling back to the cache after a short timeout or when offline.
// - Google Fonts: cache first — they never change.
//
// Bump CACHE_VERSION when the list of shell files changes.

const CACHE_VERSION = 'skirouter-v38';
const SHELL = [
  './',
  'index.html',
  'liftmatch.js',
  'dayplan.js',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'data/areas.json',
];
const NETWORK_TIMEOUT_MS = 3500; // weak mountain signal: don't wait forever

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // 'reload': skip the browser's HTTP cache, so one version of every file.
    await cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    // Every area the registry lists, so any area can be opened offline.
    try {
      const areas = await (await fetch('data/areas.json', { cache: 'no-store' })).json();
      // One by one: a missing file (e.g. no lift status yet) must not stop the rest.
      await Promise.allSettled(areas.flatMap(a => [a.file, a.liftstatus?.file]).filter(Boolean).map(f => cache.add(f)));
      // The Europe list too, so the picker works offline. The areas in it are
      // cached one by one as they are opened (network first, below).
      await cache.add('data/europe/index.json').catch(() => {});
    } catch (err) {
      console.warn('Could not pre-cache area data:', err);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
  } else if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    // 'no-cache': always ask the server (cheap with ETags), never a stale
    // HTTP-cached copy, so app.js, styles.css and index.html stay in step.
    const res = await withTimeout(fetch(req, { cache: 'no-cache' }), NETWORK_TIMEOUT_MS);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    return new Response('Offline and not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
