const CACHE_NAME = 'microjoy-v1';
const ASSETS = ['./', './index.html', './manifest.json', './icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => {
    if (k !== CACHE_NAME) return caches.delete(k);
  }))));
});
