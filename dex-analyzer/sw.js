/* OTR Analyzer — minimal offline-capable service worker */
const CACHE = 'otr-analyzer-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.min.css',
  'https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.iife.min.js',
  'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&family=Barlow+Condensed:wght@500;700;800;900&display=swap',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>{}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        // opportunistically cache same-origin and CDN assets
        if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        }
        return res;
      }).catch(() => hit);
    })
  );
});
