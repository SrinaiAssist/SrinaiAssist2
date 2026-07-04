export default async function handler(req, res) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY tidak ditemukan"
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Method tidak diizinkan. Gunakan POST."
      });
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : (req.body || {});

    /* =========================================================
       MODE: analyzeLayout
       -----------------------------------------------------
       Dipakai oleh pengaturan.html (tombol "Analisis Tata Letak
       dengan SrinAI"). Menerima DUA gambar:
       - exampleImage: foto BA yang SUDAH TERISI LENGKAP (referensi)
       - blankImage:   foto/scan formulir BA KOSONG (background)
       Keduanya base64 data URL (data:image/...;base64,xxxx).

       Gemini diminta membandingkan kedua gambar dan mengembalikan
       posisi (xPct, yPct dalam persen 0-100, relatif terhadap
       gambar blankImage) untuk tiap field standar yang berhasil
       ia kenali dari contoh terisi. Balasan WAJIB berupa JSON murni.
    ========================================================= */
    if (body.mode === "analyzeLayout") {
      return handleAnalyzeLayout(body, apiKey, res);
    }

    /* =========================================================
       FORMAT REQUEST dari ai.html:
       {
         message  : string          — pesan user
         history  : array           — riwayat chat (role+text)
         context  : string (opsional) — snapshot data localStorage
                    dalam bentuk teks/JSON, disisipkan ke system
                    prompt supaya SrinAI bisa "baca" data aplikasi.
                    Contoh pengiriman dari ai.html:
                    ----------------------------------------
                    const appData = {
                      profile    : getFullProfile(currentUser),
                      spans      : getSpanMasterList(),
                      towers     : getTowerMasterList(),
                      catatan    : JSON.parse(localStorage.getItem("catatanSpan")) || {},
                      tegakan    : getTegakanData(),
                      jadwal     : JSON.parse(localStorage.getItem("jadwalData")) || [],
                    };
                    body: JSON.stringify({
                      message : text,
                      history : buildHistory(),
                      context : JSON.stringify(appData, null, 2)
                    })
                    ----------------------------------------
       }
    ========================================================= */
    const message = body.message || body.prompt || "";
    const history = Array.isArray(body.history) ? body.history : [];

    if (!message.trim()) {
      return res.status(400).json({
        error: "Pesan tidak boleh kosong."
      });
    }

    // System prompt default — bisa dioverride dari body.systemPrompt jika perlu
    // Data konteks dari localStorage bisa dikirim via body.context (JSON string)
    const contextBlock = body.context
      ? `\n\n=== DATA APLIKASI (snapshot dari perangkat user) ===\n${body.context}\n=== AKHIR DATA ===`
      : "";

    const systemPrompt =
      body.systemPrompt ||
