/* Deteksi tema tersimpan sedini mungkin supaya halaman tidak "flash"
   tema lama sebelum CSS tema baru sempat dimuat. File ini SENGAJA
   sangat kecil dan tanpa dependency supaya bisa dimuat paling awal. */
(function () {
  try {
    if (localStorage.getItem("srinai_theme") === "fieldlog") {
      document.documentElement.classList.add("theme-fieldlog");
    }
  } catch (e) { /* localStorage tidak tersedia — abaikan, pakai tema default */ }
})();
