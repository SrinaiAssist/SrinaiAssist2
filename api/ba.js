// api/ba.js
//
// GET    /api/ba?spanId=..                 -> list BA untuk satu span
// GET    /api/ba                           -> list SEMUA BA (untuk menu SOS)
// POST   /api/ba                           -> simpan BA baru
//        body: { spanId, judul, pemilik, jumlahTegakan, namaTegakan,
//                pdf, foto, fileName, sumber, uploader }
// DELETE /api/ba?id=..                     -> hapus satu BA
//
// PENTING (data transfer Neon): pdf & foto TIDAK LAGI disimpan sebagai base64
// langsung di Postgres. Kalau berupa data URL base64 (dari upload di browser),
// file diupload dulu ke Google Drive lewat lib/googleDrive.js, dan yang
// disimpan di DB cuma URL-nya (beberapa puluh karakter, bukan puluhan/ratusan
// KB). Ini juga memperbaiki fitur "View PDF" yang sebelumnya memakai Google
// Docs Viewer (butuh URL yang bisa diakses publik, tidak bisa data URL base64).
// Kalau kredensial Drive belum diset / upload gagal, fallback simpan base64
// seperti semula supaya fitur tetap jalan (sama seperti api/catatan-span.js).

const { sql } = require('../lib/db');
const { uploadPhotoToDrive } = require('../lib/googleDrive');

function mapRow(r) {
  return {
    id: Number(r.id),
    span: r.span,
    judul: r.judul,
    pemilik: r.pemilik,
    jumlahTegakan: r.jumlahTegakan,
    namaTegakan: r.namaTegakan,
    pdf: r.pdf,
    foto: r.foto || [],
    fileName: r.fileName,
    sumber: r.sumber,
    uploader: r.uploader,
    tanggal: r.tanggal,
  };
}

// Upload 1 file (pdf ATAU foto, sama-sama data URL base64) ke Drive.
// uploadPhotoToDrive sebenarnya generic (baca mimeType dari data URL-nya
// sendiri), jadi aman dipakai untuk PDF juga, bukan cuma gambar.
// Return: URL final yang disimpan ke DB (Drive link kalau sukses, base64 asli
// kalau upload gagal / bukan data URL).
async function resolveFileUrl(dataUrlOrUrl, fileNamePrefix, warnings) {
  if (!dataUrlOrUrl || typeof dataUrlOrUrl !== 'string' || !dataUrlOrUrl.startsWith('data:')) {
    return dataUrlOrUrl || null; // sudah berupa URL (edit tanpa ganti file), atau kosong
  }
  try {
    const isPdf = dataUrlOrUrl.startsWith('data:application/pdf');
    const ext = isPdf ? 'pdf' : 'jpg';
    const uploaded = await uploadPhotoToDrive(dataUrlOrUrl, `${fileNamePrefix}-${Date.now()}.${ext}`);
    // PDF: pakai link download langsung supaya bisa dipakai Google Docs Viewer
    // maupun tombol Download. Foto: pakai thumbUrl supaya <img src> tetap ringan.
    return isPdf
      ? `https://drive.google.com/uc?export=download&id=${uploaded.fileId}`
      : uploaded.thumbUrl;
  } catch (driveErr) {
    console.error('Upload BA ke Drive gagal, fallback simpan base64:', driveErr.message);
    warnings.push(driveErr.message);
    return dataUrlOrUrl; // fallback: simpan base64 asli seperti semula
  }
}

