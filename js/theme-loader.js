/* Tema ditentukan ADMIN lewat Pengaturan (setting "appTheme" di
   server) — localStorage "srinai_theme" di sini HANYA cache lokal
   dari nilai server itu, supaya halaman tidak "flash" tema lama
   sebelum CSS tema baru sempat dimuat. Cache ini dikoreksi otomatis
   dari server oleh syncAdminTheme() di js/auth.js setiap halaman
   dibuka. File ini SENGAJA sangat kecil dan tanpa dependency supaya
   bisa dimuat paling awal, sebelum auth.js. */
(function () {
  try {
    if (localStorage.getItem("srinai_theme") === "fieldlog") {
      document.documentElement.classList.add("theme-fieldlog");
    }
  } catch (e) { /* localStorage tidak tersedia — abaikan, pakai tema default */ }
})();
