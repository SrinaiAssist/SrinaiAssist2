package com.srinai.assist;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Jembatan JS <-> native buat fitur "lokasi tetap update walau app ditutup".
 * Dipanggil dari js/auth.js lewat window.Capacitor.Plugins.LocationTracker
 * setelah login sukses (startTracking) dan saat logout (stopTracking).
 */
@CapacitorPlugin(name = "LocationTracker")
public class LocationTrackerPlugin extends Plugin {

    private static final int REQ_FOREGROUND_LOCATION = 9001;
    private static final int REQ_BACKGROUND_LOCATION = 9002;
    private static final int REQ_NOTIFICATIONS = 9003;

    @PluginMethod
    public void requestLocationPermissions(PluginCall call) {
        saveCall(call);
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(),
                new String[]{ Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION },
                REQ_FOREGROUND_LOCATION);
        } else {
            requestBackgroundIfNeeded();
        }
    }

    private void requestBackgroundIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(),
                new String[]{ Manifest.permission.ACCESS_BACKGROUND_LOCATION },
                REQ_BACKGROUND_LOCATION);
            return;
        }
        requestNotificationsIfNeeded();
    }

    private void requestNotificationsIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(),
                new String[]{ Manifest.permission.POST_NOTIFICATIONS },
                REQ_NOTIFICATIONS);
            return;
        }
        finishPermissionResult();
    }

    private void finishPermissionResult() {
        PluginCall call = getSavedCall();
        if (call == null) return;
        boolean fineGranted = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
        boolean backgroundGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED;

        JSObject ret = new JSObject();
        ret.put("granted", fineGranted);
        ret.put("backgroundGranted", backgroundGranted);
        call.resolve(ret);
        call.release(bridge);
    }

    @Override
    public void handleRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.handleRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_FOREGROUND_LOCATION) {
            requestBackgroundIfNeeded();
        } else if (requestCode == REQ_BACKGROUND_LOCATION) {
            requestNotificationsIfNeeded();
        } else if (requestCode == REQ_NOTIFICATIONS) {
            finishPermissionResult();
        }
    }

    @PluginMethod
    public void startTracking(PluginCall call) {
        String username = call.getString("username");
        if (username == null || username.isEmpty()) {
            call.reject("username kosong");
            return;
        }
        SharedPreferences prefs = getContext().getSharedPreferences("srinai_location", 0);
        prefs.edit().putString("username", username).apply();

        Intent serviceIntent = new Intent(getContext(), LocationTrackingService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(serviceIntent);
        } else {
            getContext().startService(serviceIntent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stopTracking(PluginCall call) {
        Intent serviceIntent = new Intent(getContext(), LocationTrackingService.class);
        getContext().stopService(serviceIntent);
        call.resolve();
    }
}
