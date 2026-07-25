/* =========================================================
   SRINAI ASSIST — SYNC.JS
   Cache layer: semua data API disimpan ke localStorage agar
   halaman terasa cepat (baca cache dulu).

   PENTING (revisi): cache yang sudah "stale" (lewat TTL) TIDAK
   lagi dipicu refresh otomatis diam-diam di background. Kalau
   cache ada, cache itu yang dipakai apa adanya -- walau sudah
   lama -- sampai user sendiri menekan tombol Sinkron (syncAll()).
   Ini supaya tiap akun tidak diam-diam menghabiskan kuota/koneksi
   tiap buka halaman, dan supaya kapan data "resmi" diperbarui
   selalu jelas dan bisa dikontrol user, bukan tiba-tiba berubah
   sendiri di tengah pemakaian. Satu-satunya pengecualian: kalau
   BELUM ADA cache sama sekali, tetap fetch (blocking) supaya
   halaman tidak kosong total di pemakaian pertama.

   CARA PAKAI:
   1. Sertakan SETELAH auth.js di setiap halaman:
        <script src="js/sync.js"></script>
   2. Ganti pemanggilan fungsi async di auth.js dengan versi
      cached di bawah (nama sama + prefiks "cached"):
        cachedGetFullProfile(username)
        cachedGetJalurMasterList()
        cachedGetTowerMasterList(jalurId?)
        cachedGetSpanMasterList(jalurId?)
        cachedGetAllAccountsFull()
        cachedGetAllBA()
        cachedGetAppSetting(key)
   3. Tombol Sinkron di dashboard memanggil syncAll().
   4. Data baru (tegakan, BA, catatan) disimpan ke antrian
      pending dulu lewat queuePendingWrite(type, payload),
      lalu dikirim saat syncPending() dipanggil.
========================================================= */

/* ─── Konfigurasi ─────────────────────────────────────── */
const SYNC_VERSION  = 1;                // naikkan bila struktur cache berubah
const SYNC_TTL_MS   = 30 * 60 * 1000;  // 30 menit — cache dianggap segar
const SYNC_KEY_META = "srinai_sync_meta";

/* ─── Key localStorage ────────────────────────────────── */
const CACHE_KEYS = {
  accounts  : "srinai_cache_accounts",
  jalur     : "srinai_cache_jalur",
  tower     : "srinai_cache_tower",
  span      : "srinai_cache_span",
  ba        : "srinai_cache_ba",
  tegakanAll: "srinai_cache_tegakan_all",
  settings  : "srinai_cache_settings",
  pending   : "srinai_cache_pending",
  // per-span: kunci dinamis pakai helper di bawah
};

/* Key dinamis per span — TTL lebih pendek (5 mnt) karena data lebih sering berubah */
const SPAN_CACHE_TTL_MS = 5 * 60 * 1000;
function _spanTegakanKey(spanId) { return "srinai_cache_tegakan_" + spanId; }
function _spanCatatanKey(spanId) { return "srinai_cache_catatan_"  + spanId; }
function _spanCacheStale(key) {
  const obj = _cacheGet(key);
  if (!obj) return true;
  return (Date.now() - obj.ts) > SPAN_CACHE_TTL_MS;
}

/* Key dinamis per user untuk foto profil — TTL panjang (24 jam) karena
   foto jarang berubah, tidak seperti data akun lain (tower/span/jalur).
   Dipisah dari CACHE_KEYS.accounts supaya tidak ikut kadaluarsa tiap 30 mnt
   dan tidak perlu download ulang dari Google Drive tiap buka dashboard. */
const FOTO_CACHE_PREFIX = "srinai_cache_foto_";
const FOTO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// TTL jauh lebih pendek khusus untuk hasil KOSONG. Kalau foto kosong karena
// benar-benar belum pernah upload, ini cuma bikin sedikit lebih sering
// dicek ulang (murah, cuma 1 akun). Tapi kalau kosong itu SEBENARNYA gara-gara
// server gagal download dari Google Drive sesaat (lihat resolveFotoForRead di
// api/accounts.js), foto akan otomatis "pulih" dalam hitungan menit alih-alih
// nyangkut kosong selama 24 jam penuh.
const FOTO_EMPTY_CACHE_TTL_MS = 5 * 60 * 1000;
function _fotoProfilKey(username) { return FOTO_CACHE_PREFIX + username; }

