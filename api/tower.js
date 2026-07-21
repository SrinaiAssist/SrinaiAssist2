// api/tower.js
//
// GET    /api/tower?jalurId=..            -> list tower (filter opsional by jalurId)
// POST   /api/tower                        -> tambah satu tower
//        body: { jalurId, nomor }
// POST   /api/tower?action=generate        -> generate massal (dari, sampai)
//        body: { jalurId, dari, sampai }
// PUT    /api/tower                        -> update satu tower
//        body: { id, fields:{ jenis, isolator, renceng, status,
//                              latitude, longitude, akurasiMeter, koordinatBy } }
// DELETE /api/tower?id=..                  -> hapus satu tower

const { sql } = require('../lib/db');

function nextId(prefix, existingIds) {
  let maxNum = 0;
  existingIds.forEach((existingId) => {
    const m = existingId.match(new RegExp(`^${prefix}_(\\d+)$`));
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  });
  return `${prefix}_${String(maxNum + 1).padStart(3, '0')}`;
}

module.exports = async (req, res) => {
  try {
    const { jalurId: qJalurId, id: qId, action } = req.query || {};

    if (req.method === 'GET') {
      const rows = qJalurId
        ? await sql`SELECT * FROM tower WHERE jalur_id = ${qJalurId} ORDER BY nomor`
        : await sql`SELECT * FROM tower ORDER BY jalur_id, nomor`;
      return res.status(200).json({ success: true, tower: rows });
    }

    if (req.method === 'POST' && action === 'generate') {
      const { jalurId, dari, sampai } = req.body || {};
      const start = parseInt(dari, 10);
      const end = parseInt(sampai, 10);

      if (!jalurId || isNaN(start) || isNaN(end) || end < start) {
        return res.status(400).json({ success: false, message: 'Parameter generate tidak valid.' });
      }

      // Cek nomor yang sudah ada di jalur ini (untuk skip duplikat)
      const jalurRows = await sql`SELECT nomor FROM tower WHERE jalur_id = ${jalurId}`;
      const existingNomors = new Set(jalurRows.map((r) => r.nomor));

      // PENTING: ambil semua ID dari seluruh tabel tower (lintas jalur)
      // supaya nextId tidak menghasilkan ID yang sudah dipakai jalur lain
      const allIds = (await sql`SELECT id FROM tower`).map((r) => r.id);

      let added = 0;
      for (let n = start; n <= end; n++) {
        if (existingNomors.has(n)) continue;
        const newId = nextId('tower', allIds);
        allIds.push(newId); // track ID baru agar iterasi berikutnya tidak conflict
        await sql`
          INSERT INTO tower (id, jalur_id, nomor)
          VALUES (${newId}, ${jalurId}, ${n})
        `;
        added++;
      }

      return res.status(200).json({ success: true, added });
    }

    if (req.method === 'POST') {
      const { jalurId, nomor } = req.body || {};
      const nomorInt = parseInt(nomor, 10);
      if (!jalurId || isNaN(nomorInt) || nomorInt < 1) {
        return res.status(400).json({ success: false, message: 'jalurId dan nomor (>=1) wajib diisi.' });
      }

      const existing = await sql`SELECT id FROM tower WHERE jalur_id = ${jalurId} AND nomor = ${nomorInt}`;
      if (existing.length > 0) {
        return res.status(200).json({ success: false, message: `Tower nomor ${nomorInt} sudah ada di jalur ini.` });
      }

      const existingIds = (await sql`SELECT id FROM tower`).map((r) => r.id);
      const newId = nextId('tower', existingIds);

      await sql`
        INSERT INTO tower (id, jalur_id, nomor)
        VALUES (${newId}, ${jalurId}, ${nomorInt})
      `;
      return res.status(200).json({ success: true, id: newId });
    }

    if (req.method === 'PUT') {
      const { id, fields } = req.body || {};
      if (!id || !fields) {
        return res.status(400).json({ success: false, message: 'id dan fields wajib diisi.' });
      }

      // Hapus koordinat: butuh jalur eksplisit (bukan lewat COALESCE) karena
      // COALESCE tidak bisa dipakai untuk sengaja meng-NULL-kan kolom.
      if (fields.clearKoordinat === true) {
        await sql`
          UPDATE tower SET
            latitude = NULL, longitude = NULL, akurasi_meter = NULL,
            koordinat_by = NULL, koordinat_at = NULL
          WHERE id = ${id}
        `;
        return res.status(200).json({ success: true });
      }

      await sql`
        UPDATE tower SET
          jenis         = COALESCE(${fields.jenis ?? null}, jenis),
          isolator      = COALESCE(${fields.isolator ?? null}, isolator),
          renceng       = COALESCE(${fields.renceng ?? null}, renceng),
          status        = COALESCE(${fields.status ?? null}, status),
          latitude      = COALESCE(${fields.latitude ?? null}, latitude),
          longitude     = COALESCE(${fields.longitude ?? null}, longitude),
          akurasi_meter = COALESCE(${fields.akurasiMeter ?? null}, akurasi_meter),
          koordinat_by  = COALESCE(${fields.koordinatBy ?? null}, koordinat_by),
          koordinat_at  = CASE WHEN ${fields.latitude ?? null}::double precision IS NOT NULL
                                 AND ${fields.longitude ?? null}::double precision IS NOT NULL
                               THEN now() ELSE koordinat_at END
        WHERE id = ${id}
      `;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (!qId) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
      await sql`DELETE FROM tower WHERE id = ${qId}`;
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Tower API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
