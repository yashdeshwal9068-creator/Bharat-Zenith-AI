/**
 * Bharat Nova AI — Service Worker
 * Basic offline-fallback caching so PWABuilder detects a valid SW
 * and the app shell loads even with no network connection.
 * API calls (/api/server) are always network-only — never cached,
 * since chat responses must always be fresh.
 */

const CACHE_NAME = 'bharat-nova-ai-v2';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.png',
  '/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

/* Lets the page (script.js) force this waiting worker to activate
   immediately, instead of staying queued until every open tab closes.
   This ONLY swaps which code is controlling network requests — it never
   touches localStorage/sessionStorage, so logged-in sessions are safe. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never cache API calls — chat responses must always be live.
  if (req.method !== 'GET' || req.url.includes('/api/')) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match('/index.html'));
    })
  );
});