/* ═══════════════════════════════════════════════════════
   UTILITAS CACHE
═══════════════════════════════════════════════════════ */
function _cacheSet(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch(e) {
    console.warn("[sync] localStorage full, skip cache:", key);
  }
}

function _cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.data === undefined) return null;
    return obj; // { ts, data }
  } catch(e) {
    return null;
  }
}

function _cacheGetData(key) {
  const obj = _cacheGet(key);
  return obj ? obj.data : null;
}

function _cacheStale(key) {
  const obj = _cacheGet(key);
  if (!obj) return true;
  return (Date.now() - obj.ts) > SYNC_TTL_MS;
}

function _cacheClear(key) {
  localStorage.removeItem(key);
}

/* ═══════════════════════════════════════════════════════
   FUNGSI CACHED — pengganti fungsi di auth.js
   Strategi: cache-first, refresh di background kalau stale.
═══════════════════════════════════════════════════════ */

/**
 * Ambil semua akun. Jika cache segar, langsung pakai.
 * Jika stale, kembalikan cache sambil fetch di background.
 */
async function cachedGetAllAccountsFull() {
  const cached = _cacheGetData(CACHE_KEYS.accounts);
  // Cache lama TETAP dipakai walau sudah "stale" -- TIDAK ada fetch diam-diam
  // di background lagi. Data baru cuma masuk lewat syncAll() (tombol Sinkron)
  // atau invalidate eksplisit setelah user sendiri mengubah data.
  if (cached) return cached;
  // Belum ada cache sama sekali — fetch sekarang (blocking pertama kali).
  return await _refreshAccounts();
}

async function _refreshAccounts() {
  try {
    const data = await getAllAccountsFull();
    if (data && data.length >= 0) _cacheSet(CACHE_KEYS.accounts, data);
    return data;
  } catch(e) {
    return _cacheGetData(CACHE_KEYS.accounts) || [];
  }
}

/* ═══════════════════════════════════════════════════════
   FOTO PROFIL — cache khusus, terpisah dari cache akun.
   TTL 24 jam supaya foto tidak fetch ulang dari Neon/Drive
   tiap buka dashboard, walau cache akun (30 mnt) sudah stale.
═══════════════════════════════════════════════════════ */

/**
 * Ambil foto profil satu user, cache-first (localStorage, base64).
 * - Kalau cache foto masih segar (<24 jam) -> langsung pakai, TANPA request.
 * - Kalau tidak ada / stale -> coba ambil dari cache akun yang masih segar
 *   dulu (hindari request baru), baru kalau tidak ada, fetch 1 akun saja
 *   lewat /api/accounts?username=... (bukan seluruh daftar akun).
 */
async function cachedGetFotoProfil(username) {
  const key = _fotoProfilKey(username);
  const cached = _cacheGet(key);
  if (cached) {
    const ttl = cached.data ? FOTO_CACHE_TTL_MS : FOTO_EMPTY_CACHE_TTL_MS;
    if ((Date.now() - cached.ts) <= ttl) {
      return cached.data || "";
    }
  }

  // Coba pakai cache akun yang masih segar dulu supaya tidak dobel request
  const freshAccounts = !_cacheStale(CACHE_KEYS.accounts) ? _cacheGetData(CACHE_KEYS.accounts) : null;
  if (freshAccounts) {
    const acc = freshAccounts.find(a => a.username === username);
    if (acc) {
      _cacheSet(key, acc.foto || "");
      return acc.foto || "";
    }
  }

  // Fallback: fetch ringan, 1 akun saja (bukan seluruh daftar)
  try {
    const result = await apiRequest("/api/accounts?username=" + encodeURIComponent(username));
    const acc = result && result.success && result.accounts ? result.accounts[0] : null;
    const foto = acc ? (acc.foto || "") : "";
    _cacheSet(key, foto);
    return foto;
  } catch(e) {
    // Kalau gagal & ada cache lama (walau stale), lebih baik daripada kosong
    return cached ? (cached.data || "") : "";
  }
}

