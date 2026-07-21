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

async function apiRequest(url, options) {
    try {
        const res = await fetch(url, {
            headers: { "Content-Type": "application/json" },
            ...options
        });
        const data = await res.json();
        return data;
    } catch (err) {
        console.error("Gagal menghubungi server:", err);
        return { success: false, message: "Tidak bisa menghubungi server. Periksa koneksi internet." };
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
        try {
            localStorage.setItem(LOGIN_CHECK_CACHE_KEY, JSON.stringify({ username: result.username, valid: true, ts: Date.now() }));
        } catch (e) { /* localStorage penuh, lewati cache */ }
    }

    return result;
}

function logoutUser() {
    stopBackgroundMusic();
    localStorage.removeItem("srinaiUser");
    localStorage.removeItem("srinaiRole");
    localStorage.removeItem("loginTime");
    localStorage.removeItem(LOGIN_CHECK_CACHE_KEY);
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

async function isLoggedIn() {
    const username = getCurrentUser();
    if (!username) return false;

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

async function getJalurMasterList() {
    const result = await apiRequest("/api/jalur");
    if (!result.success) throw new Error(result.message || "Gagal memuat data jalur.");
    return result.jalur.map(j => ({
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
    }));
}

async function getTowerMasterList(jalurId) {
    const url = jalurId ? "/api/tower?jalurId=" + encodeURIComponent(jalurId) : "/api/tower";
    const result = await apiRequest(url);
    if (!result.success) throw new Error(result.message || "Gagal memuat data tower.");
    return result.tower.map(t => ({
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
    }));
}

async function getSpanMasterList(jalurId) {
    const url = jalurId ? "/api/span?jalurId=" + encodeURIComponent(jalurId) : "/api/span";
    const result = await apiRequest(url);
    if (!result.success) throw new Error(result.message || "Gagal memuat data span.");
    return result.span.map(s => ({
        id: s.id,
        jalurId: s.jalur_id,
        nomor: s.nomor,
        spacer: s.spacer || "",
        joint: s.joint || "",
        status: s.status || ""
    }));
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

function getTegakanData() {
    return JSON.parse(localStorage.getItem("tegakanData")) || {};
}

function saveTegakanData(data) {
    localStorage.setItem("tegakanData", JSON.stringify(data));
}

function getTegakanBySpan(span) {
    const data = getTegakanData();
    return data[span] || [];
}

function tambahTegakan(span, fields) {
    const data = getTegakanData();
    if (!data[span]) data[span] = [];

    const item = {
        id          : Date.now(),
        nama        : fields.nama || "",
        idTegakan   : fields.idTegakan || "",
        pemilikNama : fields.pemilikNama || "",
        pemilikAlamat: fields.pemilikAlamat || "",
        pemilikTelp : fields.pemilikTelp || "",
        petugas     : fields.petugas || getCurrentUser(),
        ttdType     : fields.ttdType || "",
        ttdData     : fields.ttdData || "",
        dibuatOleh  : getCurrentUser(),
        tanggal     : new Date().toLocaleString("id-ID")
    };

    data[span].unshift(item);
    saveTegakanData(data);
    return item;
}

function updateTegakan(span, id, fields) {
    const data = getTegakanData();
    if (!data[span]) return false;
    const item = data[span].find(x => x.id === id);
    if (!item) return false;

    Object.keys(fields).forEach(key => {
        item[key] = fields[key];
    });

    saveTegakanData(data);
    return true;
}

function hapusTegakan(span, id) {
    const data = getTegakanData();
    if (!data[span]) return false;
    data[span] = data[span].filter(x => x.id !== id);
    saveTegakanData(data);
    return true;
}

function isTegakanLengkap(item) {
    return !!(item.pemilikNama && item.pemilikNama.trim() &&
               item.pemilikAlamat && item.pemilikAlamat.trim() &&
               item.ttdData && item.ttdData.trim());
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
   KIRIM KOORDINAT KE GROUP CHAT — pakai /api/chat yang sudah
   ada (field meta), supaya tidak perlu endpoint baru
========================================================= */
async function sendCoordinateToChat(username, meta) {
    return await apiRequest("/api/chat", {
        method: "POST",
        body: JSON.stringify({ username, text: "", meta })
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

async function getAllBA() {
    const result = await apiRequest("/api/ba");
    if (!result.success) throw new Error(result.message || "Gagal memuat data BA.");
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
   (loginLogo, loginBackground, systemNotice, baBackground,
   baContohLayout, baFieldLayout, dll)
========================================================= */
async function getAppSetting(key) {
    const result = await apiRequest("/api/settings?key=" + encodeURIComponent(key));
    return result.value ?? null;
}

async function getAppSettings(keys) {
    const result = await apiRequest("/api/settings?keys=" + encodeURIComponent(keys.join(",")));
    return result.settings || {};
}

async function setAppSetting(key, value) {
    return await apiRequest("/api/settings", {
        method: "POST",
        body: JSON.stringify({ key, value })
    });
}

async function deleteAppSetting(key) {
    return await apiRequest("/api/settings?key=" + encodeURIComponent(key), {
        method: "DELETE"
    });
}

/* =========================================================
   TEMA — sejak tema Klasik dihapus, aplikasi hanya punya satu
   tampilan (Buku Lapangan). Halaman bersama sudah permanen
   memakai class "theme-fieldlog" di <html>, jadi tidak perlu
   lagi sinkronisasi/redirect tema di sini.
========================================================= */

/* =========================================================
   GROUP CHAT — Neon Postgres lewat /api/chat
========================================================= */
async function getChatMessages(limit) {
    const result = await apiRequest("/api/chat?limit=" + (limit || 100));
    return result.messages || [];
}

async function sendChatMessage(username, text, foto) {
    return await apiRequest("/api/chat", {
        method: "POST",
        body: JSON.stringify({ username, text, foto })
    });
}

async function deleteChatMessage(id) {
    return await apiRequest("/api/chat?id=" + encodeURIComponent(id), {
        method: "DELETE"
    });
}

async function clearAllChatMessages() {
    return await apiRequest("/api/chat?all=1", {
        method: "DELETE"
    });
}

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

    // Hormati pilihan terakhir user: kalau dimatikan manual, jangan autoplay lagi
    if (localStorage.getItem(MUSIC_ON_KEY) === "0") {
        __setMusicIcon(false);
    } else {
        tryAutoplay();
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

function startLocationHeartbeat() {
    if (!getCurrentUser() || !navigator.geolocation) return;
    sendLocationHeartbeat();
    setInterval(sendLocationHeartbeat, LOCATION_HEARTBEAT_INTERVAL_MS);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startLocationHeartbeat);
} else {
    startLocationHeartbeat();
}
