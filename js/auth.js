/* =========================================================
   SRINAI ASSIST
   AUTH SYSTEM v3 — Akun/profil DAN Master Data (jalur/tower/
   span) sekarang di Neon (Postgres), diakses lewat /api/login,
   /api/accounts, /api/jalur, /api/tower, /api/span.

   PERUBAHAN UTAMA dari v2:
   - getJalurMasterList(), getTowerMasterList(), getSpanMasterList()
     SEKARANG ASYNC dan fetch dari Neon, BUKAN localStorage lagi.
   - getFullProfile() sekarang fetch master data dari API juga.
========================================================= */

// Daftarkan service worker (js/../sw.js) supaya aplikasi bisa "Add to Home
// Screen" / dibungkus jadi APK (PWA/TWA). Lihat manifest.json + sw.js di
// root project. Aman untuk semua browser -- kalau tidak didukung, baris ini
// cuma dilewati tanpa error.
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch((err) => {
            console.warn("Gagal daftar service worker:", err);
        });
    });
}

const JALUR_LABEL = {
    "lembursitu-cianjur":   "Lembursitu - Cianjur",
    "lembursitu-semenjawa": "Lembursitu - Semenjawa"
};

function jalurLabel(value) {
    return JALUR_LABEL[value] || value || "-";
}

// Batas waktu tunggu satu request API. TANPA ini, fetch() bisa "menggantung"
// tanpa batas waktu saat koneksi dalam kondisi tidak stabil -- misalnya
// sesaat setelah data seluler dimatikan lalu dinyalakan lagi (radio sudah
// aktif tapi rute internet belum benar-benar tersambung). Selama fetch
// menggantung, semua await di halaman (initPage, loadSpan, dst) ikut
// nyangkut, dan cache-first di sync.js tidak sempat fallback karena
// promise-nya belum pernah selesai (bukan gagal, cuma belum selesai-selesai).
const API_TIMEOUT_MS = 15000;

async function apiRequest(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { "Content-Type": "application/json" },
            ...options,
            signal: controller.signal
        });
        const data = await res.json();
        return data;
    } catch (err) {
        if (err && err.name === "AbortError") {
            console.error("Request timeout (>" + API_TIMEOUT_MS + "ms):", url);
            return { success: false, message: "Koneksi lambat/terputus. Coba lagi setelah sinyal stabil." };
        }
        console.error("Gagal menghubungi server:", err);
        return { success: false, message: "Tidak bisa menghubungi server. Periksa koneksi internet." };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function loginUser(username, password) {
    username = username.trim();

    const result = await apiRequest("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
    });

    if (result.success) {
        localStorage.setItem("srinaiUser", result.username);
        localStorage.setItem("srinaiRole", result.role);
        localStorage.setItem("lastLoginUser", result.username);
        localStorage.setItem("loginTime", Date.now());
        // Password masih default (baru dibuat / baru direset admin) -- wajib
        // diganti dulu sebelum bisa pakai halaman lain. Dicek di index.html
        // (redirect) dan profile.html (buka otomatis form ganti password).
        if (result.mustChangePassword) {
            localStorage.setItem("srinaiMustChangePassword", "1");
        } else {
            localStorage.removeItem("srinaiMustChangePassword");
        }
        try {
            localStorage.setItem(LOGIN_CHECK_CACHE_KEY, JSON.stringify({ username: result.username, valid: true, ts: Date.now() }));
        } catch (e) { /* localStorage penuh, lewati cache */ }
        // Tandai login baru (bukan sekadar pindah halaman dalam sesi yang sama).
        // Dicek oleh dashboard.html untuk memunculkan pemberitahuan sinkronisasi
        // wajib, karena data cache lama bisa sudah ketinggalan sejak sesi
        // sebelumnya (logout otomatis jam 6 pagi, atau login di perangkat lain).
        try {
            sessionStorage.setItem("srinaiJustLoggedIn", "1");
        } catch (e) { /* sessionStorage tidak tersedia, lewati */ }
    }

    return result;
}

function logoutUser() {
    stopBackgroundMusic();
    stopNativeLocationTracking();
    unregisterPushToken();
    // Tandai titik lokasi terakhir user ini "redup" di peta.html. Sengaja
    // fire-and-forget (tidak di-await) supaya logout tetap instan meski
    // request ini lambat/gagal (mis. lagi offline) -- request diambil
    // SEBELUM localStorage dibersihkan karena butuh username-nya.
    const username = getCurrentUser();
    if (username) {
        apiRequest("/api/settings?action=locationLogout", {
            method: "POST",
            body: JSON.stringify({ username }),
        }).catch(() => { /* diamkan -- ini bukan fitur wajib buat bisa logout */ });
    }
    localStorage.removeItem("srinaiUser");
    localStorage.removeItem("srinaiRole");
    localStorage.removeItem("loginTime");
    localStorage.removeItem(LOGIN_CHECK_CACHE_KEY);
    localStorage.removeItem("srinaiMustChangePassword");
}

/** Ringkasan log login semua akun (admin) — last_login & jumlah login */
async function getLoginLogSummary() {
    const result = await apiRequest("/api/login");
    return result && result.success ? result.accounts : [];
}

/** Riwayat login satu akun, terbaru dulu (default 50, maks 200) */
async function getLoginHistory(username, limit) {
    let url = "/api/login?username=" + encodeURIComponent(username);
    if (limit) url += "&limit=" + encodeURIComponent(limit);
    const result = await apiRequest(url);
    return result && result.success ? result.history : [];
}

/** Feed log aktivitas (tegakan & akun) — terbaru dulu, default 100, maks 300 */
async function getActivityLog(entityType, limit) {
    let url = "/api/login?action=activity";
    if (entityType) url += "&entityType=" + encodeURIComponent(entityType);
    if (limit) url += "&limit=" + encodeURIComponent(limit);
    const result = await apiRequest(url);
    return result && result.success ? result.activities : [];
}

function getCurrentUser() {
    return localStorage.getItem("srinaiUser");
}

function getCurrentRole() {
    return localStorage.getItem("srinaiRole");
}

function getLastLoginUser() {
    return localStorage.getItem("lastLoginUser");
}