/** Simpan foto ke cache langsung — panggil setelah upload/simpan foto berhasil */
function _setFotoProfilCache(username, foto) {
  _cacheSet(_fotoProfilKey(username), foto || "");
  _patchAccountFotoInCache(username, foto || "");
}

/** Hapus cache foto satu user — panggil kalau foto perlu dipaksa fetch ulang */
function invalidateFotoProfilCache(username) {
  _cacheClear(_fotoProfilKey(username));
}

/** Selaraskan foto di cache daftar akun (CACHE_KEYS.accounts) tanpa invalidate semua */
function _patchAccountFotoInCache(username, foto) {
  const accounts = _cacheGetData(CACHE_KEYS.accounts);
  if (!accounts) return;
  const idx = accounts.findIndex(a => a.username === username);
  if (idx !== -1) {
    accounts[idx] = { ...accounts[idx], foto: foto || "" };
    _cacheSet(CACHE_KEYS.accounts, accounts);
  }
}

/** Profile lengkap satu user, pakai cache akun */
async function cachedGetFullProfile(username) {
  // getFullProfile di auth.js butuh jalur & tower — pakai versi cached
  const accounts = await cachedGetAllAccountsFull();
  const account  = accounts.find(a => a.username === username);
  if (!account) return null;

  // Foto diambil dari cache khusus foto (TTL 24 jam), bukan langsung dari
  // account.foto — supaya foto tidak ikut fetch ulang tiap cache akun
  // (TTL 30 mnt) refresh, kecuali memang belum pernah di-cache.
  const foto = await cachedGetFotoProfil(username);

  // Tiru logika getFullProfile dari auth.js
  const towerAwal   = account.tower_awal  != null ? account.tower_awal  : 1;
  const towerAkhir  = account.tower_akhir != null ? account.tower_akhir : 1;
  const towerIds    = account.tower_ids || [];
  const spanIds     = account.span_ids  || [];
  const hasNew      = towerIds.length > 0 || spanIds.length > 0;

  let jumlahTower, jumlahSpan, towerLabel;

  const isFullJalurRole = (account.role === "admin" || account.role === "klw" || account.role === "monitor");

  if (isFullJalurRole) {
    // Admin & KLW: akses SEMUA jalur, termasuk yang baru dibuat.
    // cachedGetTowerMasterList()/cachedGetSpanMasterList() tanpa argumen
    // (atau jalurId null/undefined) sudah otomatis mengembalikan data
    // LINTAS SEMUA jalur (lihat definisi fungsinya di bawah).
    const [towerMaster, spanMaster] = await Promise.all([
      cachedGetTowerMasterList(),
      cachedGetSpanMasterList()
    ]);
    jumlahTower = towerMaster.length;
    jumlahSpan  = spanMaster.length;
    if (towerMaster.length > 0) {
      const nums = towerMaster.map(t => t.nomor);
      towerLabel = "T" + String(Math.min(...nums)).padStart(3,"0")
                 + " – T" + String(Math.max(...nums)).padStart(3,"0") + " (semua jalur)";
    } else {
      towerLabel = "Belum ada data";
    }
  } else if (hasNew) {
    const jalurList   = await cachedGetJalurMasterList();
    const towerMaster = await cachedGetTowerMasterList();
    const jalurMatch  = jalurList.find(j => j.id === account.jalur_id);
    const allTowers   = towerMaster.filter(t => towerIds.includes(t.id));
    jumlahTower = allTowers.length;
    jumlahSpan  = spanIds.length;
    if (allTowers.length > 0 && jalurMatch) {
      const nums = allTowers.map(t => t.nomor).sort((a,b) => a-b);
      towerLabel = assetCodeTower(jalurMatch.code, nums[0]) +
        (nums.length > 1 ? " + " + (nums.length-1) + " lainnya" : "");
    } else {
      towerLabel = "Belum ada tower";
    }
  } else {
    jumlahTower = towerAkhir - towerAwal + 1;
    jumlahSpan  = Math.max(jumlahTower - 1, 0);
    towerLabel  = "T" + String(towerAwal).padStart(3,"0") +
                  " - T" + String(towerAkhir).padStart(3,"0");
  }

  const JALUR_LABEL_MAP = { "lembursitu-cianjur":"Lembursitu - Cianjur", "lembursitu-semenjawa":"Lembursitu - Semenjawa" };

  return {
    nama        : username,
    role        : account.role || "",
    status      : account.status,
    jabatan     : account.jabatan || (account.role ? account.role.toUpperCase() : ""),
    jalur       : account.jalur || "lembursitu-cianjur",
    jalurId     : isFullJalurRole ? null : (account.jalur_id || null),
    jalurLabel  : isFullJalurRole ? "🌐 Semua Jalur" : (JALUR_LABEL_MAP[account.jalur] || account.jalur || "-"),
    allJalurAccess: isFullJalurRole,
    towerAwal, towerAkhir, towerLabel,
    towerIds, spanIds,
    jumlahTower, jumlahSpan,
    hasNewAssignment: hasNew,
    wilayah     : account.wilayah || "",
    foto        : foto || ""
  };
}

