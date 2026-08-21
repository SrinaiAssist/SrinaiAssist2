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

/* Fingerprint per-span (jumlah tegakan + updated_at terbaru) dari sync
   terakhir -- dipakai _refreshAllTegakanGrouped() untuk invalidasi
   TERPILIH (hanya span yang benar-benar berubah), bukan hapus semua
   cache TTD tiap kali Sinkron ditekan. Lihat komentar di
   _refreshAllTegakanGrouped() untuk detail. */
const TEGAKAN_FP_KEY = "srinai_sync_tegakan_fp";
// Fingerprint GLOBAL (bukan per-item) untuk jalur/tower/span/ba -- data ini
// beda dari tegakan (jarang perlu breakdown per-span), jadi cukup satu
// angka "count:maxUpdatedAt" per tabel. Kalau sama dengan sync sebelumnya,
// SELURUH fetch data lengkap tabel itu di-skip total.
const MASTER_FP_KEY = "srinai_sync_master_fp"; // { jalur, tower, span, ba }

/* ─── Log sinkronisasi (dipakai popup "Sinkronisasi Data" di dashboard) ──
   _syncLogFn diset oleh syncAll() dari callback onLog yang dioper UI.
   Fungsi-fungsi _refresh... dan syncPending di bawah cukup panggil
   _syncLog(pesan), tanpa perlu tahu ada UI popup atau tidak
   (no-op kalau tidak diset). */
let _syncLogFn = null;
let _syncBytesTotal = 0;
function _syncLog(msg) {
  if (typeof _syncLogFn === "function") {
    try { _syncLogFn(msg); } catch(e) {}
  }
}
function _jsonSize(obj) {
  try { return new Blob([JSON.stringify(obj)]).size; } catch(e) { return (JSON.stringify(obj) || "").length; }
}
function _fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
const SETTINGS_IMG_FP_KEY = "srinai_sync_settings_img_fp"; // key setting -> referensi gambar mentah terakhir
// HARUS sinkron dengan IMAGE_SETTING_KEYS di api/settings.js (key yang
// disimpan sbg referensi Drive & perlu di-resolve jadi base64).
const SETTINGS_IMAGE_KEYS = ["baLogo", "baBackground", "baContohLayout", "ttdJargiLogo"];
function _spanCatatanKey(spanId) { return "srinai_cache_catatan_"  + spanId; }
function _spanCacheStale(key) {
  const obj = _cacheGet(key);
  if (!obj) return true;
  return (Date.now() - obj.ts) > SPAN_CACHE_TTL_MS;
}

/* ═══════════════════════════════════════════════════════
   NAMESPACE CACHE PER AKUN
   Semua key di atas (CACHE_KEYS.*, key per-span, fingerprint, antrian
   pending, meta sync) di-namespace pakai username yang sedang login.
   Tujuannya:
   1) Logout TIDAK menghapus cache (lihat logoutUser() di js/auth.js --
      cuma hapus srinaiUser/srinaiRole/loginTime, tidak pernah sentuh
      cache sync). Data tetap ada, tidak perlu download ulang saat
      login lagi dengan akun yang sama.
   2) Ganti akun di device yang sama TIDAK memakai cache akun lain
      secara tidak sengaja (tower/span/jalur bisa beda hak akses per
      akun). Tiap akun otomatis punya "kotak" cache sendiri.
   3) Balik ke akun semula: cache akun itu masih ada di kotaknya
      sendiri, langsung terpakai lagi tanpa download ulang. */
function _currentCacheUser() {
  try {
    return (typeof getCurrentUser === "function" && getCurrentUser()) || "_guest";
  } catch (e) {
    return "_guest";
  }
}
function _scopedKey(key) {
  return key + "::u:" + _currentCacheUser();
}

/* ═══════════════════════════════════════════════════════
   UTILITAS CACHE
═══════════════════════════════════════════════════════ */
function _cacheSet(key, data) {
  try {
    localStorage.setItem(_scopedKey(key), JSON.stringify({ ts: Date.now(), data }));
  } catch(e) {
    console.warn("[sync] localStorage full, skip cache:", key);
  }
}