/* ─── Cache status login ───────────────────────────────────
   isLoggedIn() sebelumnya SELALU hit /api/accounts ke server,
   di SETIAP halaman yang dibuka — ini jadi bottleneck utama
   karena tidak peduli data lain (BA, span, dst) sudah di-cache
   atau belum. Sekarang hasil cek disimpan dengan TTL pendek,
   supaya navigasi antar-halaman dalam rentang TTL tidak perlu
   round-trip ke server lagi. */
const LOGIN_CHECK_CACHE_KEY = "srinai_cache_login_check";
const LOGIN_CHECK_TTL_MS = 2 * 60 * 1000; // 2 menit

// Logout otomatis tiap jam 6 pagi (bukan 24 jam sejak waktu login lagi).
// Begitu jam dinding lewat pukul 06:00 setelah waktu login ("loginTime",
// sudah disimpan di localStorage sejak loginUser()), sesi dianggap
// kedaluwarsa. Dicek di isLoggedIn() SEBELUM cache 2-menit di atas, supaya
// sesi yang sudah lewat jam 6 pagi tidak "diselamatkan" oleh cache
// tersebut (yang tujuannya cuma buat status akun aktif/nonaktif dari
// server, bukan buat expiry waktu). Dicek juga secara berkala lewat
// startSessionExpiryWatcher() di bawah, buat tab yang dibiarkan terbuka
// terus tanpa pindah halaman.
const SESSION_EXPIRY_HOUR = 6; // jam 06:00 waktu lokal perangkat

// Mengembalikan timestamp (ms) jam 06:00 TERAKHIR yang sudah lewat,
// dihitung dari waktu "now". Kalau sekarang masih sebelum jam 6 pagi hari
// ini, berarti jam 6 terakhir jatuh di hari kemarin.
function getLastSessionExpiryTime(now) {
    const d = new Date(now);
    d.setHours(SESSION_EXPIRY_HOUR, 0, 0, 0);
    if (d.getTime() > now.getTime()) {
        d.setDate(d.getDate() - 1);
    }
    return d.getTime();
}

function isSessionExpired() {
    const loginTime = parseInt(localStorage.getItem("loginTime") || "0", 10);
    if (!loginTime) return false;
    return loginTime < getLastSessionExpiryTime(new Date());
}

async function isLoggedIn() {
    const username = getCurrentUser();
    if (!username) return false;

    if (isSessionExpired()) {
        logoutUser();
        return false;
    }

    try {
        const raw = localStorage.getItem(LOGIN_CHECK_CACHE_KEY);
        if (raw) {
            const cached = JSON.parse(raw);
            if (cached && cached.username === username && (Date.now() - cached.ts) < LOGIN_CHECK_TTL_MS) {
                return cached.valid;
            }
        }
    } catch (e) { /* cache rusak, lanjut cek ke server seperti biasa */ }

    const result = await apiRequest("/api/accounts?username=" + encodeURIComponent(username) + "&check=1");

    if (result.success === false && result.message === "Tidak bisa menghubungi server. Periksa koneksi internet.") {
        return true;
    }

    const account = (result.accounts || []).find(a => a.username === username);
    const valid = !!(account && account.status === "Aktif");

    try {
        localStorage.setItem(LOGIN_CHECK_CACHE_KEY, JSON.stringify({ username, valid, ts: Date.now() }));
    } catch (e) { /* localStorage penuh, lewati cache */ }

    if (!valid) {
        logoutUser();
        return false;
    }

    return true;
}

function isAdmin()   { return getCurrentRole() === "admin";   }
function isKLW()     { return getCurrentRole() === "klw";     }
function isLW()      { return getCurrentRole() === "lw";      }
function isMonitor() { return getCurrentRole() === "monitor"; }

// Catatan: dulu ada parameter includeFoto untuk skip resolve foto Drive.
// Fitur foto profil sudah dihapus (Ags 2026), jadi parameter itu dibuang.
async function getAllAccountsFull() {
    const result = await apiRequest("/api/accounts");
    if (!result.success) throw new Error(result.message || "Gagal memuat akun.");
    return result.accounts || [];
}

async function getActiveUsernames() {
    const accounts = await getAllAccountsFull();
    return accounts
        .filter(a => a.status === "Aktif")
        .map(a => a.username)
        .sort();
}

async function getAllUsernames() {
    const accounts = await getAllAccountsFull();
    return accounts.map(a => a.username).sort();
}

function assetCodeTower(jalurCode, nomor) {
    return jalurCode + "-T" + String(nomor).padStart(3, "0");
}

function assetCodeSpan(jalurCode, nomor) {
    return jalurCode + "-S" + String(nomor).padStart(3, "0");
}

// ===================== QR CODE (cache-first via Google Drive) =====================
// key contoh: "qr:tower:<id>" atau "qr:span:<id>"
// url        : isi/link yang di-encode ke QR
// Cek dulu ke /api/settings (Drive), kalau belum ada baru generate di browser
// pakai QRCode.js lalu upload sekali supaya panggilan berikutnya tinggal ambil.
// Butuh QRCode.js (qrcodejs) sudah termuat di halaman pemanggil.
async function getOrCreateQrDataUrl(key, url, size) {
    size = size || 220;

    // 1) Coba ambil dari cache Drive dulu
    try {
        const res = await apiRequest(`/api/settings?key=${encodeURIComponent(key)}`);
        if (res && res.success && res.value) {
            return res.value; // sudah berupa data:image/png;base64,...
        }
    } catch (e) {
        console.warn("Cek cache QR gagal, lanjut generate baru:", e.message);
    }

    // 2) Belum ada -> generate di browser pakai canvas sementara
    const tempDiv = document.createElement("div");
    tempDiv.style.display = "none";
    document.body.appendChild(tempDiv);

    new QRCode(tempDiv, {
        text: url,
        width: size,
        height: size,
        colorDark: "#0A1E3D",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
    });

    // QRCode.js menggambar async ke canvas; beri sedikit waktu render
    await new Promise(r => setTimeout(r, 60));

    const canvas = tempDiv.querySelector("canvas");
    const dataUrl = canvas ? canvas.toDataURL("image/png") : null;
    document.body.removeChild(tempDiv);

    if (!dataUrl) return null;

    // 3) Upload ke Drive supaya panggilan berikutnya tidak generate ulang
    try {
        await apiRequest("/api/settings", {
            method: "POST",
            body: JSON.stringify({ key, value: dataUrl })
        });
    } catch (e) {
        console.warn("Simpan cache QR ke Drive gagal (QR tetap dipakai):", e.message);
    }

    return dataUrl;
}

