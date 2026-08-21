// restore-catatan-span.js
//
// Cara pakai (di GitHub Codespaces, dalam folder repo SrinaiAssist2):
//   1. Upload file `catatan_span_data.json` ke root repo (drag & drop di file explorer Codespaces)
//   2. Taruh file ini (`restore-catatan-span.js`) juga di root repo
//   3. Di terminal Codespaces, jalankan:
//        export POSTGRES_URL="<connection string Neon project BARU>"
//        node restore-catatan-span.js
//
// Script ini insert 20 baris catatan_span langsung lewat koneksi database,
// jadi tidak lewat proses copy-paste SQL di browser HP sama sekali —
// menghindari masalah clipboard yang memotong base64 panjang.

const fs = require('fs');
const path = require('path');
const neondb = require('@neondatabase/serverless');
const neon = neondb.neon || (neondb.default && neondb.default.neon);

if (typeof neon !== 'function') {
  console.error('Gagal memuat @neondatabase/serverless. Jalankan dulu: npm install @neondatabase/serverless');
  process.exit(1);
}

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Env var POSTGRES_URL belum diset. Jalankan:');
  console.error('  export POSTGRES_URL="postgresql://...connection-string-neon-baru..."');
  process.exit(1);
}

const sql = neon(connectionString);

async function main() {
  const dataPath = path.join(__dirname, 'catatan_span_data.json');
  if (!fs.existsSync(dataPath)) {
    console.error(`File tidak ditemukan: ${dataPath}`);
    console.error('Pastikan catatan_span_data.json ada di folder yang sama dengan script ini.');
    process.exit(1);
  }

  const rows = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  console.log(`Memuat ${rows.length} baris dari catatan_span_data.json...`);

  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await sql`
        INSERT INTO catatan_span (
          id, span_id, tower_id, username, catatan, foto, foto_file_id,
          tegakan_id, tegakan_nama, tegakan_id_tegakan, created_at, updated_at
        )
        VALUES (
          ${row.id}, ${row.span_id}, ${row.tower_id}, ${row.username}, ${row.catatan},
          ${row.foto}, ${row.foto_file_id}, ${row.tegakan_id}, ${row.tegakan_nama},
          ${row.tegakan_id_tegakan}, ${row.created_at || new Date().toISOString()},
          ${row.updated_at || new Date().toISOString()}
        )
        ON CONFLICT (id) DO UPDATE SET
          span_id = EXCLUDED.span_id,
          tower_id = EXCLUDED.tower_id,
          username = EXCLUDED.username,
          catatan = EXCLUDED.catatan,
          foto = EXCLUDED.foto,
          foto_file_id = EXCLUDED.foto_file_id,
          tegakan_id = EXCLUDED.tegakan_id,
          tegakan_nama = EXCLUDED.tegakan_nama,
          tegakan_id_tegakan = EXCLUDED.tegakan_id_tegakan
      `;
      ok++;
      console.log(`OK  id=${row.id}`);
    } catch (err) {
      failed++;
      console.error(`GAGAL id=${row.id}: ${err.message}`);
    }
  }

  console.log(`\nSelesai. Berhasil: ${ok}, Gagal: ${failed}`);
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
