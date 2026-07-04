-- scripts/schema.sql
-- Jalankan sekali di Neon (lewat SQL editor Neon, atau psql) sebelum migrasi data.

CREATE TABLE IF NOT EXISTS accounts (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'klw', 'lw', 'monitor')),
    status        TEXT NOT NULL DEFAULT 'Aktif' CHECK (status IN ('Aktif', 'Belum Aktif')),
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
