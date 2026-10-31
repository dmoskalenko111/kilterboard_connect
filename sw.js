// Offline copy of the app. The page and its icons are kept on the phone and served from there,
// with or without internet. A new version is downloaded in the background when online and takes over
// on the next launch (after the app has been fully closed), or at once via «Обновить сейчас».
// Nothing is sent anywhere: the worker only stores this site's own files and the fonts the page uses.
const VERSION = "99995a019d0f";
const CACHE = "kilter-twister-" + VERSION;
const FONTS = "kilter-twister-fonts";
const FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONTS).map((k) => caches.delete(k)))));
});
self.addEventListener("message", (e) => { if (e.data === "update-now") self.skipWaiting(); });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.searchParams.has("check")) {
    // the weekly update check must reach the site, never the stored copy
    e.respondWith(fetch(req, { cache: "no-store" }));
  } else if (url.origin === location.origin) {
    // the app itself: always the stored copy of this version (pages open as "./")
    const key = req.mode === "navigate" ? "./" : req;
    e.respondWith(caches.open(CACHE).then((c) => c.match(key, { ignoreSearch: true }).then((hit) => hit || fetch(req))));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    // fonts: stored on first use; without internet the page falls back to system fonts anyway
    e.respondWith(caches.open(FONTS).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }))));
  }
});
