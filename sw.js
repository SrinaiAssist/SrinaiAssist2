// sw.js — Service worker untuk SRINAI ASSIST.
//
// STRATEGI (selaras dengan js/sync.js):
// - Data lapangan (tower, span, tegakan, BA, chat, akun) TETAP tidak pernah
//   di-cache oleh service worker ini. Itu murni tanggung jawab js/sync.js
//   lewat localStorage + tombol "Sinkron" (syncAll()). SW tidak ikut campur
//   supaya tidak dobel/bentrok dengan mekanisme sync yang sudah ada.
// - Halaman HTML (navigasi) dan aset statis (JS/CSS/ikon): CACHE-FIRST,
//   TANPA revalidate/update diam-diam di background. Begitu suatu halaman
//   pernah berhasil dimuat, versi itu yang dipakai terus -- persis, walau
//   sudah lama -- sampai cache-nya sengaja dibuang (lihat CACHE_VERSION di
//   bawah). Ini supaya perilakunya predictable: tidak ada permintaan network
//   tersembunyi tiap kali user buka halaman, dan tidak ada versi halaman
//   yang tiba-tiba berubah sendiri di tengah pemakaian tanpa user tahu.
// - Satu-satunya pengecualian: kalau halaman/aset itu BELUM PERNAH ada di
//   cache sama sekali, tetap fetch ke network (supaya tidak kosong total di
//   kunjungan pertama / setelah install APK baru).
// - Cara "mensinkronkan" versi app shell (HTML/JS/CSS) yang baru: naikkan
//   CACHE_VERSION di bawah tiap kali rilis. SW akan buang cache lama saat
//   attivate dan fetch ulang versi baru secara alami saat halaman dibuka
//   berikutnya -- ini aksi rilis yang disengaja, bukan silent background
//   refresh per-request.

const CACHE_VERSION = "v4";
const PAGES_CACHE = "srinai-pages-" + CACHE_VERSION;
const STATIC_CACHE = "srinai-static-" + CACHE_VERSION;
const CURRENT_CACHES = [PAGES_CACHE, STATIC_CACHE];

const PRECACHE_ICONS = [
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/icon-maskable-192.png",
  "/assets/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_ICONS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !CURRENT_CACHES.includes(k))
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Cache-first, TANPA revalidate di background: kalau ada di cache, itu yang
// dipakai apa adanya. Cuma fetch ke network kalau memang belum ada cache-nya
// sama sekali.
function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => {
          // Offline & belum pernah dibuka saat online -> tidak ada cadangan.
          if (request.mode === "navigate") {
            return cache.match("/index.html");
          }
          return Response.error();
        });
    })
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Data lapangan (API): jangan pernah diintersep. Selalu network, dan biar
  // js/sync.js yang atur cache/antrian offline-nya sendiri.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Navigasi HTML (buka/pindah halaman).
  if (req.mode === "navigate") {
    event.respondWith(cacheFirst(req, PAGES_CACHE));
    return;
  }

  // Ikon statis, JS, CSS: sama, cache-first.
  const isStaticAsset =
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/assets/") ||
      url.pathname.startsWith("/js/") ||
      url.pathname.startsWith("/css/") ||
      url.pathname.endsWith(".html"));

  if (isStaticAsset) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Selain itu, biarkan browser tangani seperti biasa (tidak diintersep).
});
