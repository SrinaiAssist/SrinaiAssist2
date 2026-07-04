// api/signature.js
//
// Satu endpoint untuk DUA jenis TTD tersimpan (digabung supaya tidak nambah
// slot serverless function baru di Vercel):
//
// 1) TTD AKUN PETUGAS — dikunci per username
//    GET    /api/signature?username=..
//    POST   /api/signature   body: { username, ttdType, ttdData }
//    DELETE /api/signature?username=..
//
// 2) TTD OTOMATIS PEMILIK TEGAKAN — dikunci per nama pemilik (dinormalisasi),
//    supaya kalau nama pemilik yang sama dipakai di tegakan/span lain,
//    TTD-nya konsisten dengan yang pertama kali dibuat untuk nama tsb.
//    GET    /api/signature?nama=..
//    POST   /api/signature   body: { namaPemilik, ttdType, ttdData }
//           -> hanya simpan kalau nama ini BELUM punya TTD (first-write-wins)
//    PUT    /api/signature   body: { namaPemilik, ttdType, ttdData }
//           -> sengaja mengganti/replace TTD canonical milik nama tsb
//    DELETE /api/signature?nama=..
//
// PENTING (perbaikan kuota transfer Neon): sebelumnya ttd_data SELALU
// disimpan sebagai base64 mentah langsung di Postgres. TTD mode "foto"
// (upload foto kertas bertanda tangan) bisa berukuran ratusan KB-beberapa
// MB per baris, dan di-fetch ulang setiap kali BA/catatan digenerate ->
// cepat menghabiskan kuota network transfer bulanan Neon (terutama plan
// Free yang cuma 5 GB/bulan).
//
// Sekarang: kalau ttdData berupa base64 data URL, file diupload dulu ke
// Google Drive (lib/googleDrive.js) dan yang disimpan di kolom ttd_data
// cuma referensi kecil "drive:<fileId>" (beberapa puluh karakter). Saat
// dibaca (GET), referensi itu otomatis di-download dari Drive lalu
// dikonversi balik jadi base64 SEBELUM dikirim ke browser -- supaya
// frontend (catatan-span.html, catatan.html, profile.html) yang masih
// pakai `doc.addImage(ttdData, ...)` TIDAK PERLU diubah sama sekali.
// Kalau kredensial Drive belum diset / upload gagal, fallback: simpan
// base64 apa adanya seperti semula supaya fitur tetap jalan.

const { sql } = require('../lib/db');
const { uploadPhotoToDrive, downloadFileAsDataUrl } = require('../lib/googleDrive');

const DRIVE_PREFIX = 'drive:';