async function cachedGetJalurMasterList() {
  const cached = _cacheGetData(CACHE_KEYS.jalur);
  if (cached) return cached; // stale tetap dipakai, hanya syncAll() yang refresh
  return await _refreshJalur();
}

async function _refreshJalur() {
  try {
    const data = await getJalurMasterList();
    if (data) _cacheSet(CACHE_KEYS.jalur, data);
    return data;
  } catch(e) {
    return _cacheGetData(CACHE_KEYS.jalur) || [];
  }
}

async function cachedGetTowerMasterList(jalurId) {
  // Cache tower tanpa filter (semua); filter di client kalau perlu
  const cached = _cacheGetData(CACHE_KEYS.tower);
  if (cached) {
    // stale tetap dipakai, hanya syncAll() yang refresh
    return jalurId ? cached.filter(t => t.jalurId === jalurId) : cached;
  }
  const data = await _refreshTower();
  return jalurId ? (data||[]).filter(t => t.jalurId === jalurId) : (data||[]);
}

async function _refreshTower() {
  try {
    const data = await getTowerMasterList(); // tanpa jalurId = semua
    if (data) _cacheSet(CACHE_KEYS.tower, data);
    return data;
  } catch(e) {
    return _cacheGetData(CACHE_KEYS.tower) || [];
  }
}

async function cachedGetSpanMasterList(jalurId) {
  const cached = _cacheGetData(CACHE_KEYS.span);
  if (cached) {
    // stale tetap dipakai, hanya syncAll() yang refresh
    return jalurId ? cached.filter(s => s.jalurId === jalurId) : cached;
  }
  const data = await _refreshSpan();
  return jalurId ? (data||[]).filter(s => s.jalurId === jalurId) : (data||[]);
}

async function _refreshSpan() {
  try {
    const data = await getSpanMasterList();
    if (data) _cacheSet(CACHE_KEYS.span, data);
    return data;
  } catch(e) {
    return _cacheGetData(CACHE_KEYS.span) || [];
  }
}

async function cachedGetAllBA() {
  const cached = _cacheGetData(CACHE_KEYS.ba);
  if (cached) return cached; // stale tetap dipakai, hanya syncAll() yang refresh
  return await _refreshBA();
}

async function _refreshBA() {
  try {
    const data = await getAllBA();
    if (data) _cacheSet(CACHE_KEYS.ba, data);
    return data;
  } catch(e) {
    return _cacheGetData(CACHE_KEYS.ba) || [];
  }
}