async function getSpanOwner(spanId) {
    const accounts = await getAllAccountsFull();
    const owner = accounts.find(a => (a.span_ids || []).includes(spanId));
    return owner ? owner.username : null;
}

async function getFullProfile(username) {
    const accounts = await getAllAccountsFull();
    const account = accounts.find(a => a.username === username);
    if (!account) return null;

    const towerAwal  = account.tower_awal  != null ? account.tower_awal  : 1;
    const towerAkhir = account.tower_akhir != null ? account.tower_akhir : 1;
    const towerIds   = account.tower_ids || [];
    const spanIds    = account.span_ids  || [];
    const hasNewAssignment = towerIds.length > 0 || spanIds.length > 0;

    let jumlahTower, jumlahSpan, towerLabel;

    if (account.role === "admin" || account.role === "monitor") {
        // Admin & Monitor melihat semua data berdasarkan jalur miliknya
        const [towerMaster, spanMaster] = await Promise.all([
            getTowerMasterList(account.jalur_id),
            getSpanMasterList(account.jalur_id)
        ]);
        jumlahTower = towerMaster.length;
        jumlahSpan  = spanMaster.length;
        if (towerMaster.length > 0) {
            const nums = towerMaster.map(t => t.nomor);
            towerLabel = "T" + String(Math.min(...nums)).padStart(3, "0")
                       + " – T" + String(Math.max(...nums)).padStart(3, "0");
        } else {
            towerLabel = "Belum ada data";
        }
    } else if (hasNewAssignment) {
        const jalurList = await getJalurMasterList();
        const towerMaster = await getTowerMasterList();
        const jalurMatch = jalurList.find(j => j.id === account.jalur_id);

        const allTowers = towerMaster.filter(t => towerIds.includes(t.id));
        jumlahTower = allTowers.length;
        jumlahSpan = spanIds.length;

        if (allTowers.length > 0 && jalurMatch) {
            const nums = allTowers.map(t => t.nomor).sort((a, b) => a - b);
            towerLabel = assetCodeTower(jalurMatch.code, nums[0]) +
                (nums.length > 1 ? " + " + (nums.length - 1) + " lainnya" : "");
        } else {
            towerLabel = "Belum ada tower";
        }
    } else {
        jumlahTower = (towerAkhir - towerAwal + 1);
        jumlahSpan  = Math.max(jumlahTower - 1, 0);
        towerLabel  = "T" + String(towerAwal).padStart(3, "0") + " - T" + String(towerAkhir).padStart(3, "0");
    }

    return {
        nama        : username,
        role        : account.role || "",
        status      : account.status,
        jabatan     : account.jabatan || (account.role ? account.role.toUpperCase() : ""),
        jalur       : account.jalur || "lembursitu-cianjur",
        jalurId     : account.jalur_id || null,
        jalurLabel  : jalurLabel(account.jalur),
        towerAwal   : towerAwal,
        towerAkhir  : towerAkhir,
        towerLabel  : towerLabel,
        towerIds    : towerIds,
        spanIds     : spanIds,
        jumlahTower : jumlahTower,
        jumlahSpan  : jumlahSpan,
        hasNewAssignment: hasNewAssignment,
        wilayah     : account.wilayah || "",
        foto        : account.foto || ""
    };
}

/** Mode ringan {count, maxUpdatedAt} -- dipakai sync.js buat cek ada
 *  perubahan atau tidak sejak sync terakhir, tanpa tarik data lengkap. */
async function _getMasterMeta(endpoint) {
    const result = await apiRequest(endpoint + "?meta=1");
    if (!result.success) throw new Error(result.message || "Gagal memuat metadata.");
    return result.meta || { count: 0, maxUpdatedAt: null };
}
async function getJalurMeta() { return await _getMasterMeta("/api/jalur"); }
async function getTowerMeta() { return await _getMasterMeta("/api/tower"); }
async function getSpanMeta()  { return await _getMasterMeta("/api/span");  }
async function getBAMeta()    { return await _getMasterMeta("/api/ba");    }

function _mapJalurRow(j) {
    return {
        id: j.id,
        code: j.code,
        label: j.label,
        aktif: j.aktif,
        penghantar: j.penghantar || "",
        parentJalurId: j.parent_jalur_id || null,
        parentLabel: j.parent_label || null,
        parentCode: j.parent_code || null,
        towerCount: Number(j.tower_count) || 0,
        spanCount: Number(j.span_count) || 0
    };
}
function _mapTowerRow(t) {
    return {
        id: t.id,
        jalurId: t.jalur_id,
        nomor: t.nomor,
        jenis: t.jenis || "",
        isolator: t.isolator || "",
        renceng: t.renceng || "",
        status: t.status || "",
        latitude: t.latitude !== null && t.latitude !== undefined ? Number(t.latitude) : null,
        longitude: t.longitude !== null && t.longitude !== undefined ? Number(t.longitude) : null,
        akurasiMeter: t.akurasi_meter !== null && t.akurasi_meter !== undefined ? Number(t.akurasi_meter) : null,
        koordinatBy: t.koordinat_by || null,
        koordinatAt: t.koordinat_at || null
    };
}
function _mapSpanRow(s) {
    return {
        id: s.id,
        jalurId: s.jalur_id,
        nomor: s.nomor,
        spacer: s.spacer || "",
        joint: s.joint || "",
        status: s.status || ""
    };
}

/**
 * getJalurMasterList/getTowerMasterList/getSpanMasterList:
 * - TANPA `since` -> perilaku lama persis, return array lengkap (dipakai
 *   semua halaman selain sync.js: master-jalur.html, informasi-span.html, dst).
 * - DENGAN `since` (ISO timestamp dari sync terakhir) -> mode delta, return
 *   { rows, activeIds } supaya sync.js bisa upsert+deteksi-hapus tanpa
 *   tarik ulang seluruh tabel. Dipakai HANYA oleh js/sync.js.
 */
async function getJalurMasterList(since) {
    const url = "/api/jalur" + (since ? "?since=" + encodeURIComponent(since) : "");
    const result = await apiRequest(url);
    if (!result.success) throw new Error(result.message || "Gagal memuat data jalur.");
    if (since) return { rows: result.jalur.map(_mapJalurRow), activeIds: result.activeIds || [] };
    return result.jalur.map(_mapJalurRow);
}

