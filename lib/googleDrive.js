// lib/googleDrive.js
//
// Modul ringan untuk upload foto eviden ke Google Drive akun admin,
// dipakai oleh api/catatan-span.js (dan bisa dipakai api/catatan-tower.js
// kalau ada versi terpisah nanti).
//
// Sengaja TIDAK pakai package "googleapis" (berat, nambah cold-start &
// ukuran bundle) — cukup pakai fetch bawaan Node.js untuk:
//   1. Tukar refresh_token -> access_token lewat OAuth2 token endpoint
//   2. Upload file ke Drive lewat REST API (multipart upload)
//   3. Set permission "anyone can view" supaya thumbUrl bisa dipakai
//      langsung sebagai <img src="..."> di foto-eviden.html
//
// ENV VARS yang wajib diset di Vercel (Project Settings -> Environment Variables):
//   GOOGLE_DRIVE_CLIENT_ID      -> Client ID dari Google Cloud Console
//   GOOGLE_DRIVE_CLIENT_SECRET  -> Client Secret dari Google Cloud Console
//   GOOGLE_DRIVE_REFRESH_TOKEN  -> Refresh token dari OAuth Playground (diawali "1//")
//   GOOGLE_DRIVE_FOLDER_ID      -> (opsional) ID folder tujuan upload di Drive.
//                                  Kalau kosong, file diupload ke root My Drive.
//
// PENTING (privasi): supaya thumbUrl bisa ditampilkan sebagai <img> di halaman
// foto-eviden.html tanpa perlu login Google, file di-set permission
// "anyone with the link can view". Artinya siapa pun yang tahu link-nya bisa
// lihat foto itu. Kalau foto eviden sifatnya rahasia, pertimbangkan untuk
// TIDAK menampilkan foto langsung ke publik, atau tambahkan lapisan auth
// sendiri di sisi aplikasi.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,thumbnailLink,webViewLink';
const PERMISSIONS_URL_TMPL = (fileId) => `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`;
const DOWNLOAD_URL_TMPL = (fileId) => `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

// Cache access token di module scope. Selama function instance masih "warm"
// (dipakai lagi tanpa cold start), kita hemat 1 request ke Google tiap upload.
let cachedAccessToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

function getEnvOrThrow(name) {
  const raw = process.env[name];
  const val = raw ? raw.trim() : '';
  if (!val) {
    throw new Error(`Kredensial Google Drive belum diset: env var ${name} kosong.`);
  }
  return val;
}

function findSuspiciousChars(label, value) {
  // Karakter yang valid untuk client_id/client_secret/refresh_token Google:
  // huruf, angka, dan simbol umum -_./: (base64url-ish + dot untuk client_id)
  const allowed = /[A-Za-z0-9\-_./:]/;
  const suspicious = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (!allowed.test(ch)) {
      suspicious.push({ pos: i, char: ch, code: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') });
    }
  }
  return suspicious.length > 0 ? { label, suspicious } : null;
}

async function getAccessToken() {
  const now = Date.now();
  // Pakai cache kalau masih valid minimal 60 detik lagi
  if (cachedAccessToken && now < cachedTokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  const clientId = getEnvOrThrow('GOOGLE_DRIVE_CLIENT_ID');
  const clientSecret = getEnvOrThrow('GOOGLE_DRIVE_CLIENT_SECRET');
  const refreshToken = getEnvOrThrow('GOOGLE_DRIVE_REFRESH_TOKEN');

  // DEBUG SEMENTARA: cek apakah ada karakter aneh/tersembunyi (mis. dash unicode
  // hasil autocorrect, smart quote, zero-width space) yang nyempil di credential.
  const charIssues = [
    findSuspiciousChars('clientId', clientId),
    findSuspiciousChars('clientSecret', clientSecret),
    findSuspiciousChars('refreshToken', refreshToken),
  ].filter(Boolean);

  if (charIssues.length > 0) {
    throw new Error(
      `Ditemukan karakter mencurigakan di env var (kemungkinan rusak saat copy-paste): ${JSON.stringify(charIssues)}`
    );
  }

  if (!refreshToken.startsWith('1//')) {
    throw new Error(
      `GOOGLE_DRIVE_REFRESH_TOKEN tampaknya tidak valid (harus diawali "1//"). ` +
      `Kemungkinan ke-copy tidak lengkap dari OAuth Playground. Panjang saat ini: ${refreshToken.length} karakter.`
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const rawText = await resp.text();
  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    // Respons bukan JSON valid, biarkan data = {} supaya rawText tetap kepakai di bawah.
  }

  if (!resp.ok || !data.access_token) {
    // DEBUG SEMENTARA: tampilkan info lengkap (status, body mentah dari Google,
    // panjang & beberapa karakter awal tiap kredensial) supaya bisa didiagnosis
    // dari pesan error di UI, tanpa perlu buka Vercel logs.
    const debugInfo = {
      status: resp.status,
      rawBody: rawText.slice(0, 500),
      clientIdPreview: clientId.slice(0, 12) + '...(' + clientId.length + ' char)',
      clientSecretPreview: clientSecret.slice(0, 8) + '...(' + clientSecret.length + ' char)',
      refreshTokenPreview: refreshToken.slice(0, 12) + '...(' + refreshToken.length + ' char)',
      outgoingBodyLength: body.toString().length,
    };
    throw new Error(
      `Gagal tukar refresh_token jadi access_token (status ${resp.status}). DEBUG: ${JSON.stringify(debugInfo)}`
    );
  }

  cachedAccessToken = data.access_token;
  // expires_in dalam detik (biasanya 3599)
  cachedTokenExpiresAt = now + (data.expires_in || 3600) * 1000;

  return cachedAccessToken;
}

// Parse data URL "data:image/jpeg;base64,...." jadi { mimeType, buffer }
//
// CATATAN: jsPDF punya "quirk" pada doc.output("datauristring") — hasilnya
// bukan "data:application/pdf;base64,...." polos, tapi menyisipkan parameter
// tambahan "filename=...." di tengah:
//   data:application/pdf;filename=generated.pdf;base64,JVBERi0...
// Regex lama cuma menerima TEPAT SATU ";" sebelum "base64,", jadi format di
// atas gagal match dan selalu dianggap "bukan base64 data URL" (fallback ke
// database). Regex baru ini membolehkan nol atau satu parameter tambahan
// (";key=value") di antara mime type dan "base64,".
function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error('Format foto tidak valid, bukan base64 data URL.');
  }
  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  return { mimeType, buffer };
}

// Upload 1 foto (data URL base64) ke Google Drive.
// Return: { fileId, thumbUrl, webViewLink }
async function uploadPhotoToDrive(fotoDataUrl, fileName) {
  if (!fotoDataUrl || typeof fotoDataUrl !== 'string') {
    throw new Error('fotoDataUrl kosong / tidak valid.');
  }

  const accessToken = await getAccessToken();
  const { mimeType, buffer } = parseDataUrl(fotoDataUrl);

  const metadata = {
    name: fileName || `eviden-${Date.now()}.jpg`,
  };
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID ? process.env.GOOGLE_DRIVE_FOLDER_ID.trim() : '';
  if (folderId) {
    metadata.parents = [folderId];
  }

  // Multipart upload manual: 2 bagian (metadata JSON + file binary)
  const boundary = 'srinai-drive-boundary-' + Date.now();
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadataPart =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata);

  const mediaPartHeader = delimiter + `Content-Type: ${mimeType}\r\n` + 'Content-Transfer-Encoding: base64\r\n\r\n';

  const multipartBody = Buffer.concat([
    Buffer.from(metadataPart, 'utf-8'),
    Buffer.from(mediaPartHeader, 'utf-8'),
    Buffer.from(buffer.toString('base64'), 'utf-8'),
    Buffer.from(closeDelimiter, 'utf-8'),
  ]);

  const uploadResp = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  const uploaded = await uploadResp.json();

  if (!uploadResp.ok || !uploaded.id) {
    throw new Error(
      `Upload ke Google Drive gagal (status ${uploadResp.status}): ${
        (uploaded.error && uploaded.error.message) || 'unknown error'
      }`
    );
  }

  const fileId = uploaded.id;

  // Set permission publik "anyone with link can view" supaya thumbUrl
  // bisa langsung dipakai sebagai <img src>. Kalau gagal (mis. karena
  // Shared Drive policy), upload tetap dianggap sukses, cuma foto
  // mungkin tidak bisa ditampilkan langsung.
  try {
    await fetch(PERMISSIONS_URL_TMPL(fileId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
  } catch (permErr) {
    console.error('Set permission publik gagal (foto tetap terupload):', permErr.message);
  }

  return {
    fileId,
    thumbUrl: `https://drive.google.com/thumbnail?id=${fileId}&sz=w2000`,
    webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
  };
}

