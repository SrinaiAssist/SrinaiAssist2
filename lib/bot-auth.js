// lib/bot-auth.js
//
// Validasi sederhana buat request yang datang dari bot Telegram (BotLab)
// saat menulis data (POST/PUT/DELETE) ke SrinaiAssist2.
//
// PENTING -- desain ini SENGAJA tidak mengubah perilaku endpoint untuk
// web app biasa (dashboard, master-jalur.html, dll):
//   - Kalau header x-bot-key TIDAK ada di request -> dianggap request dari
//     web app seperti biasa, LOLOS tanpa diperiksa (perilaku sama persis
//     seperti sebelum file ini ada, jadi tidak ada resiko web app yang
//     sudah jalan jadi rusak).
//   - Kalau header x-bot-key ADA tapi nilainya salah -> ditolak (401).
//   - Kalau header x-bot-key ADA dan benar -> lolos.
//
// Jadi ini bukan proteksi menyeluruh (endpoint tetap terbuka untuk request
// tanpa header sama sekali), tapi cukup untuk mencegah bot menulis data
// pakai key yang salah/ketebak, tanpa perlu bongkar sistem login yang
// sudah ada.
//
// Env var yang dibutuhkan (isi di Vercel project SrinaiAssist2):
//   SRINAI_BOT_KEY = <string acak, sama persis dengan yang diisi di
//                     Vercel project BotLab>

function isBotRequestValid(req) {
  const key = req.headers['x-bot-key'];
  if (!key) return true; // bukan request dari bot, tidak diperiksa di sini
  if (!process.env.SRINAI_BOT_KEY) {
    console.warn('SRINAI_BOT_KEY belum diset -- request dengan x-bot-key akan selalu ditolak.');
    return false;
  }
  return key === process.env.SRINAI_BOT_KEY;
}

module.exports = { isBotRequestValid };
