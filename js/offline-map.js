// js/offline-map.js
//
// Cache tile peta (OpenStreetMap) di IndexedDB supaya peta bisa dipakai
// offline. Dipakai di peta.html.
//
// - OfflineTileLayer: pengganti L.tileLayer biasa. Saat butuh tile,
//   cek IndexedDB dulu; kalau belum ada, ambil dari jaringan lalu
//   simpan untuk dipakai lagi nanti (termasuk saat offline).
// - downloadOfflineArea(): unduh massal semua tile dalam suatu area
//   (bounding box) untuk rentang zoom tertentu, dipanggil sekali saat
//   user pertama kali membuka halaman Peta.
//
// Catatan: mengunduh SEMUA level zoom untuk satu area akan jadi ribuan
// file. Supaya unduhan awal ringan & cepat, downloadOfflineArea hanya
// menyiapkan zoom "dasar" (lihat MIN/MAX di peta.html). Level zoom yang
// lebih dalam tetap otomatis ke-cache satu-persatu saat user browsing
// peta selagi online, jadi lama-lama cakupan offline makin lengkap.

const OFFLINE_DB_NAME = "srinai_offline_map";
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE = "tiles";

function openTileDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
        db.createObjectStore(OFFLINE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getTileBlob(key) {
  const db = await openTileDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, "readonly");
    const req = tx.objectStore(OFFLINE_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function putTileBlob(key, blob) {
  const db = await openTileDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, "readwrite");
    tx.objectStore(OFFLINE_STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function countOfflineTiles() {
  const db = await openTileDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, "readonly");
    const req = tx.objectStore(OFFLINE_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tileUrlFromTemplate(urlTemplate, subdomains, z, x, y) {
  const s = subdomains[(x + y) % subdomains.length];
  return urlTemplate.replace("{s}", s).replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

// Layer Leaflet custom: tampilkan dari IndexedDB kalau ada, kalau
// tidak ambil dari jaringan sambil menyimpannya untuk dipakai lagi.
const OfflineTileLayer = L.TileLayer.extend({
  createTile: function (coords, done) {
    const tile = document.createElement("img");
    tile.alt = "";
    const key = `${coords.z}/${coords.x}/${coords.y}`;
    const url = this.getTileUrl(coords);

    getTileBlob(key)
      .then((blob) => {
        if (blob) {
          tile.src = URL.createObjectURL(blob);
          done(null, tile);
          return;
        }
        return fetch(url)
          .then((resp) => {
            if (!resp.ok) throw new Error("tile fetch gagal");
            return resp.blob();
          })
          .then((blob) => {
            putTileBlob(key, blob).catch(() => {});
            tile.src = URL.createObjectURL(blob);
            done(null, tile);
          });
      })
      .catch((err) => {
        // IndexedDB atau jaringan bermasalah -- fallback ke src langsung,
        // biar peta tetap tampil selama benar-benar online.
        tile.src = url;
        tile.onerror = () => done(err, tile);
        tile.onload = () => done(null, tile);
      });

    return tile;
  },
});

function createOfflineTileLayer(urlTemplate, options) {
  return new OfflineTileLayer(urlTemplate, options);
}

function latLngToTileXY(lat, lng, z) {
  const n = Math.pow(2, z);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

// Unduh semua tile dalam bounds (L.LatLngBounds) untuk rentang zoom
// [minZoom, maxZoom]. onProgress(done, total) dipanggil tiap 1 tile
// selesai (baik berhasil, gagal, atau sudah ada di cache).
// shouldStop() dicek berkala; kalau return true, proses dihentikan.
async function downloadOfflineArea(bounds, minZoom, maxZoom, urlTemplate, subdomains, onProgress, shouldStop) {
  const tileList = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const nw = latLngToTileXY(bounds.getNorth(), bounds.getWest(), z);
    const se = latLngToTileXY(bounds.getSouth(), bounds.getEast(), z);
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) {
        tileList.push({ z, x, y });
      }
    }
  }

  const total = tileList.length;
  let done = 0;
  let bytes = 0; // total byte yang benar-benar diunduh dari jaringan (tile yang sudah ada di cache tidak dihitung)
  let idx = 0;
  const CONCURRENCY = 6;

  async function worker() {
    while (idx < tileList.length) {
      if (shouldStop && shouldStop()) return;
      const { z, x, y } = tileList[idx++];
      const key = `${z}/${x}/${y}`;
      try {
        const existing = await getTileBlob(key);
        if (!existing) {
          const url = tileUrlFromTemplate(urlTemplate, subdomains, z, x, y);
          const resp = await fetch(url);
          if (resp.ok) {
            const blob = await resp.blob();
            bytes += blob.size;
            await putTileBlob(key, blob);
          }
        }
      } catch (e) {
        // lewati tile yang gagal, lanjut ke tile berikutnya
      }
      done++;
      if (onProgress) onProgress(done, total, bytes);
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  return { total, done, bytes };
}
