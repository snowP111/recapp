/* recApp – Service Worker: App offline verfügbar machen.
   App-Dateien: zuerst Netz (damit Updates sofort ankommen), sonst Cache.
   Bibliotheken und Schriften (CDN): zuerst Cache. Supabase-Anfragen laufen nie über den Cache. */
const CACHE = "recapp-v3";
const APP = [
  "./", "index.html", "style.css?v=3", "logik.js?v=3", "app.js?v=3", "config.js", "manifest.webmanifest",
  "icons/icon-192.png?v=2", "icons/apple-touch-icon.png?v=2",
];
const CDN = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.1",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) =>
    Promise.all([...APP, ...CDN].map((u) => c.add(u).catch(() => {})))   // eine fehlende Datei bricht nichts ab
  ).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((namen) => Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;            // Daten: immer live (offline übernimmt die App)

  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then((antwort) => {
        if (antwort.ok) {
          const kopie = antwort.clone();          // sofort klonen – die Seite liest das Original
          caches.open(CACHE).then((c) => c.put(req, kopie));
        }
        return antwort;
      }).catch(() => caches.match(req, { ignoreSearch: req.mode === "navigate" }))
    );
    return;
  }
  // CDN, Schriften (KaTeX-Schriften, Google Fonts): Cache zuerst, sonst laden und merken
  e.respondWith(
    caches.match(req).then((treffer) => treffer || fetch(req).then((antwort) => {
      if (antwort.ok || antwort.type === "opaque") {
        const kopie = antwort.clone();
        caches.open(CACHE).then((c) => c.put(req, kopie));
      }
      return antwort;
    }))
  );
});
