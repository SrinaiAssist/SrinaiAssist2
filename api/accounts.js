// api/accounts.js
//
// GET    /api/accounts            -> list semua akun + profil (tanpa password_hash)
// POST   /api/accounts             -> tambah akun baru
//        body: { username, password, role, profileFields:{...}, actor }
// PUT    /api/accounts             -> update akun/profil (role, status, jabatan, jalur, dst)
//        body: { username, fields:{...}, actor }
// DELETE /api/accounts?username=..&actor=.. -> hapus akun
//
// Endpoint khusus password (dipisah agar jelas niatnya):
// POST   /api/accounts?action=resetPassword   body:{ username, actor }
// POST   /api/accounts?action=changePassword  body:{ username, newPassword }
//
// "actor" = username yang melakukan aksi (dikirim dari js/auth.js lewat
// getCurrentUser()), dicatat ke tabel activity_logs untuk fitur admin
// Log Aktivitas (lihat lib/activityLog.js). changePassword sengaja TIDAK
// dicatat (self-service ganti password sendiri, di luar cakupan fitur ini).
//
// CATATAN: fitur foto profil akun DIHAPUS (Ags 2026) -- sebelumnya boros
// kuota transfer Neon & Vercel FOT karena tiap Sinkron menekan resolve foto
// dari Google Drive. Kolom profiles.foto TETAP ADA di database (tidak
// dihapus/migrasi, supaya aman & reversible), tapi API ini sudah tidak lagi
// membaca maupun menulis ke kolom itu -- selalu dikirim sebagai string
// kosong ke frontend, dan field foto yang dikirim client diabaikan.

const { sql } = require('../lib/db');
const bcrypt = require('bcryptjs');
const { logActivity } = require('../lib/activityLog');

// Password default untuk akun baru & reset password diambil dari environment
// variable (Vercel > Settings > Environment Variables), BUKAN hardcode di
// source code -- supaya tidak kelihatan siapapun yang baca kode di GitHub.
// Fallback di bawah cuma jaga-jaga kalau env belum sempat diset, tapi
// SEBAIKNYA DEFAULT_PASSWORD selalu diisi manual di Vercel.
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || 'Srinai#Ganti2026!';

// Validasi server-side: pastikan yang manggil resetPassword / tambah akun
// BENAR admin, dicek dari tabel accounts langsung (bukan cuma percaya field
// "actor" yang dikirim client, yang selama ini bisa dipalsukan lewat request
// API langsung tanpa lewat UI sama sekali). Pola sama dengan assertIsAdmin
// di api/settings.js.
async function assertIsAdmin(username) {
  if (!username) return false;
  const rows = await sql`SELECT role, status FROM accounts WHERE username = ${username}`;
  return rows[0]?.role === 'admin' && rows[0]?.status === 'Aktif';
}

// includeFoto dipertahankan sebagai parameter (dipanggil dari beberapa
// tempat) tapi sudah tidak berpengaruh -- foto selalu dikirim kosong.
async function listAccounts(filterUsername) {
  const rows = filterUsername
    ? await sql`
        SELECT
          a.username, a.role, a.status,
          p.jabatan, p.jalur, p.jalur_id, p.tower_ids, p.span_ids,
          p.tower_awal, p.tower_akhir, p.wilayah
        FROM accounts a
        LEFT JOIN profiles p ON p.username = a.username
        WHERE a.username = ${filterUsername}
      `
    : await sql`
        SELECT
          a.username, a.role, a.status,
          p.jabatan, p.jalur, p.jalur_id, p.tower_ids, p.span_ids,
          p.tower_awal, p.tower_akhir, p.wilayah
        FROM accounts a
        LEFT JOIN profiles p ON p.username = a.username
        ORDER BY a.username
      `;

  return rows.map((r) => ({ ...r, foto: '' }));
}