/** Invalidate cache daftar akun — panggil setelah tambah/edit/hapus/toggle akun
    di kelola-akun.html supaya loadAccountsList() berikutnya ambil data segar
    (bukan cache lama), tanpa perlu hapus cache foto (foto tetap 24 jam). */

/** Invalidate cache jalur/tower/span — panggil setelah tambah/edit/hapus
    data master di master-jalur.html, master-tower.html, master-span.html,
    supaya halaman itu (dan halaman lain yang baca cache) langsung dapat
    data segar di load berikutnya, bukan menunggu TTL 30 menit habis. */
function invalidateJalurCache() {
  _cacheClear(CACHE_KEYS.jalur);
}
function invalidateTowerCache() {
  _cacheClear(CACHE_KEYS.tower);
}
function invalidateSpanCache() {
  _cacheClear(CACHE_KEYS.span);
}
function invalidateAccountsCache() {
  _cacheClear(CACHE_KEYS.accounts);
}

/** Invalidate cache BA — panggil setelah upload/edit/hapus BA */
function invalidateBACache() {
  _cacheClear(CACHE_KEYS.ba);
}

/**
 * Cached getAppSetting — semua setting disimpan dalam 1 objek.
 * Pertama kali: fetch semua key yang umum dipakai sekaligus.
 */
const COMMON_SETTINGS = ["loginLogo","loginBackground","systemNotice","baBackground","baContohLayout","baFieldLayout","baLogo","ttdJargiLogo"];

async function cachedGetAppSetting(key) {
  const cached = _cacheGetData(CACHE_KEYS.settings) || {};
  const adaDiCache = key in cached;
  const nilaiKosong = !cached[key]; // null/""/undefined

  // Cache "kosong" TIDAK otomatis dipercaya -- bisa jadi bekas kegagalan
  // sementara (mis. baca Google Drive gagal gara-gara kredensial belum
  // ke-attach setelah redeploy), bukan berarti memang belum diupload.
  // Kalau ada tapi kosong, tetap cek ulang ke server dulu (BLOCKING, bukan
  // di background) supaya tidak "nyangkut" salah sampai TTL 30 menit habis.
  if (adaDiCache && !nilaiKosong) {
    // stale tetap dipakai, hanya syncAll() yang refresh
    return cached[key];
  }

  // Belum ada di cache, ATAU ada tapi kosong -- fetch ulang semua sekaligus.
  const fresh = await _refreshSettings();
  return (fresh && fresh[key]) ?? null;
}

async function _refreshSettings() {
  try {
    const data = await getAppSettings(COMMON_SETTINGS);
    if (data) {
      // Merge dengan cache yang sudah ada (jangan hapus key lain)
      const existing = _cacheGetData(CACHE_KEYS.settings) || {};
      _cacheSet(CACHE_KEYS.settings, { ...existing, ...data });
    }
    return data;
  } catch(e) {
    return _cacheGetData(CACHE_KEYS.settings) || {};
  }
}

/* ═══════════════════════════════════════════════════════
   CACHE PER SPAN — Tegakan & Catatan
   TTL lebih pendek (5 mnt) karena data ini lebih dinamis.
   Setelah write (add/update/delete), cache di-invalidate
   otomatis supaya loadTegakan() selalu dapat data fresh.
═══════════════════════════════════════════════════════ */

async function cachedGetTegakanBySpan(spanId) {
  const key    = _spanTegakanKey(spanId);
  const cached = _cacheGetData(key);
  if (cached !== null) return cached; // stale tetap dipakai, hanya syncAll() yang refresh
  return await _refreshTegakanBySpan(spanId);
}

async function _refreshTegakanBySpan(spanId) {
  try {
    const data = await getTegakanBySpan(spanId);
    _cacheSet(_spanTegakanKey(spanId), data || []);
    return data || [];
  } catch(e) {
    return _cacheGetData(_spanTegakanKey(spanId)) || [];
  }
}

