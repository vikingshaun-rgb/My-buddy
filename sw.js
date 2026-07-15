// sw.js — minimal service worker so the app is installable and the shell loads offline.
const CACHE = "aperture-v1";
const SHELL = ["./app.html", "./icon.svg", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for the shell; network for API calls (never cache proxy responses).
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.match(/\/(vision|chat|translate|directions|places|flight|weather|currency|health|summarize)$/)) {
    return; // let API calls hit the network directly
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
