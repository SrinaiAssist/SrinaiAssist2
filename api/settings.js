// api/settings.js
//
// GET    /api/settings?key=..              -> ambil satu setting
// GET    /api/settings?keys=a,b,c           -> ambil beberapa setting sekaligus
// POST   /api/settings                      -> simpan/replace satu setting
//        body: { key, value }
// DELETE /api/settings?key=..               -> hapus satu setting (reset ke default)
//
// GET    /api/settings?action=backup        -> Export SEMUA data (semua tabel) jadi
//                                              satu objek JSON. Dipakai tombol
//                                              "Backup Data" (Admin) di pengaturan.html.
// POST   /api/settings?action=backup        -> Restore data dari file backup JSON.
//        body: { tables: { accounts:[...], profiles:[...], jalur:[...], ... } }
//        Upsert per baris (INSERT ... ON CONFLICT DO UPDATE) berdasarkan primary
//        key tiap tabel -> TIDAK MENGHAPUS data yang sudah ada di server, hanya
//        menambah baris baru & menimpa baris yang id/key-nya sama persis.
// (Digabung ke sini, bukan file api/backup.js terpisah, karena folder /api sudah
//  di limit 12 function Vercel Hobby. Lihat blok BACKUP/RESTORE di bawah.)
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
const { uploadPhotoToDrive, downloadFileAsDataUrl } = require('../lib/googleDrive');

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

// ===== BACKUP / RESTORE (digabung dari bekas api/backup.js, lihat catatan header) =====

// Urutan tabel SENGAJA disusun parent dulu supaya restore tidak gagal karena
// foreign key (mis. profiles.username -> accounts.username).
const BACKUP_TABLES = [
  { name: 'accounts', pk: ['username'] },
  { name: 'profiles', pk: ['username'] },
  { name: 'jalur', pk: ['id'] },
  { name: 'tower', pk: ['id'] },
  { name: 'span', pk: ['id'] },
  { name: 'tegakan', pk: ['id'] },
  { name: 'catatan_span', pk: ['id'] },
  { name: 'ba_dokumen', pk: ['id'] },
  { name: 'pemilik_signatures', pk: ['nama_key'] },
  { name: 'profile_signatures', pk: ['username'] },
  { name: 'chat_messages', pk: ['id'] },
  { name: 'app_settings', pk: ['key'] },
];

const BACKUP_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function backupQuoteIdent(name) {
  if (typeof name !== 'string' || !BACKUP_IDENT_RE.test(name)) {
    throw new Error(`Nama kolom/tabel tidak valid: ${name}`);
  }
  return '"' + name + '"';
}

async function exportAllTables() {
  const result = {};
  for (const t of BACKUP_TABLES) {
    try {
      const rows = await sql(`SELECT * FROM ${backupQuoteIdent(t.name)}`);
      result[t.name] = rows;
    } catch (err) {
      console.error(`Backup: gagal export tabel ${t.name}:`, err.message);
      result[t.name] = [];
    }
  }
  return result;
}

// Upsert satu baris. Kolom yang tidak dikenal (bukan identifier valid) dilewati
// per-baris supaya satu baris rusak tidak menggagalkan seluruh restore.
async function upsertBackupRow(tableName, pkCols, row) {
  const cols = Object.keys(row).filter((c) => BACKUP_IDENT_RE.test(c));
  if (cols.length === 0) return;

  const colIdents = cols.map(backupQuoteIdent).join(', ');
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const pkIdents = pkCols.map(backupQuoteIdent).join(', ');
  const updateCols = cols.filter((c) => !pkCols.includes(c));
  const values = cols.map((c) => row[c]);

  let queryText;
  if (updateCols.length === 0) {
    queryText = `
      INSERT INTO ${backupQuoteIdent(tableName)} (${colIdents})
      VALUES (${placeholders})
      ON CONFLICT (${pkIdents}) DO NOTHING
    `;
  } else {
    const setClause = updateCols.map((c) => `${backupQuoteIdent(c)} = EXCLUDED.${backupQuoteIdent(c)}`).join(', ');
    queryText = `
      INSERT INTO ${backupQuoteIdent(tableName)} (${colIdents})
      VALUES (${placeholders})
      ON CONFLICT (${pkIdents}) DO UPDATE SET ${setClause}
    `;
  }
  await sql(queryText, values);
}

async function restoreAllTables(tablesData) {
  const summary = {};
  for (const t of BACKUP_TABLES) {
    const rows = tablesData[t.name];
    if (!Array.isArray(rows)) {
      summary[t.name] = { skipped: true };
      continue;
    }
    let ok = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await upsertBackupRow(t.name, t.pk, row);
        ok += 1;
      } catch (err) {
        failed += 1;
        console.error(`Restore: gagal upsert baris di ${t.name}:`, err.message);
      }
    }
    summary[t.name] = { ok, failed, total: rows.length };
  }
  return summary;
}

// ===== akhir bagian BACKUP / RESTORE =====

module.exports = async (req, res) => {
  try {
    const { key: qKey, keys: qKeys, action } = req.query || {};

    if (action === 'backup') {
      if (req.method === 'GET') {
        const tables = await exportAllTables();
        return res.status(200).json({
          success: true,
          exportedAt: new Date().toISOString(),
          version: 1,
          tables,
        });
      }
      if (req.method === 'POST') {
        const { tables } = req.body || {};
        if (!tables || typeof tables !== 'object') {
          return res.status(400).json({
            success: false,
            message: 'File backup tidak valid: field "tables" tidak ditemukan.',
          });
        }
        const summary = await restoreAllTables(tables);
        return res.status(200).json({ success: true, summary });
      }
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
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