/** Invalidate cache tegakan span — panggil setelah add/update/delete */
function invalidateTegakanCache(spanId) {
  localStorage.removeItem(_spanTegakanKey(spanId));
  // Total tegakan dashboard juga harus dianggap stale supaya
  // statTegakanCard tidak menampilkan angka basi.
  _cacheClear(CACHE_KEYS.tegakanAll);
}

/**
 * Ambil SEMUA tegakan (satu request, semua span) lalu sebar ke
 * masing-masing key cache per-span yang sudah ada (srinai_cache_tegakan_<spanId>).
 * Dipanggil dari syncAll() supaya setelah Sinkron, cachedGetTegakanBySpan()
 * untuk SETIAP span langsung hit cache — tidak perlu fetch on-demand lagi.
 * Memakai endpoint /api/tegakan yang sama (tanpa parameter spanId = ambil semua),
 * tidak ada file API baru.
 */
async function getAllTegakan() {
  const result = await apiRequest("/api/tegakan");
  if (!result.success) throw new Error(result.message || "Gagal memuat data tegakan.");
  return result.tegakan || [];
}

async function _refreshAllTegakanGrouped() {
  try {
    const all = await getAllTegakan();
    const bySpan = {};
    (all || []).forEach(item => {
      if (!bySpan[item.spanId]) bySpan[item.spanId] = [];
      bySpan[item.spanId].push(item);
    });

    // PENTING: hapus dulu SEMUA cache tegakan per-span yang ada sebelum
    // ditulis ulang. Tanpa ini, span yang tegakannya sudah 0 (semua item
    // baru saja dihapus) tidak akan pernah muncul di `bySpan` di atas --
    // jadi cache lamanya (masih berisi tegakan yang sudah dihapus) tidak
    // pernah ditimpa/dibersihkan, walau Sinkron sudah dijalankan.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.indexOf("srinai_cache_tegakan_") === 0) localStorage.removeItem(k);
    }

    Object.keys(bySpan).forEach(spanId => {
      _cacheSet(_spanTegakanKey(spanId), bySpan[spanId]);
    });
    // Simpan juga daftar lengkap (dipakai statistik dashboard) supaya
    // tidak perlu fetch ulang /api/tegakan tanpa parameter di tempat lain.
    _cacheSet(CACHE_KEYS.tegakanAll, all || []);
    return all;
  } catch(e) {
    return _cacheGetData(CACHE_KEYS.tegakanAll) || [];
  }
}

/**
 * Cache-first untuk SELURUH data tegakan (semua span, semua pemilik),
 * dipakai statistik dashboard "Tegakan Tercatat" — independen dari BA,
 * jadi menghitung setiap tegakan yang sudah dicatat petugas walau
 * belum (atau sudah) dibuatkan Berita Acara.
 */
async function cachedGetAllTegakan() {
  const cached = _cacheGetData(CACHE_KEYS.tegakanAll);
  if (cached) return cached; // stale tetap dipakai, hanya syncAll() yang refresh
  return await _refreshAllTegakanGrouped();
}

async function cachedGetCatatanBySpan(spanId) {
  const key    = _spanCatatanKey(spanId);
  const cached = _cacheGetData(key);
  if (cached !== null) return cached; // stale tetap dipakai, hanya syncAll() yang refresh
  return await _refreshCatatanBySpan(spanId);
}

async function _refreshCatatanBySpan(spanId) {
  try {
    const data = await getCatatanBySpan(spanId);
    _cacheSet(_spanCatatanKey(spanId), data || []);
    return data || [];
  } catch(e) {
    return _cacheGetData(_spanCatatanKey(spanId)) || [];
  }
}

/** Invalidate cache catatan span — panggil setelah add/edit/delete */
function invalidateCatatanCache(spanId) {
  localStorage.removeItem(_spanCatatanKey(spanId));
}

/* ═══════════════════════════════════════════════════════
   ANTRIAN PENDING WRITE (offline-first)
   Simpan data baru ke antrian, kirim saat online/sinkron.
═══════════════════════════════════════════════════════ */

