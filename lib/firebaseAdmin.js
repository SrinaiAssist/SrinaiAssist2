// lib/firebaseAdmin.js
//
// Modul ringan untuk kirim push notification lewat Firebase Cloud Messaging
// (FCM) HTTP v1 API. Sengaja TIDAK pakai package "firebase-admin" (berat,
// nambah cold-start & ukuran bundle) -- cukup pakai modul "crypto" bawaan
// Node.js buat sign JWT (service account) dan "fetch" bawaan buat call API,
// gaya yang sama seperti lib/googleDrive.js.
//
// ENV VARS yang wajib diset di Vercel (Project Settings -> Environment Variables),
// diambil dari file JSON service account (Firebase Console -> Project
// Settings -> Service Accounts -> Generate new private key):
//   FCM_PROJECT_ID     -> field "project_id" di JSON
//   FCM_CLIENT_EMAIL   -> field "client_email" di JSON
//   FCM_PRIVATE_KEY    -> field "private_key" di JSON (termasuk header/footer
//                         -----BEGIN PRIVATE KEY-----...-----END PRIVATE KEY-----)
//                         Kalau ditempel sebagai satu baris di Vercel, ganti
//                         karakter newline asli jadi literal "\n" -- kode di
//                         bawah otomatis convert balik ("\\n" -> "\n").

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let cachedAccessToken = null;
let cachedTokenExpiresAt = 0;
let cachedProjectId = null;

function getEnvOrThrow(name) {
  const raw = process.env[name];
  const val = raw ? raw.trim() : '';
  if (!val) throw new Error(`Kredensial FCM belum diset: env var ${name} kosong.`);
  return val;
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Bikin & sign JWT (RS256) buat tukar ke access token, sesuai OAuth2
// "service account" flow (grant_type: jwt-bearer).
function buildSignedJwt(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${unsigned}.${signature}`;
}

// SELALU return { accessToken, projectId } -- baik saat ambil dari cache
// maupun saat fetch token baru. Sebelumnya ada bug: cabang cache-hit cuma
// return string token mentah (bukan object), sementara semua pemanggil
// (sendFcmMessage) selalu destructure `const { accessToken } = await
// getAccessToken()`. Akibatnya begitu token sempat ke-cache dalam
// serverless instance yang sama (warm start), accessToken jadi undefined
// -> request ke FCM dikirim dengan header "Authorization: Bearer undefined"
// -> FCM tolak (401) -> error itu cuma ditangkap try/catch di
// lib/pushHelper.js dan di-console.error, jadi GAGAL SENYAP tanpa
// mempengaruhi response ke admin. Ini penyebab kenapa broadcast file ke
// Telegram sukses tapi notifikasi push FCM-nya tidak sampai.
async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && cachedProjectId && now < cachedTokenExpiresAt - 60000) {
    return { accessToken: cachedAccessToken, projectId: cachedProjectId };
  }

  const clientEmail = getEnvOrThrow('FCM_CLIENT_EMAIL');
  const projectId = getEnvOrThrow('FCM_PROJECT_ID');
  let privateKey = getEnvOrThrow('FCM_PRIVATE_KEY');
  // Kalau disimpan sebagai satu baris di Vercel, "\n" literal perlu
  // dikembalikan jadi newline asli supaya valid sebagai PEM.
  if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');

  const assertion = buildSignedJwt(clientEmail, privateKey);

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`Gagal ambil access token FCM: ${JSON.stringify(data)}`);
  }

  cachedAccessToken = data.access_token;
  cachedProjectId = projectId;
  cachedTokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return { accessToken: cachedAccessToken, projectId: cachedProjectId };
}

// Kirim satu push message ke satu token FCM.
// Return { ok: true } atau { ok: false, invalidToken: true/false, error }
// supaya pemanggil bisa hapus token yang sudah tidak valid (UNREGISTERED /
// uninstall / logout dari device) dari tabel fcm_tokens.
async function sendFcmMessage(token, { title, body, data, sound, channel }) {
  const { accessToken, projectId } = await getAccessToken();

  const message = {
    message: {
      token,
      notification: { title, body },
      data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
      android: {
        priority: 'high',
        notification: {
          // channel default kalau tidak diisi -- harus match salah satu
          // channel_id yang didaftarkan di MainActivity.java. Channel
          // Android TIDAK BISA ganti suara setelah dibuat, jadi setiap
          // suara custom baru butuh channel_id baru juga.
          channel_id: channel || 'srinai_default',
          sound: sound || 'notif_sound',
        },
      },
    },
  };

  const resp = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    }
  );

  if (resp.ok) return { ok: true };

  const errData = await resp.json().catch(() => ({}));
  const status = errData?.error?.details?.find((d) => d.errorCode)?.errorCode
    || errData?.error?.status;
  const invalidToken = status === 'UNREGISTERED' || status === 'NOT_FOUND' || status === 'INVALID_ARGUMENT';
  return { ok: false, invalidToken, error: errData };
}

module.exports = { sendFcmMessage };
