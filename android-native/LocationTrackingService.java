package com.srinai.assist;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Foreground service supaya titik lokasi user tetap ke-update ke server
 * walau app SrinaiAssist ditutup / di-swipe dari recent apps.
 * Notifikasi permanen WAJIB ditampilkan selama service jalan -- ini
 * aturan Android buat foreground service tipe "location", bukan pilihan.
 *
 * Endpoint & format body SENGAJA dibikin sama persis dengan heartbeat JS
 * di js/auth.js (sendLocationHeartbeat) supaya peta.html tidak perlu
 * diubah sama sekali -- dari sisi server, update dari native service ini
 * tidak dibedakan dari update dari JS.
 */
public class LocationTrackingService extends Service implements LocationListener {

    private static final String CHANNEL_ID = "srinai_location_channel";
    private static final int NOTIF_ID = 5501;
    private static final long UPDATE_INTERVAL_MS = 60 * 1000; // samain dengan interval heartbeat JS
    private static final String API_URL = "https://srinai-assist2.vercel.app/api/settings?action=location";

    private LocationManager locationManager;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIF_ID, buildNotification());
        startLocationUpdates();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // START_STICKY: kalau Android kill service ini (low memory dsb),
        // sistem akan coba jalanin ulang otomatis.
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); } catch (SecurityException ignored) {}
        }
    }

    private void startLocationUpdates() {
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, UPDATE_INTERVAL_MS, 0, this);
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, UPDATE_INTERVAL_MS, 0, this);
            }
        } catch (SecurityException e) {
            // Izin lokasi belum diberikan -- service tetap jalan (notifikasi tampil)
            // tapi baru dapat update GPS setelah izin diberikan & service direstart.
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        sendLocationToServer(location);
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}

    private void sendLocationToServer(final Location location) {
        SharedPreferences prefs = getSharedPreferences("srinai_location", Context.MODE_PRIVATE);
        final String username = prefs.getString("username", null);
        if (username == null) return;

        final double lat = location.getLatitude();
        final double lng = location.getLongitude();
        final float accuracy = location.getAccuracy();

        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(API_URL);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);

                String json = "{\"username\":\"" + username.replace("\"", "\\\"") + "\","
                        + "\"lat\":" + lat + ","
                        + "\"lng\":" + lng + ","
                        + "\"accuracy\":" + accuracy + "}";

                OutputStream os = conn.getOutputStream();
                os.write(json.getBytes("UTF-8"));
                os.flush();
                os.close();

                conn.getResponseCode(); // trigger request beneran dikirim
            } catch (Exception e) {
                // Gagal kirim (offline dll) -- diamkan, dicoba lagi update berikutnya.
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Pelacakan Lokasi", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Menjaga titik lokasi kamu tetap update di peta SrinaiAssist");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        Intent intent = new Intent(this, MainActivity.class);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("SrinaiAssist aktif")
                .setContentText("Melacak lokasi kamu untuk ditampilkan di peta")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }
}
