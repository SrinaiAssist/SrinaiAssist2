-- Migrasi: Push Notification (FCM) + Halaman Artikel/Berita
-- Jalankan sekali di Neon (SQL editor Neon, atau lewat psql/migrasi script).

-- ─── Push Notification ──────────────────────────────────────────────
-- Satu user bisa punya lebih dari satu token (login di beberapa device).
CREATE TABLE IF NOT EXISTS fcm_tokens (
  id           SERIAL PRIMARY KEY,
  username     TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  device_info  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_username ON fcm_tokens(username);

-- ─── Artikel / Berita ────────────────────────────────────────────────
-- Semua role bisa baca. Hanya admin yang bisa create/update/delete
-- (dicek di sisi API, api/settings.js, bukan di DB).
CREATE TABLE IF NOT EXISTS articles (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,           -- isi artikel (plain text / simple markup)
  created_by   TEXT NOT NULL REFERENCES accounts(username),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published    BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published, created_at DESC);

-- Lampiran per artikel: foto, video, atau file lain. File-nya sendiri
-- disimpan di Google Drive (lib/googleDrive.js) -- yang disimpan di sini
-- cuma referensi drive_file_id, bukan isi filenya (supaya hemat kuota
-- transfer Neon, sama seperti pola foto profil / foto eviden).
CREATE TABLE IF NOT EXISTS article_media (
  id            SERIAL PRIMARY KEY,
  article_id    TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  media_type    TEXT NOT NULL CHECK (media_type IN ('image','video','file')),
  drive_file_id TEXT NOT NULL,
  file_name     TEXT,
  mime_type     TEXT,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_article_media_article ON article_media(article_id, sort_order);