function _cacheGet(key) {
  try {
    const raw = localStorage.getItem(_scopedKey(key));
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
  localStorage.removeItem(_scopedKey(key));
}

/* Tandai cache sebagai stale TANPA membuang datanya (beda dengan
   _cacheClear yang menghapus total). Dipakai saat butuh maksa refresh
   berikutnya tapi data lama masih perlu dipakai sebagai basis "untouched"
   oleh _refreshAllTegakanGrouped() -- lihat invalidateTegakanCache(). */
function _cacheMarkStale(key) {
  const obj = _cacheGet(key);
  if (!obj) return;
  try {
    localStorage.setItem(_scopedKey(key), JSON.stringify({ ts: 0, data: obj.data }));
  } catch(e) {}
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

/** Profile lengkap satu user, pakai cache akun */
async function cachedGetFullProfile(username) {
  // getFullProfile di auth.js butuh jalur & tower — pakai versi cached
  const accounts = await cachedGetAllAccountsFull();
  const account  = accounts.find(a => a.username === username);
  if (!account) return null;

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
    wilayah     : account.wilayah || ""
  };
}

async function cachedGetJalurMasterList() {
  const cached = _cacheGetData(CACHE_KEYS.jalur);
  if (cached) return cached; // stale tetap dipakai, hanya syncAll() yang refresh
  return await _refreshJalur();
}

/**
 * PENTING (fix kuota Fast Origin Transfer, Ags 2026, disempurnakan lagi
 * belakangan): jalur, tower, span, dan ba dulu SELALU ditarik PENUH tiap
 * syncAll() jalan begitu ada SATU SAJA perubahan sejak sync terakhir --
 * fingerprint {count, maxUpdatedAt} cuma dipakai untuk skip-total kalau
 * TIDAK ADA perubahan sama sekali. Sekarang beneran inkremental:
 *
 *  1. Cek dulu mode ringan (?meta=1) -- kalau fingerprint SAMA dengan sync
 *     sebelumnya, skip total, cache lama dipakai apa adanya (kasus paling
 *     umum: tidak ada perubahan antar sync).
 *  2. Kalau BEDA dan sudah pernah sync sebelumnya (punya anchor waktu) ->
 *     fetch HANYA baris yang updated_at-nya lebih baru dari sync terakhir
 *     lewat ?since=, plus activeIds (seluruh id yang masih ada di server).
 *     Hasil delta di-upsert ke cache lama per id, lalu baris yang id-nya
 *     TIDAK ADA lagi di activeIds dibuang dari cache (mendeteksi hapus).
 *  3. Kalau belum pernah sync sama sekali (cache kosong) -> fetch penuh
 *     seperti biasa, sekali saja, sebagai titik awal.
 */
function _masterFp(meta) {
  return (meta.count || 0) + ":" + (meta.maxUpdatedAt || "");
}

/** Upsert delta rows ke array cache lama (by id), lalu buang id yang sudah
 *  tidak ada di activeIds (dihapus di server sejak sync terakhir). */
function _mergeDelta(oldArray, delta, activeIds) {
  const map = new Map((oldArray || []).map(item => [String(item.id), item]));
  (delta || []).forEach(item => map.set(String(item.id), item));
  const activeSet = new Set((activeIds || []).map(String));
  return Array.from(map.values()).filter(item => activeSet.has(String(item.id)));
}

async function _refreshMasterSelective(name, metaFn, listFn, cacheKey, label) {
  try {
    _syncLog(`Mulai mengunduh ${label} ...`);
    const meta = await metaFn();
    const fp = _masterFp(meta);
    const oldFpAll = _cacheGetData(MASTER_FP_KEY) || {};
    // { fp, maxUpdatedAt } dari sync sebelumnya. KOMPATIBILITAS: sebelum
    // rilis sinkron-bertahap ini, nilainya cuma string "count:maxUpdatedAt"
    // (bukan objek) -- kalau ketemu bentuk lama itu, parse dulu supaya
    // anchor waktunya tetap kepakai dan sync PERTAMA setelah update ini
    // TIDAK perlu tarik ulang tabel penuh dari nol.
    let oldMeta = oldFpAll[name];
    if (typeof oldMeta === "string") {
      const idx = oldMeta.indexOf(":");
      oldMeta = idx >= 0
        ? { fp: oldMeta, maxUpdatedAt: oldMeta.slice(idx + 1) || null }
        : null;
    }
    const cachedData = _cacheGetData(cacheKey);

    if (oldMeta && oldMeta.fp === fp && cachedData !== null) {
      // Tidak ada perubahan -- skip fetch total, pakai cache lama.
      _syncLog(`Update tidak dilakukan, menggunakan data sebelumnya... ${_fmtBytes(_jsonSize(cachedData))}`);
      return cachedData;
    }

    let data;
    let mode;
    if (oldMeta && oldMeta.maxUpdatedAt && cachedData !== null) {
      // Ada perubahan, TAPI sudah punya anchor waktu dari sync sebelumnya
      // -> tarik cuma yang berubah (delta), bukan tabel penuh.
      const result = await listFn(oldMeta.maxUpdatedAt);
      data = _mergeDelta(cachedData, result.rows, result.activeIds);
      mode = `delta (${(result.rows || []).length} baris berubah)`;
    } else {
      // Belum pernah sync / cache kosong -> tarik penuh sekali sebagai titik awal.
      data = await listFn();
      mode = "penuh (sinkron pertama)";
    }

    if (data) {
      _cacheSet(cacheKey, data);
      const newFpAll = { ..._cacheGetData(MASTER_FP_KEY), [name]: { fp, maxUpdatedAt: meta.maxUpdatedAt || null } };
      _cacheSet(MASTER_FP_KEY, newFpAll);
      const sz = _jsonSize(data);
      _syncBytesTotal += sz;
      _syncLog(`Sukses, ${label} diperbarui (${mode})... ${_fmtBytes(sz)}`);
    } else {
      _syncLog(`Gagal mengunduh ${label}`);
    }
    return data;
  } catch(e) {
    console.warn(`[sync] Gagal refresh inkremental ${label}, fallback:`, e);
    _syncLog(`Gagal sinkron bertahap ${label}, memakai data sebelumnya`);
    return _cacheGetData(cacheKey) || [];
  }
}

async function _refreshJalur() {
  return await _refreshMasterSelective("jalur", getJalurMeta, (since) => getJalurMasterList(since), CACHE_KEYS.jalur, "master jalur");
}

async function _refreshTower() {
  return await _refreshMasterSelective("tower", getTowerMeta, (since) => getTowerMasterList(undefined, since), CACHE_KEYS.tower, "master tower");
}

async function _refreshSpan() {
  return await _refreshMasterSelective("span", getSpanMeta, (since) => getSpanMasterList(undefined, since), CACHE_KEYS.span, "master span");
}

async function _refreshBA() {
  return await _refreshMasterSelective("ba", getBAMeta, (since) => getAllBA(since), CACHE_KEYS.ba, "master Berita Acara");
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

async function cachedGetSpanMasterList(jalurId) {
  const cached = _cacheGetData(CACHE_KEYS.span);
  if (cached) {
    // stale tetap dipakai, hanya syncAll() yang refresh
    return jalurId ? cached.filter(s => s.jalurId === jalurId) : cached;
  }
  const data = await _refreshSpan();
  return jalurId ? (data||[]).filter(s => s.jalurId === jalurId) : (data||[]);
}

async function cachedGetAllBA() {
  const cached = _cacheGetData(CACHE_KEYS.ba);
  if (cached) return cached; // stale tetap dipakai, hanya syncAll() yang refresh
  return await _refreshBA();
}

/** Invalidate cache daftar akun — panggil setelah tambah/edit/hapus/toggle akun
    di kelola-akun.html supaya loadAccountsList() berikutnya ambil data segar
    (bukan cache lama), tanpa perlu hapus cache foto (foto tetap 24 jam). */

/** Invalidate cache jalur/tower/span — panggil setelah tambah/edit/hapus
    data master di master-jalur.html, master-tower.html, master-span.html,
    supaya halaman itu (dan halaman lain yang baca cache) langsung dapat
    data segar di load berikutnya, bukan menunggu TTL 30 menit habis. */
function _clearMasterFp(name) {
  const fp = _cacheGetData(MASTER_FP_KEY) || {};
  delete fp[name];
  _cacheSet(MASTER_FP_KEY, fp);
}
function invalidateJalurCache() {
  _cacheClear(CACHE_KEYS.jalur);
  _clearMasterFp("jalur");
}
function invalidateTowerCache() {
  _cacheClear(CACHE_KEYS.tower);
  _clearMasterFp("tower");
}
function invalidateSpanCache() {
  _cacheClear(CACHE_KEYS.span);
  _clearMasterFp("span");
}
function invalidateAccountsCache() {
  _cacheClear(CACHE_KEYS.accounts);
}

/** Invalidate cache BA — panggil setelah upload/edit/hapus BA */
function invalidateBACache() {
  _cacheClear(CACHE_KEYS.ba);
  _clearMasterFp("ba");
}

/**
 * Cached getAppSetting — semua setting disimpan dalam 1 objek.
 * Pertama kali: fetch semua key yang umum dipakai sekaligus.
 */
const COMMON_SETTINGS = ["systemNotice","baBackground","baContohLayout","baFieldLayout","baLogo","ttdJargiLogo"];

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
async function invalidateTegakanCache(spanId) {
  _cacheClear(_spanTegakanKey(spanId));
  // PENTING (fix #3, Ags 2026): fix #2 (tarik ulang SEMUA span tiap ada 1
  // edit) benar tapi boros -- edit N tegakan di N span beda = N kali tarik
  // seluruh tabel. Sekarang cukup tarik ulang span YANG BERSANGKUTAN SAJA
  // (getTegakanMetaBySpan, ringan) lalu tempelkan ke cache gabungan yang
  // sudah ada -- span lain tidak disentuh/dihitung ulang sama sekali, jadi
  // tidak ada lagi kemungkinan salah anggap "berubah" atau "hilang" seperti
  // di fix #1 (yang masalahnya justru ada di reasoning soal span LAIN).
  try {
    // PENTING (fix #4, Ags 2026): kalau cache gabungan (CACHE_KEYS.tegakanAll)
    // BELUM PERNAH terisi sama sekali di device/sesi ini -- misal user buka
    // catatan-span.html LANGSUNG (dari dashboard/link/deep-link) tanpa lebih
    // dulu mampir ke span.html -- maka _cacheGetData tadinya balikin `[]`,
    // lalu di-treat seolah "semua span lain memang kosong" dan ke-merge jadi
    // cache gabungan baru yang CUMA berisi span ini sendiri. Cache parsial
    // itu lalu dianggap fresh (baru di-set) oleh cachedGetAllTegakan(), jadi
    // badge "Ada Tegakan" span LAIN hilang massal walau datanya utuh di DB.
    // Sekarang: bedakan "belum pernah ada cache" (null) vs "sudah ada cache
    // tapi memang kosong" ([]) -- HANYA merge kalau cache gabungan memang
    // sudah pernah ada. Kalau belum pernah ada, jangan bikin cache parsial;
    // biarkan tetap kosong supaya cachedGetAllTegakan() nanti fetch PENUH.
    const hadCacheBefore = _cacheGet(CACHE_KEYS.tegakanAll) !== null;
    const freshForSpan = await getTegakanMetaBySpan(spanId); // includeTtd=false, 1 span saja

    if (hadCacheBefore) {
      const oldAll = _cacheGetData(CACHE_KEYS.tegakanAll) || [];
      const merged = oldAll.filter(t => t.spanId !== spanId).concat(freshForSpan);
      _cacheSet(CACHE_KEYS.tegakanAll, merged);
    }

    // Update fingerprint span ini saja, biar syncAll() berikutnya tidak
    // menganggap span ini "berubah lagi" dan menariknya ulang percuma.
    // Fingerprint tetap diupdate walau cache gabungan belum ada, supaya
    // begitu cache gabungan di-fetch penuh nanti, span ini tidak ikut
    // dianggap "berubah" lagi secara percuma.
    const fp = _cacheGetData(TEGAKAN_FP_KEY) || {};
    if (freshForSpan.length) {
      let maxUpdatedAt = "";
      freshForSpan.forEach(t => { if ((t.updatedAt || "") > maxUpdatedAt) maxUpdatedAt = t.updatedAt || ""; });
      fp[spanId] = freshForSpan.length + ":" + maxUpdatedAt;
    } else {
      delete fp[spanId]; // tegakan terakhir di span ini baru saja dihapus
    }
    _cacheSet(TEGAKAN_FP_KEY, fp);
  } catch(e) {
    // Gagal tarik ulang -- minimal tandai stale, jangan diam-diam pakai
    // data lama yang mungkin sudah tidak akurat.
    _cacheMarkStale(CACHE_KEYS.tegakanAll);
  }
}

/**
 * Ambil SEMUA tegakan (satu request, semua span) -- HANYA metadata, TANPA
 * foto TTD (includeTtd=false). Dipakai buat statistik dashboard & grouping
 * per span, yang keduanya tidak pernah menampilkan gambar TTD.
 *
 * PENTING (fix kuota Fast Origin Transfer, Jul 2026): sebelumnya endpoint
 * ini dipanggil TANPA includeTtd=false, jadi server ikut resolve TTD tiap
 * tegakan dari Google Drive jadi base64 dan mengirim SEMUANYA ke browser
 * setiap kali syncAll() jalan -- padahal cuma butuh metadata. Ini penyebab
 * utama lonjakan Fast Origin Transfer. Endpoint /api/tegakan sudah punya
 * logic strip TTD (includeTtd=false -> ttdData jadi true/null saja),
 * sekarang benar-benar dipakai di sini.
 */
async function getAllTegakan() {
  const result = await apiRequest("/api/tegakan?includeTtd=false");
  if (!result.success) throw new Error(result.message || "Gagal memuat data tegakan.");
  return result.tegakan || [];
}

/**
 * Hitung fingerprint satu span dari baris meta ringan:
 * "<jumlah tegakan>:<updated_at terbaru>". Kalau fingerprint span sama
 * dengan sync sebelumnya, berarti span itu TIDAK berubah (tidak ada
 * tambah/edit/hapus) sejak sync terakhir.
 */
function _tegakanFingerprintFromMeta(m) {
  return (m.count || 0) + ":" + (m.maxUpdatedAt || "");
}

/**
 * PENTING (fix kuota Fast Origin Transfer, Ags 2026): sebelumnya fungsi ini
 * SELALU tarik metadata SEMUA tegakan di SEMUA span (getAllTegakan()) tiap
 * syncAll() jalan, walau cuma 1 tegakan di 1 span yang berubah -- span lain
 * yang sama sekali tidak berubah ikut ke-transfer ulang percuma.
 *
 * Sekarang: cek dulu mode ringan (getTegakanMeta(), cuma angka per span,
 * bukan data lengkap). Span yang fingerprint-nya SAMA dengan sync
 * sebelumnya di-skip total -- cache lamanya (baik daftar metadata gabungan
 * maupun cache detail per-span berisi TTD) dibiarkan apa adanya. Cuma span
 * yang fingerprint-nya BEDA yang metadatanya ditarik ulang, itu pun HANYA
 * untuk span itu sendiri (getTegakanMetaBySpan), bukan seluruh sistem.
 */
async function _refreshAllTegakanGrouped() {
  try {
    _syncLog("Mulai mengunduh data tegakan semua span ...");
    const metaList = await getTegakanMeta();

    const oldFp = _cacheGetData(TEGAKAN_FP_KEY) || {};
    const newFp = {};
    metaList.forEach(m => { newFp[m.spanId] = _tegakanFingerprintFromMeta(m); });

    const changedSpanIds = Object.keys(newFp).filter(spanId => oldFp[spanId] !== newFp[spanId]);
    // Span yang dulu ada fingerprint-nya tapi sekarang tidak muncul lagi di
    // meta (semua tegakan-nya baru saja dihapus).
    const removedSpanIds = Object.keys(oldFp).filter(spanId => !(spanId in newFp));

    // Cache detail per-span (dipakai halaman tegakan.html, berisi TTD):
    // hapus HANYA span yang benar-benar berubah/hilang, supaya
    // cachedGetTegakanBySpan() tetap hit cache untuk span yang tidak
    // berubah (tidak perlu resolve ulang TTD dari Drive sia-sia).
    changedSpanIds.forEach(spanId => _cacheClear(_spanTegakanKey(spanId)));
    removedSpanIds.forEach(spanId => _cacheClear(_spanTegakanKey(spanId)));

    // Daftar metadata gabungan (dipakai statistik dashboard) -- mulai dari
    // cache lama, buang entri span yang berubah/hilang, lalu isi ulang
    // HANYA span yang berubah dengan data terbaru (metadata saja, tanpa TTD).
    const oldAll = _cacheGetData(CACHE_KEYS.tegakanAll) || [];
    const untouched = oldAll.filter(item => !changedSpanIds.includes(item.spanId) && !removedSpanIds.includes(item.spanId));

    if (changedSpanIds.length === 0 && removedSpanIds.length === 0) {
      _syncLog(`Update tidak dilakukan, menggunakan data sebelumnya... ${_fmtBytes(_jsonSize(oldAll))}`);
      // PENTING: tetap "cap ulang" timestamp cache meski datanya sama persis --
      // tanpa ini, cachedGetAllTegakan() (yang sekarang TTL 5 menit, lihat
      // komentar di sana) akan menganggap cache selalu stale dan memanggil
      // getTegakanMeta() ULANG di SETIAP load halaman selama tidak ada
      // perubahan sama sekali, bukan cuma sekali tiap 5 menit.
      _cacheSet(CACHE_KEYS.tegakanAll, oldAll);
      return oldAll;
    }

    // PENTING (fix akar masalah, Ags 2026): kalau yang berubah BANYAK span
    // sekaligus (kasus paling umum: cache baru pertama diisi / abis
    // dibersihkan -- SEMUA span dianggap "berubah" karena belum ada
    // fingerprint history sama sekali), dulu di sini nembak SATU REQUEST
    // PARALEL PER SPAN via Promise.all -- bisa puluhan request bersamaan.
    // Di Vercel Hobby plan ini gampang kena limit/gagal sebagian, dan tiap
    // request yang gagal DIAM-DIAM dianggap kosong (.catch(() => [])) --
    // inilah penyebab asli badge "Belum Ada Tegakan" salah massal yang
    // dilaporkan berulang. Sekarang: kalau span yang berubah lebih dari
    // ambang batas ini, pakai SATU request tunggal yang ambil semua
    // (getAllTegakan) alih-alih fan-out puluhan request kecil.
    const FANOUT_THRESHOLD = 8;
    let all;
    if (changedSpanIds.length > FANOUT_THRESHOLD) {
      _syncLog(`${changedSpanIds.length} span berubah sekaligus, ambil semua dalam 1 request ...`);
      const freshAll = await getAllTegakan(); // 1 request, semua span, tanpa TTD
      const changedSet = new Set(changedSpanIds);
      const freshChanged = freshAll.filter(t => changedSet.has(t.spanId));
      all = untouched.concat(freshChanged);
    } else {
      const refreshedParts = await Promise.all(
        changedSpanIds.map(spanId => getTegakanMetaBySpan(spanId).catch(() => []))
      );
      all = untouched.concat(...refreshedParts);
    }

    _cacheSet(TEGAKAN_FP_KEY, newFp);
    _cacheSet(CACHE_KEYS.tegakanAll, all);
    const sz = _jsonSize(all);
    _syncBytesTotal += sz;
    _syncLog(`Sukses, ${changedSpanIds.length} span diperbarui... ${_fmtBytes(sz)}`);
    return all;
  } catch(e) {
    _syncLog("Gagal mengunduh data tegakan");
    return _cacheGetData(CACHE_KEYS.tegakanAll) || [];
  }
}

/**
 * Cache-first untuk SELURUH data tegakan (semua span, semua pemilik),
 * dipakai statistik dashboard "Tegakan Tercatat" — independen dari BA,
 * jadi menghitung setiap tegakan yang sudah dicatat petugas walau
 * belum (atau sudah) dibuatkan Berita Acara.
 *
 * PENTING (fix, Ags 2026): sebelumnya pakai kebijakan cache 30 menit
 * yang TIDAK PERNAH auto-refresh (cuma manual "Sinkron") -- akibatnya
 * kalau ada tegakan baru ditambahkan dari akun/device LAIN, badge
 * "Ada/Belum Ada Tegakan" di daftar span.html & informasi-span.html
 * tetap salah/basi selama berhari-hari di device ini, padahal cukup
 * tap "Lihat" (cachedGetTegakanBySpan, cache terpisah per-span) untuk
 * lihat data yang sebenarnya sudah benar di server. Data tegakan itu
 * dinamis (bisa berubah dari device lain kapan saja) jadi sekarang
 * dipakaikan TTL pendek yang sama seperti cache per-span (5 menit,
 * lihat SPAN_CACHE_TTL_MS) supaya badge auto-refresh sendiri tanpa
 * perlu Sinkron manual.
 */
async function cachedGetAllTegakan() {
  const key = CACHE_KEYS.tegakanAll;
  if (!_spanCacheStale(key)) return _cacheGetData(key);
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
  _cacheClear(_spanCatatanKey(spanId));
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
  localStorage.setItem(_scopedKey(CACHE_KEYS.pending), JSON.stringify(queue));
  _updateSyncBadge();
}

function _getPendingQueue() {
  try {
    return JSON.parse(localStorage.getItem(_scopedKey(CACHE_KEYS.pending))) || [];
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

  _syncLog(`Mulai mengirim ${queue.length} data tertunda... ${_fmtBytes(_jsonSize(queue))}`);
  _syncBytesTotal += _jsonSize(queue);

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

  localStorage.setItem(_scopedKey(CACHE_KEYS.pending), JSON.stringify(remaining));
  _updateSyncBadge();
  _syncLog(`Sukses, ${sent} data tersimpan dari ${queue.length}${failed ? ` (${failed} gagal)` : ""}.`);
  return { sent, failed };
}

/* ═══════════════════════════════════════════════════════
   AKUN — refresh
   Catatan: dulu ada logic resolve foto profil per-akun dari Google
   Drive di sini (fitur foto profil sudah dihapus, Ags 2026), jadi
   sekarang cukup ambil daftar akun apa adanya dan cache.
═══════════════════════════════════════════════════════ */
async function _refreshAccountsSelective() {
  _syncLog("Mulai mengunduh akun pengguna ...");
  const accounts = await getAllAccountsFull();
  _cacheSet(CACHE_KEYS.accounts, accounts);
  const sz = _jsonSize(accounts);
  _syncBytesTotal += sz;
  _syncLog(`Sukses, akun pengguna diperbarui... ${_fmtBytes(sz)}`);
  return accounts;
}

/* ═══════════════════════════════════════════════════════
   PENGATURAN (BA logo/background/contoh layout) — refresh SELEKTIF
   Sama seperti akun/tegakan: baLogo, baBackground, baContohLayout
   sebelumnya di-resolve penuh dari Drive tiap syncAll() jalan, padahal
   jarang berubah (cuma kalau admin sengaja ganti lewat pengaturan-ba.html).
   Sekarang: ambil dulu referensi mentahnya (includeImages=false, murah),
   bandingkan dengan referensi hasil sync sebelumnya -- HANYA key yang
   referensinya berubah yang di-resolve ulang satu-per-satu. Kalibrasi
   posisi (baFieldLayout, dipakai pengaturan-ba.html) TETAP selalu akurat
   ke versi terbaru karena begitu admin ganti gambarnya, referensinya pasti
   berubah dan otomatis ke-resolve ulang sync berikutnya -- ini BUKAN cache
   permanen yang mengunci ke versi lama selamanya.
═══════════════════════════════════════════════════════ */
async function _refreshSettingsSelective() {
  _syncLog("Mulai mengunduh pengaturan ...");
  const light = await getAppSettings(COMMON_SETTINGS, false); // includeImages=false

  const oldFp = _cacheGetData(SETTINGS_IMG_FP_KEY) || {};
  const oldSettings = _cacheGetData(CACHE_KEYS.settings) || {};

  const newFp = {};
  const merged = { ...light }; // key non-gambar (systemNotice, dll) sudah fresh & murah apa adanya
  let resolvedCount = 0;

  for (const imgKey of SETTINGS_IMAGE_KEYS) {
    const ref = light[imgKey] || "";
    newFp[imgKey] = ref;
    if (oldFp[imgKey] === ref && Object.prototype.hasOwnProperty.call(oldSettings, imgKey)) {
      // Referensi sama dengan sync sebelumnya -> pakai hasil resolve lama,
      // TIDAK download ulang dari Drive.
      merged[imgKey] = oldSettings[imgKey];
    } else {
      // Belum pernah ada / referensinya berubah -> resolve HANYA key ini.
      try {
        merged[imgKey] = await getAppSetting(imgKey);
        resolvedCount++;
      } catch (e) {
        merged[imgKey] = oldSettings[imgKey] || null;
      }
    }
  }

  const finalSettings = { ...oldSettings, ...merged };
  _cacheSet(CACHE_KEYS.settings, finalSettings);
  _cacheSet(SETTINGS_IMG_FP_KEY, newFp);
  if (resolvedCount === 0) {
    _syncLog(`Update tidak dilakukan, menggunakan data sebelumnya... ${_fmtBytes(_jsonSize(finalSettings))}`);
  } else {
    const sz = _jsonSize(finalSettings);
    _syncBytesTotal += sz;
    _syncLog(`Sukses, ${resolvedCount} gambar pengaturan diperbarui... ${_fmtBytes(sz)}`);
  }
  return finalSettings;
}

/* ═══════════════════════════════════════════════════════
   SYNC ALL — refresh semua cache dari server
═══════════════════════════════════════════════════════ */

/**
 * Sinkronkan semua data dari server ke localStorage.
 * Dipanggil dari tombol Sinkron di dashboard.
 * onProgress(step, total, label) — callback opsional untuk UI.
 */
async function syncAll(onProgress, onLog) {
  const steps = [
    { key: CACHE_KEYS.accounts, fn: _refreshAccountsSelective, selfCached: true, label: "Akun pengguna" },
    { key: CACHE_KEYS.jalur,    fn: _refreshJalur, selfCached: true, label: "Master jalur"     },
    { key: CACHE_KEYS.tower,    fn: _refreshTower, selfCached: true, label: "Master tower"     },
    { key: CACHE_KEYS.span,     fn: _refreshSpan,  selfCached: true, label: "Master span"      },
    { key: CACHE_KEYS.ba,       fn: _refreshBA,    selfCached: true, label: "Berita Acara"     },
    { key: CACHE_KEYS.settings, fn: _refreshSettingsSelective, selfCached: true, label: "Pengaturan" },
    // grouped: true -> data disebar ke banyak key cache per-span sendiri
    // (srinai_cache_tegakan_<spanId>) di dalam _refreshAllTegakanGrouped(),
    // bukan disimpan ke satu CACHE_KEYS key tunggal seperti step lain.
    { key: null, fn: _refreshAllTegakanGrouped, label: "Data tegakan semua span", grouped: true },
  ];

  // onLog(msg) opsional -- dipakai popup "Sinkronisasi Data" di dashboard
  // untuk menampilkan baris log real-time (mirip "Info : ..." pada log sync).
  _syncLogFn = (typeof onLog === "function") ? onLog : null;
  _syncBytesTotal = 0;
  const startTs = Date.now();

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
        } else if (s.selfCached) {
          // _refreshAccountsSelective() / _refreshSettingsSelective() sudah
          // menyimpan cache (+ fingerprint) sendiri di dalam fungsinya --
          // jangan _cacheSet lagi di sini, supaya nilai yang tidak berubah
          // tidak balik ke referensi mentah / ke-overwrite ganda.
        } else {
          _cacheSet(s.key, data);
        }
        success++;
      } else {
        failed++;
      }
    } catch(e) {
      console.warn("[sync] Gagal sinkron:", s.label, e);
      _syncLog(`Gagal sinkron: ${s.label}`);
      failed++;
    }
  }

  // Simpan metadata sinkronisasi terakhir
  localStorage.setItem(_scopedKey(SYNC_KEY_META), JSON.stringify({
    lastSync: Date.now(),
    version: SYNC_VERSION,
    success, failed
  }));

  _updateSyncBadge();

  const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(1);
  _syncLog(failed === 0 ? "Sukses. Sinkronisasi selesai." : `Selesai dengan ${failed} kegagalan.`);
  _syncLog(`Total sinkronisasi ${_fmtBytes(_syncBytesTotal)}  (${elapsedSec} Detik)`);

  const bytesTotal = _syncBytesTotal;
  _syncLogFn = null; // lepas logger supaya tidak nyangkut ke sync berikutnya

  return { success, failed, total: steps.length, bytes: bytesTotal, elapsedSec };
}

