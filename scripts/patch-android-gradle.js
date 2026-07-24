/**
 * android/build.gradle & android/app/build.gradle di-generate ulang tiap build
 * (`npx cap add android`), jadi tidak bisa di-commit & edit manual. Script ini
 * jalan di CI, SETELAH platform Android dibuat, buat nyisipin plugin
 * "google-services" yang dibutuhkan Firebase Cloud Messaging (push notification).
 */
const fs = require("fs");

// ── 1. Root build.gradle: tambah classpath google-services ──
const rootPath = "android/build.gradle";
let root = fs.readFileSync(rootPath, "utf8");

if (!root.includes("com.google.gms:google-services")) {
  root = root.replace(
    /dependencies\s*\{/,
    `dependencies {\n        classpath 'com.google.gms:google-services:4.4.2'`
  );
  fs.writeFileSync(rootPath, root, "utf8");
  console.log("android/build.gradle sudah dipatch (classpath google-services).");
} else {
  console.log("android/build.gradle sudah punya classpath google-services, skip.");
}

// ── 2. App build.gradle: apply plugin google-services ──
const appPath = "android/app/build.gradle";
let app = fs.readFileSync(appPath, "utf8");

if (!app.includes("com.google.gms.google-services")) {
  app += `\napply plugin: 'com.google.gms.google-services'\n`;
  fs.writeFileSync(appPath, app, "utf8");
  console.log("android/app/build.gradle sudah dipatch (apply plugin google-services).");
} else {
  console.log("android/app/build.gradle sudah punya plugin google-services, skip.");
}
