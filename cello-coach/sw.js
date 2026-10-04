// Cello Coach service worker: lets the app open and run without a network
// connection. The build (vite.config.ts) fills in the version and the list of
// files to keep; each release gets its own cache.
const VERSION = "aca0e26c1275";
const PRECACHE = [
  "./",
  "./assets/analysis.worker-CiFSDVqL.js",
  "./assets/main-BsjGOq_k.js",
  "./assets/probe-CWza_Uhw.js",
  "./assets/style-BpcSHmst.css",
  "./assets/style-CmANw_JE.js",
  "./capture-processor.js",
  "./icon-192.png",
  "./icon-512.png",
  "./icon.svg",
  "./index.html",
  "./manifest.webmanifest",
  "./pulse-probe.html"
];
const CACHE = `cello-coach-app-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop the caches of earlier releases (not the piano samples, which have their own cache).
      for (const key of await caches.keys()) if (key.startsWith('cello-coach-app-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

/**
 * Put back any files missing from the cache. Other apps on the same origin
 * (e.g. on GitHub Pages under one user's site) may clear every cache but their
 * own when they update; the page asks for this on each visit, so the app is
 * ready offline again after the next visit online.
 */
async function repair() {
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const url of PRECACHE) if (!(await cache.match(url, { ignoreVary: true }))) missing.push(url);
  if (missing.length) await cache.addAll(missing.map((url) => new Request(url, { cache: 'reload' })));
  return missing.length;
}

self.addEventListener('message', (event) => {
  // The page asks the waiting new version to take over when the user chooses to reload.
  if (event.data === 'skip-waiting') self.skipWaiting();
  if (event.data === 'repair') {
    event.waitUntil(
      repair().then(
        (n) => event.source?.postMessage({ type: 'repaired', restored: n }),
        () => event.source?.postMessage({ type: 'repaired', error: true }),
      ),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Other sites (e.g. the piano samples, cached by the piano player itself) go to the network.
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Pages from the cache (so they open offline); any other address is the app, index.html.
    event.respondWith(
      (async () =>
        (await caches.match(req, { cacheName: CACHE, ignoreSearch: true, ignoreVary: true })) ??
        (await caches.match('./index.html', { cacheName: CACHE, ignoreVary: true })) ??
        fetch(req))(),
    );
    return;
  }
  event.respondWith(
    (async () => {
      const hit = await caches.match(req, { cacheName: CACHE, ignoreSearch: true, ignoreVary: true });
      return hit ?? fetch(req);
    })(),
  );
});
