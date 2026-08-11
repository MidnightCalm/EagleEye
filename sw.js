/* Eagle Eye service worker.

   Same-origin app files are network-first, so a deployed fix is never held back
   by a stale cache. The cache is still written on every successful fetch, which
   keeps a complete offline copy — the point of the whole exercise, since a roof
   in an industrial park is exactly where the signal dies.

   `cache: 'no-cache'` on that fetch is load-bearing, and its absence is a trap
   this worker fell into: network-first defeats the SERVICE WORKER cache, but a
   bare fetch() still consults the browser's HTTP cache first. A static host that
   sends Last-Modified without Cache-Control — python http.server, and plenty of
   real ones — invites heuristic caching, and the worker then serves a stale file
   while looking, in its own logs, like it went to the network. no-cache forces
   revalidation, so an unchanged file still costs only a 304.

   Fonts are cache-first: immutable and versioned by URL. */
const CACHE = 'eagle-eye-1.14.0';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'geo.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

/* The page asks for this when it finds a worker waiting. Belt and braces beside
   the skipWaiting() on install: a worker that installed while an older one was
   still controlling a tab would otherwise sit waiting until every tab closed —
   which, for a home-screen app that is only ever suspended, may be never. */
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === location.origin;
  const isFont = url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com');

  if (!sameOrigin && !isFont) return;

  if (sameOrigin) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))
      )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
