/* WiFi Heatmap Architect - service worker (SPEC 6.3).
 * GENERATED: `node build.mjs` writes the root sw.js from src/pwa/sw.js - edit the source, not the copy.
 *
 * Only registered when the app is served over http(s) (GitHub Pages, a local server); file:// never sees it.
 *   - install:  precache the app shell (both HTML files, the manifest, the icons) under a versioned cache name
 *   - activate: delete older caches of THIS app only (the origin may host other apps), then take control of open tabs
 *   - fetch:    same-origin GET -> cache first (a folder URL such as ./ means index.html), network as a fallback
 *               cross-origin (the speed test against speed.cloudflare.com) and non-GET -> untouched: network only,
 *               never cached
 *   - message:  {type:'SKIP_WAITING'} from the page ("A new version is available - Reload") activates a waiting update
 */
'use strict';

const VERSION = '66bf674460';
const PREFIX = 'wifi-heatmap-architect-';
const CACHE = `${PREFIX}${VERSION}`;
const PRECACHE = ["index.cs.html","index.html","manifest.webmanifest","assets/icon-192.png","assets/icon-512.png","assets/icon-maskable-512.png","assets/apple-touch-icon.png"];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache:'reload' skips the HTTP cache, so a new version never precaches a stale copy of a file
    await cache.addAll(PRECACHE.map((file) => new Request(file, { cache: 'reload' })));
  })());
  // No skipWaiting() here: a new version waits until the page asks for it (update toast), so a running session is
  // never switched to different code under the user's hands.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Absolute URL of the cached copy for a same-origin request URL ('…/' -> '…/index.html'). */
function cacheKey(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  if (u.pathname.endsWith('/')) u.pathname += 'index.html';
  return u.href;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                                   // e.g. the speed-test upload: network only
  if (new URL(req.url).origin !== self.location.origin) return;       // cross-origin (speed test): network only, never cached
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(cacheKey(req.url), { ignoreSearch: true, ignoreVary: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      // offline and not precached: a page navigation still gets the app (English file; it switches to Czech by itself)
      if (req.mode === 'navigate') {
        const shell = await cache.match(new URL('index.html', self.registration.scope).href, { ignoreVary: true });
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
