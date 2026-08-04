-- scripts/schema.sql
-- Sumber kebenaran skema Neon Postgres untuk SrinaiAssist2.
-- Aman dijalankan ulang kapan saja (semua statement idempotent: IF NOT
-- EXISTS / ADD COLUMN IF NOT EXISTS) -- termasuk di database produksi yang
-- sudah berisi data, jadi tidak akan menghapus/menimpa apa pun yang sudah ada.
--
-- CATATAN PERBAIKAN (Ags 2026): sebelumnya file ini adalah kumpulan tempelan
-- riwayat migrasi yang di-append terus -- salah satunya membuat statement
-- CREATE TABLE profiles(...) tidak pernah ditutup ")" sehingga file ini
-- sebenarnya TIDAK VALID sebagai satu file SQL yang bisa dijalankan dari
-- awal. Tabel inti (jalur, tower, span, ba_dokumen, tegakan) yang sudah lama
-- dipakai di semua api/*.js juga tidak pernah tercatat definisinya di sini.
-- File ini sekarang disusun ulang jadi representasi lengkap & runut dari
-- skema yang benar-benar dipakai kode saat ini.

-- ─────────────────────────────────────────────────────────
-- AKUN & PROFIL
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'klw', 'lw', 'monitor')),
    status        TEXT NOT NULL DEFAULT 'Aktif' CHECK (status IN ('Aktif', 'Belum Aktif')),
    last_login    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
    username    TEXT PRIMARY KEY REFERENCES accounts(username) ON DELETE CASCADE,
    jabatan     TEXT DEFAULT '',
    jalur       TEXT DEFAULT 'lembursitu-cianjur',
    jalur_id    TEXT,
    tower_ids   JSONB DEFAULT '[]'::jsonb,
    span_ids    JSONB DEFAULT '[]'::jsonb,
    tower_awal  INTEGER DEFAULT 1,
    tower_akhir INTEGER DEFAULT 1,
    wilayah     TEXT DEFAULT '',
    foto        TEXT DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────
-- MASTER DATA: JALUR / TOWER / SPAN
-- Ketiganya punya updated_at yang di-set eksplisit `now()` di setiap
-- UPDATE (lihat api/jalur.js, api/tower.js, api/span.js) -- dipakai
-- untuk mode ringan ?meta=1 dan sinkron bertahap (?since=) di js/sync.js.
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jalur (
    id              TEXT PRIMARY KEY,
    code            TEXT NOT NULL,
    label           TEXT NOT NULL,
    aktif           BOOLEAN NOT NULL DEFAULT true,
    penghantar      TEXT DEFAULT '',
    parent_jalur_id TEXT REFERENCES jalur(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jalur_parent ON jalur(parent_jalur_id);

CREATE TABLE IF NOT EXISTS tower (
    id             TEXT PRIMARY KEY,
    jalur_id       TEXT NOT NULL REFERENCES jalur(id) ON DELETE CASCADE,
    nomor          INTEGER NOT NULL,
    jenis          TEXT DEFAULT '',
    isolator       TEXT DEFAULT '',
    renceng        TEXT DEFAULT '',
    status         TEXT DEFAULT '',
    latitude       DOUBLE PRECISION,
    longitude      DOUBLE PRECISION,
    akurasi_meter  DOUBLE PRECISION,
    koordinat_by   TEXT,
    koordinat_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (jalur_id, nomor)
);
CREATE INDEX IF NOT EXISTS idx_tower_jalur       ON tower(jalur_id);
CREATE INDEX IF NOT EXISTS idx_tower_updated_at  ON tower(updated_at);

CREATE TABLE IF NOT EXISTS span (
    id          TEXT PRIMARY KEY,
    jalur_id    TEXT NOT NULL REFERENCES jalur(id) ON DELETE CASCADE,
    nomor       INTEGER NOT NULL,
    spacer      TEXT DEFAULT '',
    joint       TEXT DEFAULT '',
    status      TEXT DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (jalur_id, nomor)
);
CREATE INDEX IF NOT EXISTS idx_span_jalur       ON span(jalur_id);
CREATE INDEX IF NOT EXISTS idx_span_updated_at  ON span(updated_at);

-- ─────────────────────────────────────────────────────────
-- TEGAKAN (catatan per span, TTD pemilik lahan)
-- updated_at di-GROUP BY span_id untuk mode ?meta=1 (lihat api/tegakan.js)
-- supaya syncAll() tahu SPAN MANA yang berubah tanpa tarik semua span dulu.
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tegakan (
    id              BIGINT PRIMARY KEY,
    span_id         TEXT NOT NULL REFERENCES span(id) ON DELETE CASCADE,
    nama            TEXT NOT NULL,
    id_tegakan      TEXT,
    pemilik_nama    TEXT,
    pemilik_alamat  TEXT,
    pemilik_telp    TEXT,
    petugas         TEXT NOT NULL,
    ttd_type        TEXT,
    ttd_data        TEXT,
    tanggal         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tegakan_span        ON tegakan(span_id);
CREATE INDEX IF NOT EXISTS idx_tegakan_updated_at  ON tegakan(updated_at);

-- ─────────────────────────────────────────────────────────
-- BERITA ACARA (BA)
-- id pakai BIGINT (Date.now() dari server, bukan SERIAL) -- lihat api/ba.js.
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ba_dokumen (
    id              BIGINT PRIMARY KEY,
    span_id         TEXT NOT NULL REFERENCES span(id) ON DELETE CASCADE,
    judul           TEXT,
    pemilik         TEXT,
    jumlah_tegakan  INTEGER DEFAULT 0,
    nama_tegakan    TEXT,
    pdf             TEXT,
    foto            JSONB DEFAULT '[]'::jsonb,
    file_name       TEXT,
    sumber          TEXT DEFAULT 'manual',
    uploader        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ba_span         ON ba_dokumen(span_id);
CREATE INDEX IF NOT EXISTS idx_ba_updated_at   ON ba_dokumen(updated_at);

-- ─────────────────────────────────────────────────────────
-- LOG LOGIN (admin — lihat siapa login & kapan terakhir)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_logs (
    id         SERIAL PRIMARY KEY,
    username   TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    login_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_logs_username ON login_logs(username);
CREATE INDEX IF NOT EXISTS idx_login_logs_login_at  ON login_logs(login_at DESC);

-- ─────────────────────────────────────────────────────────
-- LOG AKTIVITAS (admin — tegakan & akun: tambah/edit/hapus)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_logs (
    id          SERIAL PRIMARY KEY,
    username    TEXT NOT NULL,          -- pelaku (bukan FK -- log harus tetap ada walau akun dihapus)
    action      TEXT NOT NULL,          -- 'create' | 'update' | 'delete' | 'reset_password'
    entity_type TEXT NOT NULL,          -- 'tegakan' | 'akun'
    entity_id   TEXT,                   -- id tegakan / username akun terkait
    detail      TEXT,                   -- ringkasan singkat, human-readable
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity     ON activity_logs(entity_type, entity_id);

-- ─────────────────────────────────────────────────────────
-- NOTIFIKASI COMMANDBOT (rekap harian "span belum ada tegakan"
-- + badge/getar ikon CommandBot untuk notif belum terbaca)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_notifications (
    id         SERIAL PRIMARY KEY,
    username   TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    type       TEXT NOT NULL,           -- 'span_belum_tegakan' (bisa ditambah jenis lain nanti)
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at    TIMESTAMPTZ              -- NULL = belum dibaca
);
CREATE INDEX IF NOT EXISTS idx_bot_notif_unread ON bot_notifications(username) WHERE read_at IS NULL;

-- ─────────────────────────────────────────────────────────
-- Jaga-jaga: kalau tabel di atas SUDAH ada sebelum file ini dirapikan
-- (dibuat manual dulu tanpa lewat schema.sql), pastikan kolom yang
-- dibutuhkan mode ?meta= / ?since= tetap ada tanpa mengubah data lain.
-- ─────────────────────────────────────────────────────────
ALTER TABLE jalur      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE tower       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE span        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE tegakan     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE ba_dokumen  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
