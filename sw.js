/* Eagle Eye service worker.

   Same-origin app files are network-first, so a deployed fix is never held back
   by a stale cache. The cache is still written on every successful fetch, which
   keeps a complete offline copy — the point of the whole exercise, since a roof
   in an industrial park is exactly where the signal dies.

   Fonts are cache-first: immutable and versioned by URL. */
const CACHE = 'eagle-eye-1.0.0';
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
      fetch(e.request).then(res => {
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
