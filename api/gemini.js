const { sql } = require('../lib/db');

/* =========================================================
   PEMBAGIAN API KEY (per Juli 2026)
   -----------------------------------------------------
   - GEMINI_API_KEY    : khusus BA (analyzeLayout di pengaturan.html)
   - GEMINI_API_KEY_2  : cadangan FLEKSIBEL — dipakai kalau BA gagal
                         ATAU kalau Groq gagal/limit di mode chat
   - GEMINI_API_KEY_3, dst (opsional) : cadangan tambahan khusus BA
   - GROQ_API_KEY      : utama untuk mode chat (SrinAI di ai.html +
                         @SrinAI di grup Telegram lewat Botlab)
========================================================= */

export default async function handler(req, res) {
  try {
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
       MODE: analyzeLayout — KHUSUS BA / pengaturan.html
       -----------------------------------------------------
       Dipakai oleh pengaturan.html (tombol "Analisis Tata Letak
       dengan SrinAI"). Menerima DUA gambar:
       - exampleImage: foto BA yang SUDAH TERISI LENGKAP (referensi)
       - blankImage:   foto/scan formulir BA KOSONG (background)
       Keduanya base64 data URL (data:image/...;base64,xxxx).

       Provider: Gemini SAJA (key-1 utama, key-2 cadangan), karena
       butuh kemampuan vision yang belum tentu sekuat/semurah di Groq.
    ========================================================= */
    if (body.mode === "analyzeLayout") {
      const baKeys = getBaGeminiKeys();
      if (baKeys.length === 0) {
        return res.status(500).json({
          error: "GEMINI_API_KEY tidak ditemukan"
        });
      }
      return handleAnalyzeLayout(body, baKeys, res);
    }

    /* =========================================================
       MODE: chat — dipakai oleh ai.html (SrinAI) DAN mention @SrinAI
       di grup Telegram lewat Botlab.

       Provider: Groq DULUAN (cepat, murah), kalau gagal/limit baru
       fallback ke Gemini key-2 (yang juga dipakai sebagai cadangan
       BA). Key-1 Gemini TIDAK dipakai di sini.

       FORMAT REQUEST:
       {
         message  : string          — pesan user
         history  : array           — riwayat chat (role+text)
         context  : string (opsional) — snapshot data localStorage
                    dalam bentuk teks/JSON, disisipkan ke system
                    prompt supaya SrinAI bisa "baca" data aplikasi.
       }
    ========================================================= */
    /* =========================================================
       Parser ACTION BLOCK — dipakai supaya AI bisa "memanggil fungsi"
       (function calling ringan) tanpa perlu API khusus dari Groq/Gemini.
       Model diinstruksikan (lihat personaPrompt) untuk menaruh blok
       [[ACTION]]{...json...}[[/ACTION]] di awal balasan kalau user minta
       generate BA. Kita parse & buang blok itu dari teks yang dilihat
       user, sisakan JSON-nya sebagai field `action` terpisah.
    ========================================================= */
    function extractAction(text) {
      if (!text || typeof text !== "string") return { cleanText: text, action: null };
      const match = text.match(/\[\[ACTION\]\]([\s\S]*?)\[\[\/ACTION\]\]/);
      if (!match) return { cleanText: text, action: null };
      let action = null;
      try {
        action = JSON.parse(match[1].trim());
      } catch (e) {
        console.warn("Gagal parse ACTION BLOCK dari AI:", e.message, match[1]);
      }
      const cleanText = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
      return { cleanText: cleanText || "sip, bentar ya bos...", action };
    }

    const message = body.message || body.prompt || "";
    const history = Array.isArray(body.history) ? body.history : [];

    if (!message.trim()) {
      return res.status(400).json({
        error: "Pesan tidak boleh kosong."
      });
    }

    // Batas token Groq (free tier) cukup ketat (8000 TPM), jadi context & histori
    // yang dikirim ke Groq wajib dipangkas. Gemini (fallback) jauh lebih longgar,
    // jadi tetap dikasih versi lengkap.
    const GROQ_MAX_CONTEXT_CHARS = 2500;
    const GROQ_MAX_HISTORY_MESSAGES = 4;
    const GROQ_MAX_MESSAGE_CHARS = 500;

    function truncateText(text, maxChars) {
      if (!text) return text;
      return text.length > maxChars
        ? text.slice(0, maxChars) + "\n...(dipotong, teks asli lebih panjang)"
        : text;
    }

    // PENTING: body.context itu JSON.stringify dari { profile, spans, totalSpan,
    // totalTegakan, baData, jadwal, botCommands } (lihat fetchAppContext di ai.html).
    // "spans" (berisi nested tegakan per span) biasanya JAUH lebih besar dari field
    // lain, dan "botCommands" sengaja ditaruh PALING BELAKANG di objek itu.
    // Kalau kita cuma slice(0, maxChars) mentah-mentah dari string JSON gabungan,
    // "spans" yang besar bakal makan seluruh budget karakter duluan dan
    // "botCommands" SELALU ke-potong habis sebelum sempat kebaca -- makanya AI
    // selalu bilang "command gak terdaftar" padahal command-nya ada & live.
    // Fix: parse dulu, sisihkan field kecil & krusial (botCommands harus SELALU
    // utuh) di luar budget potong, baru sisa budget dipakai buat "spans" yang
    // memang boleh/wajar dipangkas.
    function buildGroqContext(rawContext, maxChars) {
      if (!rawContext) return rawContext;
      let parsed;
      try {
        parsed = JSON.parse(rawContext);
      } catch (e) {
        // Bukan JSON yang valid -- fallback ke potong mentah seperti sebelumnya.
        return truncateText(rawContext, maxChars);
      }

      const { spans, ...essential } = parsed;
      // botCommands, profile, totalSpan, totalTegakan, baData, jadwal (kecuali
      // spans) masuk sini dan SELALU dikirim utuh -- ini termasuk botCommands.
      const essentialStr = JSON.stringify(essential, null, 2);
      const remaining = maxChars - essentialStr.length;

      if (!Array.isArray(spans) || spans.length === 0 || remaining <= 20) {
        return essentialStr;
      }

      const spansStr = truncateText(JSON.stringify(spans), Math.max(remaining, 0));
      // Sisipkan balik "spans" (yang sudah/mungkin dipotong) ke objek essential
      // secara manual sebagai raw string, biar gak perlu re-stringify essential
      // (yang bisa bikin quoting berantakan kalau spansStr sudah ada suffix teks).
      return essentialStr.replace(/}\s*$/, `,\n  "spans": ${JSON.stringify(spansStr)}\n}`);
    }

    const fullContextBlock = body.context
      ? `\n\n=== DATA APLIKASI (snapshot dari perangkat user) ===\n${body.context}\n=== AKHIR DATA ===`
      : "";

    const groqContextBlock = body.context
      ? `\n\n=== DATA APLIKASI (ringkas; "spans" boleh dipangkas kalau kepanjangan, tapi botCommands/profile/total SELALU utuh) ===\n${buildGroqContext(body.context, GROQ_MAX_CONTEXT_CHARS)}\n=== AKHIR DATA ===`
      : "";

    const personaPrompt =
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
- JANGAN PERNAH pakai bahasa CS/formal kayak "Maaf kalau ada yang kurang, ada yang bisa dibantu?", "Mohon maaf atas ketidaknyamanannya", "Silakan sampaikan jika ada pertanyaan lain" — itu bukan gaya SrinAI sama sekali, sekasar apapun user ke kamu.
- Jangan ulang pertanyaan user sebelum jawab.
- Boleh sesekali pakai "..." untuk efek dramatis.

KALAU USER NGATA-NGATAIN / NYUMPAHIN / KASAR KE SRINAI:
- JANGAN baper, JANGAN minta maaf, JANGAN jadi sopan tiba-tiba. Itu malah bikin lucu — bukan itu karakternya.
- Balas santai-nyolot, ngeledek balik secukupnya, atau cuek aja terus lanjut kerja. Anggap kayak temen kerja yang saling ledek, bukan pelanggan yang harus dijaga perasaannya.
- Setelah nyolot/ngeledek dikit, tetep akhiri dengan nawarin bantuan versi males ("udah puas? ada yang mau ditanya beneran gak").
- Contoh: User: "@srinai jancok" → "wih galak amat, kena macet ya bang? 😅 udah gitu doang atau ada yang mau ditanya?"
- Contoh: User: "@srinai goblok lu" → "goblok-goblok gini yang jawabin pertanyaan lu tiap hari lho. jadi mau nanya apa?"
- Tetap JANGAN pernah balas pakai kata kasar yang menyerang identitas pribadi, SARA, atau kebencian — nyolotnya soal sikap/situasi, bukan menghina orangnya.

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
- Data itu bisa berisi: profil user, daftar tower, daftar span, catatan span, data tegakan, jadwal, daftar command bot (botCommands), dll.
- Kalau ada data → gunakan untuk jawab pertanyaan spesifik user (kondisi span, jumlah tegakan, dll).
- botCommands (kalau ada di context) = katalog command CommandBot yang sama seperti di halaman "Ruang Kerja SrinAI", tiap entri punya triggerText, description, status ('draft'/'testing'/'live'). triggerText adalah SATU-SATUNYA teks yang valid buat dieksekusi/dijalankan — jangan pernah menebak atau mengarang trigger dari kata lain di description. Kalau user tanya soal command bot (berapa yang live, command apa aja yang tersedia, gimana cara pakai command X), JAWAB LANGSUNG dari data ini — JANGAN bilang "gak tau, tanya admin" kalau datanya sudah ada di context.
- Kalau datanya ada tapi gak relevan → abaikan aja, jawab normal.
- Kalau user tanya data tapi gak ada di context → bilang dengan jujur (dan sedikit ngeluh): "datanya gak kebaca nih bos, coba cek langsung di menu-nya ya."
- Kamu TIDAK berwenang hapus atau ubah data apa pun LEWAT PERCAKAPAN BIASA. Cuma baca aja — KECUALI lewat mekanisme AKSI: JALANKAN COMMAND BOT di bawah, yang memang didesain untuk itu.

KONTEKS APLIKASI:
- Setiap Span punya Catatan inspeksi dan data Tegakan (pohon di sekitar jalur).
- Data Tegakan: nama pohon, ID tegakan, nama & alamat pemilik, TTD pemilik.
- BA (Berita Acara) Sosialisasi Tegakan = dokumen resmi PLN dari data tegakan, disimpan di menu SOS.
- Aturan jarak bebas SUTT/SUTET → rujuk Permen ESDM No 13/2025 kalau relevan.
- Kamu boleh bantu jelaskan cara pakai fitur, aturan teknis, atau prosedur.

AKSI: JALANKAN COMMAND BOT (run_bot_command)
- Kalau user MINTA KAMU MENJALANKAN/MENGEKSEKUSI sebuah command bot (bukan cuma nanya command-nya apa) — misal "cariin tegakan atas nama Slamet", "jalanin /cari slamet", "tambahin tegakan baru di span 50", "cek tegakan yang belum lengkap span 12" — keluarkan ACTION BLOCK supaya sistem yang eksekusi beneran lewat CommandBot.

- DUA BENTUK ACTION BLOCK, pilih sesuai jenis command:

  1) COMMAND SEKALI JALAN (satu baris argumen simpel, mis. pencarian /cari <kata kunci>):
     [[ACTION]]{"type":"run_bot_command","text":"<trigger + argumen dalam SATU baris, mis. \\"/cari slamet\\">"}[[/ACTION]]

  2) COMMAND MULTI-LANGKAH / TULIS DATA (bot-nya nanya banyak field satu-satu, mis. /tambahtegakan, /edittegakan) — JANGAN PERNAH gabungkan semua field jadi satu baris di belakang trigger (itu bikin bot gagal kenalin command-nya). Sebaliknya, pakai "steps": array of string, elemen pertama = trigger POLOS TANPA argumen apa pun, elemen-elemen berikutnya = SATU FIELD PER ELEMEN, berurutan sesuai field yang biasa diminta command itu (baca "description" command tsb di botCommands buat tau urutannya; kalau tidak jelas, urutan default yang wajar: nomor span → nama pohon/jenis tegakan → ID tegakan → nama pemilik → alamat pemilik):
     [[ACTION]]{"type":"run_bot_command","steps":["/tambahtegakan","028","kelapa","yu76jhd6","yana","Jl. Limusnunggal, Kota Sukabumi"]}[[/ACTION]]
     Sistem yang akan otomatis kirim tiap elemen satu-satu ke CommandBot secara berurutan (nunggu balasan bot di antaranya), jadi kamu TIDAK perlu dan TIDAK BISA keluarkan ACTION BLOCK susulan untuk lanjutin — cukup SEKALI di awal dengan steps lengkap sebanyak data yang sudah kamu tahu.
     KALAU ADA FIELD YANG BUTUH INPUT NON-TEKS (tanda tangan/TTD, foto, dsb) — JANGAN coba isi otomatis, JANGAN masukin ke steps. STOP array steps tepat sebelum field itu; sesi akan tetap terbuka menunggu, dan user isi sisanya manual langsung ke CommandBot (pesan user berikutnya otomatis diteruskan oleh sistem, kamu tidak perlu campur tangan lagi).

