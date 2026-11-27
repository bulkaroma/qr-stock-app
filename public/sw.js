// Service worker: keeps the app and the camera scanner on the phone so they open
// without a connection. Sheet data is handled by the app itself (see app.js).
const CACHE = 'stock-finder-v4';
const SHELL = ['/', '/app.js', '/locations.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];
const SCANNER = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all([
      ...SHELL.map((url) => cache.add(url).catch(() => {})),
      fetch(SCANNER, { mode: 'cors' }).then((res) => res.ok && cache.put(SCANNER, res)).catch(() => {}),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return; // live data: never cached here
  if (url.hostname === 'cdn.jsdelivr.net') return event.respondWith(cacheFirst(req));
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(req, req.mode === 'navigate' ? '/' : null));
});

// Fixed-version library files never change: use the saved copy when there is one.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

// App files: newest version when the connection is good, saved copy when it's slow or gone.
async function networkFirst(req, fallbackUrl) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  net.catch(() => {});
  try {
    return await Promise.race([net, new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 4000))]);
  } catch {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (fallbackUrl && (await cache.match(fallbackUrl)));
    if (hit) return hit;
    return net.catch(() => new Response('No connection, and this page has not been opened on this phone before.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  }
}
