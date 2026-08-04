/**
 * android/AndroidManifest.xml di-generate ulang tiap build (`npx cap add android`),
 * jadi tidak bisa di-commit & edit manual. Script ini jalan di CI, SETELAH platform
 * Android dibuat, buat nyisipin izin lokasi background + deklarasi
 * LocationTrackingService yang dibutuhkan fitur "lokasi tetap update walau app ditutup".
 */
const fs = require("fs");
const path = "android/app/src/main/AndroidManifest.xml";

let xml = fs.readFileSync(path, "utf8");

const permissions = `
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
`;

const service = `
        <service
            android:name=".LocationTrackingService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="location" />
`;

if (!xml.includes("ACCESS_BACKGROUND_LOCATION")) {
  xml = xml.replace("</manifest>", permissions + "</manifest>");
}
if (!xml.includes("LocationTrackingService")) {
  xml = xml.replace("</application>", service + "</application>");
}

fs.writeFileSync(path, xml, "utf8");
console.log("AndroidManifest.xml sudah dipatch untuk background location tracking.");
