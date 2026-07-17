// api/jalur.js
//
// GET    /api/jalur              -> list semua jalur (+ jumlah tower & span)
// POST   /api/jalur               -> tambah jalur baru
//        body: { id, code, label, aktif, penghantar }
// PUT    /api/jalur                -> update jalur
//        body: { id, fields:{...} }
// DELETE /api/jalur?id=..          -> hapus jalur (cascade ke tower & span)

const { sql } = require('../lib/db');
const { isBotRequestValid } = require('../lib/bot-auth');

module.exports = async (req, res) => {
  try {
    const { id: qId } = req.query || {};

    if (req.method !== 'GET' && !isBotRequestValid(req)) {
      return res.status(401).json({ success: false, message: 'Bot key tidak valid.' });
    }

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT
          j.id, j.code, j.label, j.aktif, j.penghantar,
          (SELECT COUNT(*) FROM tower t WHERE t.jalur_id = j.id) AS tower_count,
          (SELECT COUNT(*) FROM span  s WHERE s.jalur_id = j.id) AS span_count
        FROM jalur j
        ORDER BY j.code
      `;
      return res.status(200).json({ success: true, jalur: rows });
    }

    if (req.method === 'POST') {
      const { id, code, label, aktif, penghantar } = req.body || {};
      if (!id || !code || !label) {
        return res.status(400).json({ success: false, message: 'id, code, dan label wajib diisi.' });
      }

      const existing = await sql`SELECT id FROM jalur WHERE id = ${id}`;
      if (existing.length > 0) {
        return res.status(200).json({ success: false, message: 'Jalur dengan id tersebut sudah ada.' });
      }

      await sql`
        INSERT INTO jalur (id, code, label, aktif, penghantar)
        VALUES (${id}, ${code}, ${label}, ${aktif !== false}, ${penghantar || ''})
      `;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT') {
      const { id, fields } = req.body || {};
      if (!id || !fields) {
        return res.status(400).json({ success: false, message: 'id dan fields wajib diisi.' });
      }

      await sql`
        UPDATE jalur SET
          code       = COALESCE(${fields.code ?? null}, code),
          label      = COALESCE(${fields.label ?? null}, label),
          aktif      = COALESCE(${fields.aktif ?? null}, aktif),
          penghantar = COALESCE(${fields.penghantar ?? null}, penghantar)
        WHERE id = ${id}
      `;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (!qId) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
      await sql`DELETE FROM jalur WHERE id = ${qId}`;
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Jalur API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
