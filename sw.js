// sw.js — minimal service worker so the app is installable and the shell loads offline.
const CACHE = "buddy-v2";
const SHELL = ["/app.html", "/icon-180.png", "/icon-512.png", "/manifest.json"];

self.addEventListener("install", (e) => {
  // Cache the shell, but don't fail install if one item is missing.
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(SHELL.map((u) => c.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for the shell; always network for API calls (never cache proxy responses).
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never intercept cross-origin (the brain/proxy) or API-style paths.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.match(/\/(vision|chat|translate|directions|places|flight|weather|currency|health|summarize|route|scamcheck|allergy|unlost|gooddeal|planday|converse|etiquette|landmark|survival|pair|share|room|frame|sms|mail)/)) {
    return; // let API calls hit the network directly
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