async function getTowerMasterList(jalurId, since) {
    const params = [];
    if (jalurId) params.push("jalurId=" + encodeURIComponent(jalurId));
    if (since) params.push("since=" + encodeURIComponent(since));
    const url = "/api/tower" + (params.length ? "?" + params.join("&") : "");
    const result = await apiRequest(url);
    if (!result.success) throw new Error(result.message || "Gagal memuat data tower.");
    if (since) return { rows: result.tower.map(_mapTowerRow), activeIds: result.activeIds || [] };
    return result.tower.map(_mapTowerRow);
}

async function getSpanMasterList(jalurId, since) {
    const params = [];
    if (jalurId) params.push("jalurId=" + encodeURIComponent(jalurId));
    if (since) params.push("since=" + encodeURIComponent(since));
    const url = "/api/span" + (params.length ? "?" + params.join("&") : "");
    const result = await apiRequest(url);
    if (!result.success) throw new Error(result.message || "Gagal memuat data span.");
    if (since) return { rows: result.span.map(_mapSpanRow), activeIds: result.activeIds || [] };
    return result.span.map(_mapSpanRow);
}

async function addAccount(username, password, role, profileFields) {
    return await apiRequest("/api/accounts", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password, role, profileFields, actor: getCurrentUser() })
    });
}

async function updateAccountProfile(username, fields) {
    const result = await apiRequest("/api/accounts", {
        method: "PUT",
        body: JSON.stringify({ username, fields, actor: getCurrentUser() })
    });
    return result;
}

async function activateAccount(username) {
    const result = await updateAccountProfile(username, { status: "Aktif" });
    return result;
}

async function deactivateAccount(username) {
    const result = await updateAccountProfile(username, { status: "Belum Aktif" });
    return result;
}

async function resetPassword(username) {
    const result = await apiRequest("/api/accounts?action=resetPassword", {
        method: "POST",
        body: JSON.stringify({ username, actor: getCurrentUser() })
    });
    return result.success === true;
}

async function changePassword(username, oldPassword, newPassword) {
    const result = await apiRequest("/api/accounts?action=changePassword", {
        method: "POST",
        body: JSON.stringify({ username, oldPassword, newPassword })
    });
    return result || { success: false, message: "Gagal menghubungi server." };
}

async function changeRole(username, newRole) {
    return await updateAccountProfile(username, { role: newRole });
}

async function deleteAccount(username) {
    const result = await apiRequest("/api/accounts?username=" + encodeURIComponent(username) + "&actor=" + encodeURIComponent(getCurrentUser() || ""), {
        method: "DELETE"
    });

    if (result.success && getCurrentUser() === username) {
        logoutUser();
    }

    return result.success === true;
}

async function canEditSpan(span) {
    if (isAdmin() || isKLW()) return true;
    if (isMonitor()) return false;

    const profile = await getFullProfile(getCurrentUser());
    if (!profile) return false;

    const nomor = parseInt(span.replace(/[^0-9]/g, ""), 10);
    const akhir = Math.max(profile.towerAkhir - 1, profile.towerAwal);
    return nomor >= profile.towerAwal && nomor <= akhir;
}

function getSpanKey(spanLabel, jalur) {
    if (spanLabel && spanLabel.match(/^span_/)) {
        return spanLabel;
    }
    const j = (jalur || "default").replace(/\s+/g, "-").toLowerCase();
    const s = (spanLabel || "S001").replace(/\s+/g, "");
    return j + "_" + s;
}

async function getProfileSignature(username) {
    const result = await apiRequest("/api/signature?username=" + encodeURIComponent(username));
    return result.signature || null;
}

async function saveProfileSignature(username, ttdType, ttdData) {
    const result = await apiRequest("/api/signature", {
        method: "POST",
        body: JSON.stringify({ username, ttdType, ttdData })
    });
    if (!result.success) return null;
    return { ttdType, ttdData, tanggal: new Date().toLocaleDateString("id-ID") };
}

async function deleteProfileSignature(username) {
    await apiRequest("/api/signature?username=" + encodeURIComponent(username), {
        method: "DELETE"
    });
}

/* =========================================================
   TTD OTOMATIS PEMILIK TEGAKAN
   Dikunci per nama pemilik (bukan per akun) supaya kalau nama yang sama
   dipakai di tegakan/span lain, TTD-nya konsisten dengan yang pertama
   kali dibuat untuk nama tsb.
========================================================= */
async function getPemilikSignature(namaPemilik) {
    if (!namaPemilik || !namaPemilik.trim()) return null;
    const result = await apiRequest("/api/signature?nama=" + encodeURIComponent(namaPemilik));
    return result.signature || null;
}

async function savePemilikSignature(namaPemilik, ttdType, ttdData) {
    // POST: hanya tersimpan kalau nama ini belum punya TTD (first-write-wins),
    // supaya TTD pertama yang dibuat untuk nama tsb tetap jadi acuan auto-fill.
    if (!namaPemilik || !namaPemilik.trim() || !ttdData) return null;
    const result = await apiRequest("/api/signature", {
        method: "POST",
        body: JSON.stringify({ namaPemilik, ttdType, ttdData })
    });
    if (!result.success) return null;
    return result;
}

async function replacePemilikSignature(namaPemilik, ttdType, ttdData) {
    // PUT: sengaja mengganti TTD canonical milik nama pemilik ini.
    if (!namaPemilik || !namaPemilik.trim() || !ttdData) return null;
    const result = await apiRequest("/api/signature", {
        method: "PUT",
        body: JSON.stringify({ namaPemilik, ttdType, ttdData })
    });
    return result.success ? result : null;
}

/* =========================================================
   CATATAN SPAN — Neon Postgres lewat /api/catatan-span
========================================================= */
async function getCatatanBySpan(spanId) {
    const result = await apiRequest("/api/catatan-span?spanId=" + encodeURIComponent(spanId));
    if (!result.success) throw new Error(result.message || "Gagal memuat catatan span.");
    return result.catatan || [];
}

async function addCatatanSpan(spanId, username, catatan, foto, tegakanId, tegakanNama, tegakanIdTegakan) {
    return await apiRequest("/api/catatan-span", {
        method: "POST",
        body: JSON.stringify({ spanId, username, catatan, foto, tegakanId, tegakanNama, tegakanIdTegakan })
    });
}

