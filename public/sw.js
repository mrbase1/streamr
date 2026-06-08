const CACHE  = 'streamr-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install',  e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  // Only cache GET requests for same-origin assets; stream proxies bypass cache
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache stream data
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
