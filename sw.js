/* 1KZARIKI · service worker
   Стратегия: cache-first для app-shell и CDN, рантайм-кэш для шрифтов.
   ВАЖНО: при каждом релизе меняй версию в CACHE — это триггерит обновление кэша. */
const CACHE = '1kzariki-v1';

// то, что кладём в кэш на установке (локальное + CDN-скрипты с CORS)
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.6/babel.min.js'
];

// хосты, которые разрешаем докэшировать на лету (шрифты подтягиваются хешированными URL)
const RUNTIME = /cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(CORE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          const url = new URL(req.url);
          const sameOrigin = url.origin === self.location.origin;
          const cacheable = sameOrigin || RUNTIME.test(url.host);
          if (cacheable && res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // офлайн: для навигаций отдаём оболочку
          if (req.mode === 'navigate') return caches.match('./index.html');
        });
    })
  );
});
