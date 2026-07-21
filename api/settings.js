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
//
// (Digabung di sini, bukan file /api terpisah, supaya tidak menambah slot
// serverless function baru -- Vercel Hobby dibatasi 12 function/deployment
// dan project ini sudah pas di batas itu.)
//
// PENTING (perbaikan kuota transfer Neon): 5 key berikut berisi gambar yang
// bisa cukup besar (logo/background/contoh layout BA & halaman login):
//   baLogo, baBackground, baContohLayout, loginLogo, loginBackground
// PLUS: key apa pun berawalan "qr:" (mis. qr:tower:<id>, qr:span:<id>) --
// dipakai untuk cache QR Code Tower/Span (dashboard.html, tower.html).
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

const { sql } = require('../lib/db');
const { uploadPhotoToDrive, downloadFileAsDataUrl, getDriveStorageInfo } = require('../lib/googleDrive');

const DRIVE_PREFIX = 'drive:';

// Kelima key ini SELALU disimpan frontend sebagai JPEG (canvas.toDataURL
// ("image/jpeg", ...) di pengaturan.html & pengaturan-ba.html), jadi aman
// hardcode mimeType 'image/jpeg' saat resolve balik dari Drive.
const IMAGE_SETTING_KEYS = new Set([
  'baLogo', 'baBackground', 'baContohLayout', 'loginLogo', 'loginBackground',
]);

// Selain 5 key tetap di atas, key apa pun berawalan "qr:" (contoh:
// "qr:tower:<id>", "qr:span:<id>") JUGA diperlakukan sebagai gambar dan
// disimpan ke Drive. Dipakai untuk cache QR Code Tower/Span (generate
// sekali di browser, upload sekali, GET berikutnya tinggal ambil dari Drive
// -- tidak generate ulang & tidak upload ulang).
function isImageKey(key) {
  return IMAGE_SETTING_KEYS.has(key) || (typeof key === 'string' && key.startsWith('qr:'));
}

// QR disimpan sebagai PNG (canvas.toDataURL("image/png")), 5 key lama tetap JPEG.
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

// Batas storage Neon Free plan: 0.5 GB per project. Dipakai untuk hitung
// persentase pemakaian yang ditampilkan di dashboard (widget di atas quickgrid).
const DB_STORAGE_LIMIT_BYTES = 0.5 * 1024 * 1024 * 1024;

// Batas storage Google Drive dipakai untuk widget "Penyimpanan Drive" (di
// bawah widget Penyimpanan Database di dashboard). Google Drive akun gratis
// berbagi kuota 15 GB dengan Gmail & Google Photos, dan `storageQuota.limit`
// dari API kadang null (tidak dilaporkan / akun unlimited) -- jadi 15 GB
// di sini SELALU dipakai sebagai acuan tetap, bukan diambil dari API. Angka
// persentase yang tampil di dashboard karena itu sifatnya PERKIRAAN saja.
const DRIVE_STORAGE_LIMIT_BYTES = 15 * 1024 * 1024 * 1024;

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
  });
  await sql`
    INSERT INTO app_settings (key, value)
    VALUES (${'loc:' + username}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
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

module.exports = async (req, res) => {
  try {
    const { key: qKey, keys: qKeys, stats: qStats, action: qAction } = req.query || {};

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

    if (qAction === 'backup') {
      if (req.method === 'GET') return await handleBackupExport(res);
      if (req.method === 'POST') return await handleBackupRestore(req, res);
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
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

    if (req.method === 'GET' && qStats === 'db') {
      const rows = await sql`SELECT pg_database_size(current_database()) AS bytes`;
      const bytes = Number(rows[0]?.bytes || 0);
      const percent = Math.min(100, (bytes / DB_STORAGE_LIMIT_BYTES) * 100);
      return res.status(200).json({
        success: true,
        bytes,
        mb: +(bytes / (1024 * 1024)).toFixed(1),
        limitMb: +(DB_STORAGE_LIMIT_BYTES / (1024 * 1024)).toFixed(0),
        percent: +percent.toFixed(1),
      });
    }

    if (req.method === 'GET' && qStats === 'drive') {
      const info = await getDriveStorageInfo();
      const bytes = info.usageBytes;
      const percent = Math.min(100, (bytes / DRIVE_STORAGE_LIMIT_BYTES) * 100);
      return res.status(200).json({
        success: true,
        bytes,
        mb: +(bytes / (1024 * 1024)).toFixed(1),
        limitMb: +(DRIVE_STORAGE_LIMIT_BYTES / (1024 * 1024)).toFixed(0),
        percent: +percent.toFixed(1),
      });
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
        const settings = {};
        for (const r of rows) {
          settings[r.key] = await resolveValueForRead(r.key, r.value);
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
