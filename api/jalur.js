// api/jalur.js
//
// GET    /api/jalur              -> list semua jalur (+ jumlah tower & span + info induk/combine)
// POST   /api/jalur               -> tambah jalur baru
//        body: { id, code, label, aktif, penghantar, parentJalurId }
//        parentJalurId (opsional) -> jadikan jalur ini "jalur combine" dari jalur induk yang sudah ada
// PUT    /api/jalur                -> update jalur
//        body: { id, fields:{ ..., parent_jalur_id } }
//        fields.parent_jalur_id: string id  -> set/ganti jalur induk
//                                 ""         -> lepas dari jalur induk (jadi mandiri lagi)
//                                 tidak dikirim -> tidak diubah
// DELETE /api/jalur?id=..          -> hapus jalur (cascade ke tower & span; anak combine dilepas ke mandiri)

const { sql } = require('../lib/db');
const { isBotRequestValid } = require('../lib/bot-auth');

// Jalur combine dibatasi maksimal 1 tingkat: jalur induk tidak boleh
// sendiri berupa jalur combine (punya parent_jalur_id sendiri).
async function validateParent(parentId, selfId) {
  if (!parentId) return null;
  if (parentId === selfId) {
    return 'Jalur tidak bisa dijadikan induk untuk dirinya sendiri.';
  }
  const rows = await sql`SELECT id, parent_jalur_id FROM jalur WHERE id = ${parentId}`;
  if (rows.length === 0) {
    return 'Jalur induk yang dipilih tidak ditemukan.';
  }
  if (rows[0].parent_jalur_id) {
    return 'Jalur induk tidak boleh berupa jalur combine lain (maksimal 1 tingkat).';
  }
  if (selfId) {
    // Jika jalur ini sendiri sudah punya anak combine, jangan biarkan ia
    // jadi anak dari jalur lain (akan menghasilkan nesting 2 tingkat).
    const children = await sql`SELECT id FROM jalur WHERE parent_jalur_id = ${selfId} LIMIT 1`;
    if (children.length > 0) {
      return 'Jalur ini sudah menjadi induk dari jalur combine lain, tidak bisa sekaligus dijadikan anak.';
    }
  }
  return null;
}

module.exports = async (req, res) => {
  try {
    const { id: qId, meta: qMeta } = req.query || {};

    if (req.method !== 'GET' && !isBotRequestValid(req)) {
      return res.status(401).json({ success: false, message: 'Bot key tidak valid.' });
    }

    // Mode ringan: dipakai sync.js buat cek ada perubahan atau tidak sejak
    // sync terakhir, tanpa tarik seluruh daftar jalur tiap kali Sinkron.
    if (req.method === 'GET' && qMeta === '1') {
      const [row] = await sql`SELECT COUNT(*)::int AS count, MAX(updated_at) AS "maxUpdatedAt" FROM jalur`;
      return res.status(200).json({ success: true, meta: row });
    }

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT
          j.id, j.code, j.label, j.aktif, j.penghantar, j.parent_jalur_id,
          p.label AS parent_label, p.code AS parent_code,
          (SELECT COUNT(*) FROM tower t WHERE t.jalur_id = j.id) AS tower_count,
          (SELECT COUNT(*) FROM span  s WHERE s.jalur_id = j.id) AS span_count
        FROM jalur j
        LEFT JOIN jalur p ON p.id = j.parent_jalur_id
        ORDER BY j.code
      `;
      return res.status(200).json({ success: true, jalur: rows });
    }

    if (req.method === 'POST') {
      const { id, code, label, aktif, penghantar, parentJalurId } = req.body || {};
      if (!id || !code || !label) {
        return res.status(400).json({ success: false, message: 'id, code, dan label wajib diisi.' });
      }

      const existing = await sql`SELECT id FROM jalur WHERE id = ${id}`;
      if (existing.length > 0) {
        return res.status(200).json({ success: false, message: 'Jalur dengan id tersebut sudah ada.' });
      }

      const parentErr = await validateParent(parentJalurId || null, null);
      if (parentErr) {
        return res.status(200).json({ success: false, message: parentErr });
      }

      await sql`
        INSERT INTO jalur (id, code, label, aktif, penghantar, parent_jalur_id)
        VALUES (${id}, ${code}, ${label}, ${aktif !== false}, ${penghantar || ''}, ${parentJalurId || null})
      `;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT') {
      const { id, fields } = req.body || {};
      if (!id || !fields) {
        return res.status(400).json({ success: false, message: 'id dan fields wajib diisi.' });
      }

      const hasParentField = Object.prototype.hasOwnProperty.call(fields, 'parent_jalur_id');
      const parentValue = hasParentField ? (fields.parent_jalur_id || null) : undefined;

      if (hasParentField && parentValue) {
        const parentErr = await validateParent(parentValue, id);
        if (parentErr) {
          return res.status(200).json({ success: false, message: parentErr });
        }
      }

      await sql`
        UPDATE jalur SET
          code       = COALESCE(${fields.code ?? null}, code),
          label      = COALESCE(${fields.label ?? null}, label),
          aktif      = COALESCE(${fields.aktif ?? null}, aktif),
          penghantar = COALESCE(${fields.penghantar ?? null}, penghantar),
          parent_jalur_id = CASE WHEN ${hasParentField} THEN ${parentValue ?? null} ELSE parent_jalur_id END,
          updated_at = now()
        WHERE id = ${id}
      `;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (!qId) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
      // Lepas jalur combine anak dari jalur ini supaya tidak ikut kena
      // cascade delete tower/span-nya sendiri (mereka jalur mandiri).
      await sql`UPDATE jalur SET parent_jalur_id = NULL WHERE parent_jalur_id = ${qId}`;
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