async function editCatatanSpan(id, catatan, tegakanId, tegakanNama, tegakanIdTegakan) {
    return await apiRequest("/api/catatan-span", {
        method: "PUT",
        body: JSON.stringify({ id, catatan, tegakanId, tegakanNama, tegakanIdTegakan })
    });
}

async function deleteCatatanSpan(id) {
    return await apiRequest("/api/catatan-span?id=" + encodeURIComponent(id), {
        method: "DELETE"
    });
}

/* =========================================================
   CATATAN TOWER — pakai tabel & endpoint yang sama dengan
   Catatan Span (/api/catatan-span), dibedakan lewat towerId
========================================================= */
async function getCatatanByTower(towerId) {
    const result = await apiRequest("/api/catatan-span?towerId=" + encodeURIComponent(towerId));
    if (!result.success) throw new Error(result.message || "Gagal memuat catatan tower.");
    return result.catatan || [];
}

async function addCatatanTower(towerId, username, catatan, foto) {
    return await apiRequest("/api/catatan-span", {
        method: "POST",
        body: JSON.stringify({ towerId, username, catatan, foto })
    });
}

async function editCatatanTower(id, catatan) {
    return await apiRequest("/api/catatan-span", {
        method: "PUT",
        body: JSON.stringify({ id, catatan })
    });
}

async function deleteCatatanTower(id) {
    return await apiRequest("/api/catatan-span?id=" + encodeURIComponent(id), {
        method: "DELETE"
    });
}

/* =========================================================
   FOTO EVIDEN — semua foto yang sudah naik ke Google Drive
========================================================= */
async function getAllFotoEvidence() {
    const result = await apiRequest("/api/catatan-span?evidence=true");
    if (!result.success) throw new Error(result.message || "Gagal memuat foto eviden.");
    return result.catatan || [];
}

/* =========================================================
   KOORDINAT GPS TOWER — /api/tower (PUT, field koordinat)
========================================================= */
async function saveTowerCoordinate(towerId, latitude, longitude, akurasiMeter, username) {
    return await apiRequest("/api/tower", {
        method: "PUT",
        body: JSON.stringify({
            id: towerId,
            fields: { latitude, longitude, akurasiMeter, koordinatBy: username }
        })
    });
}

async function hapusKoordinatTower(towerId) {
    return await apiRequest("/api/tower", {
        method: "PUT",
        body: JSON.stringify({
            id: towerId,
            fields: { clearKoordinat: true }
        })
    });
}

/* =========================================================
   DATA TEGAKAN — Neon Postgres lewat /api/tegakan
========================================================= */
async function getTegakanBySpan(spanId) {
    const result = await apiRequest("/api/tegakan?spanId=" + encodeURIComponent(spanId));
    if (!result.success) throw new Error(result.message || "Gagal memuat data tegakan.");
    return result.tegakan || [];
}

/** Mode ringan: {spanId, count, maxUpdatedAt} per span, dipakai sync.js
 *  buat deteksi span mana yang berubah tanpa tarik data lengkap. */
async function getTegakanMeta() {
    const result = await apiRequest("/api/tegakan?meta=1");
    if (!result.success) throw new Error(result.message || "Gagal memuat metadata tegakan.");
    if (result.meta) return result.meta;
    // Fallback: backend yang sedang live belum mengenali ?meta=1 (masih versi
    // lama / belum ter-redeploy) sehingga cuma balikin { tegakan: [...] }
    // seperti mode lama, bukan { meta: [...] }. Daripada diam-diam dianggap
    // kosong (bikin badge "Belum Ada Tegakan" salah untuk semua span),
    // hitung sendiri ringkasannya dari data lengkap yang memang terkirim.
    if (result.tegakan) {
        const grouped = {};
        result.tegakan.forEach(t => {
            if (!grouped[t.spanId]) grouped[t.spanId] = { spanId: t.spanId, count: 0, maxUpdatedAt: null };
            grouped[t.spanId].count++;
            if (!grouped[t.spanId].maxUpdatedAt || (t.updatedAt || "") > grouped[t.spanId].maxUpdatedAt) {
                grouped[t.spanId].maxUpdatedAt = t.updatedAt || null;
            }
        });
        return Object.values(grouped);
    }
    return [];
}

/** Metadata tegakan (TANPA foto TTD) untuk SATU span saja -- dipakai sync.js
 *  buat refresh span yang benar-benar berubah, tanpa ikut menarik span lain. */
async function getTegakanMetaBySpan(spanId) {
    const result = await apiRequest("/api/tegakan?spanId=" + encodeURIComponent(spanId) + "&includeTtd=false");
    if (!result.success) throw new Error(result.message || "Gagal memuat data tegakan.");
    return result.tegakan || [];
}

async function addTegakan(fields) {
    return await apiRequest("/api/tegakan", {
        method: "POST",
        body: JSON.stringify(fields)
    });
}

async function updateTegakan(id, fields) {
    return await apiRequest("/api/tegakan", {
        method: "PUT",
        body: JSON.stringify({ id, fields, actor: getCurrentUser() })
    });
}

async function deleteTegakan(id) {
    return await apiRequest("/api/tegakan?id=" + encodeURIComponent(id) + "&actor=" + encodeURIComponent(getCurrentUser() || ""), {
        method: "DELETE"
    });
}

/* =========================================================
   BERITA ACARA (BA) — Neon Postgres lewat /api/ba
========================================================= */
async function getBABySpan(spanId) {
    const result = await apiRequest("/api/ba?spanId=" + encodeURIComponent(spanId));
    return result.ba || [];
}

/**
 * TANPA `since` -> perilaku lama, array lengkap.
 * DENGAN `since` -> mode delta { rows, activeIds }, dipakai HANYA js/sync.js.
 */
async function getAllBA(since) {
    const url = "/api/ba" + (since ? "?since=" + encodeURIComponent(since) : "");
    const result = await apiRequest(url);
    if (!result.success) throw new Error(result.message || "Gagal memuat data BA.");
    if (since) return { rows: result.ba || [], activeIds: result.activeIds || [] };
    return result.ba || [];
}

async function saveBADocument(fields) {
    return await apiRequest("/api/ba", {
        method: "POST",
        body: JSON.stringify(fields)
    });
}

async function deleteBADocument(id) {
    return await apiRequest("/api/ba?id=" + encodeURIComponent(id), {
        method: "DELETE"
    });
}