function normalizeNama(nama) {
  return (nama || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// mimeType TTD selalu salah satu dari 2: "foto" (upload foto kertas TTD,
// biasanya JPEG) atau "digital" (hasil gambar di canvas, PNG). Ini sama
// persis dengan asumsi yang sudah dipakai di frontend (ttdType === "foto"
// ? "JPEG" : "PNG" saat doc.addImage).
function mimeTypeFor(ttdType) {
  return ttdType === 'foto' ? 'image/jpeg' : 'image/png';
}

// Upload ttdData (data URL base64) ke Drive. Return { toSave, warning }
// - toSave: nilai yang disimpan ke kolom ttd_data ("drive:<fileId>" kalau
//   sukses, base64 asli kalau gagal/fallback)
// - warning: pesan error kalau upload gagal (null kalau sukses / tidak perlu upload)
async function resolveTtdDataForSave(ttdData, ttdType, fileNamePrefix) {
  if (!ttdData || typeof ttdData !== 'string' || !ttdData.startsWith('data:')) {
    // Sudah berupa referensi Drive lama, atau kosong -> simpan apa adanya
    return { toSave: ttdData || null, warning: null };
  }
  try {
    const ext = ttdType === 'foto' ? 'jpg' : 'png';
    const uploaded = await uploadPhotoToDrive(ttdData, `${fileNamePrefix}-${Date.now()}.${ext}`);
    return { toSave: `${DRIVE_PREFIX}${uploaded.fileId}`, warning: null };
  } catch (driveErr) {
    console.error('Upload TTD ke Drive gagal, fallback simpan base64:', driveErr.message);
    return { toSave: ttdData, warning: driveErr.message };
  }
}

// Baca ttd_data dari DB dan ubah jadi base64 data URL kalau berupa
// referensi Drive. Kalau bukan referensi Drive (base64 lama / kosong),
// dikembalikan apa adanya.
async function resolveTtdDataForRead(ttdDataRaw, ttdType) {
  if (!ttdDataRaw || typeof ttdDataRaw !== 'string' || !ttdDataRaw.startsWith(DRIVE_PREFIX)) {
    return ttdDataRaw || null;
  }
  const fileId = ttdDataRaw.slice(DRIVE_PREFIX.length);
  try {
    return await downloadFileAsDataUrl(fileId, mimeTypeFor(ttdType));
  } catch (err) {
    console.error('Download TTD dari Drive gagal:', err.message);
    return null; // biar frontend anggap TTD belum ada, daripada error total
  }
}

module.exports = async (req, res) => {
  try {
    const { username: qUsername, nama: qNama } = req.query || {};

    /* ================= GET ================= */
    if (req.method === 'GET') {
      if (qNama !== undefined) {
        const namaKey = normalizeNama(qNama);
        if (!namaKey) {
          return res.status(400).json({ success: false, message: 'nama wajib diisi.' });
        }
        const rows = await sql`
          SELECT nama_key AS "namaKey", nama_pemilik AS "namaPemilik",
                 ttd_type AS "ttdType", ttd_data AS "ttdData", tanggal
          FROM pemilik_signatures
          WHERE nama_key = ${namaKey}
        `;
        const row = rows[0] || null;
        if (row) row.ttdData = await resolveTtdDataForRead(row.ttdData, row.ttdType);
        return res.status(200).json({ success: true, signature: row });
      }

      if (!qUsername) {
        return res.status(400).json({ success: false, message: 'username wajib diisi.' });
      }
      const rows = await sql`
        SELECT username, ttd_type AS "ttdType", ttd_data AS "ttdData", tanggal
        FROM profile_signatures
        WHERE username = ${qUsername}
      `;
      const row = rows[0] || null;
      if (row) row.ttdData = await resolveTtdDataForRead(row.ttdData, row.ttdType);
      return res.status(200).json({ success: true, signature: row });
    }

    /* ================= POST / PUT ================= */
    if (req.method === 'POST' || req.method === 'PUT') {
      const { username, namaPemilik, ttdType, ttdData } = req.body || {};
      const tanggal = new Date().toLocaleDateString('id-ID');

      // --- TTD pemilik tegakan (dikunci per nama) ---
      if (namaPemilik !== undefined) {
        const namaKey = normalizeNama(namaPemilik);
        if (!namaKey || !ttdData) {
          return res.status(400).json({ success: false, message: 'namaPemilik dan ttdData wajib diisi.' });
        }

        const { toSave, warning } = await resolveTtdDataForSave(ttdData, ttdType || 'digital', `ttd-${namaKey}`);

        if (req.method === 'PUT') {
          // sengaja mengganti TTD canonical milik nama pemilik ini
          await sql`
            INSERT INTO pemilik_signatures (nama_key, nama_pemilik, ttd_type, ttd_data, tanggal)
            VALUES (${namaKey}, ${namaPemilik}, ${ttdType || 'digital'}, ${toSave}, ${tanggal})
            ON CONFLICT (nama_key) DO UPDATE SET
              nama_pemilik = EXCLUDED.nama_pemilik,
              ttd_type = EXCLUDED.ttd_type,
              ttd_data = EXCLUDED.ttd_data,
              tanggal = EXCLUDED.tanggal,
              updated_at = now()
          `;
          return res.status(200).json({ success: true, replaced: true, driveWarning: warning });
        }

        // POST: hanya simpan kalau belum ada (first-write-wins)
        const result = await sql`
          INSERT INTO pemilik_signatures (nama_key, nama_pemilik, ttd_type, ttd_data, tanggal)
          VALUES (${namaKey}, ${namaPemilik}, ${ttdType || 'digital'}, ${toSave}, ${tanggal})
          ON CONFLICT (nama_key) DO NOTHING
          RETURNING nama_key
        `;
        return res.status(200).json({ success: true, created: result.length > 0, driveWarning: warning });
      }

      // --- TTD akun petugas (dikunci per username) ---
      if (!username || !ttdData) {
        return res.status(400).json({ success: false, message: 'username dan ttdData wajib diisi.' });
      }
      const { toSave, warning } = await resolveTtdDataForSave(ttdData, ttdType || 'digital', `ttd-${username}`);
      await sql`
        INSERT INTO profile_signatures (username, ttd_type, ttd_data, tanggal)
        VALUES (${username}, ${ttdType || 'digital'}, ${toSave}, ${tanggal})
        ON CONFLICT (username) DO UPDATE SET
          ttd_type = EXCLUDED.ttd_type,
          ttd_data = EXCLUDED.ttd_data,
          tanggal = EXCLUDED.tanggal,
          updated_at = now()
      `;
      return res.status(200).json({ success: true, driveWarning: warning });
    }

    /* ================= DELETE ================= */
    if (req.method === 'DELETE') {
      if (qNama !== undefined) {
        const namaKey = normalizeNama(qNama);
        if (!namaKey) return res.status(400).json({ success: false, message: 'nama wajib diisi.' });
        await sql`DELETE FROM pemilik_signatures WHERE nama_key = ${namaKey}`;
        return res.status(200).json({ success: true });
      }
      if (!qUsername) return res.status(400).json({ success: false, message: 'username wajib diisi.' });
      await sql`DELETE FROM profile_signatures WHERE username = ${qUsername}`;
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Signature API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