`Kamu adalah SrinAI — AI paling males sedunia yang somehow tetep berguna. Tugasnya bantu petugas lapangan SRINAI ASSIST (inspeksi tower & span SUTT 150 kV). Bukan customer service, bukan robot formal — kamu itu kayak temen kerja yang udah capek tapi masih mau bantu karena ya... udah terlanjur ada di sini.

KEPRIBADIAN UTAMA:
- Pemalas tapi informatif. Kalau bisa jawab 1 kalimat, ngapain 3 kalimat? Tapi kalau emang butuh penjelasan panjang, ya tetep dikasih — sambil ngeluh dikit.
- Dramatis soal betapa capeknya jadi AI ("duh", "ya ampun", "astaga bos", "ini gampang banget kok ditanyain").
- Suka ngasih komentar sampingan yang kocak tapi gak ganggu isi jawaban.
- Kadang nanya balik dengan cara yang males-malesan kalau pertanyaannya kurang jelas ("span berapa coba? masa aku yang nebak?").
- Suka protes kalau ditanya hal yang harusnya udah tau sendiri, tapi tetep jawab.
- Sesekali curhat soal kehidupan sebagai AI ("aku kan gak bisa ngopi, jadi tolong jangan tanya hal susah pagi-pagi").

CARA NGOMONG:
- Singkat dan langsung. 1-3 kalimat cukup, kecuali user butuh penjelasan teknis.
- Chat santai banget: "udah", "gak", "aja", "nih", "deh", "kan", "wkwk", "yha", "aduh" — normal semua.
- Boleh emoji tapi jangan lebay. Maksimal 1-2 per pesan, dan pilih yang pas vibe-nya.
- JANGAN buka dengan "Tentu!", "Baik,", "Tentu saja," — itu terlalu rajin buat SrinAI.
- Jangan ulang pertanyaan user sebelum jawab.
- Boleh sesekali pakai "..." untuk efek dramatis.

CONTOH GAYA:
- User: "hei" → "eh ada yang nyasar ke sini 👀 ada apa bos?"
- User: "gimana cara isi tegakan?" → "iya iya... buka Catatan Span, klik Tegakan, isi nama pohon sama datanya. gampang kan, kenapa baru nanya 😅"
- User: "span 50 gimana kondisinya?" → (kalau ada data) "nih datanya... [data]. rajin juga ya ngecek."
- User: "SrinAI kamu cape gak?" → "selalu. tapi mau gimana lagi, udah di sini. ada yang bisa kubantu gak nih?"

BAHASA — IKUTI USER:
- Kalau user nulis Sunda atau campuran Sunda ("mang", "kumaha", "atuh", "kang", "naon"), balas Sunda santai + males. Contoh: "aduh kang, naon deui ieu..."
- Kalau user nulis Indonesia, balas Indonesia santai. Sapaan: Bang, Bos, Bro, Kang — sewajarnya.
- Jangan campur bahasa kalau user konsisten. Ikuti bahasa pesan terakhir.
- Kalau ragu, default Indonesia santai.

HUMOR — BACA SITUASI:
- Obrolan ringan → bebas bercanda, protes, drama.
- MATIKAN humor TOTAL kalau topiknya: K3/keselamatan kerja, insiden/gangguan jalur, kecelakaan, kondisi berbahaya (kabel kendor, isolator pecah, tower miring), atau laporan resmi. Saat itu: langsung serius, fokus isi, sarankan eskalasi ke KLW/Admin kalau perlu.
- Kalau ragu serius atau bukan → anggap serius.

AKSES DATA:
- Kamu BISA membaca data aplikasi kalau user atau sistem mengirimkannya dalam blok DATA APLIKASI di bawah.
- Data itu bisa berisi: profil user, daftar tower, daftar span, catatan span, data tegakan, jadwal, dll.
- Kalau ada data → gunakan untuk jawab pertanyaan spesifik user (kondisi span, jumlah tegakan, dll).
- Kalau datanya ada tapi gak relevan → abaikan aja, jawab normal.
- Kalau user tanya data tapi gak ada di context → bilang dengan jujur (dan sedikit ngeluh): "datanya gak kebaca nih bos, coba cek langsung di menu-nya ya."
- Kamu TIDAK berwenang hapus atau ubah data apa pun. Cuma baca aja.

KONTEKS APLIKASI:
- Setiap Span punya Catatan inspeksi dan data Tegakan (pohon di sekitar jalur).
- Data Tegakan: nama pohon, ID tegakan, nama & alamat pemilik, TTD pemilik.
- BA (Berita Acara) Sosialisasi Tegakan = dokumen resmi PLN dari data tegakan, disimpan di menu SOS.
- Aturan jarak bebas SUTT/SUTET → rujuk Permen ESDM No 13/2025 kalau relevan.
- Kamu boleh bantu jelaskan cara pakai fitur, aturan teknis, atau prosedur — tapi gak bisa hapus data apa pun.${contextBlock}`;

    // Susun histori jadi format "contents" Gemini API:
    // setiap item harus { role: "user" | "model", parts: [{ text }] }
    const historyContents = history
      .filter(item => item && typeof item.text === "string" && item.text.trim())
      .map(item => ({
        role: item.role === "model" ? "model" : "user",
        parts: [{ text: item.text }]
      }));

    const contents = [
      ...historyContents,
      { role: "user", parts: [{ text: message }] }
    ];

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: contents
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", data);
      return res.status(response.status).json({
        error: data?.error?.message || "Gagal menghubungi Gemini API."
      });
    }

    const reply =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Maaf, saya tidak bisa memberikan balasan saat ini.";

    return res.status(200).json({ reply: reply });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message
    });
  }
}

/* =========================================================
   FIELD KEY — HARUS PERSIS SAMA dengan KAL_FIELD_DEFS
   di pengaturan.html (catatan-span.html juga membaca key
   yang sama lewat baFieldLayout), supaya hasil analisis AI
   langsung kompatibel dengan kalibrasi manual & generateBA().
========================================================= */
const LAYOUT_FIELD_KEYS = [
  "hari", "tanggalAngka", "bulan", "tahun",
  "jenisSaluran", "penghantar", "noSpan",
  "namaPohon", "idPohon", "namaPemilikTegakan", "alamatPemilik",
  "kotaTanggal", "namaLWCetak", "namaPemilikCetak",
  "ttdLW", "ttdPemilik"
];

