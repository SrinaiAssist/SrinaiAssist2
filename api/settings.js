// api/settings.js
//
// GET    /api/settings?key=..              -> ambil satu setting
// GET    /api/settings?keys=a,b,c           -> ambil beberapa setting sekaligus
// POST   /api/settings                      -> simpan/replace satu setting
//        body: { key, value }
// DELETE /api/settings?key=..               -> hapus satu setting (reset ke default)
//
// GET    /api/settings?action=botNotify&username=..   -> notif CommandBot
//        belum terbaca untuk 1 user (rekap harian "span belum ada tegakan")
// POST   /api/settings?action=botNotifyRead body:{username, id?}
//        -> tandai notif dibaca (tanpa id = tandai semua punya user itu)
// GET    /api/settings?action=botNotifyCron -> dipanggil Vercel Cron sekali
//        sehari (lihat vercel.json), diproteksi header
//        Authorization: Bearer <CRON_SECRET>
//
// POST   /api/settings?action=location  body:{ username, lat, lng, accuracy? }
//        -> heartbeat lokasi live 1 petugas (dipanggil otomatis dari
//        js/auth.js di semua halaman, lihat startLocationHeartbeat())
// GET    /api/settings?action=locations -> semua lokasi live petugas
//        sekaligus, dipakai peta.html
// POST   /api/settings?action=locationLogout  body:{ username }
//        -> tandai titik lokasi terakhir user itu "loggedOut" (dipanggil
//        dari logoutUser() di js/auth.js). Lat/lng TIDAK dihapus supaya
//        titik terakhirnya tetap muncul di peta.html, cuma ditampilkan
//        redup. Menutup app saja (tanpa logout) TIDAK memicu ini -- titik
//        harus tetap terlihat normal sampai user benar-benar logout.
//
// GET    /api/settings?action=telegramLinkStatus&username=..
//        -> lihat catatan lengkap di dekat handleTelegramLinkStatus di bawah.
//
// GET    /api/settings?action=botlabDashboardUrl -> { url } dashboard Botlab
//        (dari BOTLAB_API_URL), dipakai tombol "Buka Dashboard BotLab" di
//        workspace-command.html. Tidak mengirim BOTLAB_ADMIN_KEY.
//
// GET    /api/settings?action=baAutoGet&username=..
//        -> { enabled, appEnabled, slots:[{slotIndex,tanggal,spanId,petugasUsername,tegakanIds}, ...10] }
//        dipanggil halaman Pengaturan (kartu "BA Otomatis via Telegram").
// POST   /api/settings?action=baAutoToggle  body:{ username, enabled }
//        -> upsert ba_auto_settings.enabled (channel Telegram)
// POST   /api/settings?action=baAutoAppToggle  body:{ username, enabled }
//        -> upsert ba_auto_settings.app_enabled (channel app "Berita Acara",
//        TERPISAH dari channel Telegram di atas -- lihat handleBaAutoAppToggle)
// POST   /api/settings?action=baAutoSlotSave  body:{ username, slotIndex,
//        tanggal, spanId, petugasUsername?, tegakanIds }
//        -> upsert SATU baris ba_auto_slot (slotIndex 1-4). tanggal null
//        berarti slot itu dikosongkan/nonaktif.
//
// (Digabung di sini, bukan file /api terpisah, supaya tidak menambah slot
// serverless function baru -- Vercel Hobby dibatasi 12 function/deployment
// dan project ini sudah pas di batas itu.)
//
// PENTING (perbaikan kuota transfer Neon): key berikut berisi gambar yang
// bisa cukup besar (logo/background/contoh layout BA, tanda tangan TL JARGI):
//   baLogo, baBackground, baContohLayout, ttdJargiLogo
// PLUS: key apa pun berawalan "qr:" (mis. qr:tower:<id>, qr:span:<id>) --
// dipakai untuk cache QR Code Tower/Span (dashboard.html, tower.html).
// (Catatan: loginLogo & loginBackground dulu ada di daftar ini juga, tapi
// fitur upload logo/background halaman login sudah dihapus total -- lihat
// pengaturan.html -- karena halaman login (index.html) sekarang pakai tema
// fieldlog statis dan tidak pernah membaca kedua key itu sama sekali.)
// Sebelumnya SEMUA disimpan sebagai base64 mentah langsung di kolom `value`
// Postgres. Sekarang kalau value untuk salah satu key di atas berupa data
// URL base64, file diupload dulu ke Google Drive (lib/googleDrive.js) dan
// yang disimpan di DB cuma referensi kecil "drive:<fileId>" (beberapa puluh
// karakter). Saat dibaca (GET), referensi itu otomatis di-download dari
// Drive lalu dikonversi balik jadi base64 SEBELUM dikirim ke browser --
// supaya frontend (pengaturan.html, pengaturan-ba.html, catatan-span.html,
// index.html) yang masih assign langsung ke <img src> ATAU doc.addImage()
// (jsPDF, butuh base64 asli bukan URL) TIDAK PERLU diubah sama sekali.
// Key lain (baFieldLayout, systemNotice, dll) tidak disentuh logic ini sama
// sekali karena isinya bukan data URL gambar.
// Kalau kredensial Drive belum diset / upload gagal, fallback: simpan
// base64 apa adanya seperti semula supaya fitur tetap jalan.

const crypto = require('crypto');
const { sql } = require('../lib/db');
const {
  uploadPhotoToDrive, downloadFileAsDataUrl, getDriveStorageInfo, listLargestDriveFiles,
  createResumableUploadSession, makeFilePublic,
} = require('../lib/googleDrive');
const { sendPushToAllUsers, sendPushToUsers } = require('../lib/pushHelper');

const DRIVE_PREFIX = 'drive:';

// Key ini SELALU disimpan frontend sebagai JPEG (canvas.toDataURL
// ("image/jpeg", ...) di pengaturan.html & pengaturan-ba.html), jadi aman
// hardcode mimeType 'image/jpeg' saat resolve balik dari Drive.
const IMAGE_SETTING_KEYS = new Set([
  'baLogo', 'baBackground', 'baContohLayout', 'ttdJargiLogo',
]);

// Selain key tetap di atas, key apa pun berawalan "qr:" (contoh:
// "qr:tower:<id>", "qr:span:<id>") JUGA diperlakukan sebagai gambar dan
// disimpan ke Drive. Dipakai untuk cache QR Code Tower/Span (generate
// sekali di browser, upload sekali, GET berikutnya tinggal ambil dari Drive
// -- tidak generate ulang & tidak upload ulang).
function isImageKey(key) {
  return IMAGE_SETTING_KEYS.has(key) || (typeof key === 'string' && key.startsWith('qr:'));
}

// QR disimpan sebagai PNG (canvas.toDataURL("image/png")), key tetap di atas selalu JPEG.
function mimeForKey(key) {
  return (typeof key === 'string' && key.startsWith('qr:')) ? 'image/png' : 'image/jpeg';
}

// Upload value (data URL base64) ke Drive kalau key-nya termasuk gambar.
// Return: { toSave, warning }
async function resolveValueForSave(key, value) {
  if (!isImageKey(key)) {
    return { toSave: value ?? null, warning: null }; // key non-gambar, simpan apa adanya
  }
  if (!value || typeof value !== 'string' || !value.startsWith('data:')) {
    return { toSave: value ?? null, warning: null }; // kosong / sudah referensi Drive lama
  }
  try {
    const ext = mimeForKey(key) === 'image/png' ? 'png' : 'jpg';
    const uploaded = await uploadPhotoToDrive(value, `${key.replace(/[:]/g, '-')}-${Date.now()}.${ext}`);
    return { toSave: `${DRIVE_PREFIX}${uploaded.fileId}`, warning: null };
  } catch (driveErr) {
    console.error(`Upload setting "${key}" ke Drive gagal, fallback simpan base64:`, driveErr.message);
    return { toSave: value, warning: driveErr.message };
  }
}

// Baca value dari DB dan ubah jadi base64 data URL kalau berupa referensi
// Drive. Key non-gambar / value bukan referensi Drive dikembalikan apa adanya.
async function resolveValueForRead(key, valueRaw) {
  if (!isImageKey(key)) return valueRaw;
  if (!valueRaw || typeof valueRaw !== 'string' || !valueRaw.startsWith(DRIVE_PREFIX)) {
    return valueRaw;
  }
  const fileId = valueRaw.slice(DRIVE_PREFIX.length);
  try {
    return await downloadFileAsDataUrl(fileId, mimeForKey(key));
  } catch (err) {
    console.error(`Download setting "${key}" dari Drive gagal:`, err.message);
    return null; // biar frontend anggap belum ada gambar, daripada error total
  }
}

// Faktor pembesar tampilan storage di dashboard (permintaan user): baik
// limit MAUPUN ukuran terpakai sama-sama dikali ini, supaya rasio/persentase
// tetap akurat terhadap kondisi nyata tapi angka GB yang tampil di layar
// (limit & terpakai) sama-sama kelihatan 20x lebih besar.
const DISPLAY_SIZE_MULTIPLIER = 20;

// Batas storage Neon Free plan: 0.5 GB per project, DIKALI 20 atas permintaan
// user supaya angka yang tampil di dashboard jadi 10 GB. Dipakai untuk
// hitung persentase pemakaian yang ditampilkan di widget quickgrid.
const DB_STORAGE_LIMIT_BYTES = 0.5 * DISPLAY_SIZE_MULTIPLIER * 1024 * 1024 * 1024; // = 10 GB

// Batas storage Google Drive dipakai untuk widget "Penyimpanan Drive" (di
// bawah widget Penyimpanan Database di dashboard). Google Drive akun gratis
// berbagi kuota 15 GB dengan Gmail & Google Photos, dan `storageQuota.limit`
// dari API kadang null (tidak dilaporkan / akun unlimited) -- jadi angka ini
// dipakai sebagai acuan tetap, bukan diambil dari API, lalu DIKALI 20 atas
// permintaan user supaya angka yang tampil di dashboard jadi 300 GB. Angka
// persentase yang tampil di dashboard karena itu sifatnya PERKIRAAN saja.
const DRIVE_STORAGE_LIMIT_BYTES = 15 * DISPLAY_SIZE_MULTIPLIER * 1024 * 1024 * 1024; // = 300 GB

// Default batas harian request Gemini API (widget "Pemakaian AI" di
// Pengaturan, admin only). Angka resmi Google sering berubah dan beda-beda
// per akun/tier, jadi ini cuma default -- admin bisa override lewat setting
// "ai_daily_limit" (disimpan sebagai string angka biasa di app_settings).
const AI_DAILY_LIMIT_DEFAULT = 250;

