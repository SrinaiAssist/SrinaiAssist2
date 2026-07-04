// api/span.js
//
// GET    /api/span?jalurId=..            -> list span (filter opsional by jalurId)
// POST   /api/span                        -> tambah satu span
//        body: { jalurId, nomor }
// POST   /api/span?action=generate        -> generate massal (dari, sampai)
//        body: { jalurId, dari, sampai }
// PUT    /api/span                        -> update satu span
//        body: { id, fields:{ spacer, joint, status } }
// DELETE /api/span?id=..                  -> hapus satu span

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
        ? await sql`SELECT * FROM span WHERE jalur_id = ${qJalurId} ORDER BY nomor`
        : await sql`SELECT * FROM span ORDER BY jalur_id, nomor`;
      return res.status(200).json({ success: true, span: rows });
    }

    if (req.method === 'POST' && action === 'generate') {
      const { jalurId, dari, sampai } = req.body || {};
      const start = parseInt(dari, 10);
      const end = parseInt(sampai, 10);

      if (!jalurId || isNaN(start) || isNaN(end) || end < start) {
        return res.status(400).json({ success: false, message: 'Parameter generate tidak valid.' });
      }

      // Cek nomor yang sudah ada di jalur ini (untuk skip duplikat)
      const jalurRows = await sql`SELECT nomor FROM span WHERE jalur_id = ${jalurId}`;
      const existingNomors = new Set(jalurRows.map((r) => r.nomor));

      // PENTING: ambil semua ID dari seluruh tabel span (lintas jalur)
      // supaya nextId tidak menghasilkan ID yang sudah dipakai jalur lain
      const allIds = (await sql`SELECT id FROM span`).map((r) => r.id);

      let added = 0;
      for (let n = start; n <= end; n++) {
        if (existingNomors.has(n)) continue;
        const newId = nextId('span', allIds);
        allIds.push(newId); // track ID baru agar iterasi berikutnya tidak conflict
        await sql`
          INSERT INTO span (id, jalur_id, nomor)
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

      const existing = await sql`SELECT id FROM span WHERE jalur_id = ${jalurId} AND nomor = ${nomorInt}`;
      if (existing.length > 0) {
        return res.status(200).json({ success: false, message: `Span nomor ${nomorInt} sudah ada di jalur ini.` });
      }

      const existingIds = (await sql`SELECT id FROM span`).map((r) => r.id);
      const newId = nextId('span', existingIds);

      await sql`
        INSERT INTO span (id, jalur_id, nomor)
        VALUES (${newId}, ${jalurId}, ${nomorInt})
      `;
      return res.status(200).json({ success: true, id: newId });
    }

    if (req.method === 'PUT') {
      const { id, fields } = req.body || {};
      if (!id || !fields) {
        return res.status(400).json({ success: false, message: 'id dan fields wajib diisi.' });
      }

      await sql`
        UPDATE span SET
          spacer = COALESCE(${fields.spacer ?? null}, spacer),
          joint  = COALESCE(${fields.joint ?? null}, joint),
          status = COALESCE(${fields.status ?? null}, status)
        WHERE id = ${id}
      `;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (!qId) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
      await sql`DELETE FROM span WHERE id = ${qId}`;
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Span API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
