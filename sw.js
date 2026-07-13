// sw.js — Service worker minimal untuk SRINAI ASSIST.
//
// SENGAJA tidak melakukan caching data apa pun (halaman, API, dsb). Data di
// aplikasi ini (tower, span, tegakan, BA, chat AI) berubah terus dan harus
// selalu ambil dari server -- caching agresif berisiko menampilkan data basi
// ke petugas lapangan. Service worker ini cuma dipasang supaya browser/APK
// menganggap aplikasi ini "installable" (syarat wajib PWA/TWA), dan
// meng-cache aset statis (ikon) yang memang tidak pernah berubah per rilis.

const CACHE_NAME = "srinai-static-v1";
const STATIC_ASSETS = [
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/icon-maskable-192.png",
  "/assets/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Jangan pernah campur tangan API atau navigasi HTML -- selalu network,
  // supaya data & versi halaman selalu yang terbaru.
  if (url.pathname.startsWith("/api/") || event.request.mode === "navigate") {
    return;
  }

  // Ikon statis saja yang boleh cache-first (tidak pernah berubah per rilis).
  if (STATIC_ASSETS.some((p) => url.pathname === p)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
  // Selain itu, biarkan browser tangani seperti biasa (tidak diintersep).
});