// ─────────────────────────────────────────────────────────
// BACKUP & RESTORE (fitur "Backup Data" di pengaturan.html)
// GET  /api/settings?action=backup   -> ekspor SELURUH tabel di bawah ini
// POST /api/settings?action=backup   -> body: { tables:{...} }, upsert per tabel
//
// Urutan array di bawah SENGAJA accounts lebih dulu dari profiles/
// profile_signatures (keduanya punya FK REFERENCES accounts(username)),
// supaya restore tidak kena foreign key violation.
// ─────────────────────────────────────────────────────────
const BACKUP_TABLES = [
  { name: 'accounts', pk: 'username' },
  { name: 'profiles', pk: 'username' },
  { name: 'jalur', pk: 'id' },
  { name: 'tower', pk: 'id' },
  { name: 'span', pk: 'id' },
  { name: 'tegakan', pk: 'id' },
  { name: 'catatan_span', pk: 'id' },
  { name: 'ba_dokumen', pk: 'id' },
  { name: 'pemilik_signatures', pk: 'nama_key' },
  { name: 'profile_signatures', pk: 'username' },
  { name: 'chat_messages', pk: 'id' },
  { name: 'app_settings', pk: 'key' },
];

// Hanya izinkan nama kolom huruf/angka/underscore (row dari file backup
// upload-an user) -- dipakai langsung sebagai identifier di query dinamis
// di bawah, jadi wajib divalidasi supaya tidak bisa dipakai untuk injection.
const SAFE_COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

async function handleBackupExport(res) {
  const tables = {};
  for (const t of BACKUP_TABLES) {
    // t.name selalu berasal dari whitelist tetap di atas, bukan dari input
    // request, jadi aman diselipkan langsung ke query.
    // CATATAN: client `sql` dari @neondatabase/serverless TIDAK punya method
    // .query() -- dipanggil langsung sebagai fungsi: sql(text, params?).
    const rows = await sql(`SELECT * FROM ${t.name}`);
    tables[t.name] = rows;
  }
  return res.status(200).json({
    success: true,
    exportedAt: new Date().toISOString(),
    version: 1,
    tables,
  });
}

async function handleBackupRestore(req, res) {
  const { tables } = req.body || {};
  if (!tables || typeof tables !== 'object') {
    return res.status(400).json({ success: false, message: 'tables wajib diisi.' });
  }

  const summary = {};
  for (const t of BACKUP_TABLES) {
    const rows = tables[t.name];
    if (!Array.isArray(rows)) {
      summary[t.name] = { skipped: true };
      continue;
    }

    let ok = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const cols = Object.keys(row || {}).filter((c) => SAFE_COLUMN_RE.test(c));
        if (cols.length === 0 || !cols.includes(t.pk)) { failed++; continue; }

        const values = cols.map((c) => {
          const v = row[c];
          return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
        });
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const updateSet = cols
          .filter((c) => c !== t.pk)
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(', ');
        const quotedCols = cols.map((c) => `"${c}"`).join(', ');

        const query = updateSet
          ? `INSERT INTO ${t.name} (${quotedCols}) VALUES (${placeholders})
             ON CONFLICT (${t.pk}) DO UPDATE SET ${updateSet}`
          : `INSERT INTO ${t.name} (${quotedCols}) VALUES (${placeholders})
             ON CONFLICT (${t.pk}) DO NOTHING`;

        await sql(query, values);
        ok++;
      } catch (rowErr) {
        console.error(`Restore baris di tabel "${t.name}" gagal:`, rowErr.message);
        failed++;
      }
    }
    summary[t.name] = { total: rows.length, ok, failed };
  }

  return res.status(200).json({ success: true, summary });
}

// ─────────────────────────────────────────────────────────
// KATALOG COMMAND BOT (halaman workspace-command.html, admin only)
// GET /api/settings?action=botCommands
//
// Botlab (bot Telegram) adalah project & Neon database TERPISAH dari
// SrinaiAssist2 -- jadi ini BUKAN query ke DB sendiri, melainkan proxy
// server-to-server ke endpoint GET /api/commands milik Botlab, yang
// sudah lebih dulu ada dan dipakai dashboard Botlab.
//
// Kenapa diproxy lewat sini, bukan browser fetch langsung ke Botlab?
// 1. Botlab tidak mengizinkan CORS dari origin lain -- fetch langsung
//    dari browser SrinaiAssist2 akan diblokir.
// 2. BOTLAB_ADMIN_KEY (dipakai buat auth ke Botlab) jadi tetap di
//    server, tidak pernah terkirim/terlihat di browser.
//
// Env var yang WAJIB diisi di Vercel project SrinaiAssist2 (Project
// Settings > Environment Variables), belum ada sebelumnya:
//   BOTLAB_API_URL   -> URL deploy Botlab, mis. https://botlab-xxx.vercel.app
//   BOTLAB_ADMIN_KEY -> HARUS SAMA PERSIS dengan BOTLAB_ADMIN_KEY yang
//                       sudah diset di project Botlab (itu yang dipakai
//                       lib/auth.js Botlab buat cek header x-botlab-key).
//
// CATATAN: sama seperti endpoint admin lain di app ini (kelola-akun,
// log-login, dst), proteksi "hanya admin" di sini dilakukan di SISI
// KLIEN (workspace-command.html cek isAdmin() sebelum manggil endpoint
// ini) -- bukan lewat token sesi server, karena app ini memang belum
// pakai session token di server. Konsisten dengan pola yang sudah ada,
// bukan celah baru.
// GET /api/settings?action=botlabDashboardUrl (admin only, dicek di klien)
// -> cuma balikin URL dashboard Botlab (dari BOTLAB_API_URL) supaya tombol
// "Buka Dashboard BotLab" di workspace-command.html tidak perlu hardcode
// domain di frontend. TIDAK mengirim BOTLAB_ADMIN_KEY ke browser.
async function handleBotlabDashboardUrl(res) {
  const botlabUrl = process.env.BOTLAB_API_URL;
  if (!botlabUrl) {
    return res.status(500).json({
      success: false,
      message: 'BOTLAB_API_URL belum diset di environment variables SrinaiAssist2.',
    });
  }
  return res.status(200).json({
    success: true,
    url: `${botlabUrl.replace(/\/+$/, '')}/dashboard.html`,
  });
}

