// api/login.js
// POST { username, password } -> { success, message?, role? }
// Menggantikan fungsi loginUser() yang dulu baca localStorage langsung.

const { sql } = require('../lib/db');
const bcrypt = require('bcryptjs');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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

    // Password benar. Kita TIDAK mengirim password_hash ke client.
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