module.exports = async (req, res) => {
  try {
    const { action, username: qUsername, actor: qActor } = req.query || {};

    if (req.method === 'GET') {
      const accounts = await listAccounts(qUsername);
      return res.status(200).json({ success: true, accounts });
    }

    if (req.method === 'POST' && action === 'resetPassword') {
      const { username, actor } = req.body || {};
      if (!username) return res.status(400).json({ success: false, message: 'username wajib diisi.' });
      if (!(await assertIsAdmin(actor))) {
        return res.status(403).json({ success: false, message: 'Hanya admin yang boleh reset password.' });
      }

      const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
      const result = await sql`
        UPDATE accounts SET password_hash = ${passwordHash}, must_change_password = true
        WHERE username = ${username}
        RETURNING username
      `;
      if (result.length === 0) return res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });
      logActivity({
        username: actor, action: 'reset_password', entityType: 'akun', entityId: username,
        detail: `Reset password akun "${username}" ke default`,
      });
      return res.status(200).json({ success: true });
    }

    if (req.method === 'POST' && action === 'changePassword') {
      const { username, oldPassword, newPassword } = req.body || {};
      if (!username || !oldPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'username, oldPassword, dan newPassword wajib diisi.' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter.' });
      }

      const rows = await sql`SELECT password_hash FROM accounts WHERE username = ${username}`;
      if (rows.length === 0) return res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });

      const cocok = await bcrypt.compare(oldPassword, rows[0].password_hash);
      if (!cocok) return res.status(401).json({ success: false, message: 'Password lama salah.' });

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await sql`
        UPDATE accounts SET password_hash = ${passwordHash}, must_change_password = false
        WHERE username = ${username}
      `;
      return res.status(200).json({ success: true });
    }

    // Dipanggil dari js/auth.js (startPushRegistration) begitu Capacitor
    // PushNotifications plugin dapat token dari FCM. Upsert supaya token
    // yang sama untuk device yang sama tidak dobel-dobel tersimpan.
    if (req.method === 'POST' && action === 'registerFcmToken') {
      const { username, token, deviceInfo } = req.body || {};
      if (!username || !token) {
        return res.status(400).json({ success: false, message: 'username dan token wajib diisi.' });
      }
      await sql`
        INSERT INTO fcm_tokens (username, token, device_info)
        VALUES (${username}, ${token}, ${deviceInfo || null})
        ON CONFLICT (token) DO UPDATE SET username = ${username}, device_info = ${deviceInfo || null}, updated_at = now()
      `;
      return res.status(200).json({ success: true });
    }

    // Dipanggil saat logout supaya device yang sudah logout tidak lagi
    // menerima push notification atas nama user yang lama.
    if (req.method === 'POST' && action === 'unregisterFcmToken') {
      const { token } = req.body || {};
      if (!token) return res.status(400).json({ success: false, message: 'token wajib diisi.' });
      await sql`DELETE FROM fcm_tokens WHERE token = ${token}`;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'POST') {
      // Tambah akun baru
      const { username, password, role, profileFields, actor } = req.body || {};
      if (!username || !username.trim()) {
        return res.status(400).json({ success: false, message: 'Username wajib diisi.' });
      }

      if (!(await assertIsAdmin(actor))) {
        return res.status(403).json({ success: false, message: 'Hanya admin yang boleh menambah akun.' });
      }

      const trimmed = username.trim();
      const existing = await sql`SELECT username FROM accounts WHERE username = ${trimmed}`;
      if (existing.length > 0) {
        return res.status(200).json({ success: false, message: 'Akun sudah ada.' });
      }

      const usingDefaultPassword = !password;
      const passwordHash = await bcrypt.hash(password || DEFAULT_PASSWORD, 10);
      const finalRole = role || 'lw';

      await sql`
        INSERT INTO accounts (username, password_hash, role, status, must_change_password)
        VALUES (${trimmed}, ${passwordHash}, ${finalRole}, 'Aktif', ${usingDefaultPassword})
      `;

      const pf = profileFields || {};

      await sql`
        INSERT INTO profiles (
          username, jabatan, jalur, jalur_id, tower_ids, span_ids,
          tower_awal, tower_akhir, wilayah, foto
        ) VALUES (
          ${trimmed},
          ${pf.jabatan || finalRole.toUpperCase()},
          ${pf.jalur || 'lembursitu-cianjur'},
          ${pf.jalurId || null},
          ${JSON.stringify(pf.towerIds || [])},
          ${JSON.stringify(pf.spanIds || [])},
          ${pf.towerAwal != null ? pf.towerAwal : 1},
          ${pf.towerAkhir != null ? pf.towerAkhir : 1},
          ${pf.wilayah || ''},
          ${''}
        )
      `;

      logActivity({
        username: actor, action: 'create', entityType: 'akun', entityId: trimmed,
        detail: `Menambahkan akun baru "${trimmed}" (role: ${finalRole})`,
      });
      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT') {
      // Update akun + profil (menggantikan updateAccountProfile)
      const { username: bodyUsername, fields, actor } = req.body || {};
      if (!bodyUsername || !fields) {
        return res.status(400).json({ success: false, message: 'username dan fields wajib diisi.' });
      }

      const existing = await sql`SELECT username FROM accounts WHERE username = ${bodyUsername}`;
      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });
      }

      // username akan dipakai sebagai "target" query untuk sisa proses di
      // bawah. Kalau ada rename, nilainya diganti ke username baru setelah
      // proses rename berhasil, supaya update role/jabatan/dll di bawah
      // langsung kena ke baris yang baru.
      let username = bodyUsername;

      // Ringkasan field yang berubah, dibangun dari body asli SEBELUM
      // fields.newUsername/rename diproses -- dipakai untuk activity log.
      const changedFieldLabels = [];
      if (fields.newUsername !== undefined && String(fields.newUsername).trim() !== bodyUsername) {
        changedFieldLabels.push(`ganti nama akun -> "${fields.newUsername}"`);
      }
      if (fields.role !== undefined) changedFieldLabels.push(`role -> ${fields.role}`);
      if (fields.status !== undefined) changedFieldLabels.push(`status -> ${fields.status}`);
      if (fields.jabatan !== undefined) changedFieldLabels.push('jabatan');
      if (fields.jalur !== undefined) changedFieldLabels.push('jalur');
      if (fields.jalurId !== undefined) changedFieldLabels.push('akses jalur');
      if (fields.towerIds !== undefined) changedFieldLabels.push('penugasan tower');
      if (fields.spanIds !== undefined) changedFieldLabels.push('penugasan span');
      if (fields.wilayah !== undefined) changedFieldLabels.push('wilayah');

      // --- Rename akun (ganti username/nama login) ---
      // username adalah PRIMARY KEY dan direferensikan oleh tabel profiles
      // (FK, ON DELETE CASCADE, tanpa ON UPDATE CASCADE), jadi UPDATE
      // langsung ke kolom PK akan gagal kena constraint. Solusinya: insert
      // baris baru dengan username baru (copy semua data -- termasuk
      // referensi "drive:<fileId>" pada foto, TIDAK perlu upload ulang ke
      // Drive karena file-nya tetap sama, cuma pindah pemilik baris di DB),
      // pindahkan TTD (profile_signatures) ke username baru, baru hapus
      // baris lama (profiles lama ikut kehapus otomatis lewat CASCADE).
      // Catatan histori: username lama yang sudah tercatat di catatan-span
      // (laporan/inspeksi) TIDAK ikut diubah -- itu memang riwayat dokumen,
      // bukan referensi hidup ke akun.
      if (fields.newUsername !== undefined) {
        const newUsername = String(fields.newUsername).trim();
        if (!newUsername) {
          return res.status(400).json({ success: false, message: 'Nama akun baru tidak boleh kosong.' });
        }
        if (newUsername !== username) {
          const clash = await sql`SELECT username FROM accounts WHERE username = ${newUsername}`;
          if (clash.length > 0) {
            return res.status(200).json({ success: false, message: 'Nama tersebut sudah dipakai akun lain.' });
          }

          const accRows = await sql`SELECT * FROM accounts WHERE username = ${username}`;
          const profRows = await sql`SELECT * FROM profiles WHERE username = ${username}`;
          const accRow = accRows[0];
          const profRow = profRows[0];

          const steps = [
            sql`
              INSERT INTO accounts (username, password_hash, role, status, created_at)
              VALUES (${newUsername}, ${accRow.password_hash}, ${accRow.role}, ${accRow.status}, ${accRow.created_at})
            `,
          ];
          if (profRow) {
            steps.push(sql`
              INSERT INTO profiles (
                username, jabatan, jalur, jalur_id, tower_ids, span_ids,
                tower_awal, tower_akhir, wilayah, foto
              ) VALUES (
                ${newUsername}, ${profRow.jabatan}, ${profRow.jalur}, ${profRow.jalur_id},
                ${JSON.stringify(profRow.tower_ids)}, ${JSON.stringify(profRow.span_ids)},
                ${profRow.tower_awal}, ${profRow.tower_akhir}, ${profRow.wilayah}, ${profRow.foto}
              )
            `);
          }
          steps.push(sql`UPDATE profile_signatures SET username = ${newUsername} WHERE username = ${username}`);
          steps.push(sql`DELETE FROM accounts WHERE username = ${username}`);

          await sql.transaction(steps);

          username = newUsername;
        }
      }

      if (fields.role !== undefined || fields.status !== undefined) {
        await sql`
          UPDATE accounts SET
            role   = COALESCE(${fields.role ?? null}, role),
            status = COALESCE(${fields.status ?? null}, status)
          WHERE username = ${username}
        `;
      }

      const hasProfileFields = [
        'jabatan', 'jalur', 'jalurId', 'towerIds', 'spanIds', 'towerAwal', 'towerAkhir', 'wilayah',
      ].some((k) => fields[k] !== undefined);

      if (hasProfileFields) {
        // jalur_id butuh perlakuan khusus: COALESCE tidak bisa dipakai untuk
        // MENGOSONGKAN nilai (set NULL), karena COALESCE(null, kolom_lama)
        // akan selalu balik ke nilai lama. Admin & KLW sengaja punya
        // jalur_id = NULL supaya otomatis akses SEMUA jalur (termasuk yang
        // baru dibuat) -- lihat kelola-akun.html.
        const jalurIdProvided = Object.prototype.hasOwnProperty.call(fields, 'jalurId');

        await sql`
          UPDATE profiles SET
            jabatan     = COALESCE(${fields.jabatan ?? null}, jabatan),
            jalur       = COALESCE(${fields.jalur ?? null}, jalur),
            tower_ids   = COALESCE(${fields.towerIds !== undefined ? JSON.stringify(fields.towerIds) : null}, tower_ids),
            span_ids    = COALESCE(${fields.spanIds !== undefined ? JSON.stringify(fields.spanIds) : null}, span_ids),
            tower_awal  = COALESCE(${fields.towerAwal ?? null}, tower_awal),
            tower_akhir = COALESCE(${fields.towerAkhir ?? null}, tower_akhir),
            wilayah     = COALESCE(${fields.wilayah ?? null}, wilayah)
          WHERE username = ${username}
        `;

        if (jalurIdProvided) {
          // Set langsung (boleh NULL) -- dipanggil terpisah dari COALESCE di atas.
          await sql`UPDATE profiles SET jalur_id = ${fields.jalurId ?? null} WHERE username = ${username}`;
        }
      }

      logActivity({
        username: actor, action: 'update', entityType: 'akun', entityId: username,
        detail: changedFieldLabels.length ? `Mengubah ${changedFieldLabels.join(', ')}` : 'Update akun',
      });
      return res.status(200).json({ success: true, username });
    }

    if (req.method === 'DELETE') {
      const username = qUsername;
      if (!username) return res.status(400).json({ success: false, message: 'username wajib diisi.' });

      // ON DELETE CASCADE di tabel profiles akan ikut menghapus profil.
      await sql`DELETE FROM accounts WHERE username = ${username}`;
      logActivity({
        username: qActor, action: 'delete', entityType: 'akun', entityId: username,
        detail: `Menghapus akun "${username}"`,
      });
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Accounts API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