async function handleBotCommandsCatalog(res) {
  const botlabUrl = process.env.BOTLAB_API_URL;
  const botlabKey = process.env.BOTLAB_ADMIN_KEY;

  if (!botlabUrl || !botlabKey) {
    return res.status(500).json({
      success: false,
      message: 'BOTLAB_API_URL dan/atau BOTLAB_ADMIN_KEY belum diset di environment variables SrinaiAssist2.',
    });
  }

  try {
    const upstream = await fetch(`${botlabUrl.replace(/\/+$/, '')}/api/commands`, {
      method: 'GET',
      headers: { 'x-botlab-key': botlabKey },
    });
    const data = await upstream.json();

    if (!upstream.ok || !data.success) {
      return res.status(upstream.status || 502).json({
        success: false,
        message: data.message || 'Botlab menolak permintaan (cek BOTLAB_ADMIN_KEY cocok di kedua project).',
      });
    }

    return res.status(200).json({ success: true, commands: data.commands || [] });
  } catch (err) {
    console.error('Gagal ambil katalog command dari Botlab:', err);
    return res.status(502).json({
      success: false,
      message: 'Tidak bisa menghubungi Botlab: ' + err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────
// JALANKAN COMMAND BOT DARI WEB (workspace-command.html, admin only)
// POST /api/settings?action=botConsole
// body: { text, chatId, username }
//
// Proxy server-to-server ke POST /api/lab-console milik Botlab (endpoint
// ini SUDAH ADA sebelumnya, dipakai dashboard Botlab sendiri buat "chat"
// simulasi tanpa Telegram). Router Botlab menganggap source ini sebagai
// 'lab-console' -- artinya command berstatus 'testing' MAUPUN 'live' bisa
// dijalankan (draft tetap tidak bisa).
//
// PENTING: INI BUKAN SANDBOX. Kalau command yang dijalankan menulis data
// (mis. /tambahtegakan, /edittegakan), datanya BENERAN tersimpan lewat API
// SrinaiAssist2 yang sama persis dipakai bot Telegram -- bukan simulasi.
// Sesi command multi-langkah (mis. /catatan yang nunggu beberapa balasan)
// tetap nyambung selama chatId+username yang dikirim frontend konsisten
// antar pesan (lihat workspace-command.html: dipakai "web:<username>").
//
// Env var: pakai BOTLAB_API_URL & BOTLAB_ADMIN_KEY yang sama dengan
// handleBotCommandsCatalog di atas.
async function handleBotConsole(req, res) {
  const botlabUrl = process.env.BOTLAB_API_URL;
  const botlabKey = process.env.BOTLAB_ADMIN_KEY;

  if (!botlabUrl || !botlabKey) {
    return res.status(500).json({
      success: false,
      message: 'BOTLAB_API_URL dan/atau BOTLAB_ADMIN_KEY belum diset di environment variables SrinaiAssist2.',
    });
  }

  const { text, chatId, username } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, message: 'text wajib diisi.' });
  }

  try {
    const upstream = await fetch(`${botlabUrl.replace(/\/+$/, '')}/api/lab-console`, {
      method: 'POST',
      headers: { 'x-botlab-key': botlabKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, chatId, username }),
    });
    const data = await upstream.json();

    if (!upstream.ok || !data.success) {
      return res.status(upstream.status || 502).json({
        success: false,
        message: data.message || 'Botlab menolak permintaan (cek BOTLAB_ADMIN_KEY cocok di kedua project).',
      });
    }

    return res.status(200).json({
      success: true,
      replyText: data.replyText,
      matchedCommand: data.matchedCommand,
      sessionActive: !!data.sessionActive,
    });
  } catch (err) {
    console.error('Gagal jalankan command lewat Botlab lab-console:', err);
    return res.status(502).json({
      success: false,
      message: 'Tidak bisa menghubungi Botlab: ' + err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────
// NOTIF COMMANDBOT (rekap harian "span belum ada tegakan" + badge/getar
// ikon CommandBot untuk notif belum terbaca -- lihat command-bot.html,
// command-bot.html, dashboard.html)
// Tabel bot_notifications: lihat migrasi di scripts/schema.sql.

function isCronRequestValid(req) {
  if (!process.env.CRON_SECRET) {
    console.warn('CRON_SECRET belum diset -- endpoint cron akan selalu ditolak.');
    return false;
  }
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${process.env.CRON_SECRET}`) return true;

  // Fallback: query param ?cronKey=... -- Vercel Cron sendiri SELALU pakai
  // header Authorization di atas, jadi ini TIDAK dibutuhkan untuk jadwal
  // otomatis. Ini cuma buat trigger manual dari browser HP (browser biasa
  // tidak bisa nyetel header custom), supaya bisa dites tanpa nunggu jadwal
  // cron atau butuh terminal/Postman. Jangan sebar URL yang sudah terisi
  // cronKey-nya, karena CRON_SECRET jadi kelihatan di situ.
  const queryKey = req.query && req.query.cronKey;
  return !!queryKey && queryKey === process.env.CRON_SECRET;
}

// Validasi request MASUK dari ba-control-panel (arah kebalikan dari
// isBaAutoMasterEnabled di atas, yang panggil KELUAR ke panel). Dipakai
// oleh action=baAutoAdminList supaya rekap semua user tidak bisa diakses
// sembarang orang yang tahu URL-nya -- harus bawa header x-panel-key yang
// sama persis dengan PANEL_SHARED_KEY.
function isPanelKeyValid(req) {
  const key = process.env.PANEL_SHARED_KEY;
  if (!key) {
    console.warn('PANEL_SHARED_KEY belum diset -- request dari panel akan selalu ditolak.');
    return false;
  }
  const headerKey = req.headers['x-panel-key'];
  return !!headerKey && headerKey === key;
}

// GET /api/settings?action=baAutoAdminList  (dipanggil ba-control-panel,
// lihat api/monitor.js di repo panel -- bukan dipanggil dari frontend
// SrinaiAssist2 sendiri). Rekap status BA Otomatis SEMUA user sekaligus,
// buat halaman "Monitor Pengiriman" di panel admin.
async function handleBaAutoAdminList(req, res) {
  if (!isPanelKeyValid(req)) {
    return res.status(401).json({ success: false, message: 'Tidak diizinkan.' });
  }

  const rows = await sql`
    SELECT
      st.username, st.enabled,
      s.slot_index AS "slotIndex", s.tanggal, s.span_id AS "spanId",
      s.petugas_username AS "petugasUsername",
      jsonb_array_length(s.tegakan_ids) AS "tegakanCount",
      s.last_run_date AS "lastRunDate",
      CASE WHEN sp.id IS NOT NULL
        THEN sp.jalur_id || '-S' || lpad(sp.nomor::text, 3, '0')
        ELSE NULL
      END AS "spanLabel"
    FROM ba_auto_settings st
    LEFT JOIN ba_auto_slot s ON s.username = st.username
    LEFT JOIN span sp ON sp.id = s.span_id
    ORDER BY st.username, s.slot_index
  `;

  const byUser = {};
  for (const r of rows) {
    if (!byUser[r.username]) {
      byUser[r.username] = { username: r.username, enabled: r.enabled, slots: [] };
    }
    if (r.slotIndex != null) {
      byUser[r.username].slots.push({
        slotIndex: r.slotIndex,
        tanggal: r.tanggal,
        spanId: r.spanId,
        spanLabel: r.spanLabel,
        petugasUsername: r.petugasUsername,
        tegakanCount: r.tegakanCount || 0,
        lastRunDate: r.lastRunDate,
      });
    }
  }

  return res.status(200).json({ success: true, users: Object.values(byUser) });
}

// Untuk satu username: span yang ada di profil (span_ids) TAPI belum
// punya satu pun baris di tabel tegakan.
async function findSpanBelumTegakan(username) {
  const profRows = await sql`SELECT span_ids FROM profiles WHERE username = ${username}`;
  const spanIds = profRows[0]?.span_ids;
  if (!Array.isArray(spanIds) || spanIds.length === 0) return [];

  const rows = await sql`
    SELECT s.id, s.jalur_id AS "jalurId", s.nomor
    FROM span s
    WHERE s.id = ANY(${spanIds})
      AND NOT EXISTS (SELECT 1 FROM tegakan t WHERE t.span_id = s.id)
    ORDER BY s.jalur_id, s.nomor
  `;
  return rows;
}

async function runBotNotifyDailyRecap() {
  // Hanya akun aktif yang punya span_ids terisi -- akun tanpa penugasan
  // span dilewati saja supaya tidak query sia-sia.
  const users = await sql`
    SELECT a.username
    FROM accounts a
    JOIN profiles p ON p.username = a.username
    WHERE a.status = 'Aktif' AND jsonb_array_length(COALESCE(p.span_ids, '[]'::jsonb)) > 0
  `;

  let created = 0;
  for (const u of users) {
    const missing = await findSpanBelumTegakan(u.username);
    if (missing.length === 0) continue;

    await sql`
      INSERT INTO bot_notifications (username, type, payload)
      VALUES (${u.username}, 'span_belum_tegakan', ${JSON.stringify({ spans: missing })})
    `;
    created++;
  }
  return { usersChecked: users.length, notificationsCreated: created };
}

async function handleBotNotifyGet(req, res) {
  const { username } = req.query || {};
  if (!username) {
    return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  }
  const rows = await sql`
    SELECT id, type, payload, created_at AS "createdAt"
    FROM bot_notifications
    WHERE username = ${username} AND read_at IS NULL
    ORDER BY created_at DESC
  `;
  return res.status(200).json({ success: true, unreadCount: rows.length, notifications: rows });
}

async function handleBotNotifyRead(req, res) {
  const { username, id } = req.body || {};
  if (!username) {
    return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  }
  if (id) {
    await sql`UPDATE bot_notifications SET read_at = now() WHERE id = ${id} AND username = ${username}`;
  } else {
    // Tanpa id -> tandai SEMUA notif user ini sudah dibaca (dipakai saat
    // command-bot.html dibuka dan seluruh rekap sudah ditampilkan).
    await sql`UPDATE bot_notifications SET read_at = now() WHERE username = ${username} AND read_at IS NULL`;
  }
  return res.status(200).json({ success: true });
}

async function handleBotNotifyCron(req, res) {
  if (!isCronRequestValid(req)) {
    return res.status(401).json({ success: false, message: 'Tidak diizinkan.' });
  }
  const summary = await runBotNotifyDailyRecap();
  return res.status(200).json({ success: true, ...summary });
}

// ─────────────────────────────────────────────────────────
// LINK TELEGRAM (fitur BA Otomatis -- profile.html "Hubungkan Telegram")
// Tabel telegram_link_token: lihat migration-ba-otomatis-srinaiassist2.sql
//
// POST /api/settings?action=telegramLinkToken  body:{ username }
//      -> generate token sekali pakai (berlaku 10 menit), dipanggil saat
//         user tap tombol "Hubungkan Telegram" di profile.html. Frontend
//         lalu buka deep link https://t.me/<BOT>?start=<token> supaya user
//         tinggal tap "kirim" sekali di Telegram.
//
// POST /api/settings?action=telegramLinkValidate  body:{ token }
//      -> DIPANGGIL OLEH BOTLAB (bukan browser), saat webhook Botlab
//         terima pesan "/start <token>". Diproteksi header x-bot-key
//         (SRINAI_BOT_KEY, sama seperti lib/bot-auth.js) -- BEDA dari
//         isBotRequestValid() yang cuma "periksa kalau ada": endpoint ini
//         WAJIB ada header & harus benar, karena hasilnya (username asli
//         pemilik token) sensitif. Kalau valid & belum kedaluwarsa/dipakai,
//         token ditandai used_at supaya tidak bisa dipakai dua kali, lalu
//         username-nya dikembalikan ke Botlab buat ditulis ke
//         bot_authorized_users di sisi sana.
//
// Env var TAMBAHAN yang perlu diisi di Vercel project SrinaiAssist2:
//   TELEGRAM_BOT_USERNAME -> username bot Botlab tanpa "@", mis. "SrinaiBot"
//                            (dipakai bikin deep link, BUKAN token bot --
//                            token bot Telegram asli cuma ada di Botlab)
function isBotlabRequestValid(req) {
  const key = req.headers['x-bot-key'];
  if (!process.env.SRINAI_BOT_KEY) {
    console.warn('SRINAI_BOT_KEY belum diset -- endpoint telegramLinkValidate akan selalu ditolak.');
    return false;
  }
  return !!key && key === process.env.SRINAI_BOT_KEY;
}

async function handleTelegramLinkToken(req, res) {
  const { username } = req.body || {};
  if (!username) {
    return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  }

  const acc = await sql`SELECT 1 FROM accounts WHERE username = ${username}`;
  if (acc.length === 0) {
    return res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  if (!botUsername) {
    return res.status(500).json({
      success: false,
      message: 'TELEGRAM_BOT_USERNAME belum diset di environment variables SrinaiAssist2.',
    });
  }

  // Token lama yang belum kepakai punya user ini dibiarkan saja (kadaluwarsa
  // sendiri lewat expires_at) -- tidak perlu dihapus, cuma numpuk beberapa
  // baris tak terpakai yang ringan buat DB.
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 menit

  await sql`
    INSERT INTO telegram_link_token (token, username, expires_at)
    VALUES (${token}, ${username}, ${expiresAt.toISOString()})
  `;

  return res.status(200).json({
    success: true,
    token,
    expiresAt: expiresAt.toISOString(),
    deepLink: `https://t.me/${botUsername}?start=${token}`,
  });
}

async function handleTelegramLinkValidate(req, res) {
  if (!isBotlabRequestValid(req)) {
    return res.status(401).json({ success: false, message: 'Tidak diizinkan.' });
  }

  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ success: false, message: 'token wajib diisi.' });
  }

  const rows = await sql`
    SELECT username, expires_at AS "expiresAt", used_at AS "usedAt"
    FROM telegram_link_token
    WHERE token = ${token}
  `;
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Token tidak ditemukan.' });
  }

  const row = rows[0];
  if (row.usedAt) {
    return res.status(410).json({ success: false, message: 'Token sudah pernah dipakai.' });
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return res.status(410).json({ success: false, message: 'Token sudah kedaluwarsa, minta link baru dari halaman Profil.' });
  }

  await sql`UPDATE telegram_link_token SET used_at = now() WHERE token = ${token}`;

  return res.status(200).json({ success: true, username: row.username });
}

