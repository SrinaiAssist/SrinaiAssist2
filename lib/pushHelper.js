// lib/pushHelper.js
//
// Helper buat kirim push notification ke satu/banyak user, dipakai dari
// api/chat.js (chat baru), api/settings.js (artikel baru), api/tower.js
// & api/span.js (data diubah admin). Gagal kirim push TIDAK BOLEH bikin
// aksi utama (kirim chat / simpan tower / dst) gagal -- selalu dibungkus
// try/catch di sisi pemanggil dan diabaikan kalau error.

const { sql } = require('./db');
const { sendFcmMessage } = require('./firebaseAdmin');

// Kirim ke daftar username tertentu (unik-kan dulu, exclude opsional --
// biasanya exclude si pengirim sendiri).
async function sendPushToUsers(usernames, { title, body, data, sound }, excludeUsername) {
  const targets = [...new Set(usernames)].filter((u) => u && u !== excludeUsername);
  if (targets.length === 0) return;

  const tokenRows = await sql`
    SELECT id, username, token FROM fcm_tokens WHERE username = ANY(${targets})
  `;
  if (tokenRows.length === 0) return;

  const deadTokenIds = [];
  await Promise.all(
    tokenRows.map(async (row) => {
      try {
        const result = await sendFcmMessage(row.token, { title, body, data, sound });
        if (!result.ok && result.invalidToken) deadTokenIds.push(row.id);
      } catch (err) {
        console.error(`Gagal kirim push ke ${row.username}:`, err.message);
      }
    })
  );

  if (deadTokenIds.length > 0) {
    await sql`DELETE FROM fcm_tokens WHERE id = ANY(${deadTokenIds})`;
  }
}

// Kirim ke semua user terdaftar (dipakai untuk artikel baru -- semua role
// bisa baca, jadi semua user diberi tahu).
async function sendPushToAllUsers(payload, excludeUsername) {
  const rows = await sql`SELECT username FROM accounts WHERE status = 'Aktif'`;
  await sendPushToUsers(rows.map((r) => r.username), payload, excludeUsername);
}

// Kirim ke user yang "memiliki" sebuah jalur -- yaitu profiles.jalur_id
// cocok DENGAN jalur tower/span yang diedit, PLUS admin & klw (yang selalu
// unrestricted-access ke semua jalur, lihat js/auth.js isAdmin()/isKLW()).
async function sendPushToJalurOwners(jalurId, payload, excludeUsername) {
  if (!jalurId) return;
  const rows = await sql`
    SELECT a.username
    FROM accounts a
    JOIN profiles p ON p.username = a.username
    WHERE p.jalur_id = ${jalurId} OR a.role IN ('admin', 'klw')
  `;
  await sendPushToUsers(rows.map((r) => r.username), payload, excludeUsername);
}

module.exports = { sendPushToUsers, sendPushToAllUsers, sendPushToJalurOwners };
