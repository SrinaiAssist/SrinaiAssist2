// api/chat.js
//
// GET    /api/chat?limit=50                -> ambil pesan terbaru (urut lama->baru)
// GET    /api/chat?sinceId=169900000       -> ambil pesan BARU saja (id > sinceId),
//                                              dipakai polling ringan chat.html supaya
//                                              tidak narik ulang seluruh history tiap
//                                              kali polling (hemat Fast Origin Transfer)
// POST   /api/chat                         -> kirim pesan baru
//        body: { username, text, foto, meta }
//        meta (opsional) untuk pesan non-teks biasa, mis. kirim koordinat tower:
//          { kind:"koordinat", towerId, towerLabel, jalur, latitude, longitude, akurasiMeter }
// DELETE /api/chat?id=..                   -> hapus satu pesan (Admin only, dicek di client)
// DELETE /api/chat?all=1                   -> hapus seluruh chat (Admin only, dicek di client)
//
// PENTING (kuota transfer Neon): kolom foto (chat_messages.foto) sekarang
// TIDAK lagi menyimpan base64 mentah langsung ke Postgres. Kalau foto yang
// dikirim berupa base64 data URL, file diupload dulu ke Google Drive
// (lib/googleDrive.js) dan yang disimpan di kolom foto cuma referensi kecil
// "drive:<fileId>". Saat dibaca (GET), referensi itu otomatis di-download
// dari Drive lalu dikonversi balik jadi base64 SEBELUM dikirim ke browser --
// supaya frontend yang masih pakai <img src="..."> dengan base64 langsung
// TIDAK PERLU diubah. Kalau kredensial Drive belum diset / upload gagal,
// fallback: simpan base64 apa adanya seperti semula supaya fitur tetap jalan.

const { sql } = require('../lib/db');
const { uploadPhotoToDrive, downloadFileAsDataUrl } = require('../lib/googleDrive');
const { sendPushToAllUsers } = require('../lib/pushHelper');

const DRIVE_PREFIX = 'drive:';

async function resolveFotoForSave(foto, fileNamePrefix) {
  if (!foto || typeof foto !== 'string' || !foto.startsWith('data:')) {
    return { toSave: foto || null, warning: null };
  }
  try {
    const uploaded = await uploadPhotoToDrive(foto, `${fileNamePrefix}-${Date.now()}.jpg`);
    return { toSave: `${DRIVE_PREFIX}${uploaded.fileId}`, warning: null };
  } catch (driveErr) {
    console.error('Upload foto chat ke Drive gagal, fallback simpan base64:', driveErr.message);
    return { toSave: foto, warning: driveErr.message };
  }
}

async function resolveFotoForRead(fotoRaw) {
  if (!fotoRaw || typeof fotoRaw !== 'string' || !fotoRaw.startsWith(DRIVE_PREFIX)) {
    return fotoRaw || null;
  }
  const fileId = fotoRaw.slice(DRIVE_PREFIX.length);
  try {
    return await downloadFileAsDataUrl(fileId, 'image/jpeg');
  } catch (err) {
    console.error('Download foto chat dari Drive gagal:', err.message);
    return null;
  }
}

module.exports = async (req, res) => {
  try {
    const { limit: qLimit, id: qId, all: qAll, sinceId: qSinceId } = req.query || {};

    if (req.method === 'GET') {
      // Mode polling ringan: hanya pesan dengan id > sinceId. Dipakai chat.html
      // tiap 5 detik supaya kalau tidak ada pesan baru, respons hampir kosong
      // (bukan narik ulang ratusan pesan tiap kali).
      if (qSinceId) {
        const sinceId = parseInt(qSinceId, 10) || 0;
        const rows = await sql`
          SELECT id, username, text, foto, meta, created_at AS "createdAt"
          FROM chat_messages
          WHERE id > ${sinceId}
          ORDER BY created_at ASC
          LIMIT 300
        `;
        const resolved = await Promise.all(
          rows.map(async (r) => ({ ...r, foto: await resolveFotoForRead(r.foto) }))
        );
        return res.status(200).json({ success: true, messages: resolved });
      }

      const limit = Math.min(parseInt(qLimit) || 100, 300);
      const rows = await sql`
        SELECT id, username, text, foto, meta, created_at AS "createdAt"
        FROM chat_messages
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      const resolved = await Promise.all(
        rows.map(async (r) => ({ ...r, foto: await resolveFotoForRead(r.foto) }))
      );
      return res.status(200).json({ success: true, messages: resolved.reverse() });
    }

    if (req.method === 'POST') {
      const { username, text, foto, meta } = req.body || {};
      if (!username || ((!text || !text.trim()) && !foto && !meta)) {
        return res.status(400).json({ success: false, message: 'username dan salah satu dari text/foto/meta wajib diisi.' });
      }

      const { toSave: fotoToSave, warning } = await resolveFotoForSave(foto, `chat-${username}`);

      const id = Date.now();
      await sql`
        INSERT INTO chat_messages (id, username, text, foto, meta)
        VALUES (${id}, ${username}, ${text || ''}, ${fotoToSave}, ${meta ? JSON.stringify(meta) : null})
      `;
      res.status(200).json({ success: true, id, driveWarning: warning });

      sendPushToAllUsers(
        {
          title: `Chat baru dari ${username}`,
          body: text && text.trim() ? text.trim().slice(0, 120) : (meta ? 'Mengirim data/koordinat' : 'Mengirim foto'),
          data: { type: 'chat' },
        },
        username
      ).catch((err) => console.error('Gagal kirim push chat:', err.message));
      return;
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
