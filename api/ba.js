// api/ba.js
//
// GET    /api/ba?spanId=..                 -> list BA untuk satu span
// GET    /api/ba                           -> list SEMUA BA (untuk menu SOS)
// POST   /api/ba                           -> simpan BA baru
//        body: { spanId, judul, pemilik, jumlahTegakan, namaTegakan,
//                pdf, foto, fileName, sumber, uploader }
// POST   /api/ba   (action: "validateData") -> validasi data via Claude
//        SEBELUM BA dibuat/generate PDF. Tidak menyentuh database sama
//        sekali — murni cek kelengkapan & kewajaran data yang akan
//        dicetak ke dokumen resmi (field kosong, nama/alamat janggal,
//        ID tegakan duplikat, dll), supaya BA tidak terlanjur dicetak
//        & ditandatangani dengan data yang salah/kurang.
//        body: { action: "validateData", noSpan, penghantar, namaLW,
//                tegakan: [{ nama, idTegakan, pemilikNama, pemilikAlamat }] }
//        response: { success: true, ok: boolean, warnings: string[] }
//        Butuh env var ANTHROPIC_API_KEY. Kalau belum diset, endpoint ini
//        balas ok:true dengan warning penjelasan (BUKAN error 500), supaya
//        alur generate BA existing tidak pernah terblokir gara-gara fitur
//        AI tambahan ini belum dikonfigurasi.
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

// Validasi data BA pakai Claude sebelum dokumen di-generate.
// Return: { ok: boolean, warnings: string[] }
// Tidak pernah throw ke caller — kalau ada masalah (key belum ada, API
// error, dsb), balikin ok:true + warning penjelasan supaya generate BA
// yang sudah jalan sekarang TIDAK terganggu oleh fitur tambahan ini.
async function validateBADataWithClaude({ noSpan, penghantar, namaLW, tegakan }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: true, warnings: ['Validasi AI dilewati: ANTHROPIC_API_KEY belum diset di server.'] };
  }
  if (!Array.isArray(tegakan) || tegakan.length === 0) {
    return { ok: false, warnings: ['Data tegakan kosong, tidak ada yang bisa divalidasi.'] };
  }

  const dataForReview = {
    noSpan: noSpan || null,
    penghantar: penghantar || null,
    namaLW: namaLW || null,
    tegakan: tegakan.map(t => ({
      nama: t.nama || null,
      idTegakan: t.idTegakan || null,
      pemilikNama: t.pemilikNama || null,
      pemilikAlamat: t.pemilikAlamat || null,
    })),
  };

  const systemPrompt =
`Kamu adalah pemeriksa kualitas data untuk dokumen resmi "Berita Acara Sosialisasi Tegakan" milik PT PLN (jaringan SUTT 150kV). Sebelum dokumen ini dicetak dan ditandatangani oleh pemilik pohon, kamu diminta memeriksa data yang akan diisikan ke dokumen tersebut.

Periksa data JSON yang diberikan untuk hal-hal berikut:
- Field wajib yang kosong/null (nama pohon, ID tegakan, nama pemilik, alamat pemilik, no span)
- Nilai yang jelas tidak valid sebagai isian resmi (contoh: "-", "test", "asdf", angka semata untuk field nama, alamat yang terlalu singkat/tidak masuk akal)
- ID tegakan yang duplikat antar entri dalam data yang sama
- Nama pemilik yang identik tapi alamat berbeda jauh (potensi salah input), atau sebaliknya

Balas HANYA dengan JSON murni, tanpa teks lain, tanpa markdown code fence, format persis:
{"ok": true/false, "warnings": ["...", "..."]}

- "ok": false HANYA jika ada masalah yang cukup serius untuk sebaiknya dicek ulang sebelum dokumen dicetak (field wajib kosong, nilai jelas tidak valid, duplikasi ID).
- "warnings": array berisi kalimat singkat berbahasa Indonesia, tiap kalimat menjelaskan satu temuan. Kosongkan array kalau tidak ada temuan sama sekali.
- Jangan mengarang temuan yang tidak ada di data.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          { role: 'user', content: JSON.stringify(dataForReview, null, 2) },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude API error (validateData):', data);
      return { ok: true, warnings: [`Validasi AI gagal dihubungi (${data?.error?.message || 'unknown error'}), BA tetap bisa dilanjutkan manual.`] };
    }

    const rawText = (data?.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter(w => typeof w === 'string') : [];
    return { ok: parsed.ok !== false, warnings };
  } catch (err) {
    console.error('Error validateBADataWithClaude:', err);
    return { ok: true, warnings: ['Validasi AI gagal diproses, BA tetap bisa dilanjutkan manual.'] };
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

    if (req.method === 'POST' && req.body && req.body.action === 'validateData') {
      const { noSpan, penghantar, namaLW, tegakan } = req.body;
      const result = await validateBADataWithClaude({ noSpan, penghantar, namaLW, tegakan });
      return res.status(200).json({ success: true, ...result });
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
      return res.status(200).json({ success: true, id, driveWarning: driveWarnings[0] || null });
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