// GET /api/settings?action=telegramLinkStatus&username=..
//     -> status koneksi Telegram akun ini (dipanggil halaman Profil buat
//        nampilin "Terhubung sebagai @xxx" atau tombol "Hubungkan Telegram").
// Proxy server-to-server ke GET /api/commands milik Botlab (action
// telegramLinkStatus, numpang endpoint yang sudah ada -- lihat catatan di
// api/commands.js Botlab), sama arah & auth-nya dengan handleBotCommandsCatalog
// di atas (BOTLAB_API_URL + BOTLAB_ADMIN_KEY -> header x-botlab-key).
async function handleTelegramLinkStatus(req, res) {
  const { username } = req.query || {};
  if (!username || !String(username).trim()) {
    return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  }

  const botlabUrl = process.env.BOTLAB_API_URL;
  const botlabKey = process.env.BOTLAB_ADMIN_KEY;

  if (!botlabUrl || !botlabKey) {
    return res.status(500).json({
      success: false,
      message: 'BOTLAB_API_URL dan/atau BOTLAB_ADMIN_KEY belum diset di environment variables SrinaiAssist2.',
    });
  }

  try {
    const upstream = await fetch(
      `${botlabUrl.replace(/\/+$/, '')}/api/commands?action=telegramLinkStatus&username=${encodeURIComponent(username)}`,
      { method: 'GET', headers: { 'x-botlab-key': botlabKey } }
    );
    const data = await upstream.json();

    if (!upstream.ok || !data.success) {
      return res.status(upstream.status || 502).json({
        success: false,
        message: data.message || 'Botlab menolak permintaan (cek BOTLAB_ADMIN_KEY cocok di kedua project).',
      });
    }

    return res.status(200).json({
      success: true,
      connected: !!data.connected,
      chatId: data.chatId || null,
      telegramUsername: data.telegramUsername || null,
    });
  } catch (err) {
    console.error('Gagal ambil status link Telegram dari Botlab:', err);
    return res.status(502).json({
      success: false,
      message: 'Tidak bisa menghubungi Botlab: ' + err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────
// BROADCAST FILE VIA TELEGRAM (halaman telegram.html, khusus admin)
// Beda dengan BA Otomatis di atas (kirim BA per-user pas dijadwalkan):
// ini admin upload SATU file lalu langsung disebar ke SEMUA user yang
// sudah terhubung Telegram. SrinaiAssist2 manggil Telegram Bot API
// LANGSUNG (bukan proxy lewat Botlab kayak fitur BA Otomatis), pakai
// env var baru TELEGRAM_BOT_TOKEN (token bot yang sama persis dengan
// yang dipakai Botlab).
//
// Alur lengkap:
// 1. Admin pilih file di telegram.html -> upload resumable ke Drive
//    (numpang action=articleUploadSession yang sudah ada, sama seperti
//    artikel.html, supaya file besar tidak kena limit body Vercel).
// 2. POST /api/settings?action=telegramBroadcastFile
//    body:{ actor, fileId, fileName, caption }
//    -> makeFilePublic(fileId) supaya bisa diakses Telegram, lalu:
//    a. ambil daftar user yang sudah connect dari Botlab
//    b. loop kirim sendDocument ke tiap chatId lewat Telegram Bot API asli
//
// *** PENTING -- BAGIAN YANG PERLU DITAMBAHKAN DI PROJECT BOTLAB ***
// Endpoint di bawah ini BELUM ADA di Botlab (Botlab tidak termasuk di
// zip SrinaiAssist2 ini), baru dokumentasi kontrak API-nya:
//   GET /api/commands?action=telegramConnectedList
//   Header: x-botlab-key: <BOTLAB_ADMIN_KEY>
//   Response sukses: { success:true, users:[ { username, chatId,
//                       telegramUsername } , ... ] }
//   (daftar SEMUA baris di tabel bot_authorized_users milik Botlab --
//   sama sumber datanya dengan yang dipakai telegramLinkStatus per-user
//   di atas, cuma di sini butuh versi list semua sekaligus.)
//
// Env var TAMBAHAN yang perlu diisi di Vercel project SrinaiAssist2:
//   TELEGRAM_BOT_TOKEN -> token asli bot Telegram (BUKAN BOTLAB_ADMIN_KEY,
//                          harus sama persis dengan token yang dipakai
//                          Botlab buat panggil Telegram Bot API)
async function fetchTelegramConnectedUsers() {
  const botlabUrl = process.env.BOTLAB_API_URL;
  const botlabKey = process.env.BOTLAB_ADMIN_KEY;
  if (!botlabUrl || !botlabKey) {
    return {
      success: false,
      message: 'BOTLAB_API_URL dan/atau BOTLAB_ADMIN_KEY belum diset di environment variables SrinaiAssist2.',
    };
  }
  try {
    const upstream = await fetch(
      `${botlabUrl.replace(/\/+$/, '')}/api/commands?action=telegramConnectedList`,
      { method: 'GET', headers: { 'x-botlab-key': botlabKey } }
    );
    const data = await upstream.json();
    if (!upstream.ok || !data.success) {
      return {
        success: false,
        message: data.message || 'Botlab menolak permintaan (cek BOTLAB_ADMIN_KEY cocok di kedua project, dan pastikan endpoint telegramConnectedList sudah ada di Botlab).',
      };
    }
    return { success: true, users: Array.isArray(data.users) ? data.users : [] };
  } catch (err) {
    console.error('Gagal ambil daftar user Telegram dari Botlab:', err);
    return { success: false, message: 'Tidak bisa menghubungi Botlab: ' + err.message };
  }
}

// GET /api/settings?action=telegramConnectedList&actor=<username_admin>
//     -> dipakai telegram.html buat nampilin "N petugas akan menerima"
//        sebelum admin kirim broadcast.
async function handleTelegramConnectedListRoute(req, res) {
  const { actor } = req.query || {};
  if (!(await assertIsAdmin(actor))) {
    return res.status(403).json({ success: false, message: 'Hanya admin yang bisa melihat daftar ini.' });
  }
  const result = await fetchTelegramConnectedUsers();
  if (!result.success) return res.status(502).json(result);
  return res.status(200).json(result);
}

// CATATAN (fix "Bad Request: failed to get HTTP URL content"):
// Sebelumnya fungsi ini kirim { document: <url drive.google.com/uc?export=download> }
// ke Telegram, lalu Telegram SENDIRI yang fetch URL itu. Link Drive model gitu
// TIDAK reliable buat bot: Drive kadang balikin halaman HTML "konfirmasi virus
// scan" (bukan file mentah) atau butuh cookie/redirect yang nggak diikuti
// Telegram -> Telegram gagal narik isinya -> error di atas. Fix-nya: JANGAN
// kasih URL ke Telegram. Download file-nya sendiri dari Drive pakai Drive API
// (access token, alt=media), lalu upload langsung ke Telegram via
// multipart/form-data (attach binary, bukan link).
async function sendTelegramDocument(chatId, fileId, fileName, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const { getAccessToken } = require('../lib/googleDrive');

  const accessToken = await getAccessToken();
  const driveResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!driveResp.ok) {
    const t = await driveResp.text().catch(() => '');
    throw new Error(`Gagal ambil file dari Drive (status ${driveResp.status}): ${t || 'unknown'}`);
  }
  const fileBuffer = Buffer.from(await driveResp.arrayBuffer());

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([fileBuffer]), fileName || 'file');

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    throw new Error((data && data.description) || `status ${resp.status}`);
  }
}

async function handleTelegramBroadcastFile(req, res) {
  const { actor, fileId, fileName, caption } = req.body || {};
  if (!(await assertIsAdmin(actor))) {
    return res.status(403).json({ success: false, message: 'Hanya admin yang bisa membagikan file lewat Telegram.' });
  }
  if (!fileId) {
    return res.status(400).json({ success: false, message: 'fileId wajib diisi (upload file ke Drive dulu).' });
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ success: false, message: 'TELEGRAM_BOT_TOKEN belum diset di environment variables SrinaiAssist2.' });
  }

  const listResult = await fetchTelegramConnectedUsers();
  if (!listResult.success) {
    return res.status(502).json(listResult);
  }
  const users = listResult.users || [];
  if (users.length === 0) {
    return res.status(200).json({ success: true, total: 0, sent: 0, failed: 0, message: 'Belum ada petugas yang terhubung Telegram.' });
  }

  // makeFilePublic() TIDAK dipanggil lagi -- sekarang file diambil langsung
  // dari Drive pakai access token OAuth admin (bukan link publik), jadi file
  // boleh tetap private. Sekalian ini yang jadi penyebab error sebelumnya:
  // link publik Drive tetap saja tidak reliable buat di-fetch Telegram.

  // DITUNGGU sampai selesai (bukan jawab duluan lalu lanjut di background)
  // -- daftar petugas yang terhubung Telegram masih kecil, jadi aman
  // ditunggu dalam satu request tanpa kena timeout. Ini supaya admin dapat
  // laporan hasil ASLI (berapa sukses/gagal beserta sebabnya), bukan cuma
  // pesan "sedang mengirim..." yang menggantung tanpa pernah dikonfirmasi.
  const results = await Promise.allSettled(
    users.map((u) => sendTelegramDocument(u.chatId, fileId, fileName, caption))
  );
  const failedUsers = results
    .map((r, i) => (r.status === 'rejected' ? { username: users[i].username, reason: r.reason?.message || 'unknown' } : null))
    .filter(Boolean);
  const sentCount = users.length - failedUsers.length;

  if (failedUsers.length > 0) {
    console.error(`Broadcast Telegram: ${failedUsers.length}/${users.length} gagal terkirim ->`, failedUsers.map((f) => `${f.username} (${f.reason})`).join(', '));
  }

  // Notifikasi push (FCM) ke tiap petugas yang FILE-nya berhasil terkirim
  // ke Telegram -- pola sama persis seperti notifikasi "BA Otomatis
  // terkirim" di api/ba.js (channel_id Android beda tiap jenis suara,
  // karena Android tidak izinkan ganti suara channel yang sudah dibuat).
  // Gagal kirim push TIDAK BOLEH menggagalkan response ke admin.
  const failedUsernames = new Set(failedUsers.map((f) => f.username));
  const sentUsernames = users
    .map((u) => u.username)
    .filter((username) => username && !failedUsernames.has(username));

  let pushDebug = `sentUsernames=${JSON.stringify(sentUsernames)}`;
  if (sentUsernames.length > 0) {
    try {
      const tokenCheck = await sql`SELECT username FROM fcm_tokens WHERE username = ANY(${sentUsernames})`;
      pushDebug += ` | tokenRows=${tokenCheck.length}`;
      await sendPushToUsers(
        sentUsernames,
        {
          title: 'File baru di Telegram',
          body: fileName ? `${fileName} sudah dikirim admin ke chat Telegram kamu.` : 'Admin mengirim file baru ke chat Telegram kamu.',
          data: { type: 'broadcast_file_sent', fileId: String(fileId) },
          channel: 'srinai_broadcast_file',
          sound: 'notif_broadcast_file',
        },
      );
      pushDebug += ' | sendPushToUsers=selesai tanpa error';
    } catch (err) {
      pushDebug += ` | ERROR: ${err.message}`;
    }
  } else {
    pushDebug += ' | SKIP push (sentUsernames kosong)';
  }

  return res.status(200).json({
    success: true,
    total: users.length,
    sent: sentCount,
    failed: failedUsers.length,
    failedUsers,
    pushDebug,
    message: (failedUsers.length === 0
      ? `Berhasil dikirim ke ${sentCount} petugas.`
      : `Terkirim ke ${sentCount} dari ${users.length} petugas. Gagal: ${failedUsers.map((f) => f.username).join(', ')}.`)
      + ` [PUSH DEBUG: ${pushDebug}]`,
  });
}

