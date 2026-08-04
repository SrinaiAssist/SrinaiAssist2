// api/ba.js
//
// GET    /api/ba?spanId=..                 -> list BA untuk satu span
// GET    /api/ba                           -> list SEMUA BA (untuk menu SOS)
// POST   /api/ba                           -> simpan BA baru
//        body: { spanId, judul, pemilik, jumlahTegakan, namaTegakan,
//                pdf, foto, fileName, sumber, uploader }
// DELETE /api/ba?id=..                     -> hapus satu BA (baris DB +
//                                              file pdf/foto terkait di
//                                              Google Drive, best-effort)
//
// CATATAN: fitur Edit BA (ganti judul/pemilik/nama file/file/tanggal via
// scan foto) sudah DIHAPUS dari halaman sos.html -- yang tersisa cuma
// Upload dan Hapus. Endpoint PUT ikut dihapus karena sudah tidak dipakai.
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
const { uploadPhotoToDrive, extractDriveFileId, deleteFileFromDrive } = require('../lib/googleDrive');
const { sendPushToUsers } = require('../lib/pushHelper');

function mapRowFull(r) {
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

// Versi ringan untuk daftar SEMUA BA (menu SOS / widget dashboard) -- TIDAK
// ikut menarik isi pdf/foto (bisa base64 raksasa kalau upload Drive gagal
// dulu dan fallback ke base64), cukup indikator ada/tidaknya + jumlah foto.
// Halaman sos.html & dashboard.html memang tidak lagi menampilkan file-nya
// langsung (lihat catatan di atas), jadi kolom pdf/foto tidak perlu ditarik
// sama sekali di sini -- menghemat payload API & localStorage cache
// (js/sync.js) tiap kali halaman dibuka / disinkron.
function mapRowLite(r) {
  return {
    id: Number(r.id),
    span: r.span,
    judul: r.judul,
    pemilik: r.pemilik,
    jumlahTegakan: r.jumlahTegakan,
    namaTegakan: r.namaTegakan,
    hasPdf: !!r.hasPdf,
    jumlahFoto: Number(r.jumlahFoto || 0),
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
    const { spanId: qSpanId, id: qId, meta: qMeta, since: qSince } = req.query || {};

    // Mode ringan: dipakai sync.js buat cek ada perubahan atau tidak sejak
    // sync terakhir, tanpa tarik semua dokumen BA (termasuk pdf/foto) tiap
    // kali Sinkron.
    if (req.method === 'GET' && qMeta === '1') {
      const [row] = await sql`SELECT COUNT(*)::int AS count, MAX(updated_at) AS "maxUpdatedAt" FROM ba_dokumen`;
      return res.status(200).json({ success: true, meta: row });
    }

    // Mode bertahap (?since=<ISO timestamp>): hanya untuk daftar SEMUA BA
    // (tanpa spanId, dipakai syncAll()). Kirim baris lite yang berubah SEJAK
    // timestamp itu + activeIds supaya client bisa deteksi BA yang sudah
    // dihapus di server.
    if (req.method === 'GET' && qSince && !qSpanId) {
      const sinceDate = new Date(qSince);
      if (isNaN(sinceDate.getTime())) {
        return res.status(400).json({ success: false, message: 'Parameter since tidak valid.' });
      }
      const [changed, activeIdRows] = await Promise.all([
        sql`
          SELECT
            id, span_id AS span, judul, pemilik,
            jumlah_tegakan AS "jumlahTegakan", nama_tegakan AS "namaTegakan",
            (pdf IS NOT NULL) AS "hasPdf",
            COALESCE(jsonb_array_length(foto::jsonb), 0) AS "jumlahFoto",
            file_name AS "fileName", sumber, uploader,
            to_char(created_at, 'DD-MM-YYYY') AS tanggal
          FROM ba_dokumen
          WHERE updated_at > ${sinceDate}
          ORDER BY created_at DESC
        `,
        sql`SELECT id FROM ba_dokumen`,
      ]);
      return res.status(200).json({
        success: true,
        ba: changed.map(mapRowLite),
        activeIds: activeIdRows.map((r) => Number(r.id)),
      });
    }

    if (req.method === 'GET') {
      if (qSpanId) {
        const rows = await sql`
          SELECT
            id, span_id AS span, judul, pemilik,
            jumlah_tegakan AS "jumlahTegakan", nama_tegakan AS "namaTegakan",
            pdf, foto, file_name AS "fileName", sumber, uploader,
            to_char(created_at, 'DD-MM-YYYY') AS tanggal
          FROM ba_dokumen
          WHERE span_id = ${qSpanId}
          ORDER BY created_at DESC
        `;
        return res.status(200).json({ success: true, ba: rows.map(mapRowFull) });
      }

      // Daftar SEMUA BA (menu SOS / dashboard) -- lite, lihat mapRowLite().
      const rows = await sql`
        SELECT
          id, span_id AS span, judul, pemilik,
          jumlah_tegakan AS "jumlahTegakan", nama_tegakan AS "namaTegakan",
          (pdf IS NOT NULL) AS "hasPdf",
          COALESCE(jsonb_array_length(foto::jsonb), 0) AS "jumlahFoto",
          file_name AS "fileName", sumber, uploader,
          to_char(created_at, 'DD-MM-YYYY') AS tanggal
        FROM ba_dokumen
        ORDER BY created_at DESC
      `;
      return res.status(200).json({ success: true, ba: rows.map(mapRowLite) });
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
      // Notifikasi khusus BA Otomatis (dikirim dari Botlab lewat cron) --
      // BUKAN untuk BA yang disimpan manual dari catatan-span.html, karena
      // untuk kasus manual user sudah tahu/lihat langsung hasilnya di app.
      // Gagal kirim push tidak boleh menggagalkan penyimpanan BA itu sendiri.
      if (sumber === 'ba-otomatis') {
        try {
          await sendPushToUsers(
            [uploader],
            {
              title: 'BA Otomatis terkirim',
              body: `${judul || 'BA'} sudah dikirim ke Telegram.`,
              data: { type: 'ba_auto_sent', baId: String(id), spanId: String(spanId) },
              channel: 'srinai_ba_auto',
              sound: 'notif_ba_terkirim',
            },
          );
        } catch (err) {
          console.error('Gagal kirim push notifikasi BA Otomatis:', err.message);
        }

        // Notifikasi TAMBAHAN khusus Admin/KLW/Monitoring -- suara beda
        // (notif_ba_auto_monitor, lihat android-native/MainActivity.java)
        // supaya role pengawas tahu setiap kali BA Otomatis terkirim ke
        // petugas manapun, tanpa harus buka app. exclude uploader supaya
        // tidak dobel notif kalau kebetulan uploader-nya sendiri admin/klw/
        // monitor (harusnya jarang terjadi, BA Otomatis biasanya milik LW).
        try {
          const monitorRows = await sql`
            SELECT username FROM accounts WHERE role IN ('admin', 'klw', 'monitor') AND status = 'Aktif'
          `;
          await sendPushToUsers(
            monitorRows.map((r) => r.username),
            {
              title: 'BA Otomatis terkirim (Monitoring)',
              body: `${judul || 'BA'} milik ${uploader} sudah dikirim ke Telegram.`,
              data: { type: 'ba_auto_sent_monitor', baId: String(id), spanId: String(spanId), petugas: uploader },
              channel: 'srinai_ba_auto_monitor',
              sound: 'notif_ba_auto_monitor',
            },
            uploader,
          );
        } catch (err) {
          console.error('Gagal kirim push notifikasi monitoring BA Otomatis:', err.message);
        }
      }

      return res.status(200).json({ success: true, id, pdf: pdfToSave, driveWarning: driveWarnings[0] || null });
    }

    if (req.method === 'DELETE') {
      if (!qId) return res.status(400).json({ success: false, message: 'id wajib diisi.' });

      // Ambil dulu referensi pdf/foto SEBELUM baris dihapus, supaya file
      // fisiknya bisa ikut dibersihkan dari Google Drive (bukan cuma baris
      // di Neon yang hilang, filenya numpuk terus di Drive).
      const existing = await sql`SELECT pdf, foto FROM ba_dokumen WHERE id = ${qId}`;

      await sql`DELETE FROM ba_dokumen WHERE id = ${qId}`;

      if (existing.length > 0) {
        const { pdf, foto } = existing[0];
        const fileIds = [extractDriveFileId(pdf), ...((foto || []).map(extractDriveFileId))].filter(Boolean);
        // Best-effort, paralel: kalau salah satu gagal (mis. sudah dihapus
        // manual sebelumnya), tidak boleh menggagalkan response ke client
        // karena baris DB sudah terlanjur terhapus.
        await Promise.all(
          fileIds.map((fid) =>
            deleteFileFromDrive(fid).catch((err) =>
              console.error(`Gagal hapus file Drive (id=${fid}) untuk BA ${qId}:`, err.message)
            )
          )
        );
      }

      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan.' });
  } catch (err) {
    console.error('BA API error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
};
