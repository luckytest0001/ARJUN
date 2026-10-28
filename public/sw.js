// IPTV Player Service Worker for GitHub Pages Static Deployment
const CACHE_NAME = 'iptv-player-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const reqUrl = event.request.url;

  // 1. Let API proxy and stream requests pass directly to the network / backend server without interception
  if (reqUrl.includes('/api/')) {
    return;
  }

  // 2. Default fetch with SPA fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match('./index.html') || await cache.match('/index.html');
        if (cached) return cached;
        return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      })
    );
    return;
  }
});