// ─────────────────────────────────────────────────────────
// MASTER SWITCH BA OTOMATIS (dikontrol dari website terpisah
// "BA Control Panel" -- project Vercel + Neon sendiri, lihat repo
// ba-control-panel). Ini adalah SAKLAR INDUK: kalau OFF, toggle
// per-user di pengaturan.html TIDAK BISA dinyalakan (user disuruh
// hubungi admin), dan cron pengiriman (handleBaAutoCron) di-skip
// total meskipun ada user yang sudah enabled=true dari sebelumnya.
//
// ENV VARS TAMBAHAN yang perlu diisi di Vercel project SrinaiAssist2:
//   BA_PANEL_URL      -> base URL project ba-control-panel, mis.
//                         https://ba-control-panel.vercel.app (tanpa trailing slash)
//   PANEL_SHARED_KEY  -> string acak, HARUS SAMA PERSIS dengan
//                         PANEL_SHARED_KEY di project ba-control-panel
//
// FAIL-SAFE: kalau env var belum diset atau panel tidak bisa dihubungi,
// dianggap OFF (bukan ON) -- supaya kegagalan komunikasi tidak diam-diam
// membiarkan BA Otomatis tetap jalan tanpa pengawasan admin pusat.
async function isBaAutoMasterEnabled() {
  const panelUrl = process.env.BA_PANEL_URL;
  const panelKey = process.env.PANEL_SHARED_KEY;
  if (!panelUrl || !panelKey) {
    console.warn('BA_PANEL_URL/PANEL_SHARED_KEY belum diset -- BA Otomatis dianggap OFF (fail-safe).');
    return false;
  }
  try {
    const resp = await fetch(`${panelUrl.replace(/\/+$/, '')}/api/master-switch?feature=ba_auto`, {
      headers: { 'x-panel-key': panelKey },
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.success) return false;
    return !!data.enabled;
  } catch (err) {
    console.error('Gagal cek status master switch BA Otomatis ke panel:', err);
    return false; // fail-safe: panel tidak bisa dihubungi -> anggap OFF
  }
}

// ─────────────────────────────────────────────────────────
// SLOT BA OTOMATIS (halaman Pengaturan -- kartu "BA Otomatis via Telegram")
// Tabel: ba_auto_settings (toggle on/off + app_enabled), ba_auto_slot
// (MAX_BA_AUTO_SLOTS slot/username -- dulu 4, sekarang 10). Lihat
// scripts/schema.sql / migration-ba-otomatis-srinaiassist2.sql.
const MAX_BA_AUTO_SLOTS = 10;

// GET /api/settings?action=baAutoGet&username=..
async function handleBaAutoGet(req, res) {
  const { username } = req.query || {};
  if (!username || !String(username).trim()) {
    return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  }

  const [settingsRows, slotRows] = await Promise.all([
    sql`SELECT enabled, app_enabled AS "appEnabled" FROM ba_auto_settings WHERE username = ${username}`,
    sql`
      SELECT slot_index AS "slotIndex", tanggal, span_id AS "spanId",
             petugas_username AS "petugasUsername", tegakan_ids AS "tegakanIds"
      FROM ba_auto_slot
      WHERE username = ${username}
      ORDER BY slot_index
    `,
  ]);

  // Selalu kembalikan 10 slot (1-10) -- slot yang belum pernah disimpan
  // ditampilkan kosong, supaya frontend tidak perlu cek "slot ke berapa
  // saja yang ada barisnya di DB".
  const byIndex = {};
  slotRows.forEach((r) => { byIndex[r.slotIndex] = r; });
  const slots = Array.from({ length: MAX_BA_AUTO_SLOTS }, (_, k) => k + 1).map((i) => byIndex[i] || {
    slotIndex: i, tanggal: null, spanId: null, petugasUsername: null, tegakanIds: [],
  });

  return res.status(200).json({
    success: true,
    enabled: settingsRows.length > 0 ? settingsRows[0].enabled : false,
    // appEnabled = toggle channel app "Berita Acara" (project terpisah),
    // TERPISAH dari enabled/Telegram di atas -- lihat handleBaAutoAppToggle.
    appEnabled: settingsRows.length > 0 ? !!settingsRows[0].appEnabled : false,
    slots,
  });
}

// POST /api/settings?action=baAutoToggle  body:{ username, enabled }
// Toggle channel TELEGRAM.
async function handleBaAutoToggle(req, res) {
  const { username, enabled } = req.body || {};
  if (!username || !String(username).trim()) {
    return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  }

  // Cuma perlu cek master switch saat user mau MENYALAKAN. Mematikan
  // (enabled=false) selalu diizinkan tanpa syarat.
  if (enabled) {
    const masterOn = await isBaAutoMasterEnabled();
    if (!masterOn) {
      return res.status(200).json({
        success: false,
        blocked: true,
        message: 'Fitur BA Otomatis sedang dinonaktifkan oleh admin pusat. Hubungi admin untuk mengaktifkannya di panel kontrol.',
      });
    }
  }

  await sql`
    INSERT INTO ba_auto_settings (username, enabled)
    VALUES (${username}, ${!!enabled})
    ON CONFLICT (username) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
  `;
  return res.status(200).json({ success: true });
}

// POST /api/settings?action=baAutoAppToggle  body:{ username, enabled }
// Toggle channel APP "Berita Acara" (project terpisah, lihat sendBaViaApp
// di bawah) -- TERPISAH dari toggle Telegram di atas (handleBaAutoToggle).
// User boleh nyalakan salah satu, keduanya, atau tidak sama sekali; slot
// (tanggal/span/tegakan) yang dipakai TETAP SAMA untuk kedua channel.
async function handleBaAutoAppToggle(req, res) {
  const { username, enabled } = req.body || {};
  if (!username || !String(username).trim()) {
    return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  }

  // Sama seperti handleBaAutoToggle: master switch cuma dicek saat MENYALAKAN.
  if (enabled) {
    const masterOn = await isBaAutoMasterEnabled();
    if (!masterOn) {
      return res.status(200).json({
        success: false,
        blocked: true,
        message: 'Fitur BA Otomatis sedang dinonaktifkan oleh admin pusat. Hubungi admin untuk mengaktifkannya di panel kontrol.',
      });
    }
  }

  await sql`
    INSERT INTO ba_auto_settings (username, app_enabled)
    VALUES (${username}, ${!!enabled})
    ON CONFLICT (username) DO UPDATE SET app_enabled = EXCLUDED.app_enabled, updated_at = now()
  `;
  return res.status(200).json({ success: true });
}

// POST /api/settings?action=baAutoSlotSave
// body: { username, slotIndex, tanggal, spanId, petugasUsername?, tegakanIds }
async function handleBaAutoSlotSave(req, res) {
  const { username, slotIndex, tanggal, spanId, petugasUsername, tegakanIds } = req.body || {};

  if (!username || !String(username).trim()) {
    return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  }
  const idx = Number(slotIndex);
  if (!Number.isInteger(idx) || idx < 1 || idx > MAX_BA_AUTO_SLOTS) {
    return res.status(400).json({ success: false, message: `slotIndex harus angka 1-${MAX_BA_AUTO_SLOTS}.` });
  }
  if (tanggal !== null && tanggal !== undefined) {
    const t = Number(tanggal);
    if (!Number.isInteger(t) || t < 1 || t > 31) {
      return res.status(400).json({ success: false, message: 'tanggal harus angka 1-31 (atau kosongkan slot).' });
    }
  }
  if (tegakanIds !== undefined && !Array.isArray(tegakanIds)) {
    return res.status(400).json({ success: false, message: 'tegakanIds harus berupa array.' });
  }

  await sql`
    INSERT INTO ba_auto_slot (username, slot_index, tanggal, span_id, petugas_username, tegakan_ids)
    VALUES (
      ${username}, ${idx}, ${tanggal ?? null}, ${spanId ?? null},
      ${petugasUsername || null}, ${JSON.stringify(tegakanIds || [])}
    )
    ON CONFLICT (username, slot_index) DO UPDATE SET
      tanggal = EXCLUDED.tanggal,
      span_id = EXCLUDED.span_id,
      petugas_username = EXCLUDED.petugas_username,
      tegakan_ids = EXCLUDED.tegakan_ids,
      updated_at = now()
  `;
  return res.status(200).json({ success: true });
}

// GET /api/settings?action=baAutoCron  (dipanggil Vercel Cron, lihat vercel.json)
//     -> cari semua slot yang tanggal-nya cocok HARI INI (waktu Jakarta,
//        BUKAN UTC -- cron sendiri jadwalnya UTC, tapi "tanggal 1-31" yang
//        user pilih itu maksudnya tanggal lokal Indonesia) dan MINIMAL SATU
//        channel-nya (Telegram / App) belum dijalankan hari ini, generate +
//        kirim BA-nya satu-satu lewat Botlab (action=sendBaAuto untuk
//        Telegram, action=sendBaToApp untuk App -- lihat api/commands.js
//        Botlab), lalu catat last_run_date / last_run_date_app PER CHANNEL
//        supaya channel yang sudah sukses tidak dikirim dobel meskipun
//        channel lain masih gagal.
// Diproses SEKUENSIAL (bukan Promise.all) sengaja -- tiap slot generate PDF
// + upload Drive + kirim ke channel, kalau paralel semua bisa numpuk beban ke
// Botlab/Drive sekaligus; throughput bukan prioritas buat fitur mingguan
// begini, keandalan (satu gagal tidak ganggu yang lain) lebih penting.
function getJakartaDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return { dateStr: `${y}-${m}-${d}`, day: parseInt(d, 10) };
}

async function sendBaViaBotlab({ recipientUsername, spanId, tegakanIds, ownerUsername }) {
  const botlabUrl = process.env.BOTLAB_API_URL;
  const botlabKey = process.env.BOTLAB_ADMIN_KEY;
  if (!botlabUrl || !botlabKey) {
    throw new Error('BOTLAB_API_URL dan/atau BOTLAB_ADMIN_KEY belum diset di environment variables SrinaiAssist2.');
  }

  const upstream = await fetch(`${botlabUrl.replace(/\/+$/, '')}/api/commands?action=sendBaAuto`, {
    method: 'POST',
    headers: { 'x-botlab-key': botlabKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipientUsername, spanId, tegakanIds, ownerUsername }),
  });
  const data = await upstream.json().catch(() => null);
  if (!upstream.ok || !data || !data.success) {
    throw new Error((data && data.message) || `Botlab merespons status ${upstream.status}.`);
  }
  return data;
}

// Kembaran sendBaViaBotlab di atas, tapi manggil action=sendBaToApp
// (Botlab) yang meneruskan BA ke app "Berita Acara" (project terpisah,
// lihat BA_APP_URL/BA_APP_INGEST_KEY di env Botlab) -- BUKAN ke Telegram.
async function sendBaViaApp({ recipientUsername, spanId, tegakanIds, ownerUsername }) {
  const botlabUrl = process.env.BOTLAB_API_URL;
  const botlabKey = process.env.BOTLAB_ADMIN_KEY;
  if (!botlabUrl || !botlabKey) {
    throw new Error('BOTLAB_API_URL dan/atau BOTLAB_ADMIN_KEY belum diset di environment variables SrinaiAssist2.');
  }

  const upstream = await fetch(`${botlabUrl.replace(/\/+$/, '')}/api/commands?action=sendBaToApp`, {
    method: 'POST',
    headers: { 'x-botlab-key': botlabKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipientUsername, spanId, tegakanIds, ownerUsername }),
  });
  const data = await upstream.json().catch(() => null);
  if (!upstream.ok || !data || !data.success) {
    throw new Error((data && data.message) || `Botlab merespons status ${upstream.status}.`);
  }
  return data;
}