/**
 * Tambahkan item ke antrian pending.
 * type: "ba" | "tegakan" | "catatan"
 * payload: object yang akan dikirim ke API
 */
function queuePendingWrite(type, payload) {
  const queue = _getPendingQueue();
  queue.push({ id: Date.now() + "_" + Math.random().toString(36).slice(2), type, payload, ts: Date.now() });
  localStorage.setItem(CACHE_KEYS.pending, JSON.stringify(queue));
  _updateSyncBadge();
}

function _getPendingQueue() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEYS.pending)) || [];
  } catch(e) { return []; }
}

function getPendingCount() {
  return _getPendingQueue().length;
}

/**
 * Kirim semua pending ke server.
 * Panggil dari syncAll() atau saat tombol Sinkron ditekan.
 */
async function syncPending() {
  const queue = _getPendingQueue();
  if (queue.length === 0) return { sent: 0, failed: 0 };

  const remaining = [];
  let sent = 0, failed = 0;

  for (const item of queue) {
    try {
      let ok = false;
      if (item.type === "ba")       { const r = await saveBADocument(item.payload);     ok = r && r.success; }
      if (item.type === "tegakan")  { const r = await addTegakan(item.payload);          ok = r && r.success; }
      if (item.type === "catatan")  { const r = await addCatatanSpan(
          item.payload.spanId, item.payload.username,
          item.payload.catatan, item.payload.foto,
          item.payload.tegakanId, item.payload.tegakanNama, item.payload.tegakanIdTegakan); ok = r && r.success; }
      if (ok) { sent++; } else { remaining.push(item); failed++; }
    } catch(e) {
      remaining.push(item);
      failed++;
    }
  }

  localStorage.setItem(CACHE_KEYS.pending, JSON.stringify(remaining));
  _updateSyncBadge();
  return { sent, failed };
}

/* ═══════════════════════════════════════════════════════
   SYNC ALL — refresh semua cache dari server
═══════════════════════════════════════════════════════ */

/**
 * Sinkronkan semua data dari server ke localStorage.
 * Dipanggil dari tombol Sinkron di dashboard.
 * onProgress(step, total, label) — callback opsional untuk UI.
 */
async function syncAll(onProgress) {
  const steps = [
    { key: CACHE_KEYS.accounts, fn: getAllAccountsFull,   label: "Akun pengguna"    },
    { key: CACHE_KEYS.jalur,    fn: getJalurMasterList,   label: "Master jalur"     },
    { key: CACHE_KEYS.tower,    fn: getTowerMasterList,   label: "Master tower"     },
    { key: CACHE_KEYS.span,     fn: getSpanMasterList,    label: "Master span"      },
    { key: CACHE_KEYS.ba,       fn: getAllBA,              label: "Berita Acara"     },
    { key: CACHE_KEYS.settings, fn: () => getAppSettings(COMMON_SETTINGS), label: "Pengaturan" },
    // grouped: true -> data disebar ke banyak key cache per-span sendiri
    // (srinai_cache_tegakan_<spanId>) di dalam _refreshAllTegakanGrouped(),
    // bukan disimpan ke satu CACHE_KEYS key tunggal seperti step lain.
    { key: null, fn: _refreshAllTegakanGrouped, label: "Data tegakan semua span", grouped: true },
  ];

  // Kirim pending dulu sebelum refresh
  await syncPending();

  let success = 0, failed = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (typeof onProgress === "function") onProgress(i + 1, steps.length, s.label);
    try {
      const data = await s.fn();
      if (data !== null && data !== undefined) {
        if (s.grouped) {
          // _refreshAllTegakanGrouped() sudah menyimpan tiap span ke
          // key cache-nya sendiri — tidak ada satu key tunggal untuk diisi di sini.
        } else if (s.key === CACHE_KEYS.settings) {
          // Settings: simpan sebagai object langsung
          const existing = _cacheGetData(CACHE_KEYS.settings) || {};
          _cacheSet(s.key, { ...existing, ...data });
        } else {
          _cacheSet(s.key, data);
        }
        success++;
      } else {
        failed++;
      }
    } catch(e) {
      console.warn("[sync] Gagal sinkron:", s.label, e);
      failed++;
    }
  }

  // Simpan metadata sinkronisasi terakhir
  localStorage.setItem(SYNC_KEY_META, JSON.stringify({
    lastSync: Date.now(),
    version: SYNC_VERSION,
    success, failed
  }));

  _updateSyncBadge();
  return { success, failed, total: steps.length };
}

