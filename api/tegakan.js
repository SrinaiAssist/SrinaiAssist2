// api/tegakan.js
//
// GET    /api/tegakan?spanId=..            -> list tegakan untuk satu span
// GET    /api/tegakan                      -> list SEMUA tegakan (untuk sinkron massal)
// GET    /api/tegakan?includeTtd=false     -> sama seperti di atas, TAPI skip resolve
//                                              foto TTD dari Google Drive (ttdData jadi
//                                              true/null saja) -- jauh lebih cepat &
//                                              hemat kuota Drive, dipakai saat cuma
//                                              butuh metadata (mis. context AI chat).
// POST   /api/tegakan                      -> tambah tegakan baru
//        body: { spanId, nama, idTegakan, pemilikNama, pemilikAlamat,
//                pemilikTelp, petugas, ttdType, ttdData, tanggal }
// PUT    /api/tegakan                      -> edit tegakan (partial)
//        body: { id, fields: { nama, idTegakan, pemilikNama, pemilikAlamat,
//                pemilikTelp, ttdType, ttdData, tanggal }, actor }
// DELETE /api/tegakan?id=..&actor=..       -> hapus satu tegakan
//
// "actor"/"petugas" dipakai untuk mencatat siapa yang melakukan perubahan
// ke tabel activity_logs (lihat lib/activityLog.js) -- untuk fitur admin
// Log Aktivitas.
//
// PENTING (kuota transfer Neon): sama seperti api/signature.js, kolom
// ttd_data di sini SEKARANG tidak lagi menyimpan base64 mentah langsung ke
// Postgres. Kalau ttdData berupa base64 data URL, file diupload dulu ke
// Google Drive (lib/googleDrive.js) dan yang disimpan di kolom ttd_data
// cuma referensi kecil "drive:<fileId>". Saat dibaca (GET), referensi itu
// otomatis di-download dari Drive lalu dikonversi balik jadi base64 SEBELUM
// dikirim ke browser -- supaya frontend yang masih pakai
// doc.addImage(ttdData, ...) TIDAK PERLU diubah sama sekali.
// Kalau kredensial Drive belum diset / upload gagal, fallback: simpan
// base64 apa adanya seperti semula supaya fitur tetap jalan.

const { sql } = require('../lib/db');
const { uploadPhotoToDrive, downloadFileAsDataUrl } = require('../lib/googleDrive');
const { logActivity } = require('../lib/activityLog');

const DRIVE_PREFIX = 'drive:';

// mimeType TTD selalu salah satu dari 2: "foto" (upload foto kertas TTD,
// biasanya JPEG) atau "digital" (hasil gambar di canvas, PNG).
function mimeTypeFor(ttdType) {
  return ttdType === 'foto' ? 'image/jpeg' : 'image/png';
}

// Upload ttdData (data URL base64) ke Drive kalau perlu. Return { toSave, warning }
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
    console.error('Upload TTD tegakan ke Drive gagal, fallback simpan base64:', driveErr.message);
    return { toSave: ttdData, warning: driveErr.message };
  }
}

// Baca ttd_data dari DB dan ubah jadi base64 data URL kalau berupa referensi Drive.
async function resolveTtdDataForRead(ttdDataRaw, ttdType) {
  if (!ttdDataRaw || typeof ttdDataRaw !== 'string' || !ttdDataRaw.startsWith(DRIVE_PREFIX)) {
    return ttdDataRaw || null;
  }
  const fileId = ttdDataRaw.slice(DRIVE_PREFIX.length);
  try {
    return await downloadFileAsDataUrl(fileId, mimeTypeFor(ttdType));
  } catch (err) {
    console.error('Download TTD tegakan dari Drive gagal:', err.message);
    return null; // biar frontend anggap TTD belum ada, daripada error total
  }
}

function mapRow(r) {
  return {
    id: Number(r.id),
    spanId: r.spanId,
    nama: r.nama,
    idTegakan: r.idTegakan,
    pemilikNama: r.pemilikNama,
    pemilikAlamat: r.pemilikAlamat,
    pemilikTelp: r.pemilikTelp,
    petugas: r.petugas,
    ttdType: r.ttdType,
    ttdData: r.ttdData,
    tanggal: r.tanggal,
    updatedAt: r.updatedAt,
  };
}