// Download 1 file dari Drive (pakai fileId) lalu kembalikan sebagai
// data URL base64 ("data:<mime>;base64,....").
//
// Dipakai untuk TTD (lib/googleDrive.js dipanggil dari api/signature.js):
// di DB cuma disimpan referensi kecil "drive:<fileId>", tapi saat
// dibutuhkan untuk ditempel ke PDF (jsPDF addImage butuh base64, bukan
// URL biasa — kalau URL Drive langsung dipakai bakal kena masalah CORS/
// canvas tainted), file-nya diambil di sini (server-side, TIDAK lewat
// Neon) lalu dikonversi ke base64 sebelum dikirim ke browser.
async function downloadFileAsDataUrl(fileId, mimeType) {
  const accessToken = await getAccessToken();

  const resp = await fetch(DOWNLOAD_URL_TMPL(fileId), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Download dari Google Drive gagal (status ${resp.status}): ${text || 'unknown error'}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

// Ambil info pemakaian storage Google Drive akun admin (dipakai widget
// "Penyimpanan Drive" di dashboard.html, di bawah widget Penyimpanan Database).
//
// PENTING: quota.limit dari Google bisa bernilai null (mis. akun Workspace
// unlimited, atau Google kadang tidak melaporkannya), jadi TIDAK bisa dipakai
// sebagai patokan pasti. Limit yang dipakai untuk hitung persentase selalu
// di-hardcode 15 GB (kuota gratis standar, dibagi dengan Gmail & Photos) di
// api/settings.js -- makanya angka yang tampil di dashboard sifatnya
// PERKIRAAN saja, bukan angka pasti berapa GB yang benar-benar tersedia.
async function getDriveStorageInfo() {
  const accessToken = await getAccessToken();

  const resp = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(
      `Gagal ambil info storage Google Drive (status ${resp.status}): ${
        (data.error && data.error.message) || 'unknown error'
      }`
    );
  }

  const quota = data.storageQuota || {};
  return {
    usageBytes: Number(quota.usage || 0),
    usageInDriveBytes: Number(quota.usageInDrive || 0),
    limitBytes: quota.limit != null ? Number(quota.limit) : null, // null = tidak dilaporkan / unlimited
  };
}

// Buat session resumable upload buat file BESAR (video, dokumen artikel)
// yang gak muat lewat body limit Vercel Function (~4.5MB). Backend cuma
// bikinin "session URL" ke Google Drive -- file binary-nya sendiri
// di-PUT LANGSUNG dari browser ke URL itu, gak lewat server kita sama
// sekali. Dipakai oleh api/settings.js (action=articleUploadSession),
// lihat artikel.html untuk cara pakainya di sisi client.
//
// Return: { uploadUrl, fileId (baru diketahui SETELAH upload selesai --
// client harus parse response upload terakhir untuk dapat fileId final,
// lihat komentar di artikel.html).
async function createResumableUploadSession(fileName, mimeType, fileSizeBytes, origin) {
  const accessToken = await getAccessToken();

  const metadata = { name: fileName || `artikel-${Date.now()}` };
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID ? process.env.GOOGLE_DRIVE_FOLDER_ID.trim() : '';
  if (folderId) metadata.parents = [folderId];

  // PENTING: sesi resumable HARUS dibuat dengan header Origin yang sama
  // dengan domain yang nanti melakukan PUT langsung dari browser. Tanpa
  // ini, Google tidak akan mengizinkan request PUT cross-origin dari
  // browser (CORS ditolak diam-diam) -- browser gagal dengan error
  // generik "Failed to fetch". Ini akar masalah upload foto artikel gagal.
  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
        ...(fileSizeBytes ? { 'X-Upload-Content-Length': String(fileSizeBytes) } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Gagal buat sesi upload Drive (status ${resp.status}): ${text || 'unknown error'}`);
  }

  const uploadUrl = resp.headers.get('location');
  if (!uploadUrl) throw new Error('Google Drive tidak mengembalikan upload URL (header Location kosong).');
  return { uploadUrl };
}

// Set permission publik "anyone with link can view" untuk 1 file --
// dipakai SETELAH upload resumable dari client selesai (client kirim
// fileId final ke articleCreate/articleUpdate), supaya video/foto
// artikel bisa ditampilkan langsung tanpa login Google.
async function makeFilePublic(fileId) {
  const accessToken = await getAccessToken();
  await fetch(PERMISSIONS_URL_TMPL(fileId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  }).catch((err) => console.error('Set permission publik gagal:', err.message));
}

// Daftar file TERBESAR yang pernah diupload app ini ke Drive -- dipakai
// halaman detail storage khusus admin (admin-storage-drive.html) supaya
// admin bisa lihat file mana yang paling makan kuota, bukan cuma persentase
// total. Dibatasi ke folder app (GOOGLE_DRIVE_FOLDER_ID) kalau ada, biar
// tidak ikut narik file lain yang tidak terkait di akun Drive yang sama.
async function listLargestDriveFiles(limit = 25) {
  const accessToken = await getAccessToken();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID ? process.env.GOOGLE_DRIVE_FOLDER_ID.trim() : '';
  const q = folderId ? `'${folderId}' in parents and trashed = false` : 'trashed = false';
  const params = new URLSearchParams({
    q,
    orderBy: 'quotaBytesUsed desc',
    pageSize: String(limit),
    fields: 'files(id,name,mimeType,size,quotaBytesUsed,createdTime,webViewLink)',
  });
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Gagal ambil daftar file Drive (status ${resp.status}): ${(data.error && data.error.message) || 'unknown error'}`);
  }
  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    bytes: Number(f.quotaBytesUsed || f.size || 0),
    createdTime: f.createdTime,
    webViewLink: f.webViewLink,
  }));
}

module.exports = {
  uploadPhotoToDrive,
  downloadFileAsDataUrl,
  getAccessToken,
  getDriveStorageInfo,
  createResumableUploadSession,
  makeFilePublic,
  listLargestDriveFiles,
};