/** Hapus semua cache (berguna saat logout) */
function clearAllCache() {
  Object.values(CACHE_KEYS).forEach(k => localStorage.removeItem(k));
  localStorage.removeItem(SYNC_KEY_META);
  // Hapus juga semua cache foto profil per-user (key dinamis, prefix FOTO_CACHE_PREFIX)
  Object.keys(localStorage)
    .filter(k => k.startsWith(FOTO_CACHE_PREFIX))
    .forEach(k => localStorage.removeItem(k));
}

/** Waktu sinkronisasi terakhir */
function getLastSyncTime() {
  try {
    const meta = JSON.parse(localStorage.getItem(SYNC_KEY_META));
    return meta ? meta.lastSync : null;
  } catch(e) { return null; }
}

/** Format waktu sinkronisasi untuk tampilan */
function getLastSyncLabel() {
  const ts = getLastSyncTime();
  if (!ts) return "Belum pernah disinkron";
  const diff = Date.now() - ts;
  if (diff < 60000)       return "Baru saja disinkron";
  if (diff < 3600000)     return "Disinkron " + Math.floor(diff/60000) + " mnt lalu";
  if (diff < 86400000)    return "Disinkron " + Math.floor(diff/3600000) + " jam lalu";
  return "Disinkron " + Math.floor(diff/86400000) + " hari lalu";
}

/* ═══════════════════════════════════════════════════════
   SYNC BADGE — update tombol sinkron di mana saja ada
   (dashboard dan halaman lain yang embed tombol ini)
═══════════════════════════════════════════════════════ */
function _updateSyncBadge() {
  const badge = document.getElementById("syncPendingBadge");
  const label = document.getElementById("syncStatusLabel");
  const count = getPendingCount();

  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? "flex" : "none";
  }
  if (label) {
    label.textContent = getLastSyncLabel();
  }
}

/* Jalankan update badge saat DOM siap */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _updateSyncBadge);
} else {
  _updateSyncBadge();
}

/* ═══════════════════════════════════════════════════════
   AUTO-RECOVERY SAAT KONEKSI KEMBALI
   Kasus: user matikan data internet lalu nyalakan lagi. Request
   yang kebetulan berjalan saat itu bisa gagal atau (sebelum ada
   timeout di apiRequest/auth.js) menggantung, dan halaman yang
   sudah terlanjur render kosong/basi tidak akan pernah memperbarui
   diri sendiri tanpa reload manual -- tidak ada yang memicu ulang
   cachedGetXxx() di halaman itu.
   Solusi: pantau event offline -> online asli (bukan reconnect
   sesaat/flapping), lalu diam-diam sinkron ulang cache dari server
   dan reload halaman SEKALI supaya data yang gagal tampil otomatis
   muncul begitu koneksi benar-benar pulih, tanpa aksi dari user.
═══════════════════════════════════════════════════════ */
let _srinaiWasOffline = !navigator.onLine;

window.addEventListener("offline", () => {
  _srinaiWasOffline = true;
});

window.addEventListener("online", async () => {
  if (!_srinaiWasOffline) return; // bukan pemulihan dari offline nyata, abaikan
  _srinaiWasOffline = false;
  try {
    await syncAll();
  } catch (e) {
    console.warn("[sync] Gagal auto-sync saat online kembali:", e);
  }
  location.reload();
});

/* Patch logoutUser agar hapus cache */
(function() {
  const _origLogout = typeof logoutUser === "function" ? logoutUser : null;
  if (_origLogout) {
    window.logoutUser = function() {
      clearAllCache();
      _origLogout();
    };
  }
})();