/* =========================================================
   PENGATURAN GLOBAL — Neon Postgres lewat /api/settings
   (systemNotice, baBackground, baContohLayout, baFieldLayout, dll.
   Catatan: loginLogo & loginBackground sudah dihapus -- fitur upload
   logo/background halaman login sudah tidak dipakai lagi, lihat
   pengaturan.html.)
========================================================= */
async function getAppSetting(key) {
    const result = await apiRequest("/api/settings?key=" + encodeURIComponent(key));
    return result.value ?? null;
}

// includeImages=false -> minta server SKIP resolve key gambar (baLogo,
// baBackground, baContohLayout, qr:*) dari Drive, kirim referensi mentahnya
// saja. Dipakai syncAll() lewat _refreshSettingsSelective() supaya sinkron
// tidak diam-diam mendownload ulang gambar yang tidak berubah tiap kali
// tombol Sinkron ditekan. Pemanggil lain yang tidak kirim param ini tetap
// dapat resolusi penuh seperti biasa.
async function getAppSettings(keys, includeImages = true) {
    const url = "/api/settings?keys=" + encodeURIComponent(keys.join(","))
      + (includeImages ? "" : "&includeImages=false");
    const result = await apiRequest(url);
    return result.settings || {};
}

async function setAppSetting(key, value) {
    return await apiRequest("/api/settings", {
        method: "POST",
        body: JSON.stringify({ key, value })
    });
}

async function deleteAppSetting(key) {
    const actor = getCurrentUser();
    return await apiRequest(
        "/api/settings?key=" + encodeURIComponent(key) + "&actor=" + encodeURIComponent(actor || ""),
        { method: "DELETE" }
    );
}

/* =========================================================
   TEMA — sejak tema Klasik dihapus, aplikasi hanya punya satu
   tampilan (Buku Lapangan). Halaman bersama sudah permanen
   memakai class "theme-fieldlog" di <html>, jadi tidak perlu
   lagi sinkronisasi/redirect tema di sini.
========================================================= */

/* =========================================================
   MUSIK LATAR — file statis di /assets/audio (BUKAN disimpan
   di database, jadi tidak makan storage Neon). Logic ini
   dipusatkan di sini (auth.js) karena file ini di-load di
   SEMUA halaman, supaya musik "lanjut" saat user pindah
   halaman, bukan cuma di dashboard.

   Karena app ini multi-page (bukan SPA), setiap pindah halaman
   tetap full reload dokumen — jadi audionya secara teknis
   berhenti sepersekian detik lalu langsung lanjut lagi dari
   posisi (detik) terakhir yang tersimpan, sehingga terasa
   nyaris tanpa putus. Berhenti total hanya saat user tekan
   tombol musik (matikan manual) atau saat logout.
========================================================= */
const MUSIC_PLAYLIST = [
    "assets/audio/kopi-hitam-masih.mp3",
    "assets/audio/ground-patrol.mp3"
];
const MUSIC_ON_KEY   = "srinaiMusicOn";
const MUSIC_TIME_KEY = "srinaiMusicTime";
const MUSIC_TRACK_KEY = "srinaiMusicTrack";
let __bgMusicEl = null;

function __isLoginPage() {
    const path = location.pathname;
    return path === "/" || /\/?index\.html$/.test(path);
}

function stopBackgroundMusic() {
    if (__bgMusicEl) {
        try { __bgMusicEl.pause(); } catch (e) { /* noop */ }
    }
    localStorage.removeItem(MUSIC_ON_KEY);
    localStorage.removeItem(MUSIC_TIME_KEY);
    localStorage.removeItem(MUSIC_TRACK_KEY);
}

function __setMusicIcon(playing) {
    const iconOn  = document.getElementById("musicIconOn");
    const iconOff = document.getElementById("musicIconOff");
    const btn     = document.getElementById("musicBtn");
    if (iconOn)  iconOn.style.display  = playing ? "block" : "none";
    if (iconOff) iconOff.style.display = playing ? "none"  : "block";
    if (btn)     btn.classList.toggle("music-active", playing);
}

function initBackgroundMusic() {
    // Jangan putar musik di halaman login, atau kalau belum login sama sekali
    if (__isLoginPage() || !getCurrentUser()) return;

    // Track lagu mana yang sedang aktif di playlist (index array)
    let trackIndex = parseInt(localStorage.getItem(MUSIC_TRACK_KEY) || "0", 10);
    if (isNaN(trackIndex) || trackIndex < 0 || trackIndex >= MUSIC_PLAYLIST.length) {
        trackIndex = 0;
    }

    const audio = document.createElement("audio");
    audio.id = "bgMusic";
    audio.src = MUSIC_PLAYLIST[trackIndex];
    audio.loop = false; // loop dimatikan; lanjut ke lagu berikutnya via event "ended"
    audio.preload = "auto";
    audio.volume = 0.5;
    audio.style.display = "none";
    document.body.appendChild(audio);
    __bgMusicEl = audio;

    // Lanjutkan dari posisi (detik) terakhir sebelum pindah halaman
    const savedTime = parseFloat(localStorage.getItem(MUSIC_TIME_KEY) || "0");
    if (savedTime > 0 && isFinite(savedTime)) {
        audio.addEventListener("loadedmetadata", () => {
            if (savedTime < audio.duration) audio.currentTime = savedTime;
        }, { once: true });
    }

    // Begitu satu lagu habis, otomatis lanjut ke lagu berikutnya di playlist
    // (kembali ke lagu pertama lagi setelah lagu terakhir habis)
    audio.addEventListener("ended", () => {
        trackIndex = (trackIndex + 1) % MUSIC_PLAYLIST.length;
        localStorage.setItem(MUSIC_TRACK_KEY, String(trackIndex));
        localStorage.setItem(MUSIC_TIME_KEY, "0");
        audio.src = MUSIC_PLAYLIST[trackIndex];
        audio.currentTime = 0;
        audio.play().then(() => __setMusicIcon(true)).catch(() => {});
    });

    function tryAutoplay() {
        const p = audio.play();
        if (p !== undefined) {
            p.then(() => __setMusicIcon(true)).catch(() => {
                // Browser blokir autoplay bersuara tanpa gesture di halaman ini —
                // begitu user tap di mana saja, otomatis lanjut diputar.
                __setMusicIcon(false);
                const resumeOnce = () => {
                    audio.play().then(() => __setMusicIcon(true)).catch(() => {});
                };
                document.addEventListener("click", resumeOnce, { once: true });
                document.addEventListener("touchstart", resumeOnce, { once: true });
            });
        }
    }

    // Musik TIDAK boleh menyala otomatis. Hanya lanjut main kalau user
    // sebelumnya sudah menekan tombol musik untuk menyalakannya (MUSIC_ON_KEY
    // == "1"), misalnya saat pindah halaman sementara musik sedang diputar.
    // Kalau belum pernah dinyalakan sama sekali, default-nya diam.
    if (localStorage.getItem(MUSIC_ON_KEY) === "1") {
        tryAutoplay();
    } else {
        __setMusicIcon(false);
    }

    audio.addEventListener("timeupdate", () => {
        localStorage.setItem(MUSIC_TIME_KEY, String(audio.currentTime));
    });
    window.addEventListener("pagehide", () => {
        localStorage.setItem(MUSIC_TIME_KEY, String(audio.currentTime));
        localStorage.setItem(MUSIC_TRACK_KEY, String(trackIndex));
        localStorage.setItem(MUSIC_ON_KEY, audio.paused ? "0" : "1");
    });

    window.toggleMusic = function () {
        if (audio.paused) {
            audio.play().then(() => {
                __setMusicIcon(true);
                localStorage.setItem(MUSIC_ON_KEY, "1");
            }).catch(() => {});
        } else {
            audio.pause();
            __setMusicIcon(false);
            localStorage.setItem(MUSIC_ON_KEY, "0");
        }
    };
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initBackgroundMusic);
} else {
    initBackgroundMusic();
}