module.exports = async (req, res) => {
  try {
    const { spanId: qSpanId, id: qId } = req.query || {};

    if (req.method === 'GET') {
      const rows = qSpanId
        ? await sql`
            SELECT
              id, span_id AS span, judul, pemilik,
              jumlah_tegakan AS "jumlahTegakan", nama_tegakan AS "namaTegakan",
              pdf, foto, file_name AS "fileName", sumber, uploader,
              to_char(created_at, 'DD-MM-YYYY') AS tanggal
            FROM ba_dokumen
            WHERE span_id = ${qSpanId}
            ORDER BY created_at DESC
          `
        : await sql`
            SELECT
              id, span_id AS span, judul, pemilik,
              jumlah_tegakan AS "jumlahTegakan", nama_tegakan AS "namaTegakan",
              pdf, foto, file_name AS "fileName", sumber, uploader,
              to_char(created_at, 'DD-MM-YYYY') AS tanggal
            FROM ba_dokumen
            ORDER BY created_at DESC
          `;
      return res.status(200).json({ success: true, ba: rows.map(mapRow) });
    }

    if (req.method === 'POST') {
      const {
        spanId, judul, pemilik, jumlahTegakan, namaTegakan,
        pdf, foto, fileName, sumber, uploader,
      } = req.body || {};

      if (!spanId || (!pdf && (!foto || foto.length === 0)) || !uploader) {
        return res.status(400).json({ success: false, message: 'spanId, salah satu dari pdf/foto, dan uploader wajib diisi.' });
      }

      const driveWarnings = [];
      const pdfToSave = await resolveFileUrl(pdf, `ba-${spanId}`, driveWarnings);
      const fotoToSave = [];
      for (const f of (foto || [])) {
        fotoToSave.push(await resolveFileUrl(f, `ba-${spanId}`, driveWarnings));
      }

      const id = Date.now();
      await sql`
        INSERT INTO ba_dokumen (
          id, span_id, judul, pemilik, jumlah_tegakan, nama_tegakan,
          pdf, foto, file_name, sumber, uploader
        ) VALUES (
          ${id}, ${spanId}, ${judul || null}, ${pemilik || null}, ${jumlahTegakan || 0}, ${namaTegakan || null},
          ${pdfToSave}, ${JSON.stringify(fotoToSave)}, ${fileName || null}, ${sumber || 'manual'}, ${uploader}
        )
      `;
      return res.status(200).json({ success: true, id, pdf: pdfToSave, driveWarning: driveWarnings[0] || null });
    }

    // PUT /api/ba  — edit metadata BA (judul, pemilik, fileName, pdf, foto)
    // body: { id, judul?, pemilik?, fileName?, pdf?, foto? }
    if (req.method === 'PUT') {
      const { id, judul, pemilik, fileName, pdf, foto } = req.body || {};
      if (!id) return res.status(400).json({ success: false, message: 'id wajib diisi.' });

      // Ambil data lama supaya field yang tidak dikirim tidak tertimpa NULL
      const existing = await sql`SELECT * FROM ba_dokumen WHERE id = ${id}`;
      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'BA tidak ditemukan.' });
      }
      const old = existing[0];

      const driveWarnings = [];
      const pdfToSave = pdf !== undefined ? await resolveFileUrl(pdf, `ba-${old.span_id}`, driveWarnings) : old.pdf;
      let fotoToSave = old.foto;
      if (foto !== undefined) {
        fotoToSave = [];
        for (const f of (foto || [])) {
          fotoToSave.push(await resolveFileUrl(f, `ba-${old.span_id}`, driveWarnings));
        }
      }

      await sql`
        UPDATE ba_dokumen SET
          judul      = ${judul      !== undefined ? judul      : old.judul},
          pemilik    = ${pemilik    !== undefined ? pemilik    : old.pemilik},
          file_name  = ${fileName   !== undefined ? fileName   : old.file_name},
          pdf        = ${pdfToSave},
          foto       = ${JSON.stringify(fotoToSave)}
        WHERE id = ${id}
      `;
      return res.status(200).json({ success: true, driveWarning: driveWarnings[0] || null });
    }

    if (req.method === 'DELETE') {
      if (!qId) return res.status(400).json({ success: false, message: 'id wajib diisi.' });
      await sql`DELETE FROM ba_dokumen WHERE id = ${qId}`;
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('BA API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