/** Hapus semua cache (berguna saat logout) */
function clearAllCache() {
  Object.values(CACHE_KEYS).forEach(k => localStorage.removeItem(_scopedKey(k)));
  localStorage.removeItem(_scopedKey(SYNC_KEY_META));
}

/** Waktu sinkronisasi terakhir */
function getLastSyncTime() {
  try {
    const meta = JSON.parse(localStorage.getItem(_scopedKey(SYNC_KEY_META)));
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
   DETEKSI KONEKSI KEMBALI (TANPA aksi otomatis)
   Sebelumnya di sini ada auto-sync + reload diam-diam saat koneksi
   pulih dari offline. Itu dihapus karena bertentangan dengan prinsip
   utama file ini: TIDAK ADA pembaruan data yang terjadi tanpa aksi
   eksplisit dari user (tombol Sinkron). Yang tersisa cuma reset flag
   supaya status offline/online tetap konsisten dipakai bagian lain
   kalau diperlukan -- tidak ada fetch atau reload yang dipicu di sini.
═══════════════════════════════════════════════════════ */
let _srinaiWasOffline = !navigator.onLine;

window.addEventListener("offline", () => {
  _srinaiWasOffline = true;
});

window.addEventListener("online", () => {
  _srinaiWasOffline = false;
});

/* Catatan: logoutUser() (di js/auth.js) SENGAJA tidak dipatch untuk
   memanggil clearAllCache() di sini. Cache tetap dipertahankan setelah
   logout -- baik untuk login ulang dengan akun yang sama (tidak perlu
   download ulang) maupun ganti akun (cache akun lain sudah dipisah lewat
   namespace _scopedKey() di atas, jadi tidak akan tertukar). clearAllCache()
   masih tersedia untuk dipakai manual (mis. tombol "reset cache" di
   pengaturan.html), tapi tidak lagi otomatis terpicu saat logout. */

