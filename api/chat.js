// api/chat.js
//
// GET    /api/chat?limit=50                -> ambil pesan terbaru (urut lama->baru)
// POST   /api/chat                         -> kirim pesan baru
//        body: { username, text, foto, meta }
//        meta (opsional) untuk pesan non-teks biasa, mis. kirim koordinat tower:
//          { kind:"koordinat", towerId, towerLabel, jalur, latitude, longitude, akurasiMeter }
// DELETE /api/chat?id=..                   -> hapus satu pesan (Admin only, dicek di client)
// DELETE /api/chat?all=1                   -> hapus seluruh chat (Admin only, dicek di client)

const { sql } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    const { limit: qLimit, id: qId, all: qAll } = req.query || {};

    if (req.method === 'GET') {
      const limit = Math.min(parseInt(qLimit) || 100, 300);
      const rows = await sql`
        SELECT id, username, text, foto, meta, created_at AS "createdAt"
        FROM chat_messages
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return res.status(200).json({ success: true, messages: rows.reverse() });
    }

    if (req.method === 'POST') {
      const { username, text, foto, meta } = req.body || {};
      if (!username || ((!text || !text.trim()) && !foto && !meta)) {
        return res.status(400).json({ success: false, message: 'username dan salah satu dari text/foto/meta wajib diisi.' });
      }

      const id = Date.now();
      await sql`
        INSERT INTO chat_messages (id, username, text, foto, meta)
        VALUES (${id}, ${username}, ${text || ''}, ${foto || null}, ${meta ? JSON.stringify(meta) : null})
      `;
      return res.status(200).json({ success: true, id });
    }

    if (req.method === 'DELETE') {
      if (qAll) {
        await sql`DELETE FROM chat_messages`;
        return res.status(200).json({ success: true });
      }
      if (!qId) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
      await sql`DELETE FROM chat_messages WHERE id = ${qId}`;
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Chat API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
