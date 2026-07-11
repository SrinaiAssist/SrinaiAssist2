// api/login.js
// POST { username, password } -> { success, message?, role? }
//   Menggantikan fungsi loginUser() yang dulu baca localStorage langsung.
//   Setiap login berhasil juga dicatat ke login_logs + accounts.last_login.
//
// GET  /api/login                    -> ringkasan log login semua akun
//                                        (last_login, jumlah login) — dipakai
//                                        fitur admin "Log Login".
// GET  /api/login?username=X         -> riwayat login satu akun (terbaru dulu)
//
// GET & POST digabung di 1 file supaya tidak menambah jumlah serverless
// function (limit slot di Vercel).

const { sql } = require('../lib/db');
const bcrypt = require('bcryptjs');

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return handleGetLogs(req, res);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  }

  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username dan password wajib diisi.' });
    }

    const rows = await sql`
      SELECT username, password_hash, role, status
      FROM accounts
      WHERE username = ${username.trim()}
    `;

    const account = rows[0];

    if (!account) {
      return res.status(200).json({ success: false, message: 'Akun tidak ditemukan.' });
    }

    if (account.status !== 'Aktif') {
      return res.status(200).json({ success: false, message: 'Akun belum diaktifkan Administrator.' });
    }

    const passwordMatch = await bcrypt.compare(password, account.password_hash);

    if (!passwordMatch) {
      return res.status(200).json({ success: false, message: 'Password salah.' });
    }

    // Password benar. Catat log login (jangan sampai gagal-catat menggagalkan login).
    try {
      const userAgent = (req.headers && req.headers['user-agent']) || null;
      await sql`INSERT INTO login_logs (username, user_agent) VALUES (${account.username}, ${userAgent})`;
      await sql`UPDATE accounts SET last_login = now() WHERE username = ${account.username}`;
    } catch (logErr) {
      console.error('Gagal mencatat log login:', logErr);
    }

    // Kita TIDAK mengirim password_hash ke client.
    return res.status(200).json({
      success: true,
      username: account.username,
      role: account.role,
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};

async function handleGetLogs(req, res) {
  try {
    const { username, limit } = req.query || {};

    if (username) {
      const lim = Math.min(parseInt(limit, 10) || 50, 200);
      const rows = await sql`
        SELECT login_at, user_agent
        FROM login_logs
        WHERE username = ${username}
        ORDER BY login_at DESC
        LIMIT ${lim}
      `;
      return res.status(200).json({ success: true, username, history: rows });
    }

    const rows = await sql`
      SELECT
        a.username,
        a.role,
        a.status,
        a.last_login,
        COUNT(l.id)::int AS login_count
      FROM accounts a
      LEFT JOIN login_logs l ON l.username = a.username
      GROUP BY a.username, a.role, a.status, a.last_login
      ORDER BY a.last_login DESC NULLS LAST, a.username ASC
    `;
    return res.status(200).json({ success: true, accounts: rows });
  } catch (err) {
    console.error('Login-logs error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
}