/* ─── Heartbeat lokasi (dipakai peta.html) ──────────────────────────
   Selama user login DAN browser mengizinkan akses lokasi, kirim posisi
   GPS-nya secara berkala ke /api/settings (action=location) supaya bisa
   ditampilkan di peta.html. Jalan otomatis di SEMUA halaman (karena
   auth.js dipakai di mana-mana) -- bukan cuma pas peta.html dibuka --
   supaya titik petugas di peta selalu representasi lokasi TERKINI,
   bukan cuma pas dia lagi buka halaman peta.
   Diam-diam berhenti (tidak pernah nge-alert user) kalau geolocation
   tidak didukung/izin ditolak -- fitur peta jadi opsional, bukan wajib
   buat bisa tetap pakai app. Tidak nambah endpoint baru: numpang di
   /api/settings key "loc:<username>" (JSON string), sama pola dengan
   fitur botNotify sebelumnya -- Vercel Hobby dibatasi 12 function/
   deployment dan project ini sudah pas di batas itu. */
const LOCATION_HEARTBEAT_INTERVAL_MS = 60 * 1000; // 1 menit

// 21 Agustus 2026: heartbeat ini dulu jalan di SEMUA halaman (auth.js
// dipakai di mana-mana), tiap 60 detik, nge-hit DB terus-menerus selama
// tab dibiarkan terbuka -- bikin Neon compute endpoint tidak pernah
// sempat autosuspend dan menghabiskan kuota CU-hrs bulanan cuma dalam
// ~20 hari. Sekarang dibatasi supaya cuma jalan di HALAMAN PETA (yang
// benar-benar butuh data lokasi real-time), dan otomatis pause saat tab
// tidak fokus (lihat visibilitychange di bawah).
function __isPetaPage() {
    return /(^|\/)peta\.html$/.test(location.pathname);
}

let __locationHeartbeatTimer = null;

function sendLocationHeartbeat() {
    const username = getCurrentUser();
    if (!username || !navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            apiRequest("/api/settings?action=location", {
                method: "POST",
                body: JSON.stringify({
                    username,
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                }),
            });
        },
        () => { /* izin lokasi ditolak / gagal ambil posisi -- diamkan saja */ },
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
    );
}

function __startLocationHeartbeatTimer() {
    if (__locationHeartbeatTimer) return; // sudah jalan, jangan dobel
    sendLocationHeartbeat();
    __locationHeartbeatTimer = setInterval(sendLocationHeartbeat, LOCATION_HEARTBEAT_INTERVAL_MS);
}

function __stopLocationHeartbeatTimer() {
    if (!__locationHeartbeatTimer) return;
    clearInterval(__locationHeartbeatTimer);
    __locationHeartbeatTimer = null;
}

