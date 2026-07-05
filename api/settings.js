// api/settings.js
//
// GET    /api/settings?key=..              -> ambil satu setting
// GET    /api/settings?keys=a,b,c           -> ambil beberapa setting sekaligus
// POST   /api/settings                      -> simpan/replace satu setting
//        body: { key, value }
// DELETE /api/settings?key=..               -> hapus satu setting (reset ke default)
//
// PENTING (perbaikan kuota transfer Neon): 5 key berikut berisi gambar yang
// bisa cukup besar (logo/background/contoh layout BA & halaman login):
//   baLogo, baBackground, baContohLayout, loginLogo, loginBackground
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

// Upload value (data URL base64) ke Drive kalau key-nya termasuk gambar.
// Return: { toSave, warning }
async function resolveValueForSave(key, value) {
  if (!IMAGE_SETTING_KEYS.has(key)) {
    return { toSave: value ?? null, warning: null }; // key non-gambar, simpan apa adanya
  }
  if (!value || typeof value !== 'string' || !value.startsWith('data:')) {
    return { toSave: value ?? null, warning: null }; // kosong / sudah referensi Drive lama
  }
  try {
    const uploaded = await uploadPhotoToDrive(value, `${key}-${Date.now()}.jpg`);
    return { toSave: `${DRIVE_PREFIX}${uploaded.fileId}`, warning: null };
  } catch (driveErr) {
    console.error(`Upload setting "${key}" ke Drive gagal, fallback simpan base64:`, driveErr.message);
    return { toSave: value, warning: driveErr.message };
  }
}

// Baca value dari DB dan ubah jadi base64 data URL kalau berupa referensi
// Drive. Key non-gambar / value bukan referensi Drive dikembalikan apa adanya.
async function resolveValueForRead(key, valueRaw) {
  if (!IMAGE_SETTING_KEYS.has(key)) return valueRaw;
  if (!valueRaw || typeof valueRaw !== 'string' || !valueRaw.startsWith(DRIVE_PREFIX)) {
    return valueRaw;
  }
  const fileId = valueRaw.slice(DRIVE_PREFIX.length);
  try {
    return await downloadFileAsDataUrl(fileId, 'image/jpeg');
  } catch (err) {
    console.error(`Download setting "${key}" dari Drive gagal:`, err.message);
    return null; // biar frontend anggap belum ada gambar, daripada error total
  }
}

module.exports = async (req, res) => {
  try {
    const { key: qKey, keys: qKeys } = req.query || {};

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