module.exports = async (req, res) => {
  try {
    const { spanId: qSpanId, id: qId, actor: qActor, includeTtd: qIncludeTtd, meta: qMeta } = req.query || {};

    // Mode ringan: dipakai sync.js (syncAll) buat cek span MANA yang
    // datanya berubah sejak sync terakhir, TANPA tarik data lengkap semua
    // span dulu (sebelumnya: 1 tegakan berubah = semua metadata tegakan di
    // SEMUA span ikut ke-transfer ulang -- ini penyebab boros Fast Origin
    // Transfer). Payload-nya cuma angka per span, jauh lebih kecil.
    if (req.method === 'GET' && qMeta === '1') {
      const rows = await sql`
        SELECT span_id AS "spanId", COUNT(*)::int AS "count", MAX(updated_at) AS "maxUpdatedAt"
        FROM tegakan
        GROUP BY span_id
      `;
      return res.status(200).json({ success: true, meta: rows });
    }

    if (req.method === 'GET') {
      // includeTtd=false -> skip resolve foto TTD dari Google Drive (hemat
      // waktu & kuota Drive API) untuk kasus yang cuma butuh metadata,
      // misal context AI chat yang tidak menampilkan gambar TTD sama sekali.
      const includeTtd = qIncludeTtd !== 'false' && qIncludeTtd !== '0';

      // Tanpa spanId -> ambil SEMUA tegakan (dipakai syncAll() untuk
      // sinkron massal sekali jalan, dikelompokkan per span di client).
      const rows = qSpanId
        ? await sql`
            SELECT
              id, span_id AS "spanId", nama, id_tegakan AS "idTegakan",
              pemilik_nama AS "pemilikNama", pemilik_alamat AS "pemilikAlamat",
              pemilik_telp AS "pemilikTelp", petugas,
              ttd_type AS "ttdType", ttd_data AS "ttdData", tanggal,
              updated_at AS "updatedAt"
            FROM tegakan
            WHERE span_id = ${qSpanId}
            ORDER BY created_at ASC
          `
        : await sql`
            SELECT
              id, span_id AS "spanId", nama, id_tegakan AS "idTegakan",
              pemilik_nama AS "pemilikNama", pemilik_alamat AS "pemilikAlamat",
              pemilik_telp AS "pemilikTelp", petugas,
              ttd_type AS "ttdType", ttd_data AS "ttdData", tanggal,
              updated_at AS "updatedAt"
            FROM tegakan
            ORDER BY created_at ASC
          `;

      if (!includeTtd) {
        const stripped = rows.map(r => ({ ...r, ttdData: r.ttdData ? true : null }));
        return res.status(200).json({ success: true, tegakan: stripped.map(mapRow) });
      }

      // Resolve semua referensi Drive jadi base64 sebelum dikirim ke browser.
      const resolved = await Promise.all(
        rows.map(async (r) => ({
          ...r,
          ttdData: await resolveTtdDataForRead(r.ttdData, r.ttdType),
        }))
      );

      return res.status(200).json({ success: true, tegakan: resolved.map(mapRow) });
    }

    if (req.method === 'POST') {
      const {
        spanId, nama, idTegakan, pemilikNama, pemilikAlamat,
        pemilikTelp, petugas, ttdType, ttdData, tanggal,
      } = req.body || {};

      if (!spanId || !nama || !nama.trim() || !petugas) {
        return res.status(400).json({ success: false, message: 'spanId, nama, dan petugas wajib diisi.' });
      }

      const { toSave: ttdDataToSave, warning } = await resolveTtdDataForSave(
        ttdData, ttdType || 'digital', `tegakan-${spanId}`
      );

      const id = Date.now();
      await sql`
        INSERT INTO tegakan (
          id, span_id, nama, id_tegakan, pemilik_nama, pemilik_alamat,
          pemilik_telp, petugas, ttd_type, ttd_data, tanggal
        ) VALUES (
          ${id}, ${spanId}, ${nama}, ${idTegakan || null}, ${pemilikNama || null}, ${pemilikAlamat || null},
          ${pemilikTelp || null}, ${petugas}, ${ttdType || null}, ${ttdDataToSave}, ${tanggal || null}
        )
      `;
      logActivity({
        username: petugas, action: 'create', entityType: 'tegakan', entityId: id,
        detail: `Menambahkan tegakan "${nama}"${pemilikNama ? ` (pemilik: ${pemilikNama})` : ''} di span ${spanId}`,
      });
      return res.status(200).json({ success: true, id, driveWarning: warning });
    }

    if (req.method === 'PUT') {
      const { id, fields, actor } = req.body || {};
      if (!id || !fields) {
        return res.status(400).json({ success: false, message: 'id dan fields wajib diisi.' });
      }

      const existingRow = await sql`SELECT span_id, nama FROM tegakan WHERE id = ${id}`;
      const spanIdForName = existingRow[0] ? existingRow[0].span_id : 'unknown';

      let ttdDataToSave = fields.ttdData ?? null;
      let warning = null;
      if (fields.ttdData !== undefined) {
        const resolved = await resolveTtdDataForSave(
          fields.ttdData, fields.ttdType || 'digital', `tegakan-${spanIdForName}`
        );
        ttdDataToSave = resolved.toSave;
        warning = resolved.warning;
      }

      await sql`
        UPDATE tegakan SET
          nama           = COALESCE(${fields.nama ?? null}, nama),
          id_tegakan     = COALESCE(${fields.idTegakan ?? null}, id_tegakan),
          pemilik_nama   = COALESCE(${fields.pemilikNama ?? null}, pemilik_nama),
          pemilik_alamat = COALESCE(${fields.pemilikAlamat ?? null}, pemilik_alamat),
          pemilik_telp   = COALESCE(${fields.pemilikTelp ?? null}, pemilik_telp),
          ttd_type       = COALESCE(${fields.ttdType ?? null}, ttd_type),
          ttd_data       = COALESCE(${ttdDataToSave}, ttd_data),
          tanggal        = COALESCE(${fields.tanggal ?? null}, tanggal),
          updated_at     = now()
        WHERE id = ${id}
      `;
      const namaForLog = fields.nama || (existingRow[0] ? existingRow[0].nama : '') || `#${id}`;
      logActivity({
        username: actor, action: 'update', entityType: 'tegakan', entityId: id,
        detail: `Mengubah data tegakan "${namaForLog}"`,
      });
      return res.status(200).json({ success: true, driveWarning: warning });
    }

    if (req.method === 'DELETE') {
      if (!qId) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
      const existingRow = await sql`SELECT nama, span_id FROM tegakan WHERE id = ${qId}`;
      await sql`DELETE FROM tegakan WHERE id = ${qId}`;
      const row = existingRow[0];
      logActivity({
        username: qActor, action: 'delete', entityType: 'tegakan', entityId: qId,
        detail: row ? `Menghapus tegakan "${row.nama}" di span ${row.span_id}` : `Menghapus tegakan #${qId}`,
      });
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Tegakan API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