async function handleBaAutoCron(req, res) {
  if (!isCronRequestValid(req)) {
    return res.status(401).json({ success: false, message: 'Tidak diizinkan.' });
  }

  // Saklar induk OFF -> skip semua, meskipun ada user yang toggle
  // pribadinya enabled=true dari sebelum saklar induk dimatikan.
  const masterOn = await isBaAutoMasterEnabled();
  if (!masterOn) {
    return res.status(200).json({
      success: true,
      skipped: true,
      message: 'Master switch BA Otomatis sedang OFF -- cron dilewati, tidak ada BA yang dikirim.',
    });
  }

  const { dateStr: todayStr, day: todayDay } = getJakartaDateParts();

  // Slot dianggap "due" kalau tanggal-nya cocok HARI INI dan MINIMAL SATU
  // dari dua channel (Telegram / App) enabled DAN belum jalan hari ini di
  // channel itu -- last_run_date (Telegram) dan last_run_date_app (App)
  // DIPISAH supaya satu channel yang sudah sukses tidak ikut dikirim ulang
  // cuma gara-gara channel lain masih gagal/belum dicoba.
  const dueSlots = await sql`
    SELECT s.username, s.slot_index AS "slotIndex", s.span_id AS "spanId",
           s.petugas_username AS "petugasUsername", s.tegakan_ids AS "tegakanIds",
           s.last_run_date AS "lastRunDate", s.last_run_date_app AS "lastRunDateApp",
           st.enabled AS "telegramEnabled", st.app_enabled AS "appEnabled"
    FROM ba_auto_slot s
    JOIN ba_auto_settings st ON st.username = s.username
    WHERE s.tanggal = ${todayDay}
      AND s.span_id IS NOT NULL
      AND jsonb_array_length(s.tegakan_ids) > 0
      AND (
        (st.enabled = true AND (s.last_run_date IS NULL OR s.last_run_date <> ${todayStr}))
        OR
        (st.app_enabled = true AND (s.last_run_date_app IS NULL OR s.last_run_date_app <> ${todayStr}))
      )
    ORDER BY s.username, s.slot_index
  `;

  const results = [];
  for (const slot of dueSlots) {
    const ownerUsername = slot.petugasUsername || slot.username;
    const telegramDue = slot.telegramEnabled && (slot.lastRunDate == null || slot.lastRunDate !== todayStr);
    const appDue = slot.appEnabled && (slot.lastRunDateApp == null || slot.lastRunDateApp !== todayStr);

    const channels = {};

    if (telegramDue) {
      try {
        await sendBaViaBotlab({
          recipientUsername: slot.username, spanId: slot.spanId,
          tegakanIds: slot.tegakanIds, ownerUsername,
        });
        await sql`
          UPDATE ba_auto_slot SET last_run_date = ${todayStr}
          WHERE username = ${slot.username} AND slot_index = ${slot.slotIndex}
        `;
        channels.telegram = { success: true };
      } catch (err) {
        // SENGAJA tidak update last_run_date kalau gagal -- supaya slot ini
        // masih dianggap "belum jalan hari ini" di channel ini dan bisa
        // dicoba lagi kalau cron di-trigger ulang manual (lihat
        // isCronRequestValid, fallback ?cronKey=...) sebelum hari berganti.
        console.error(`baAutoCron: gagal kirim BA (Telegram) untuk ${slot.username} slot ${slot.slotIndex}:`, err);
        channels.telegram = { success: false, message: err.message };
      }
    }

    if (appDue) {
      try {
        await sendBaViaApp({
          recipientUsername: slot.username, spanId: slot.spanId,
          tegakanIds: slot.tegakanIds, ownerUsername,
        });
        await sql`
          UPDATE ba_auto_slot SET last_run_date_app = ${todayStr}
          WHERE username = ${slot.username} AND slot_index = ${slot.slotIndex}
        `;
        channels.app = { success: true };
      } catch (err) {
        console.error(`baAutoCron: gagal kirim BA (App) untuk ${slot.username} slot ${slot.slotIndex}:`, err);
        channels.app = { success: false, message: err.message };
      }
    }

    results.push({ username: slot.username, slotIndex: slot.slotIndex, ...channels });
  }

  const sent = results.filter((r) =>
    (r.telegram && r.telegram.success) || (r.app && r.app.success)
  ).length;
  return res.status(200).json({
    success: true,
    date: todayStr,
    checked: dueSlots.length,
    sent,
    failed: dueSlots.length - sent,
    results,
  });
}

// ─────────────────────────────────────────────────────────
// LOKASI LIVE PETUGAS (fitur peta.html)
// POST /api/settings?action=location  body:{ username, lat, lng, accuracy? }
//      -> upsert key "loc:<username>", numpang tabel app_settings yang
//         sudah ada (bukan tabel baru) supaya tidak nambah slot function.
// GET  /api/settings?action=locations -> { locations: { <username>: {lat,lng,accuracy,updatedAt} } }
//      dipanggil peta.html, di-poll berkala buat refresh titik petugas.
// Staleness (petugas dianggap "offline"/tidak ditampilkan kalau heartbeat
// terakhir sudah lama) SENGAJA diputuskan di client (peta.html), bukan di
// sini, supaya threshold-nya gampang diubah tanpa deploy ulang API.
// ─────────────────────────────────────────────────────────
async function handleLocationPost(req, res) {
  const { username, lat, lng, accuracy } = req.body || {};
  if (!username || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ success: false, message: 'username, lat, lng wajib diisi (lat/lng harus angka).' });
  }
  const value = JSON.stringify({
    lat, lng,
    accuracy: typeof accuracy === 'number' ? accuracy : null,
    updatedAt: new Date().toISOString(),
    loggedOut: false, // heartbeat baru masuk = user aktif lagi, hapus status redup
  });
  await sql`
    INSERT INTO app_settings (key, value)
    VALUES (${'loc:' + username}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
  return res.status(200).json({ success: true });
}

// Tandai titik lokasi terakhir user sebagai "loggedOut" tanpa menghapus
// lat/lng-nya -- peta.html jadi bisa tetap menampilkan titik terakhirnya
// (cuma redup), bukan menghilangkannya. Kalau belum pernah ada heartbeat
// sama sekali untuk user itu (baris 'loc:<username>' belum ada), tidak
// ada apa-apa yang perlu ditandai -- diamkan saja, jangan error.
async function handleLocationLogoutPost(req, res) {
  const { username } = req.body || {};
  if (!username) {
    return res.status(400).json({ success: false, message: 'username wajib diisi.' });
  }
  const rows = await sql`SELECT value FROM app_settings WHERE key = ${'loc:' + username}`;
  if (rows.length === 0) {
    return res.status(200).json({ success: true }); // belum pernah heartbeat, tidak ada yang ditandai
  }
  let data;
  try {
    data = JSON.parse(rows[0].value);
  } catch {
    return res.status(200).json({ success: true }); // value korup, lewati saja
  }
  data.loggedOut = true;
  data.loggedOutAt = new Date().toISOString();
  await sql`
    UPDATE app_settings SET value = ${JSON.stringify(data)}, updated_at = now()
    WHERE key = ${'loc:' + username}
  `;
  return res.status(200).json({ success: true });
}

async function handleLocationsGet(res) {
  const rows = await sql`SELECT key, value FROM app_settings WHERE key LIKE 'loc:%'`;
  const locations = {};
  for (const r of rows) {
    const username = r.key.slice('loc:'.length);
    try {
      locations[username] = JSON.parse(r.value);
    } catch {
      // value korup/bukan JSON -- lewati saja daripada bikin peta.html error total
    }
  }
  return res.status(200).json({ success: true, locations });
}

// ─── Artikel / Berita ────────────────────────────────────────────────
// Semua role bisa baca (GET), tapi create/update/delete di-cek server-side
// harus role 'admin' -- BEDA dari kebanyakan endpoint lain di project ini
// yang cuma ngandelin cek role di client, karena aksi ini nge-trigger push
// notification ke SEMUA user sekaligus (nyalah gede kalau bisa dipalsukan).
async function assertIsAdmin(username) {
  if (!username) return false;
  const rows = await sql`SELECT role FROM accounts WHERE username = ${username}`;
  return rows[0]?.role === 'admin';
}

// Jaga-jaga kalau migration-artikel-poster.sql belum sempat dijalankan
// manual di Neon: pastikan kolom is_poster ada sebelum query lain jalan,
// supaya fitur artikel TIDAK ikut rusak gara-gara kolom belum ada.
// IF NOT EXISTS = aman dipanggil berkali-kali, dan di-cache per cold start
// (articlesSchemaReady) supaya tidak nge-query tiap request.
let articlesSchemaReady = false;
async function ensureArticlesSchema() {
  if (articlesSchemaReady) return;
  await sql`ALTER TABLE articles ADD COLUMN IF NOT EXISTS is_poster BOOLEAN NOT NULL DEFAULT false`;
  articlesSchemaReady = true;
}

async function handleArticleList(res) {
  await ensureArticlesSchema();
  const articles = await sql`
    SELECT id, title, content, created_by AS "createdBy",
           created_at AS "createdAt", updated_at AS "updatedAt",
           is_poster AS "isPoster"
    FROM articles
    WHERE published = true
    ORDER BY created_at DESC
  `;
  const mediaRows = await sql`
    SELECT article_id AS "articleId", media_type AS "mediaType",
           drive_file_id AS "driveFileId", file_name AS "fileName",
           mime_type AS "mimeType", sort_order AS "sortOrder"
    FROM article_media ORDER BY sort_order
  `;
  const mediaByArticle = {};
  for (const m of mediaRows) {
    (mediaByArticle[m.articleId] ||= []).push({
      type: m.mediaType,
      fileId: m.driveFileId,
      name: m.fileName,
      mimeType: m.mimeType,
      // URL siap pakai: pakai format /thumbnail (sama seperti thumbUrl di
      // lib/googleDrive.js) karena "uc?export=view" sering GAGAL dirender
      // sebagai <img> oleh Google Drive (dibalikin halaman HTML, bukan
      // gambar mentah) -- itu penyebab foto artikel tidak tampil.
      // File lain (pdf, dsb) tetap dipakai sebagai link download.
      url: m.mediaType === 'image'
        ? `https://drive.google.com/thumbnail?id=${m.driveFileId}&sz=w2000`
        : `https://drive.google.com/uc?export=view&id=${m.driveFileId}`,
      downloadUrl: `https://drive.google.com/uc?export=download&id=${m.driveFileId}`,
    });
  }
  return { articles: articles.map((a) => ({ ...a, media: mediaByArticle[a.id] || [] })) };
}

