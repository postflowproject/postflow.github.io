
const DB_NAME = "postflow-media";
const DB_VERSION = 1;
const STORE_NAME = "media";

const STORAGE_KEYS = {
  drafts: "postflow-drafts",
  queue: "postflow-queue",
  history: "postflow-history",
  pages: "postflow-pages",
  settings: "postflow-settings",
};

export function loadData(key, fallback = []) {
  try {
    const value = localStorage.getItem(STORAGE_KEYS[key]);
    return value === null ? fallback : JSON.parse(value);
  } catch (error) {
    console.error(`PostFlow: failed to load ${key}`, error);
    return fallback;
  }
}

export function saveData(key, value) {
  try {
    localStorage.setItem(STORAGE_KEYS[key], JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`PostFlow: failed to save ${key}`, error);
    return false;
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not supported in this browser."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
        });

        store.createIndex("name", "name", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Could not open media storage."));
  });
}

export async function saveMedia(file) {
  const db = await openDatabase();

  try {
    const record = {
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      lastModified: file.lastModified,
      createdAt: new Date().toISOString(),
      blob: file,
    };

    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");

      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    return {
      id: record.id,
      name: record.name,
      type: record.type,
      size: record.size,
      lastModified: record.lastModified,
      createdAt: record.createdAt,
    };
  } finally {
    db.close();
  }
}

export async function getAllMedia() {
  const db = await openDatabase();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function getMediaBlob(id) {
  const db = await openDatabase();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteMedia(id) {
  const db = await openDatabase();

  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");

      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function getStorageUsage() {
  const media = await getAllMedia();

  return {
    count: media.length,
    bytes: media.reduce((total, item) => total + (item.size || 0), 0),
  };
}

export async function clearAllMedia() {
  const db = await openDatabase();

  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");

      transaction.objectStore(STORE_NAME).clear();
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );

  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}