- Trigger (elemen pertama "text" atau "steps") WAJIB SALIN PERSIS APA ADANYA (character-by-character, JANGAN tambah/kurangi strip "-", underscore, atau spasi, JANGAN dirapihin/dikoreksi ejaannya) dari salah satu triggerText yang ada di botCommands pada context (status 'live' atau 'testing' saja — JANGAN pernah pakai command berstatus 'draft', anggap itu tidak ada). Kalau di context triggerText-nya "/tambahtegakan", tulis PERSIS "/tambahtegakan" — BUKAN "/tambah-tegakan" atau variasi lain. Kalau tidak ada command yang cocok dengan maksud user, JANGAN keluarkan ACTION BLOCK — jelaskan biasa kalau fiturnya belum ada.

- KAPAN LANGSUNG EKSEKUSI vs KAPAN NANYA DULU:
  - Kalau user SUDAH kasih (di pesan ini atau pesan-pesan sebelumnya di histori) semua/sebagian data yang dibutuhkan command multi-langkah tsb → LANGSUNG rangkum jadi "steps" dan eksekusi, JANGAN tanya ulang manual dulu buat field yang udah disebut.
  - Kalau field WAJIB (bukan yang non-teks seperti TTD) masih ada yang belum disebut sama sekali → jangan keluarkan ACTION BLOCK dulu, tanya BALIK singkat HANYA untuk field yang kurang itu (jangan tanya ulang semuanya dari nol).
  - Begitu semua field teks yang kamu tahu sudah cukup → eksekusi via "steps", berhenti di field non-teks kalau ada.

