// lib/activityLog.js
// Helper bersama untuk mencatat aktivitas perubahan (tambah/edit/hapus) ke
// tabel activity_logs. Dipakai oleh api/tegakan.js & api/accounts.js.
//
// SENGAJA tidak pernah melempar error ke pemanggil -- gagal mencatat log
// tidak boleh menggagalkan operasi utama (sama seperti pola login_logs di
// api/login.js).

const { sql } = require('./db');

/**
 * @param {object} p
 * @param {string} p.username     - pelaku aktivitas (actor)
 * @param {string} p.action       - 'create' | 'update' | 'delete' | 'reset_password'
 * @param {string} p.entityType   - 'tegakan' | 'akun'
 * @param {string} [p.entityId]   - id/username entitas yang terdampak
 * @param {string} [p.detail]     - ringkasan singkat, human-readable
 */
async function logActivity({ username, action, entityType, entityId, detail }) {
  try {
    await sql`
      INSERT INTO activity_logs (username, action, entity_type, entity_id, detail)
      VALUES (${username || 'unknown'}, ${action}, ${entityType}, ${entityId != null ? String(entityId) : null}, ${detail || null})
    `;
  } catch (err) {
    console.error('Gagal mencatat activity log:', err);
  }
}

module.exports = { logActivity };
