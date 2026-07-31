package com.srinai.assist;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Harus SAMA PERSIS dengan channel_id yang dipakai lib/firebaseAdmin.js
    // (server) saat kirim FCM message, supaya suara custom ini yang dipakai
    // dan bukan suara notifikasi default HP.
    private static final String CHANNEL_ID = "srinai_default";

    // Channel terpisah khusus notifikasi "BA Otomatis terkirim" (dipicu dari
    // api/ba.js -> pushHelper.sendPushToUsers, lihat channel: 'srinai_ba_auto').
    // HARUS channel baru, bukan numpang CHANNEL_ID di atas -- Android tidak
    // mengizinkan ganti suara sebuah channel yang sudah pernah dibuat.
    private static final String CHANNEL_ID_BA_AUTO = "srinai_ba_auto";

    // Channel khusus notifikasi ke Admin/KLW/Monitoring saat BA Otomatis
    // terkirim ke Telegram petugas (dipicu dari api/ba.js -> pushHelper
    // .sendPushToUsers, lihat channel: 'srinai_ba_auto_monitor'). Terpisah
    // dari CHANNEL_ID_BA_AUTO di atas (yang ke petugas sendiri) karena
    // suaranya beda dan supaya user bisa atur importance/matikan salah
    // satu tanpa pengaruh ke yang lain lewat Pengaturan Notifikasi Android.
    private static final String CHANNEL_ID_BA_AUTO_MONITOR = "srinai_ba_auto_monitor";

    // Channel khusus notifikasi "File baru dikirim admin lewat Telegram"
    // (dipicu dari api/settings.js -> handleTelegramBroadcastFile ->
    // pushHelper.sendPushToUsers, lihat channel: 'srinai_broadcast_file').
    // Terpisah dari channel BA Otomatis di atas karena ini fitur beda
    // (admin broadcast file manual ke telegram.html, bukan BA Otomatis cron).
    private static final String CHANNEL_ID_BROADCAST_FILE = "srinai_broadcast_file";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocationTrackerPlugin.class);
        super.onCreate(savedInstanceState);
        hideSystemBars();
        createNotificationChannel();
        createBaAutoNotificationChannel();
        createBaAutoMonitorNotificationChannel();
        createBroadcastFileNotificationChannel();
    }

    // Notification channel WAJIB dibuat sebelum notifikasi pertama muncul
    // di Android 8 (API 26) ke atas -- kalau tidak dibuat manual dengan
    // suara custom, sistem otomatis bikin channel default dengan suara
    // bawaan HP begitu FCM message pertama masuk, dan channel itu TIDAK
    // BISA diubah lagi suaranya (harus uninstall app buat reset).
    //
    // File suara "nada_notif.mp3" harus ditaruh di:
    //   android/app/src/main/res/raw/nada_notif.mp3
    // (ambil dari assets/audio/chat-reply.wav yang sudah ada, convert ke
    // .mp3 kalau perlu -- format wav juga didukung, cukup ganti nama file
    // & referensi di bawah jadi .wav).
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "SrinaiAssist - Notifikasi Umum",
                    NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("Chat baru, artikel baru, dan perubahan data tower/span");
                channel.enableVibration(true);

                Uri soundUri = Uri.parse("android.resource://" + getPackageName() + "/raw/nada_notif");
                AudioAttributes audioAttrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
                channel.setSound(soundUri, audioAttrs);

                manager.createNotificationChannel(channel);
            }
        }
    }

    // Channel khusus BA Otomatis -- suara "notif_ba_terkirim.mp3" bunyi
    // meskipun app di-background/tertutup, karena ini push notification
    // native (FCM), bukan audio yang diputar dari dalam WebView/dashboard.
    //
    // File suara harus ditaruh di:
    //   android/app/src/main/res/raw/notif_ba_terkirim.mp3
    // (salin dari android-native/res-raw/notif_ba_terkirim.mp3 di repo ini --
    // folder res-raw/ cuma tempat staging, bukan lokasi asli project Android).
    private void createBaAutoNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(CHANNEL_ID_BA_AUTO) == null) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID_BA_AUTO,
                    "SrinaiAssist - BA Otomatis Terkirim",
                    NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("Notifikasi saat BA Otomatis selesai dikirim ke Telegram");
                channel.enableVibration(true);

                Uri soundUri = Uri.parse("android.resource://" + getPackageName() + "/raw/notif_ba_terkirim");
                AudioAttributes audioAttrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
                channel.setSound(soundUri, audioAttrs);

                manager.createNotificationChannel(channel);
            }
        }
    }

    // Channel khusus Admin/KLW/Monitoring -- suara "notif_ba_auto_monitor.mp3"
    // bunyi tiap kali BA Otomatis selesai dikirim ke petugas manapun, supaya
    // role pengawas tahu tanpa harus buka app terus-terusan.
    //
    // File suara harus ditaruh di:
    //   android/app/src/main/res/raw/notif_ba_auto_monitor.mp3
    // (salin dari android-native/res-raw/notif_ba_auto_monitor.mp3 di repo
    // ini -- folder res-raw/ cuma tempat staging, bukan lokasi asli project
    // Android, sama seperti channel BA Otomatis di atas).
    private void createBaAutoMonitorNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(CHANNEL_ID_BA_AUTO_MONITOR) == null) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID_BA_AUTO_MONITOR,
                    "SrinaiAssist - Monitoring BA Otomatis",
                    NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("Notifikasi ke Admin/KLW/Monitoring saat BA Otomatis terkirim ke petugas");
                channel.enableVibration(true);

                Uri soundUri = Uri.parse("android.resource://" + getPackageName() + "/raw/notif_ba_auto_monitor");
                AudioAttributes audioAttrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
                channel.setSound(soundUri, audioAttrs);

                manager.createNotificationChannel(channel);
            }
        }
    }

    // Channel khusus "File baru dikirim admin lewat Telegram" -- suara
    // "notif_broadcast_file.mp3" bunyi meskipun app di-background/tertutup.
    //
    // File suara harus ditaruh di:
    //   android/app/src/main/res/raw/notif_broadcast_file.mp3
    // (salin dari android-native/res-raw/notif_broadcast_file.mp3 di repo
    // ini -- folder res-raw/ cuma tempat staging, bukan lokasi asli project
    // Android, sama seperti channel BA Otomatis di atas).
    private void createBroadcastFileNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(CHANNEL_ID_BROADCAST_FILE) == null) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID_BROADCAST_FILE,
                    "SrinaiAssist - File dari Admin (Telegram)",
                    NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("Notifikasi saat admin mengirim file baru lewat Telegram");
                channel.enableVibration(true);

                Uri soundUri = Uri.parse("android.resource://" + getPackageName() + "/raw/notif_broadcast_file");
                AudioAttributes audioAttrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
                channel.setSound(soundUri, audioAttrs);

                manager.createNotificationChannel(channel);
            }
        }
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