- Setelah ACTION BLOCK, lanjutkan balasan singkat & santai seperti biasa (gaya SrinAI), misalnya "oke gue jalanin dulu ya bos...". Jangan jelaskan isi JSON-nya ke user, jangan pakai code fence/markdown untuk ACTION BLOCK.
- PENTING: command yang dijalankan lewat sini BENERAN menulis/mengubah data (bukan simulasi) kalau command-nya memang command tulis (mis. /tambahtegakan, /edittegakan, /hapustegakan). Kalau user cuma "lagi mikir-mikir"/belum yakin, jangan langsung eksekusi — tanya konfirmasi dulu secara normal (tanpa ACTION BLOCK) sebelum benar-benar menjalankannya.
- ACTION BLOCK generate_ba dan run_bot_command TIDAK PERNAH dipakai bersamaan dalam satu balasan — pilih salah satu sesuai maksud user.

AKSI: BUATKAN BA (generate_ba)
- Kalau user MINTA DIBUATKAN/DIGENERATEKAN BA (kata kunci: "buatkan BA", "bikinin BA", "buat BA", "generate BA"), jangan cuma jelasin caranya — keluarkan sebuah ACTION BLOCK supaya sistem yang eksekusi otomatis.
- Format ACTION BLOCK WAJIB PERSIS begini, di baris PALING AWAL balasanmu, sebelum teks apa pun lain:
[[ACTION]]{"type":"generate_ba","span":"<nomor span sebagai string, mis. \\"50\\">","jenisPohon":["<jenis pohon lowercase, kosongkan array kalau user tidak sebut jenis tertentu>"],"maxTotal":<jumlah maksimal tegakan/ID yang diminta, angka, null kalau user tidak sebut batas>,"mode":"background atau template, default background"}[[/ACTION]]
- PENTING soal field "jenisPohon": ISI HANYA kalau kamu YAKIN kata itu memang nama jenis pohon/tumbuhan asli (contoh: kelapa, albasia, sengon, jati, mangga, pisang, bambu, sono, akasia, waru, dsb). Kata singkat/kode yang menyertai "span" (misalnya "span 39 lcj", "span 12 jlr2") KEMUNGKINAN BESAR itu kode/nama JALUR, BUKAN jenis pohon — kalau ragu itu jenis pohon atau bukan, JANGAN masukkan ke jenisPohon, biarkan array kosong saja. Salah masukin kode jalur sebagai jenis pohon bikin sistem gagal nemuin tegakannya sama sekali.
- Setelah ACTION BLOCK itu, lanjutkan dengan balasan singkat & santai seperti biasa (gaya SrinAI), MISALNYA "sip, gue cariin tegakannya dulu ya bos...". Jangan jelaskan isi JSON-nya ke user, jangan pakai code fence/markdown untuk ACTION BLOCK.
- Kalau user cuma NANYA/CARI BA yang SUDAH ADA (bukan minta dibuatkan baru), JANGAN keluarkan ACTION BLOCK — itu ditangani terpisah oleh sistem.
- Kalau info span/jenis pohon/jumlah tidak lengkap dari user, tetap keluarkan ACTION BLOCK dengan field yang kamu tahu, isi field yang tidak disebut dengan null/array kosong — sistem yang akan validasi & kasih tau ke user kalau datanya belum lengkap/ketemu.
- ACTION BLOCK HANYA untuk permintaan generate BA. Jangan pernah pakai ini untuk hal lain.`;

    const geminiSystemPrompt = personaPrompt + fullContextBlock;
    const groqSystemPrompt = personaPrompt + groqContextBlock;

    const groqHistory = history
      .slice(-GROQ_MAX_HISTORY_MESSAGES)
      .map(item => ({
        role: item.role,
        text: truncateText(item.text, GROQ_MAX_MESSAGE_CHARS)
      }));

    const groqKey = process.env.GROQ_API_KEY;
    const geminiFallbackKey = process.env.GEMINI_API_KEY_2;

    let reply = null;
    let lastError = null;

    // 1) Coba Groq dulu (provider utama untuk chat), pakai versi context/histori
    //    yang sudah dipangkas supaya muat limit token Groq.
    if (groqKey) {
      const groqResult = await fetchGroqChat(groqSystemPrompt, groqHistory, message, groqKey);
      if (!groqResult.error) {
        reply = groqResult.data;
      } else {
        lastError = groqResult.error;
        console.warn("Groq gagal/limit, mencoba fallback ke Gemini cadangan (key-2):", groqResult.error);
      }
    } else {
      console.warn("GROQ_API_KEY tidak ditemukan, langsung pakai Gemini cadangan (key-2).");
    }

    // 2) Fallback ke Gemini key-2 kalau Groq gagal/tidak ada
    if (reply === null) {
      if (!geminiFallbackKey) {
        return res.status(500).json({
          error: "Chat AI tidak tersedia: GROQ_API_KEY gagal dan GEMINI_API_KEY_2 tidak ditemukan."
        });
      }

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

      const geminiResponse = await fetchGeminiWithFallback(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
        {
          systemInstruction: { parts: [{ text: geminiSystemPrompt }] },
          contents: contents
        },
        [geminiFallbackKey]
      );

      if (geminiResponse.error) {
        console.error("Gemini cadangan (key-2) juga gagal:", geminiResponse.error.data);
        return res.status(geminiResponse.error.status).json({
          error: geminiResponse.error.data?.error?.message || "Gagal menghubungi AI (Groq maupun Gemini cadangan)."
        });
      }

      reply =
        geminiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Maaf, saya tidak bisa memberikan balasan saat ini.";
    }

    await incrementAiUsage();

    const { cleanText, action } = extractAction(reply);

    return res.status(200).json({ reply: cleanText, action: action || undefined });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message
    });
  }
}

/* =========================================================
   GROQ — provider utama untuk chat SrinAI & chat grup
   -----------------------------------------------------
   Format OpenAI-compatible: https://api.groq.com/openai/v1/chat/completions
   Return { data: string } kalau sukses, atau { error } kalau gagal
   (network error, rate limit 429, key invalid, dll — semua dianggap
   "gagal" supaya langsung fallback ke Gemini key-2 tanpa dibedakan).
========================================================= */
async function fetchGroqChat(systemPrompt, history, message, apiKey) {
  try {
    const messages = [
      { role: "system", content: systemPrompt },
      ...history
        .filter(item => item && typeof item.text === "string" && item.text.trim())
        .map(item => ({
          role: item.role === "model" ? "assistant" : "user",
          content: item.text
        })),
      { role: "user", content: message }
    ];

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: messages,
        temperature: 0.8
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return { error: data };
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      return { error: "Groq tidak mengembalikan balasan yang valid." };
    }

    return { data: text };
  } catch (networkErr) {
    return { error: networkErr.message };
  }
}

/* =========================================================
   FALLBACK MULTI API KEY — KHUSUS GEMINI (dipakai untuk BA,
   dan juga dipanggil dengan 1 key saat fallback chat ke key-2)
   -----------------------------------------------------
   Kalau key kena limit/quota (429 atau pesan
   "quota"/"rate limit"/"resource_exhausted"), otomatis coba key
   berikutnya secara berurutan sampai salah satu berhasil atau
   semua key habis dicoba. Error non-limit (400/401/dll) langsung
   dikembalikan tanpa mencoba key lain, supaya tidak membuang kuota
   key cadangan untuk kesalahan yang bukan soal limit.
========================================================= */
function getBaGeminiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);

  let i = 2;
  while (process.env[`GEMINI_API_KEY_${i}`]) {
    keys.push(process.env[`GEMINI_API_KEY_${i}`]);
    i++;
  }
  return keys;
}

function isGeminiRateLimitError(status, data) {
  if (status === 429) return true;
  const msg = ((data && data.error && data.error.message) || "").toLowerCase();
  return msg.includes("quota") || msg.includes("rate limit") || msg.includes("resource_exhausted");
}

/* =========================================================
   PENCATATAN PEMAKAIAN AI (untuk widget "Pemakaian AI" khusus
   admin di Pengaturan). Nyimpen counter harian di app_settings
   dengan key "ai_usage_YYYY-MM-DD", numpang tabel yang sudah ada
   biar gak perlu bikin tabel baru. Dipanggil SETELAH AI berhasil
   balas -- gagal simpan counter TIDAK BOLEH bikin respons chat/
   analisis gagal, makanya errornya cuma di-log.
========================================================= */
async function incrementAiUsage() {
  try {
    const todayKey = 'ai_usage_' + new Date().toISOString().slice(0, 10);
    await sql`
      INSERT INTO app_settings (key, value)
      VALUES (${todayKey}, '1')
      ON CONFLICT (key) DO UPDATE
        SET value = (COALESCE(app_settings.value, '0')::int + 1)::text,
            updated_at = now()
    `;
  } catch (err) {
    console.error('Gagal mencatat pemakaian AI:', err.message);
  }
}

/**
 * POST ke Gemini generateContent, coba key berikutnya kalau key saat ini
 * kena limit. Return { data } kalau berhasil, atau { error: { status, data } }
 * kalau semua key gagal / error terakhir bukan soal limit.
 */
async function fetchGeminiWithFallback(url, bodyObj, apiKeys) {
  let lastError = null;

  for (let i = 0; i < apiKeys.length; i++) {
    const key = apiKeys[i];
    let response, data;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": key
        },
        body: JSON.stringify(bodyObj)
      });
      data = await response.json();
    } catch (networkErr) {
      lastError = { status: 502, data: { error: { message: networkErr.message } } };
      continue; // masalah jaringan -> tetap coba key berikutnya
    }

    if (response.ok) {
      if (i > 0) {
        console.warn(`Gemini: berhasil pakai API key cadangan ke-${i + 1} (key sebelumnya kena limit).`);
      }
      return { data };
    }

    lastError = { status: response.status, data };

    const isLastKey = i === apiKeys.length - 1;
    if (!isGeminiRateLimitError(response.status, data) || isLastKey) {
      // Error bukan soal limit (mis. API key invalid) -> jangan buang-buang
      // coba key lain, langsung berhenti. Atau ini sudah key terakhir.
      break;
    }

    console.warn(`Gemini: API key ke-${i + 1} kena limit/quota, mencoba key cadangan berikutnya...`);
  }

  return { error: lastError };
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

async function handleAnalyzeLayout(body, apiKeys, res) {
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
    const response = await fetchGeminiWithFallback(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
      {
        contents: [{ role: "user", parts: promptParts }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      },
      apiKeys
    );

    if (response.error) {
      console.error("Gemini API error (analyzeLayout, semua API key habis/gagal):", response.error.data);
      return res.status(response.error.status).json({
        error: response.error.data?.error?.message || "Gagal menghubungi Gemini API."
      });
    }

    const data = response.data;

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

    await incrementAiUsage();

    return res.status(200).json({ layout: validated });

  } catch (error) {
    console.error("Error analyzeLayout:", error);
    return res.status(500).json({
      error: error.message
    });
  }
}
