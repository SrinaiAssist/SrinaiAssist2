// lib/db.js
// Koneksi ke Neon Postgres, dipakai oleh semua serverless function di /api.
// Menggunakan driver HTTP @neondatabase/serverless (cocok untuk serverless,
// tidak perlu connection pooling manual seperti pg biasa).
//
// CATATAN: integrasi Neon <-> Vercel (lewat Marketplace/Storage) otomatis
// membuat beberapa env var sekaligus: POSTGRES_URL, PGHOST, PGUSER, dst.
// Kita pakai POSTGRES_URL karena itu sudah berupa connection string utuh.
// DATABASE_URL dipertahankan sebagai fallback untuk dev lokal (lihat .env.example).

const neondb = require('@neondatabase/serverless');

// Package ini adalah ESM yang di-bundle; tergantung versi Node/bundler di
// Vercel, hasil require() bisa berupa { neon } langsung ATAU { default: { neon } }.
// Baris ini mengambil mana saja yang benar-benar berupa function, supaya
// tidak pernah terjadi "sql is not a function".
const neon = neondb.neon || (neondb.default && neondb.default.neon);

if (typeof neon !== 'function') {
  throw new Error(
      'Gagal memuat fungsi neon() dari @neondatabase/serverless. ' +
          'Cek versi package ini di package.json.'
            );
            }

            const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

            if (!connectionString) {
              console.error('POSTGRES_URL / DATABASE_URL belum tersedia di environment variables.');
              }

              const sql = neon(connectionString);

              module.exports = { sql };