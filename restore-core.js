// restore-core.js
//
// Restore semua tabel inti (accounts, profiles, jalur, tower, span, tegakan,
// ba_dokumen, pemilik_signatures, profile_signatures, chat_messages, app_settings)
// langsung lewat koneksi database -- tidak lewat copy-paste SQL Editor,
// jadi tidak berisiko kepotong clipboard seperti sebelumnya.
//
// Cara pakai (di GitHub Codespaces, folder repo SrinaiAssist2):
//   1. Upload file `core_data.json` ke root repo lewat GitHub web (Add file > Upload files)
//   2. Upload file ini (`restore-core.js`) juga ke root repo
//   3. Di terminal Codespaces:
//        git pull
//        export POSTGRES_URL='connection-string-neon-baru'
//        node restore-core.js

const fs = require('fs');
const path = require('path');
const neondb = require('@neondatabase/serverless');
const neon = neondb.neon || (neondb.default && neondb.default.neon);

if (typeof neon !== 'function') {
  console.error('Gagal memuat @neondatabase/serverless.');
  process.exit(1);
}

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Env var POSTGRES_URL belum diset.');
  process.exit(1);
}

const sql = neon(connectionString);

// Urutan WAJIB sesuai ini karena foreign key (accounts/jalur/span duluan).
const TABLE_ORDER = [
  { name: 'accounts', pk: 'username' },
  { name: 'profiles', pk: 'username', jsonbCols: ['tower_ids', 'span_ids'] },
  { name: 'jalur', pk: 'id' },
  { name: 'tower', pk: 'id' },
  { name: 'span', pk: 'id' },
  { name: 'tegakan', pk: 'id' },
  { name: 'ba_dokumen', pk: 'id', jsonbCols: ['foto'] },
  { name: 'pemilik_signatures', pk: 'nama_key' },
  { name: 'profile_signatures', pk: 'username' },
  { name: 'chat_messages', pk: 'id', jsonbCols: ['meta'] },
  { name: 'app_settings', pk: 'key' },
];

const SAFE_COL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

async function insertRow(tableName, pk, row, jsonbCols) {
  const cols = Object.keys(row).filter((c) => SAFE_COL.test(c));
  const values = cols.map((c) => {
    const v = row[c];
    if (v !== null && jsonbCols && jsonbCols.includes(c)) {
      return JSON.stringify(v);
    }
    return v;
  });
  const quotedCols = cols.map((c) => `"${c}"`).join(', ');
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updateCols = cols.filter((c) => c !== pk);
  const updateSet = updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
  const conflictClause = updateSet
    ? `ON CONFLICT ("${pk}") DO UPDATE SET ${updateSet}`
    : `ON CONFLICT ("${pk}") DO NOTHING`;

  const query = `INSERT INTO ${tableName} (${quotedCols}) VALUES (${placeholders}) ${conflictClause}`;
  await sql(query, values);
}

async function main() {
  const dataPath = path.join(__dirname, 'core_data.json');
  if (!fs.existsSync(dataPath)) {
    console.error(`File tidak ditemukan: ${dataPath}`);
    process.exit(1);
  }
  const allTables = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  let totalOk = 0;
  let totalFailed = 0;

  for (const { name, pk, jsonbCols } of TABLE_ORDER) {
    const rows = allTables[name] || [];
    if (rows.length === 0) {
      console.log(`-- ${name}: 0 baris, dilewati`);
      continue;
    }
    console.log(`-- ${name}: ${rows.length} baris`);
    let ok = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await insertRow(name, pk, row, jsonbCols);
        ok++;
      } catch (err) {
        failed++;
        console.error(`   GAGAL ${name} pk=${row[pk]}: ${err.message}`);
      }
    }
    console.log(`   -> ok: ${ok}, gagal: ${failed}`);
    totalOk += ok;
    totalFailed += failed;
  }

  console.log(`\nSELESAI SEMUA TABEL. Total berhasil: ${totalOk}, Total gagal: ${totalFailed}`);
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
