// sw.js — Service worker untuk SRINAI ASSIST.
//
// STRATEGI (selaras dengan js/sync.js):
// - Data lapangan (tower, span, tegakan, BA, chat, akun) TETAP tidak pernah
//   di-cache oleh service worker ini. Itu murni tanggung jawab js/sync.js
//   lewat localStorage + tombol "Sinkron" (syncAll()). SW tidak ikut campur
//   supaya tidak dobel/bentrok dengan mekanisme sync yang sudah ada.
// - Halaman HTML (navigasi) dan aset statis (JS/CSS/ikon/gambar): SEMUA
//   di-PRECACHE saat SW pertama kali install (lihat PRECACHE_URLS di bawah),
//   bukan cuma menunggu user buka satu-satu secara lazy. Jadi begitu APK
//   sempat online sebentar (biasanya langsung saat install/buka pertama),
//   seluruh halaman sudah tersedia offline -- termasuk halaman yang belum
//   pernah dikunjungi user secara manual.
// - Setelah precache, strateginya tetap CACHE-FIRST, TANPA revalidate diam-
//   diam di background. Begitu suatu halaman/aset ada di cache, versi itu
//   yang dipakai terus -- persis, walau sudah lama -- sampai cache-nya
//   sengaja dibuang (lihat CACHE_VERSION). Ini supaya perilakunya
//   predictable: tidak ada permintaan network tersembunyi tiap kali user
//   buka halaman, dan tidak ada versi halaman yang tiba-tiba berubah
//   sendiri di tengah pemakaian tanpa user tahu.
// - Kalau ada aset yang GAGAL di-precache (mis. gagal fetch sekali saat
//   install), itu tidak menggagalkan seluruh install SW -- fallback lama
//   (fetch on-demand + simpan ke cache) tetap jalan untuk aset itu di
//   kunjungan online berikutnya.
// - Cara "mensinkronkan" versi app shell (HTML/JS/CSS/aset) yang baru:
//   naikkan CACHE_VERSION di bawah tiap kali rilis. SW akan precache ulang
//   semuanya dan buang cache lama saat activate -- ini aksi rilis yang
//   disengaja, bukan silent background refresh per-request.

const CACHE_VERSION = "v7";
const PAGES_CACHE = "srinai-pages-" + CACHE_VERSION;
const STATIC_CACHE = "srinai-static-" + CACHE_VERSION;
const CURRENT_CACHES = [PAGES_CACHE, STATIC_CACHE];

// Semua halaman HTML yang harus tersedia offline sejak awal.
const PRECACHE_PAGES = [
  "/admin-storage-db.html",
  "/admin-storage-drive.html",
  "/admin-storage-vercel.html",
  "/ai.html",
  "/artikel-publik.html",
  "/artikel.html",
  "/catatan-span.html",
  "/catatan-tower.html",
  "/catatan.html",
  "/command-bot.html",
  "/dashboard.html",
  "/foto-eviden.html",
  "/generate-barcode.html",
  "/index.html",
  "/informasi-span.html",
  "/jadwal.html",
  "/kelola-akun.html",
  "/log-aktivitas.html",
  "/log-login.html",
  "/master-jalur.html",
  "/master-span.html",
  "/master-tower.html",
  "/pengaturan-ba.html",
  "/pengaturan.html",
  "/peta.html",
  "/profile.html",
  "/scan-barcode.html",
  "/sos.html",
  "/span.html",
  "/telegram.html",
  "/tower.html",
  "/workspace-command.html",
];

// Semua JS/CSS/gambar/ikon (aset statis, bukan data) yang harus tersedia
// offline sejak awal.
const PRECACHE_STATIC = [
  "/js/auth.js",
  "/js/back-nav.js",
  "/js/choco-font.js",
  "/js/offline-map.js",
  "/js/sync.js",
  "/js/theme-loader.js",
  "/css/theme-fieldlog.css",
  "/assets/icon.png",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/icon-maskable-192.png",
  "/assets/icons/icon-maskable-512.png",
  "/assets/icons/favicon-32.png",
  "/assets/img/aurora-gold.png",
  "/assets/img/brand-logo-animasi.webp",
  "/assets/img/bg-aurora-frame.jpg",
  "/assets/img/srinai-robot.png",
  "/assets/audio/Notifikasi-female-telegram.mp3",
  "/assets/audio/chat-reply.wav",
  "/manifest.json",
];

// cache.addAll() gagal TOTAL kalau satu saja URL gagal di-fetch. Supaya satu
// aset yang hilang/berubah nama tidak menggagalkan precache aset lainnya,
// tambahkan satu-satu dan biarkan yang gagal cuma di-skip (dengan warning).
function precacheAll(cacheName, urls) {
  return caches.open(cacheName).then((cache) =>
    Promise.all(
      urls.map((url) =>
        fetch(url, { cache: "reload" })
          .then((response) => {
            if (response && response.ok) {
              return cache.put(url, response);
            }
          })
          .catch((err) => {
            console.warn("Gagal precache:", url, err);
          })
      )
    )
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      precacheAll(PAGES_CACHE, PRECACHE_PAGES),
      precacheAll(STATIC_CACHE, PRECACHE_STATIC),
    ])
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
