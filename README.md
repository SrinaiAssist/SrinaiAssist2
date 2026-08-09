# SrinaiAssist2

Aplikasi web (Vercel + Neon Postgres) untuk operasional lapangan PLN SUTT
150kV — data jalur, tower, span, tegakan, dan dokumentasi Berita Acara (BA).
Dibungkus jadi APK Android lewat Capacitor/TWA (WebView shell yang selalu
memuat konten live dari Vercel via `server.url`, lihat
`capacitor.config.json` — keputusan disengaja demi auto-update tanpa
rebuild, lihat bagian "Model 3D tower" untuk trade-off & fallback
daruratnya).

## Aturan mengikat: sinkronisasi & cache

Prinsip di bawah ini WAJIB dipatuhi oleh siapa pun (manusia atau AI) yang
mengubah `js/sync.js`, `sw.js`, atau endpoint API terkait sinkron. Ini bukan
saran, ini batasan desain yang sengaja dipilih dan tidak boleh dilanggar
demi alasan apa pun (termasuk "supaya kodenya lebih sederhana").

### 1. Dilarang sinkron diam-diam
Tidak boleh ada permintaan data lapangan (jalur/tower/span/tegakan/BA) yang
terjadi otomatis di background tanpa aksi eksplisit user menekan tombol
**Sinkron**. Ini termasuk: tidak boleh auto-refresh saat cache dianggap
"stale"/lewat TTL, tidak boleh polling berkala, tidak boleh refresh diam-diam
saat halaman dibuka/difokuskan kembali. Kalau cache ada, cache itu yang
dipakai apa adanya — walau sudah lama — sampai user sendiri yang menekan
Sinkron. Tujuannya: user (tim lapangan, sering di lokasi dengan sinyal
terbatas) yang mengontrol kapan kuota terpakai, bukan aplikasi.

Pengecualian satu-satunya: kalau cache untuk suatu data BELUM ADA SAMA
SEKALI (pemakaian pertama / setelah install baru), boleh fetch blocking
supaya halaman tidak kosong total.

### 2. Dilarang hapus/tarik ulang semua data hanya karena 1 perubahan kecil
Kalau server mendeteksi ada perubahan (lewat `?meta=1`: `count` +
`maxUpdatedAt`), proses Sinkron TIDAK BOLEH menarik ulang seluruh tabel dari
nol. Yang benar: tarik HANYA baris yang berubah lewat `?since=<timestamp
sync terakhir>`, upsert per-ID ke cache lama, dan buang ID yang sudah tidak
ada di `activeIds` (baris yang dihapus di server). Cache lama tidak pernah
dibuang total kecuali memang belum pernah ada anchor waktu sinkron
sebelumnya (baseline pertama).

Endpoint API yang butuh dua mode ini: `/api/jalur`, `/api/tower`,
`/api/span`, `/api/ba` (mode ringan `?meta=1` + mode bertahap `?since=`).
`/api/tegakan` pakai pola serupa tapi per-span (`GROUP BY span_id`).

### 3. Soal uninstall APK — batasan yang TIDAK BISA dihindari
`localStorage` dan Cache Storage (dipakai `js/sync.js` dan `sw.js`) adalah
data privat aplikasi Android. Uninstall APK membuat Android menghapus
seluruh direktori data aplikasi itu SEBELUM kode JS sempat berjalan — ini
jaminan level OS, bukan sesuatu yang bisa diatur dari sisi web app. Setelah
install ulang / ganti HP / hapus data app, cache lokal PASTI kosong dan
Sinkron pertama PASTI menarik data penuh sebagai baseline — ini bukan bug
dan tidak perlu "diperbaiki".

Yang justru harus dijaga: skenario di atas HARUS TETAP jadi satu-satunya
alasan sah untuk full pull. Perubahan kode di masa depan tidak boleh
menambah alasan lain (mis. ganti format penanda sinkron tanpa jalur
kompatibilitas mundur) yang memicu full pull padahal HP-nya sebenarnya
masih punya cache valid. Kalau format data sinkron internal perlu diubah,
WAJIB sediakan jalur baca format lama supaya sync pertama setelah update
kode tetap incremental, bukan full pull.

### 4. Sumber kebenaran tetap di server
Neon Postgres adalah sumber kebenaran. Cache lokal (localStorage) murni
optimisasi kecepatan & kuota, bukan tempat penyimpanan utama. Kehilangan
cache lokal (uninstall, ganti HP, dsb.) tidak pernah berarti kehilangan
data — cuma berarti perlu satu kali Sinkron manual untuk membangun ulang
cache dari server.

