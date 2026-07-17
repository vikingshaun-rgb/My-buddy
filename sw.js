// sw.js — SELF-DESTRUCTING. The previous service worker broke standalone launch.
// This version unregisters itself and deletes all caches, then gets out of the way.
// Any phone with the old SW cached will fetch this, which cleans everything up.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll();
    clients.forEach((c) => c.navigate(c.url)); // reload open tabs with the fresh app
  })());
});
// Pass everything straight to the network — never serve a cached shell.
self.addEventListener("fetch", () => {});
