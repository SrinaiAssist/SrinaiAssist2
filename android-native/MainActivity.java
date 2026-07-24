package com.srinai.assist;

import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocationTrackerPlugin.class);
        super.onCreate(savedInstanceState);
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Re-apply setiap kali app kembali fokus (misal setelah user swipe
        // buat munculin status/nav bar sementara, atau setelah buka app lain lalu balik lagi)
        if (hasFocus) {
            hideSystemBars();
        }
    }

    private void hideSystemBars() {
        // WindowInsetsControllerCompat adalah cara modern & stabil untuk
        // menyembunyikan status bar + navigation bar (menggantikan
        // View.SYSTEM_UI_FLAG_* yang deprecated dan tidak reliable lagi
        // di Android 12+ / edge-to-edge enforcement Android 15).
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());

        if (controller != null) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
            // Bar akan muncul sementara kalau user swipe dari tepi layar,
            // lalu otomatis sembunyi lagi (immersive sticky behavior).
            controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            );
        }
    }
}