### 5. Cache per-akun harus bertahan saat logout maupun ganti akun
`logoutUser()` (di `js/auth.js`) DILARANG memanggil `clearAllCache()` atau
menghapus key `srinai_cache_*` mana pun. Logout hanya boleh menghapus
penanda sesi (`srinaiUser`, `srinaiRole`, `loginTime`, dsb.) — bukan data
sinkron. Semua key cache di `js/sync.js` sudah dinamespace per-user lewat
`_scopedKey()` (`srinai_cache_jalur::u:<username>`), jadi cache akun A dan
akun B tidak akan tertukar walau dipakai bergantian di HP yang sama. Login
ulang dengan akun yang sama HARUS langsung dapat cache lamanya kembali,
tanpa perlu Sinkron ulang. `clearAllCache()` cuma boleh terpanggil dari aksi
manual eksplisit user (mis. tombol "reset cache" di pengaturan), tidak
pernah otomatis lewat alur logout/switch akun.

### 6. Service worker: cache-first murni, DILARANG stale-while-revalidate
`sw.js` meng-cache app shell (halaman HTML + JS/CSS/aset statis, lihat
`PRECACHE_PAGES`/`PRECACHE_STATIC`) dengan strategi cache-first tanpa
revalidate diam-diam di background. Begitu suatu request ada di cache,
versi itu yang dipakai apa adanya sampai `CACHE_VERSION` dinaikkan — TIDAK
boleh diubah jadi stale-while-revalidate atau pola lain yang tetap fetch ke
network "buat jaga-jaga ada versi baru" walau hasilnya nanti dibuang. Alasan
sama persis dengan aturan #1: tiap request jaringan yang terjadi tanpa aksi
eksplisit user (termasuk yang cuma dipakai buat cek "apakah sudah beda")
tetap menghabiskan Fast Origin Transfer, walau responsnya tidak dipakai.

Konsekuensi yang harus dipahami dan diterima: perubahan kode (HTML/JS/CSS)
TIDAK otomatis sampai ke user yang sudah pernah buka app-nya, sampai
`CACHE_VERSION` di `sw.js` dinaikkan saat rilis. Ini trade-off yang
disengaja demi offline-first + hemat kuota, bukan bug.

Efek sampingnya: karena semua 33 halaman + aset statis di-precache saat SW
pertama kali install, aplikasi sudah bisa dipakai penuh secara offline
(navigasi antar halaman, buka semua menu) begitu APK sempat online sekali.
Yang tetap butuh koneksi hanya data lapangan lewat `/api/*` (sengaja tidak
diintersep SW — itu urusan `js/sync.js` + tombol Sinkron, lihat aturan #1).

## Model 3D tower (carousel `tower.html`)

Carousel `tower.html` menampilkan 1 model 3D generik
(`resources/Tower_3d_final.glb`, ~250KB setelah resize tekstur + kompresi
Draco) yang dipakai ulang untuk render kartu tower (bukan model unik per
tower — semua tower, berapa pun jumlahnya, pakai file yang sama).

**Keputusan hosting (Agu 2026): Opsi B dipilih.** File tetap disajikan
lewat Vercel (bukan Google Drive), dan `server` di `capacitor.config.json`
TETAP dipertahankan mengarah ke domain live (lihat bagian atas README).
Konsekuensinya: model 3D di-fetch dari server baik lewat web maupun APK,
karena `server.url` Capacitor bersifat all-or-nothing — tidak ada cara
memisahkan "file ini dari lokal, file itu dari server" lewat config.
Ini diterima sebagai trade-off karena filenya kecil (~250KB) dan sudah
efektif di-cache browser setelah fetch pertama per sesi (URL sama di
semua kartu → 1 request jaringan, sisanya dari cache).

### Fallback darurat: Opsi A
Kalau FOT Vercel atau beban server menyentuh **90% dari kuota bulanan**,
aktifkan Opsi A sebagai langkah darurat sampai persentasenya turun lagi:

- Hapus blok `server` dari `capacitor.config.json` (nonaktifkan
  live-reload) supaya APK jalan dari bundle lokal (`webDir: "www"`) —
  model 3D dan seluruh app shell APK jadi nol network call
- Konsekuensi: user APK TIDAK lagi otomatis dapat update konten; setiap
  rilis harus rebuild APK lewat GitHub Actions dan user install ulang
- Ini murni langkah darurat sementara, bukan default — begitu FOT/beban
  server kembali normal, boleh dikembalikan ke Opsi B (`server.url` live)

## Struktur singkat

- `api/*.js` — 12 serverless functions (Vercel Hobby: limit 12, sudah pas;
  endpoint baru harus digabung ke file existing, bukan file baru)
- `js/auth.js` — API client + helper data
- `js/sync.js` — cache layer localStorage + incremental sync (lihat aturan
  di atas)
- `sw.js` — service worker, cache-first murni untuk app shell (HTML/JS/CSS),
  TIDAK PERNAH mengintersep `/api/*` (itu urusan `js/sync.js` sendiri).
  Naikkan `CACHE_VERSION` di setiap rilis supaya app shell lama dibuang.
- `scripts/schema.sql` — sumber kebenaran skema DB, idempotent (aman
  dijalankan ulang kapan saja)
