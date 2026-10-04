// Cello Coach is now Tonalivo, at ../tonalivo/. This worker replaces the old
// one: it removes the old app's offline copy, unregisters itself, and sends
// any open page to the new address.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('cello-coach-app-')) await caches.delete(key);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url.replace('/cello-coach/', '/tonalivo/'));
    })(),
  );
});
