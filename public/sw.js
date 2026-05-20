const CACHE = 'camnet-v13';
const PRECACHE = [
  '/',
  '/viewer.html',
  '/camera.html',
  '/css/app.css',
  '/js/viewer.js',
  '/js/camera.js',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' })))
  );
});

const CACHE_MAX = 50;

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length > CACHE_MAX) {
    await Promise.all(keys.slice(0, keys.length - CACHE_MAX).map(k => cache.delete(k)));
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Skip API calls and WebSocket upgrades — always hit the network
  if (url.pathname.startsWith('/api/') || url.protocol === 'ws:' || url.protocol === 'wss:') return;

  // Never intercept URLs with query params (join links carry room code + nonce —
  // must always reach the network fresh, never served from or stored in cache).
  if (url.search) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network-first for everything else: try the server, fall back to cache if offline
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          caches.open(CACHE).then(c => { c.put(e.request, res.clone()); trimCache(c); });
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(cached =>
        cached ?? new Response('Offline — open the app while connected to your LAN first.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        })
      ))
  );
});
