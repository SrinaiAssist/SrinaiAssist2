/* ============================================================
   back-nav.js
   ------------------------------------------------------------
   SrinaiAssist2 adalah multi-page app (setiap halaman = full
   page load, bukan SPA), jadi WebView history bawaan kadang
   tidak bisa diandalkan (mis. setelah auth-guard redirect yang
   mengganti riwayat, atau setelah reload). File ini bikin
   "stack" navigasi sendiri lewat sessionStorage, dipakai oleh:

   1. Tombol back di UI (elemen .back-btn) -> panggil smartBack()
   2. Tombol/gesture back bawaan Android -> lewat Capacitor App
      plugin, supaya tidak langsung keluar aplikasi.

   Wajib di-include SETELAH js/auth.js di setiap halaman.
   ============================================================ */
(function () {
  var STACK_KEY = "__srinai_nav_stack";
  var ROOT_PAGES = ["dashboard.html", "index.html", ""];

  function currentPage() {
    var p = location.pathname.split("/").pop();
    return p || "index.html";
  }

  function getStack() {
    try {
      var s = JSON.parse(sessionStorage.getItem(STACK_KEY));
      return Array.isArray(s) ? s : [];
    } catch (e) {
      return [];
    }
  }

  function setStack(s) {
    try { sessionStorage.setItem(STACK_KEY, JSON.stringify(s)); } catch (e) {}
  }

  (function trackEntry() {
    var page = currentPage();
    var stack = getStack();
    var top = stack[stack.length - 1];

    if (top === page) {
      // reload halaman yang sama, tidak perlu diubah
      return;
    }
    var second = stack[stack.length - 2];
    if (second === page) {
      // ini navigasi "mundur" beneran (user balik ke halaman sebelumnya)
      stack.pop();
    } else {
      stack.push(page);
    }
    // batasi biar sessionStorage tidak membengkak
    if (stack.length > 30) stack = stack.slice(stack.length - 30);
    setStack(stack);
  })();

  // Dipanggil dari tombol back di UI (.back-btn) maupun hardware back.
  window.smartBack = function (fallback) {
    var stack = getStack();
    if (stack.length > 1) {
      stack.pop(); // buang halaman sekarang
      var prev = stack[stack.length - 1];
      setStack(stack);
      location.href = prev;
    } else {
      location.href = fallback || "dashboard.html";
    }
  };

  var exitArmed = false;

  function handleHardwareBack() {
    var page = currentPage();
    var isRoot = ROOT_PAGES.indexOf(page) !== -1;

    if (isRoot) {
      // Di halaman utama (dashboard/login), tombol back Android
      // dibuat perlu ditekan 2x biar tidak keluar aplikasi tanpa
      // sengaja saat cuma mau tap sesuatu.
      if (exitArmed) {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
          window.Capacitor.Plugins.App.exitApp();
        }
        return;
      }
      exitArmed = true;
      if (window.showToast) {
        window.showToast("Tekan sekali lagi untuk keluar");
      }
      setTimeout(function () { exitArmed = false; }, 2000);
      return;
    }

    window.smartBack("dashboard.html");
  }

  function bindHardwareBack() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      window.Capacitor.Plugins.App.addListener("backButton", handleHardwareBack);
    }
  }

  if (window.Capacitor) {
    bindHardwareBack();
  } else {
    document.addEventListener("deviceready", bindHardwareBack, false);
  }

  // Sembunyikan native splash screen setelah halaman benar-benar siap
  // (bukan cuma DOM parsed, tapi paint pertama sudah terjadi), supaya
  // yang terlihat saat buka app adalah splash bermerk, bukan layar
  // navy kosong selagi menunggu load dari server.
  function hideSplash() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SplashScreen) {
      window.Capacitor.Plugins.SplashScreen.hide();
    }
  }
  function scheduleSplashHide() {
    // requestAnimationFrame x2 supaya nunggu 1 frame benar-benar tercat
    requestAnimationFrame(function () {
      requestAnimationFrame(hideSplash);
    });
  }
  if (document.readyState === "complete") {
    scheduleSplashHide();
  } else {
    window.addEventListener("load", scheduleSplashHide, { once: true });
  }
})();
