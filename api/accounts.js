// api/accounts.js
//
// GET    /api/accounts            -> list semua akun + profil (tanpa password_hash)
// POST   /api/accounts             -> tambah akun baru
//        body: { username, password, role, profileFields:{...} }
// PUT    /api/accounts             -> update akun/profil (role, status, jabatan, jalur, dst)
//        body: { username, fields:{...} }
// DELETE /api/accounts?username=.. -> hapus akun
//
// Endpoint khusus password (dipisah agar jelas niatnya):
// POST   /api/accounts?action=resetPassword   body:{ username }
// POST   /api/accounts?action=changePassword  body:{ username, newPassword }
//
// PENTING (kuota transfer Neon): kolom foto profil (profiles.foto) sekarang
// TIDAK lagi menyimpan base64 mentah langsung ke Postgres. Kalau foto yang
// dikirim berupa base64 data URL, file diupload dulu ke Google Drive
// (lib/googleDrive.js) dan yang disimpan di kolom foto cuma referensi kecil
// "drive:<fileId>". Saat dibaca (GET), referensi itu otomatis di-download
// dari Drive lalu dikonversi balik jadi base64 SEBELUM dikirim ke browser --
// supaya frontend yang masih pakai <img src="..."> dengan base64 langsung
// TIDAK PERLU diubah. Kalau kredensial Drive belum diset / upload gagal,
// fallback: simpan base64 apa adanya seperti semula supaya fitur tetap jalan.

const { sql } = require('../lib/db');
const bcrypt = require('bcryptjs');
const { uploadPhotoToDrive, downloadFileAsDataUrl } = require('../lib/googleDrive');

const DRIVE_PREFIX = 'drive:';

async function resolveFotoForSave(foto, fileNamePrefix) {
  if (!foto || typeof foto !== 'string' || !foto.startsWith('data:')) {
    // Kosong, atau sudah berupa referensi Drive lama -> simpan apa adanya
    return { toSave: foto ?? '', warning: null };
  }
  try {
    const uploaded = await uploadPhotoToDrive(foto, `${fileNamePrefix}-${Date.now()}.jpg`);
    return { toSave: `${DRIVE_PREFIX}${uploaded.fileId}`, warning: null };
  } catch (driveErr) {
    console.error('Upload foto profil ke Drive gagal, fallback simpan base64:', driveErr.message);
    return { toSave: foto, warning: driveErr.message };
  }
}

async function resolveFotoForRead(fotoRaw) {
  if (!fotoRaw || typeof fotoRaw !== 'string' || !fotoRaw.startsWith(DRIVE_PREFIX)) {
    return fotoRaw || '';
  }
  const fileId = fotoRaw.slice(DRIVE_PREFIX.length);
  try {
    return await downloadFileAsDataUrl(fileId, 'image/jpeg');
  } catch (err) {
    console.error('Download foto profil dari Drive gagal:', err.message);
    return '';
  }
}

async function listAccounts(filterUsername) {
  const rows = filterUsername
    ? await sql`
        SELECT
          a.username, a.role, a.status,
          p.jabatan, p.jalur, p.jalur_id, p.tower_ids, p.span_ids,
          p.tower_awal, p.tower_akhir, p.wilayah, p.foto
        FROM accounts a
        LEFT JOIN profiles p ON p.username = a.username
        WHERE a.username = ${filterUsername}
      `
    : await sql`
        SELECT
          a.username, a.role, a.status,
          p.jabatan, p.jalur, p.jalur_id, p.tower_ids, p.span_ids,
          p.tower_awal, p.tower_akhir, p.wilayah, p.foto
        FROM accounts a
        LEFT JOIN profiles p ON p.username = a.username
        ORDER BY a.username
      `;

  // Resolve semua referensi Drive jadi base64 sebelum dikirim ke browser.
  return Promise.all(
    rows.map(async (r) => ({ ...r, foto: await resolveFotoForRead(r.foto) }))
  );
}

