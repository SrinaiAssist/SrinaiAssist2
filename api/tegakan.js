// api/tegakan.js
//
// GET    /api/tegakan?spanId=..            -> list tegakan untuk satu span
// GET    /api/tegakan                      -> list SEMUA tegakan (untuk sinkron massal)
// POST   /api/tegakan                      -> tambah tegakan baru
//        body: { spanId, nama, idTegakan, pemilikNama, pemilikAlamat,
//                pemilikTelp, petugas, ttdType, ttdData, tanggal }
// PUT    /api/tegakan                      -> edit tegakan (partial)
//        body: { id, fields: { nama, idTegakan, pemilikNama, pemilikAlamat,
//                pemilikTelp, ttdType, ttdData, tanggal } }
// DELETE /api/tegakan?id=..                -> hapus satu tegakan

const { sql } = require('../lib/db');

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
  };
}

module.exports = async (req, res) => {
  try {
    const { spanId: qSpanId, id: qId } = req.query || {};

    if (req.method === 'GET') {
      // Tanpa spanId -> ambil SEMUA tegakan (dipakai syncAll() untuk
      // sinkron massal sekali jalan, dikelompokkan per span di client).
      const rows = qSpanId
        ? await sql`
            SELECT
              id, span_id AS "spanId", nama, id_tegakan AS "idTegakan",
              pemilik_nama AS "pemilikNama", pemilik_alamat AS "pemilikAlamat",
              pemilik_telp AS "pemilikTelp", petugas,
              ttd_type AS "ttdType", ttd_data AS "ttdData", tanggal
            FROM tegakan
            WHERE span_id = ${qSpanId}
            ORDER BY created_at ASC
          `
        : await sql`
            SELECT
              id, span_id AS "spanId", nama, id_tegakan AS "idTegakan",
              pemilik_nama AS "pemilikNama", pemilik_alamat AS "pemilikAlamat",
              pemilik_telp AS "pemilikTelp", petugas,
              ttd_type AS "ttdType", ttd_data AS "ttdData", tanggal
            FROM tegakan
            ORDER BY created_at ASC
          `;
      return res.status(200).json({ success: true, tegakan: rows.map(mapRow) });
    }

    if (req.method === 'POST') {
      const {
        spanId, nama, idTegakan, pemilikNama, pemilikAlamat,
        pemilikTelp, petugas, ttdType, ttdData, tanggal,
      } = req.body || {};

      if (!spanId || !nama || !nama.trim() || !petugas) {
        return res.status(400).json({ success: false, message: 'spanId, nama, dan petugas wajib diisi.' });
      }

      const id = Date.now();
      await sql`
        INSERT INTO tegakan (
          id, span_id, nama, id_tegakan, pemilik_nama, pemilik_alamat,
          pemilik_telp, petugas, ttd_type, ttd_data, tanggal
        ) VALUES (
          ${id}, ${spanId}, ${nama}, ${idTegakan || null}, ${pemilikNama || null}, ${pemilikAlamat || null},
          ${pemilikTelp || null}, ${petugas}, ${ttdType || null}, ${ttdData || null}, ${tanggal || null}
        )
      `;
      return res.status(200).json({ success: true, id });
    }

    if (req.method === 'PUT') {
      const { id, fields } = req.body || {};
      if (!id || !fields) {
        return res.status(400).json({ success: false, message: 'id dan fields wajib diisi.' });
      }

      await sql`
        UPDATE tegakan SET
          nama           = COALESCE(${fields.nama ?? null}, nama),
          id_tegakan     = COALESCE(${fields.idTegakan ?? null}, id_tegakan),
          pemilik_nama   = COALESCE(${fields.pemilikNama ?? null}, pemilik_nama),
          pemilik_alamat = COALESCE(${fields.pemilikAlamat ?? null}, pemilik_alamat),
          pemilik_telp   = COALESCE(${fields.pemilikTelp ?? null}, pemilik_telp),
          ttd_type       = COALESCE(${fields.ttdType ?? null}, ttd_type),
          ttd_data       = COALESCE(${fields.ttdData ?? null}, ttd_data),
          tanggal        = COALESCE(${fields.tanggal ?? null}, tanggal),
          updated_at     = now()
        WHERE id = ${id}
      `;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (!qId) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
      await sql`DELETE FROM tegakan WHERE id = ${qId}`;
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Tegakan API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