function startLocationHeartbeat() {
    if (!getCurrentUser() || !navigator.geolocation || !__isPetaPage()) return;

    // Mulai kalau tab lagi kelihatan; kalau tidak, tunggu sampai user
    // balik lihat tab ini (event visibilitychange di bawah yang mulai).
    if (document.visibilityState === "visible") {
        __startLocationHeartbeatTimer();
    }

    document.addEventListener("visibilitychange", () => {
        if (!__isPetaPage()) return;
        if (document.visibilityState === "visible") {
            __startLocationHeartbeatTimer();
        } else {
            __stopLocationHeartbeatTimer();
        }
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startLocationHeartbeat);
} else {
    startLocationHeartbeat();
}

/* ─── Background location tracking (APK native) ──────────────────────
   Heartbeat JS di atas cuma jalan selama halaman web-nya aktif -- begitu
   app native ditutup/di-swipe dari recent apps, semua JS berhenti total.
   Kalau app ini native (dibuild lewat Capacitor, bukan dibuka di browser
   biasa), pakai foreground service Android (LocationTrackerPlugin) yang
   jalan independen dari WebView supaya titik lokasi tetap ke-update ke
   endpoint yang SAMA (/api/settings?action=location) walau app ditutup.
   Di browser biasa (window.Capacitor tidak ada), bagian ini no-op --
   heartbeat JS di atas tetap jadi satu-satunya sumber update lokasi. */
function isNativeApp() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

function startNativeLocationTracking() {
    const username = getCurrentUser();
    if (!isNativeApp() || !username) return;
    const LocationTracker = window.Capacitor.Plugins && window.Capacitor.Plugins.LocationTracker;
    if (!LocationTracker) return;
    LocationTracker.requestLocationPermissions()
        .then(() => LocationTracker.startTracking({ username }))
        .catch(() => { /* izin ditolak -- diamkan, fitur peta tetap opsional */ });
}

function stopNativeLocationTracking() {
    if (!isNativeApp()) return;
    const LocationTracker = window.Capacitor.Plugins && window.Capacitor.Plugins.LocationTracker;
    if (LocationTracker) LocationTracker.stopTracking().catch(() => {});
}

/* ─── Push Notification (FCM) ───────────────────────────────────────
   Dipanggil sekali tiap halaman dimuat (sama seperti location tracking).
   Cuma jalan di app native (Capacitor), karena butuh plugin
   @capacitor/push-notifications -- browser biasa tidak didukung untuk
   notifikasi yang tetap berbunyi walau app ditutup total. */
const FCM_TOKEN_CACHE_KEY = "srinaiFcmToken";

function startPushRegistration() {
    const username = getCurrentUser();
    if (!isNativeApp() || !username) return;
    const PushNotifications = window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
    if (!PushNotifications) return;

    PushNotifications.checkPermissions().then((res) => {
        const proceed = (res.receive === "granted")
            ? Promise.resolve()
            : PushNotifications.requestPermissions().then((r) => {
                if (r.receive !== "granted") throw new Error("Izin notifikasi ditolak");
            });

        proceed.then(() => PushNotifications.register()).catch(() => {
            // izin ditolak -- diamkan, fitur notifikasi tetap opsional
        });
    });

    PushNotifications.addListener("registration", (token) => {
        localStorage.setItem(FCM_TOKEN_CACHE_KEY, token.value);
        apiRequest("/api/accounts?action=registerFcmToken", {
            method: "POST",
            body: JSON.stringify({ username, token: token.value, deviceInfo: navigator.userAgent }),
        }).catch(() => { /* diamkan -- coba lagi otomatis di load halaman berikutnya */ });
    });

    PushNotifications.addListener("registrationError", (err) => {
        console.warn("Gagal daftar push notification:", err);
    });

    // Android/FCM cuma otomatis nampilin notifikasi (+ bunyi channel
    // custom-nya) kalau app di-background/tertutup total. Kalau app lagi
    // KEBUKA pas push masuk, sistem TIDAK nampilin apa-apa secara
    // otomatis -- makanya perlu listener ini buat mainin suara sendiri
    // dari sisi JS supaya user tetap dengar notifnya walau lagi di app.
    PushNotifications.addListener("pushNotificationReceived", (notification) => {
        const type = notification && notification.data && notification.data.type;
        if (type === "ba_auto_sent") {
            playBaAutoChime();
        } else if (type === "broadcast_file_sent") {
            playBroadcastFileChime();
        }
    });
}

/** Suara notifikasi "BA Otomatis terkirim" versi foreground (app lagi
    kebuka). Versi background/tertutup dapat suaranya dari channel Android
    native (lihat android-native/MainActivity.java, channel srinai_ba_auto)
    -- ini cuma buat nutup celah pas app kebuka, jadi harus file yang sama
    persis (cukup versi web-nya di assets/audio/, format apapun boleh beda
    karena ini diputar lewat <audio> HTML, bukan resource Android). */
function playBaAutoChime() {
    try {
        const chime = new Audio("assets/audio/Notifikasi-female-telegram.mp3");
        chime.volume = 0.8;
        chime.play().catch(() => {});
    } catch (e) { /* diamkan -- suara cuma pelengkap, jangan sampai bikin error lain */ }
}

/** Suara notifikasi "File baru dikirim admin lewat Telegram" versi
    foreground (app lagi kebuka). Versi background/tertutup dapat suaranya
    dari channel Android native srinai_broadcast_file (lihat
    android-native/MainActivity.java) -- sama polanya dengan playBaAutoChime
    di atas, cuma untuk fitur broadcast file admin (bukan BA Otomatis).

    CATATAN FIX: sebelumnya file ini merujuk ke "Notif-telegram.mp3" yang
    TIDAK PERNAH ADA di folder assets/audio/ (cuma ada
    "Notifikasi-female-telegram.mp3"). Karena chime.play().catch(() => {})
    menelan error 404-nya diam-diam, ini jadi penyebab kenapa broadcast
    file sukses terkirim & FCM sukses diterima device, tapi TIDAK ADA
    bunyi/apa pun sama sekali saat app foreground -- bukan masalah FCM/
    token, murni file audio yang direferensikan tidak pernah ada. Untuk
    sementara dipakaikan file yang sama dengan playBaAutoChime() supaya
    tetap bunyi; ganti ke file audio broadcast yang sesungguhnya begitu
    tersedia. */
function playBroadcastFileChime() {
    try {
        const chime = new Audio("assets/audio/Notifikasi-female-telegram.mp3");
        chime.volume = 0.8;
        chime.play().catch(() => {});
    } catch (e) { /* diamkan -- suara cuma pelengkap, jangan sampai bikin error lain */ }
}

/** Dipanggil dari logoutUser() supaya device yang logout berhenti terima
    push atas nama user lama. */
function unregisterPushToken() {
    if (!isNativeApp()) return;
    const token = localStorage.getItem(FCM_TOKEN_CACHE_KEY);
    if (!token) return;
    apiRequest("/api/accounts?action=unregisterFcmToken", {
        method: "POST",
        body: JSON.stringify({ token }),
    }).catch(() => {});
    localStorage.removeItem(FCM_TOKEN_CACHE_KEY);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startPushRegistration);
} else {
    startPushRegistration();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startNativeLocationTracking);
} else {
    startNativeLocationTracking();
}

/* ─── Watcher sesi (logout otomatis jam 6 pagi) ─────────────────────
   Guard isLoggedIn() di atas sudah menangani logout otomatis begitu user
   PINDAH halaman setelah lewat jam 6 pagi. Tambahan ini menangani kasus
   tab yang dibiarkan terbuka terus tanpa navigasi -- dicek tiap 1 menit
   (sama interval-nya dengan heartbeat lokasi), begitu kedaluwarsa
   langsung logout + redirect ke index.html. Tidak jalan di halaman login
   itu sendiri (hindari redirect loop) atau kalau memang belum login. */
const SESSION_EXPIRY_CHECK_INTERVAL_MS = 60 * 1000; // 1 menit

function checkSessionExpiryNow() {
    if (__isLoginPage() || !getCurrentUser()) return;
    if (isSessionExpired()) {
        logoutUser();
        location.href = "index.html";
    }
}

function startSessionExpiryWatcher() {
    if (__isLoginPage() || !getCurrentUser()) return;
    checkSessionExpiryNow();
    setInterval(checkSessionExpiryNow, SESSION_EXPIRY_CHECK_INTERVAL_MS);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startSessionExpiryWatcher);
} else {
    startSessionExpiryWatcher();
}