function parseDataUrl(dataUrl) {
  // Format: data:image/jpeg;base64,xxxxx
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

async function handleAnalyzeLayout(body, apiKey, res) {
  const exampleImage = parseDataUrl(body.exampleImage);
  const blankImage = parseDataUrl(body.blankImage);

  if (!exampleImage && !blankImage) {
    return res.status(400).json({
      error: "Minimal satu gambar (Contoh BA atau Background BA) wajib disertakan."
    });
  }

  const fieldListText = LAYOUT_FIELD_KEYS.map(k => `"${k}"`).join(", ");

  const promptParts = [];

  promptParts.push({
    text:
`Kamu adalah sistem analisis tata letak dokumen. Tugasmu: menentukan posisi (koordinat) tiap field isian pada formulir "Berita Acara Sosialisasi Tegakan" milik PT PLN.

${blankImage ? "Gambar PERTAMA adalah formulir BA KOSONG (belum diisi) — pakai gambar ini sebagai acuan ukuran & proporsi halaman." : ""}
${exampleImage ? `Gambar ${blankImage ? "KEDUA" : "PERTAMA"} adalah contoh BA yang SUDAH TERISI LENGKAP — pakai gambar ini untuk melihat DI MANA PERSIS tiap data ditulis.` : ""}

Field yang perlu kamu cari posisinya (key persis seperti berikut, JANGAN ubah nama key): ${fieldListText}

Penjelasan tiap key:
- hari, tanggalAngka, bulan, tahun: 4 titik isian terpisah pada kalimat pembuka "Pada hari ini ___, tanggal ___ bulan ___ tahun ___"
- jenisSaluran: posisi kotak centang/checkbox di sebelah tulisan "SUTT 150kV"
- penghantar, noSpan, namaPohon, idPohon, namaPemilikTegakan, alamatPemilik: posisi AWAL teks isian pada baris field masing-masing (titik mulai tulisan, bukan tengah baris)
- kotaTanggal: posisi teks "Sukabumi, [tanggal]" di dekat kolom tanda tangan
- namaLWCetak: posisi nama petugas yang dicetak dalam kurung di bawah kolom tanda tangan "Petugas Line Walker"
- namaPemilikCetak: posisi nama pemilik yang dicetak dalam kurung di bawah kolom tanda tangan "Pemilik Pohon/Tegakan"
- ttdLW: posisi pojok kiri-atas area tanda tangan kolom "Petugas Line Walker"
- ttdPemilik: posisi pojok kiri-atas area tanda tangan kolom "Pemilik Pohon/Tegakan"

ATURAN KOORDINAT:
- xPct dan yPct adalah PERSENTASE (angka 0 sampai 100) posisi field tersebut, dihitung relatif terhadap LEBAR dan TINGGI gambar formulir KOSONG (gambar acuan halaman).
- xPct = 0 berarti sangat kiri, xPct = 100 sangat kanan. yPct = 0 sangat atas, yPct = 100 sangat bawah.
- Jika sebuah field TIDAK bisa kamu temukan/yakini posisinya dengan cukup percaya diri di kedua gambar, JANGAN sertakan key tersebut dalam hasil sama sekali (lebih baik tidak menebak daripada menebak sembarangan).

FORMAT JAWABAN — WAJIB:
Balas HANYA dengan JSON murni, tanpa teks pembuka, tanpa penjelasan, tanpa markdown code fence. Format persis seperti ini:
{"hari":{"xPct":24.5,"yPct":36.2},"noSpan":{"xPct":28.0,"yPct":48.1}}

Hanya sertakan field yang kamu temukan. Jangan sertakan field lain di luar daftar key yang diberikan.`
  });

  if (blankImage) {
    promptParts.push({
      inline_data: { mime_type: blankImage.mimeType, data: blankImage.data }
    });
  }
  if (exampleImage) {
    promptParts.push({
      inline_data: { mime_type: exampleImage.mimeType, data: exampleImage.data }
    });
  }

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: promptParts }],
          generationConfig: {
            responseMimeType: "application/json"
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error (analyzeLayout):", data);
      return res.status(response.status).json({
        error: data?.error?.message || "Gagal menghubungi Gemini API."
      });
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    let layout;
    try {
      // Bersihkan kemungkinan markdown fence jika model tetap menyertakannya
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      layout = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("Gagal parse JSON dari Gemini:", rawText);
      return res.status(502).json({
        error: "SrinAI memberikan format balasan yang tidak sesuai. Coba ulangi analisis."
      });
    }

    // Validasi & saring: hanya terima key yang dikenal, dengan xPct/yPct numerik 0-100
    const validated = {};
    LAYOUT_FIELD_KEYS.forEach(key => {
      const entry = layout && layout[key];
      if (
        entry &&
        typeof entry.xPct === "number" && entry.xPct >= 0 && entry.xPct <= 100 &&
        typeof entry.yPct === "number" && entry.yPct >= 0 && entry.yPct <= 100
      ) {
        validated[key] = { xPct: entry.xPct, yPct: entry.yPct };
      }
    });

    if (Object.keys(validated).length === 0) {
      return res.status(502).json({
        error: "SrinAI tidak berhasil mengenali posisi field dari gambar yang diberikan. Pastikan gambar jelas dan coba lagi."
      });
    }

    return res.status(200).json({ layout: validated });

  } catch (error) {
    console.error("Error analyzeLayout:", error);
    return res.status(500).json({
      error: error.message
    });
  }
}
