// api/catatan-span.js
//
// GET    /api/catatan-span?spanId=..       -> list catatan untuk satu span
// GET    /api/catatan-span?towerId=..      -> list catatan untuk satu tower
// GET    /api/catatan-span?evidence=true   -> list SEMUA foto evidence (yang sudah naik ke Google Drive),
//                                              dipakai halaman foto-eviden.html
// POST   /api/catatan-span                 -> tambah catatan baru
//        body: { spanId ATAU towerId, username, catatan, foto, tegakanId, tegakanNama, tegakanIdTegakan }
//        Kalau field foto berupa base64 data URL ("data:image/..;base64,.."),
//        foto otomatis diupload ke Google Drive akun admin (lihat lib/googleDrive.js)
//        dan yang disimpan di kolom foto hanya link thumbnail-nya (bukan base64-nya).
//        Kalau kredensial Drive belum diset, fallback: foto disimpan apa adanya (base64) di DB seperti sebelumnya.
// PUT    /api/catatan-span                 -> edit isi catatan
//        body: { id, catatan, tegakanId, tegakanNama, tegakanIdTegakan }
// DELETE /api/catatan-span?id=..           -> hapus satu catatan

const { sql } = require('../lib/db');
const { uploadPhotoToDrive } = require('../lib/googleDrive');
const { isBotRequestValid } = require('../lib/bot-auth');

module.exports = async (req, res) => {
  try {
    const { spanId: qSpanId, towerId: qTowerId, id: qId, evidence: qEvidence } = req.query || {};

    if (req.method !== 'GET' && !isBotRequestValid(req)) {
      return res.status(401).json({ success: false, message: 'Bot key tidak valid.' });
    }

    if (req.method === 'GET') {
      if (qEvidence === 'true' || qEvidence === '1') {
        const rows = await sql`
          SELECT
            id, span_id AS "spanId", tower_id AS "towerId", username, catatan, foto, foto_file_id AS "fotoFileId", created_at AS "createdAt"
          FROM catatan_span
          WHERE foto_file_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 300
        `;
        return res.status(200).json({ success: true, catatan: rows });
      }

      if (!qSpanId && !qTowerId) {
        return res.status(400).json({ success: false, message: 'spanId atau towerId wajib diisi.' });
      }
      const rows = qTowerId
        ? await sql`
            SELECT
              id, span_id AS "spanId", tower_id AS "towerId", username, catatan, foto, foto_file_id AS "fotoFileId", created_at AS "createdAt",
              tegakan_id AS "tegakanId", tegakan_nama AS "tegakanNama",
              tegakan_id_tegakan AS "tegakanIdTegakan"
            FROM catatan_span
            WHERE tower_id = ${qTowerId}
            ORDER BY created_at DESC
          `
        : await sql`
            SELECT
              id, span_id AS "spanId", tower_id AS "towerId", username, catatan, foto, foto_file_id AS "fotoFileId", created_at AS "createdAt",
              tegakan_id AS "tegakanId", tegakan_nama AS "tegakanNama",
              tegakan_id_tegakan AS "tegakanIdTegakan"
            FROM catatan_span
            WHERE span_id = ${qSpanId}
            ORDER BY created_at DESC
          `;
      return res.status(200).json({ success: true, catatan: rows });
    }

    if (req.method === 'POST') {
      const { spanId, towerId, username, catatan, foto, tegakanId, tegakanNama, tegakanIdTegakan } = req.body || {};
      if ((!spanId && !towerId) || !username || !catatan || !catatan.trim()) {
        return res.status(400).json({ success: false, message: 'spanId/towerId, username, dan catatan wajib diisi.' });
      }

      let fotoToSave = foto || null;
      let fotoFileId = null;
      let driveWarning = null;

      if (foto && typeof foto === 'string' && foto.startsWith('data:image')) {
        try {
          const uploaded = await uploadPhotoToDrive(foto, `${towerId || spanId}-${Date.now()}.jpg`);
          fotoToSave = uploaded.thumbUrl;
          fotoFileId = uploaded.fileId;
        } catch (driveErr) {
          // Kredensial Drive belum diset / upload gagal -> fallback simpan base64 seperti semula
          // supaya fitur catatan tetap jalan walau Drive belum dikonfigurasi.
          console.error('Upload Drive gagal, fallback simpan base64:', driveErr.message);
          driveWarning = driveErr.message;
        }
      }

      const id = Date.now();
      await sql`
        INSERT INTO catatan_span (
          id, span_id, tower_id, username, catatan, foto, foto_file_id,
          tegakan_id, tegakan_nama, tegakan_id_tegakan
        )
        VALUES (
          ${id}, ${spanId || null}, ${towerId || null}, ${username}, ${catatan}, ${fotoToSave}, ${fotoFileId},
          ${tegakanId || null}, ${tegakanNama || null}, ${tegakanIdTegakan || null}
        )
      `;
      return res.status(200).json({ success: true, id, driveWarning });
    }

    if (req.method === 'PUT') {
      const { id, catatan, tegakanId, tegakanNama, tegakanIdTegakan } = req.body || {};
      if (!id || !catatan || !catatan.trim()) {
        return res.status(400).json({ success: false, message: 'id dan catatan wajib diisi.' });
      }
      await sql`
        UPDATE catatan_span SET
          catatan = ${catatan},
          tegakan_id = COALESCE(${tegakanId ?? null}, tegakan_id),
          tegakan_nama = COALESCE(${tegakanNama ?? null}, tegakan_nama),
          tegakan_id_tegakan = COALESCE(${tegakanIdTegakan ?? null}, tegakan_id_tegakan)
        WHERE id = ${id}
      `;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (!qId) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
      await sql`DELETE FROM catatan_span WHERE id = ${qId}`;
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Catatan Span API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