function escapeHtmlServer(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Halaman preview SERVER-SIDE untuk link artikel-publik.html?id=... --
// dipakai KHUSUS oleh bot crawler link preview (WhatsApp/FB/Telegram/dst,
// lihat rewrite di vercel.json). Perlu ini karena artikel-publik.html asli
// mengisi og:title/og:image lewat JavaScript SETELAH fetch API selesai --
// bot crawler tidak menjalankan JS, jadi mereka cuma lihat meta tag
// default statis (judul generik, tanpa foto). Fungsi ini membaca data
// artikel dulu di server, lalu balikin HTML kecil berisi meta tag yang
// SUDAH terisi foto & judul artikel yang benar, plus redirect ke halaman
// asli untuk pengguna manusia yang kebetulan membukanya juga.
async function handleArticlePreview(req, res) {
  const { id } = req.query || {};
  const origin = `https://${req.headers.host}`;
  const redirectUrl = `${origin}/artikel-publik.html${id ? `?id=${encodeURIComponent(id)}` : ''}`;
  const defaultImage = `${origin}/assets/icon.png`;

  let title = 'Artikel & Berita - SRINAI ASSIST';
  let desc  = 'Artikel & Berita publik dari SRINAI ASSIST.';
  let image = defaultImage;

  if (id) {
    try {
      const { article } = await handleArticleGet(id);
      if (article) {
        title = `${article.title} - SRINAI ASSIST`;
        desc  = String(article.content || '').trim().slice(0, 150) || 'Artikel & Berita SRINAI ASSIST.';
        const firstImage = (article.media || []).find(m => m.type === 'image');
        if (firstImage) image = firstImage.url;
      }
    } catch (e) {
      // gagal ambil artikel -> biarkan fallback default di atas, jangan 500
    }
  }

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0;url=${escapeHtmlServer(redirectUrl)}">
<title>${escapeHtmlServer(title)}</title>
<meta name="description" content="${escapeHtmlServer(desc)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtmlServer(title)}">
<meta property="og:description" content="${escapeHtmlServer(desc)}">
<meta property="og:image" content="${escapeHtmlServer(image)}">
<meta property="og:url" content="${escapeHtmlServer(redirectUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtmlServer(title)}">
<meta name="twitter:description" content="${escapeHtmlServer(desc)}">
<meta name="twitter:image" content="${escapeHtmlServer(image)}">
<link rel="canonical" href="${escapeHtmlServer(redirectUrl)}">
<script>location.replace(${JSON.stringify(redirectUrl)});</script>
</head>
<body>
<p>Membuka artikel... Kalau tidak otomatis pindah, <a href="${escapeHtmlServer(redirectUrl)}">klik di sini</a>.</p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  return res.status(200).send(html);
}


// supaya link share tidak perlu narik SELURUH daftar artikel. Publik &
// tanpa login (sama seperti articleList), tapi cuma artikel published.
async function handleArticleGet(id) {
  await ensureArticlesSchema();
  const rows = await sql`
    SELECT id, title, content, created_by AS "createdBy",
           created_at AS "createdAt", updated_at AS "updatedAt",
           is_poster AS "isPoster"
    FROM articles
    WHERE id = ${id} AND published = true
  `;
  if (rows.length === 0) return { article: null };
  const mediaRows = await sql`
    SELECT media_type AS "mediaType", drive_file_id AS "driveFileId",
           file_name AS "fileName", mime_type AS "mimeType"
    FROM article_media WHERE article_id = ${id} ORDER BY sort_order
  `;
  const media = mediaRows.map((m) => ({
    type: m.mediaType,
    fileId: m.driveFileId,
    name: m.fileName,
    mimeType: m.mimeType,
    url: m.mediaType === 'image'
      ? `https://drive.google.com/thumbnail?id=${m.driveFileId}&sz=w2000`
      : `https://drive.google.com/uc?export=view&id=${m.driveFileId}`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${m.driveFileId}`,
  }));
  return { article: { ...rows[0], media } };
}

async function handleArticleUploadSession(req, res) {
  const { fileName, mimeType, fileSizeBytes } = req.body || {};
  if (!fileName || !mimeType) {
    return res.status(400).json({ success: false, message: 'fileName dan mimeType wajib diisi.' });
  }
  // Origin dari browser HARUS diteruskan ke Google saat bikin sesi resumable,
  // supaya Google mengizinkan PUT langsung dari browser (CORS). Lihat catatan
  // di lib/googleDrive.js untuk penjelasan lengkap kenapa ini wajib.
  const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
  const { uploadUrl } = await createResumableUploadSession(fileName, mimeType, fileSizeBytes, origin);
  return res.status(200).json({ success: true, uploadUrl });
}

async function handleArticleCreate(req, res) {
  await ensureArticlesSchema();
  const { title, content, actor, media, isPoster } = req.body || {};
  if (!(await assertIsAdmin(actor))) {
    return res.status(403).json({ success: false, message: 'Hanya admin yang bisa membuat artikel.' });
  }
  const posterMode = !!isPoster;
  const mediaList = Array.isArray(media) ? media : [];
  const hasImage = mediaList.some((m) => m?.type === 'image');
  if (!title || !title.trim()) {
    return res.status(400).json({ success: false, message: 'title wajib diisi.' });
  }
  if (posterMode && !hasImage) {
    return res.status(400).json({ success: false, message: 'Mode poster butuh minimal 1 gambar.' });
  }
  if (!posterMode && (!content || !content.trim())) {
    return res.status(400).json({ success: false, message: 'title dan content wajib diisi.' });
  }

  const id = `art-${Date.now()}`;
  await sql`
    INSERT INTO articles (id, title, content, created_by, is_poster)
    VALUES (${id}, ${title.trim()}, ${(content || '').trim()}, ${actor}, ${posterMode})
  `;

  for (let i = 0; i < mediaList.length; i++) {
    const m = mediaList[i];
    if (!m?.fileId || !m?.type) continue;
    await makeFilePublic(m.fileId);
    await sql`
      INSERT INTO article_media (article_id, media_type, drive_file_id, file_name, mime_type, sort_order)
      VALUES (${id}, ${m.type}, ${m.fileId}, ${m.name || null}, ${m.mimeType || null}, ${i})
    `;
  }

  res.status(200).json({ success: true, id });

  sendPushToAllUsers(
    { title: 'Artikel baru', body: title.trim().slice(0, 120), data: { type: 'article', articleId: id } },
    actor
  ).catch((err) => console.error('Gagal kirim push artikel baru:', err.message));
}

async function handleArticleUpdate(req, res) {
  await ensureArticlesSchema();
  const { id, title, content, actor, media, isPoster } = req.body || {};
  if (!(await assertIsAdmin(actor))) {
    return res.status(403).json({ success: false, message: 'Hanya admin yang bisa mengubah artikel.' });
  }
  if (!id) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
  if (!title || !title.trim()) {
    return res.status(400).json({ success: false, message: 'title wajib diisi.' });
  }
  const posterMode = !!isPoster;

  await sql`
    UPDATE articles
    SET title = ${title.trim()}, content = ${(content || '').trim()},
        is_poster = ${posterMode}, updated_at = now()
    WHERE id = ${id}
  `;

  if (Array.isArray(media)) {
    // Ganti total daftar media (sederhana; artikel jarang punya lampiran banyak).
    await sql`DELETE FROM article_media WHERE article_id = ${id}`;
    for (let i = 0; i < media.length; i++) {
      const m = media[i];
      if (!m?.fileId || !m?.type) continue;
      await makeFilePublic(m.fileId);
      await sql`
        INSERT INTO article_media (article_id, media_type, drive_file_id, file_name, mime_type, sort_order)
        VALUES (${id}, ${m.type}, ${m.fileId}, ${m.name || null}, ${m.mimeType || null}, ${i})
      `;
    }
  }
  return res.status(200).json({ success: true });
}

async function handleArticleDelete(req, res) {
  const { id, actor } = req.query || {};
  if (!(await assertIsAdmin(actor))) {
    return res.status(403).json({ success: false, message: 'Hanya admin yang bisa menghapus artikel.' });
  }
  if (!id) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
  await sql`DELETE FROM articles WHERE id = ${id}`;
  return res.status(200).json({ success: true });
}

module.exports = async (req, res) => {
  try {
    const { key: qKey, keys: qKeys, stats: qStats, action: qAction, includeImages: qIncludeImages } = req.query || {};

    if (qAction === 'location') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleLocationPost(req, res);
    }

    if (qAction === 'locations') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleLocationsGet(res);
    }

    if (qAction === 'locationLogout') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleLocationLogoutPost(req, res);
    }

    if (qAction === 'backup') {
      // Paling kritis: export membocorkan password_hash SEMUA akun,
      // restore bisa menimpa SELURUH isi database (termasuk akun & role).
      // Wajib admin, dicek dari DB -- bukan cuma percaya klien.
      const backupActor = req.method === 'GET' ? req.query?.actor : (req.body || {}).actor;
      if (!(await assertIsAdmin(backupActor))) {
        return res.status(403).json({ success: false, message: 'Hanya admin yang boleh mengakses backup data.' });
      }
      if (req.method === 'GET') return await handleBackupExport(res);
      if (req.method === 'POST') return await handleBackupRestore(req, res);
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
    }

    if (qAction === 'botlabDashboardUrl') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBotlabDashboardUrl(res);
    }

    if (qAction === 'botCommands') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBotCommandsCatalog(res);
    }

    if (qAction === 'botConsole') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBotConsole(req, res);
    }

    if (qAction === 'botNotify') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBotNotifyGet(req, res);
    }

    if (qAction === 'botNotifyRead') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBotNotifyRead(req, res);
    }

    if (qAction === 'botNotifyCron') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBotNotifyCron(req, res);
    }

    if (qAction === 'baAutoCron') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBaAutoCron(req, res);
    }

    if (qAction === 'telegramLinkToken') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleTelegramLinkToken(req, res);
    }

    if (qAction === 'telegramLinkValidate') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleTelegramLinkValidate(req, res);
    }

    if (qAction === 'telegramLinkStatus') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleTelegramLinkStatus(req, res);
    }

    if (qAction === 'telegramConnectedList') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleTelegramConnectedListRoute(req, res);
    }

    if (qAction === 'telegramBroadcastFile') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleTelegramBroadcastFile(req, res);
    }

    if (qAction === 'baAutoAdminList') {
      return handleBaAutoAdminList(req, res);
    }

    if (qAction === 'baAutoGet') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBaAutoGet(req, res);
    }

    if (qAction === 'baAutoToggle') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBaAutoToggle(req, res);
    }

    if (qAction === 'baAutoAppToggle') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBaAutoAppToggle(req, res);
    }

    if (qAction === 'baAutoSlotSave') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleBaAutoSlotSave(req, res);
    }

    if (qAction === 'articleList') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      const { articles } = await handleArticleList(res);
      return res.status(200).json({ success: true, articles });
    }

    // Dipakai halaman publik artikel-publik.html?id=... -- tanpa login,
    // sengaja dipisah dari articleList supaya link share ringan & cepat.
    // Dipakai KHUSUS bot crawler link preview (lihat rewrite di vercel.json)
    // -- balikin HTML dengan og:title/og:image sudah terisi server-side,
    // beda dari articleGet (JSON) yang dipakai halaman publik saat di-fetch
    // lewat JS di browser manusia.
    if (qAction === 'articlePreview') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleArticlePreview(req, res);
    }

    if (qAction === 'articleGet') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      const { id: getId } = req.query || {};
      if (!getId) {
        return res.status(400).json({ success: false, message: 'id wajib diisi.' });
      }
      const { article } = await handleArticleGet(getId);
      if (!article) {
        return res.status(404).json({ success: false, message: 'Artikel tidak ditemukan.' });
      }
      return res.status(200).json({ success: true, article });
    }

    if (qAction === 'articleUploadSession') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleArticleUploadSession(req, res);
    }

    if (qAction === 'articleCreate') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleArticleCreate(req, res);
    }

    if (qAction === 'articleUpdate') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleArticleUpdate(req, res);
    }

    if (qAction === 'articleDelete') {
      if (req.method !== 'DELETE') {
        res.setHeader('Allow', 'DELETE');
        return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
      }
      return await handleArticleDelete(req, res);
    }

    if (req.method === 'GET' && qStats === 'db') {
      const rows = await sql`SELECT pg_database_size(current_database()) AS bytes`;
      // Ukuran asli dari Postgres DIKALI sama seperti limit-nya (20x), supaya
      // rasio/persentase tetap akurat terhadap ukuran nyata, tapi angka GB
      // yang tampil di layar (baik terpakai maupun limit) sama-sama membesar.
      const bytes = Number(rows[0]?.bytes || 0) * DISPLAY_SIZE_MULTIPLIER;
      const percent = Math.min(100, (bytes / DB_STORAGE_LIMIT_BYTES) * 100);
      return res.status(200).json({
        success: true,
        bytes,
        mb: +(bytes / (1024 * 1024)).toFixed(1),
        limitMb: +(DB_STORAGE_LIMIT_BYTES / (1024 * 1024)).toFixed(0),
        percent: +percent.toFixed(1),
      });
    }

    // Khusus admin -- angka ASLI database (tanpa dikali DISPLAY_SIZE_MULTIPLIER)
    // + rincian ukuran per tabel. Dipakai admin-storage-db.html.
    if (req.method === 'GET' && qStats === 'dbDetail') {
      const { actor: dbActor } = req.query || {};
      if (!(await assertIsAdmin(dbActor))) {
        return res.status(403).json({ success: false, message: 'Khusus admin.' });
      }
      const totalRows = await sql`SELECT pg_database_size(current_database()) AS bytes`;
      const realBytes = Number(totalRows[0]?.bytes || 0);
      const realLimitBytes = DB_STORAGE_LIMIT_BYTES / DISPLAY_SIZE_MULTIPLIER;
      const tableRows = await sql`
        SELECT
          relname AS table_name,
          pg_total_relation_size(c.oid) AS bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public'
        ORDER BY bytes DESC
      `;
      return res.status(200).json({
        success: true,
        realBytes,
        realMb: +(realBytes / (1024 * 1024)).toFixed(2),
        realLimitBytes,
        realLimitMb: +(realLimitBytes / (1024 * 1024)).toFixed(0),
        realPercent: +Math.min(100, (realBytes / realLimitBytes) * 100).toFixed(2),
        tables: tableRows.map(r => ({
          name: r.table_name,
          bytes: Number(r.bytes),
          mb: +(Number(r.bytes) / (1024 * 1024)).toFixed(2),
        })),
      });
    }

    if (req.method === 'GET' && qStats === 'drive') {
      const info = await getDriveStorageInfo();
      // Sama seperti DB: ukuran asli dikali 20x biar konsisten sama limit-nya.
      const bytes = info.usageBytes * DISPLAY_SIZE_MULTIPLIER;
      const percent = Math.min(100, (bytes / DRIVE_STORAGE_LIMIT_BYTES) * 100);
      return res.status(200).json({
        success: true,
        bytes,
        mb: +(bytes / (1024 * 1024)).toFixed(1),
        limitMb: +(DRIVE_STORAGE_LIMIT_BYTES / (1024 * 1024)).toFixed(0),
        percent: +percent.toFixed(1),
      });
    }

    // Khusus admin -- angka ASLI Google Drive (tanpa dikali multiplier) +
    // limit yang benar-benar dilaporkan Google (kalau ada) + daftar file
    // terbesar. Dipakai admin-storage-drive.html.
    if (req.method === 'GET' && qStats === 'driveDetail') {
      const { actor: driveActor } = req.query || {};
      if (!(await assertIsAdmin(driveActor))) {
        return res.status(403).json({ success: false, message: 'Khusus admin.' });
      }
      const info = await getDriveStorageInfo();
      const realLimitBytes = info.limitBytes != null ? info.limitBytes : (DRIVE_STORAGE_LIMIT_BYTES / DISPLAY_SIZE_MULTIPLIER);
      let files = [];
      let filesError = null;
      try {
        files = await listLargestDriveFiles(30);
      } catch (e) {
        filesError = e.message;
      }
      return res.status(200).json({
        success: true,
        realBytes: info.usageBytes,
        realMb: +(info.usageBytes / (1024 * 1024)).toFixed(2),
        usageInDriveBytes: info.usageInDriveBytes,
        realLimitBytes,
        realLimitMb: realLimitBytes ? +(realLimitBytes / (1024 * 1024)).toFixed(0) : null,
        limitReportedByGoogle: info.limitBytes != null,
        realPercent: realLimitBytes ? +Math.min(100, (info.usageBytes / realLimitBytes) * 100).toFixed(2) : null,
        files: files.map(f => ({ ...f, mb: +(f.bytes / (1024 * 1024)).toFixed(2) })),
        filesError,
      });
    }

    // Khusus admin -- data Vercel (deployment terbaru + daftar deployment
    // + jumlah serverless function terpakai vs limit Hobby). Dipakai
    // admin-storage-vercel.html. Butuh env VERCEL_TOKEN (Access Token dari
    // Vercel Account Settings). Project ID diambil otomatis dari system env
    // VERCEL_PROJECT_ID (aktifkan "Automatically expose System Environment
    // Variables" di Project Settings -> Environment Variables kalau belum
    // muncul), atau fallback ke env VERCEL_PROJECT_ID_MANUAL kalau mau diisi
    // manual.
    if (req.method === 'GET' && qStats === 'vercelDetail') {
      const { actor: vercelActor } = req.query || {};
      if (!(await assertIsAdmin(vercelActor))) {
        return res.status(403).json({ success: false, message: 'Khusus admin.' });
      }
      const token = process.env.VERCEL_TOKEN;
      const projectId = process.env.VERCEL_PROJECT_ID || process.env.VERCEL_PROJECT_ID_MANUAL;
      const teamId = process.env.VERCEL_TEAM_ID || null;
      if (!token) {
        return res.status(200).json({
          success: false,
          message: 'VERCEL_TOKEN belum diset di Environment Variables project ini.',
        });
      }
      if (!projectId) {
        return res.status(200).json({
          success: false,
          message: 'Project ID Vercel tidak ditemukan. Aktifkan "Automatically expose System Environment Variables" di Project Settings, atau set VERCEL_PROJECT_ID_MANUAL.',
        });
      }

      const vHeaders = { Authorization: `Bearer ${token}` };
      const teamQ = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';

      try {
        const depRes = await fetch(
          `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=10${teamQ}`,
          { headers: vHeaders }
        );
        const depJson = await depRes.json();
        if (!depRes.ok) {
          throw new Error(depJson?.error?.message || `Vercel API error (${depRes.status})`);
        }
        const deployments = (depJson.deployments || []).map(d => ({
          uid: d.uid,
          state: d.state || d.readyState,
          target: d.target || (d.meta?.githubCommitRef ? 'production' : 'preview'),
          url: d.url,
          createdAt: d.createdAt || d.created,
          creator: d.creator?.username || d.creator?.email || null,
          commitMessage: d.meta?.githubCommitMessage || d.meta?.gitCommitMessage || null,
          commitRef: d.meta?.githubCommitRef || d.meta?.gitCommitRef || null,
        }));

        // Hitung jumlah serverless function dari deployment TERBARU (file
        // di bawah folder api/ dengan ekstensi .js/.ts), buat dibandingkan
        // ke limit 12 punya paket Hobby.
        let functionCount = null;
        let functionFiles = [];
        if (deployments[0]?.uid) {
          try {
            const filesRes = await fetch(
              `https://api.vercel.com/v6/deployments/${deployments[0].uid}/files${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`,
              { headers: vHeaders }
            );
            const filesJson = await filesRes.json();
            const collected = [];
            const walk = (nodes, prefix) => {
              for (const n of (nodes || [])) {
                const p = prefix ? `${prefix}/${n.name}` : n.name;
                if (n.type === 'directory') walk(n.children, p);
                else if (/^api\/.*\.(js|ts)$/.test(p)) collected.push(p);
              }
            };
            walk(filesJson, '');
            functionFiles = collected;
            functionCount = collected.length;
          } catch (e) {
            // Diamkan -- bagian ini best-effort, jangan sampai gagalkan seluruh respons.
          }
        }

        return res.status(200).json({
          success: true,
          deployments,
          functionCount,
          functionLimit: 12,
          functionFiles,
          note: 'Bandwidth/usage kuota Hobby tidak punya endpoint REST publik dari Vercel -- cek langsung di dashboard Vercel > Usage untuk angka itu.',
        });
      } catch (err) {
        return res.status(200).json({ success: false, message: err.message || 'Gagal menghubungi Vercel API.' });
      }
    }

    if (req.method === 'GET' && qStats === 'ai') {
      const todayKey = 'ai_usage_' + new Date().toISOString().slice(0, 10);
      const rows = await sql`
        SELECT key, value FROM app_settings WHERE key IN (${todayKey}, 'ai_daily_limit')
      `;
      const map = {};
      for (const r of rows) map[r.key] = r.value;

      const used = parseInt(map[todayKey], 10) || 0;
      const limit = parseInt(map['ai_daily_limit'], 10) || AI_DAILY_LIMIT_DEFAULT;
      const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

      return res.status(200).json({
        success: true,
        used,
        limit,
        percent: +percent.toFixed(1),
      });
    }

    if (req.method === 'GET') {
      if (qKeys) {
        const keyList = qKeys.split(',').map(k => k.trim()).filter(Boolean);
        if (keyList.length === 0) {
          return res.status(400).json({ success: false, message: 'keys wajib diisi.' });
        }
        const rows = await sql`
          SELECT key, value FROM app_settings WHERE key = ANY(${keyList})
        `;
        const includeImages = qIncludeImages !== 'false';
        const settings = {};
        for (const r of rows) {
          // includeImages=false (dipakai syncAll() buat cek fingerprint dulu):
          // SKIP download+resolve dari Drive untuk key gambar, kirim referensi
          // mentahnya saja ("drive:<fileId>", beberapa puluh karakter). Sama
          // seperti fix includeTtd=false (tegakan) & includeFoto=false (akun)
          // -- yang butuh gambar aslinya cuma yang benar-benar dipakai render/
          // generate PDF, bukan setiap kali syncAll() jalan.
          settings[r.key] = includeImages
            ? await resolveValueForRead(r.key, r.value)
            : (isImageKey(r.key) ? (r.value || '') : await resolveValueForRead(r.key, r.value));
        }
        return res.status(200).json({ success: true, settings });
      }

      if (!qKey) {
        return res.status(400).json({ success: false, message: 'key wajib diisi.' });
      }
      const rows = await sql`SELECT value FROM app_settings WHERE key = ${qKey}`;
      const value = rows[0] ? await resolveValueForRead(qKey, rows[0].value) : null;
      return res.status(200).json({ success: true, value });
    }

    if (req.method === 'POST') {
      const { key, value } = req.body || {};
      if (!key) {
        return res.status(400).json({ success: false, message: 'key wajib diisi.' });
      }
      const { toSave, warning } = await resolveValueForSave(key, value);
      await sql`
        INSERT INTO app_settings (key, value)
        VALUES (${key}, ${toSave})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
      return res.status(200).json({ success: true, driveWarning: warning });
    }

    if (req.method === 'DELETE') {
      if (!qKey) return res.status(400).json({ success: false, message: 'key wajib diisi.' });
      const { actor: deleteActor } = req.query || {};
      if (!(await assertIsAdmin(deleteActor))) {
        return res.status(403).json({ success: false, message: 'Hanya admin yang boleh menghapus setting.' });
      }
      await sql`DELETE FROM app_settings WHERE key = ${qKey}`;
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Settings API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