module.exports = async (req, res) => {
  try {
    const { action, username: qUsername } = req.query || {};

    if (req.method === 'GET') {
      const accounts = await listAccounts(qUsername);
      return res.status(200).json({ success: true, accounts });
    }

    if (req.method === 'POST' && action === 'resetPassword') {
      const { username } = req.body || {};
      if (!username) return res.status(400).json({ success: false, message: 'username wajib diisi.' });

      const passwordHash = await bcrypt.hash('123456', 10);
      const result = await sql`
        UPDATE accounts SET password_hash = ${passwordHash} WHERE username = ${username}
        RETURNING username
      `;
      if (result.length === 0) return res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });
      return res.status(200).json({ success: true });
    }

    if (req.method === 'POST' && action === 'changePassword') {
      const { username, newPassword } = req.body || {};
      if (!username || !newPassword) {
        return res.status(400).json({ success: false, message: 'username dan newPassword wajib diisi.' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      const result = await sql`
        UPDATE accounts SET password_hash = ${passwordHash} WHERE username = ${username}
        RETURNING username
      `;
      if (result.length === 0) return res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });
      return res.status(200).json({ success: true });
    }

    if (req.method === 'POST') {
      // Tambah akun baru
      const { username, password, role, profileFields } = req.body || {};
      if (!username || !username.trim()) {
        return res.status(400).json({ success: false, message: 'Username wajib diisi.' });
      }

      const trimmed = username.trim();
      const existing = await sql`SELECT username FROM accounts WHERE username = ${trimmed}`;
      if (existing.length > 0) {
        return res.status(200).json({ success: false, message: 'Akun sudah ada.' });
      }

      const passwordHash = await bcrypt.hash(password || '123456', 10);
      const finalRole = role || 'lw';

      await sql`
        INSERT INTO accounts (username, password_hash, role, status)
        VALUES (${trimmed}, ${passwordHash}, ${finalRole}, 'Aktif')
      `;

      const pf = profileFields || {};
      const { toSave: fotoToSave, warning: fotoWarning } = await resolveFotoForSave(
        pf.foto, `profil-${trimmed}`
      );

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
          ${fotoToSave}
        )
      `;

      return res.status(200).json({ success: true, driveWarning: fotoWarning });
    }

    if (req.method === 'PUT') {
      // Update akun + profil (menggantikan updateAccountProfile)
      const { username: bodyUsername, fields } = req.body || {};
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
        'jabatan', 'jalur', 'jalurId', 'towerIds', 'spanIds', 'towerAwal', 'towerAkhir', 'wilayah', 'foto',
      ].some((k) => fields[k] !== undefined);

      if (hasProfileFields) {
        let fotoToSave = null;
        let fotoWarning = null;
        if (fields.foto !== undefined) {
          const resolved = await resolveFotoForSave(fields.foto, `profil-${username}`);
          fotoToSave = resolved.toSave;
          fotoWarning = resolved.warning;
        }

        await sql`
          UPDATE profiles SET
            jabatan     = COALESCE(${fields.jabatan ?? null}, jabatan),
            jalur       = COALESCE(${fields.jalur ?? null}, jalur),
            jalur_id    = COALESCE(${fields.jalurId ?? null}, jalur_id),
            tower_ids   = COALESCE(${fields.towerIds !== undefined ? JSON.stringify(fields.towerIds) : null}, tower_ids),
            span_ids    = COALESCE(${fields.spanIds !== undefined ? JSON.stringify(fields.spanIds) : null}, span_ids),
            tower_awal  = COALESCE(${fields.towerAwal ?? null}, tower_awal),
            tower_akhir = COALESCE(${fields.towerAkhir ?? null}, tower_akhir),
            wilayah     = COALESCE(${fields.wilayah ?? null}, wilayah),
            foto        = COALESCE(${fotoToSave}, foto)
          WHERE username = ${username}
        `;

        if (fotoWarning) {
          return res.status(200).json({ success: true, username, driveWarning: fotoWarning });
        }
      }

      return res.status(200).json({ success: true, username });
    }

    if (req.method === 'DELETE') {
      const username = qUsername;
      if (!username) return res.status(400).json({ success: false, message: 'username wajib diisi.' });

      // ON DELETE CASCADE di tabel profiles akan ikut menghapus profil.
      await sql`DELETE FROM accounts WHERE username = ${username}`;
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('Accounts API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
