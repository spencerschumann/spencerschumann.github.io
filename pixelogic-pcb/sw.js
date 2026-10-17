// Service worker for the Pixelogic PCB PWA.
//
// Caching goal (per the app's priority): always load the LATEST version when
// online, while still working offline. So the fetch strategy is
// network-first — every navigation and same-origin GET tries the network
// first and only falls back to the cache when the network fails. The cache
// is refreshed from each successful network response, so an offline visit
// serves whatever the last online visit fetched, not a frozen snapshot.
//
// The versioned cache name lets `activate` purge everything from older
// versions. Bump CACHE_VERSION whenever you want to guarantee a clean sweep
// of old cached assets (network-first already keeps content fresh online, so
// this is mostly housekeeping).
//
// BUILD is stamped by scripts/publish.sh with the commit being published, and
// exists purely so this file is byte-different on every publish. A browser
// decides there is an update by byte-comparing sw.js, so a worker that never
// changes means `updatefound` never fires and the app's "New version
// available" toast (see pwa.js) can never appear — which is exactly what
// happened while the app itself changed underneath an unchanged worker. Do
// not remove it because it looks unused.

const CACHE_VERSION = 'v39';
const BUILD = '6a135e1';
const CACHE_NAME = `pixelogic-pcb-${CACHE_VERSION}-${BUILD}`;

const ASSETS = [
    './',
    './index.html',
    './pixelogic-pcb.css',
    './model/arrays.js',
    './model/blocks.js',
    './model/board.js',
    './model/cells.js',
    './model/clips.js',
    './model/edit.js',
    './model/fit.js',
    './model/index.js',
    './model/io.js',
    './model/nets.js',
    './model/rearrange.js',
    './model/regions.js',
    './model/route.js',
    './model/sim.js',
    './storage.js',
    './view.js',
    './levels.js',
    './game.js',
    './timing.js',
    './verify-worker.js',
    './worker-env.js',
    './ui/arrange.js',
    './ui/arrayedit.js',
    './ui/ask.js',
    './ui/campaign.js',
    './ui/canvas.js',
    './ui/clipboard.js',
    './ui/history.js',
    './ui/loop.js',
    './ui/main.js',
    './ui/makepart.js',
    './ui/page.js',
    './ui/scope.js',
    './ui/paint.js',
    './ui/parts.js',
    './ui/prefs.js',
    './ui/stamp.js',
    './ui/toolbar.js',
    './ui/tools.js',
    './ui/verdict.js',
    './pwa.js',
    './manifest.webmanifest',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    './favicon-32.png',
    './favicon-64.png',
];

self.addEventListener('install', (event) => {
    // Precache the shell so the very first offline load works, but don't
    // skipWaiting automatically — the page decides when to activate an update
    // (see pwa.js) so it never swaps out mid-edit without warning.
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => { })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    if (new URL(req.url).origin !== self.location.origin) return;

    event.respondWith((async () => {
        try {
            // 'no-store' keeps the HTTP cache out of the way. Without it the
            // network-first fetch can be answered from the browser's own
            // cache — GitHub Pages serves these files with a max-age — so
            // "tried the network" would quietly mean "read a stale copy".
            // Offline still works: this throws, and the catch serves the
            // Cache Storage copy below.
            const fresh = await fetch(req, { cache: 'no-store' });
            // Cache a copy of every good response so offline has the latest.
            if (fresh && fresh.status === 200 && fresh.type === 'basic') {
                const cache = await caches.open(CACHE_NAME);
                cache.put(req, fresh.clone());
            }
            return fresh;
        } catch (err) {
            const cached = await caches.match(req);
            if (cached) return cached;
            if (req.mode === 'navigate') {
                const shell = await caches.match('./index.html');
                if (shell) return shell;
            }
            throw err;
        }
    })());
});
