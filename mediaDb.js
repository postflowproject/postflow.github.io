const DB_NAME = "postflow-media";
const DB_VERSION = 1;
const STORE_NAME = "media";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error || new Error("Could not open media database.")
    );
  });
}

async function transact(mode, operation) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let result;

    try {
      result = operation(store);
    } catch (error) {
      db.close();
      reject(error);
      return;
    }

    tx.oncomplete = () => {
      db.close();
      resolve(result?.result);
    };

    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("Media database transaction failed."));
    };

    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error("Media database transaction aborted."));
    };
  });
}

export async function saveMedia(file) {
  const item = {
    id: crypto.randomUUID(),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    lastModified: file.lastModified,
    createdAt: new Date().toISOString(),
    blob: file,
  };

  await transact("readwrite", (store) => store.put(item));

  return {
    id: item.id,
    name: item.name,
    type: item.type,
    size: item.size,
    lastModified: item.lastModified,
    createdAt: item.createdAt,
  };
}

export async function getAllMedia() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();

    request.onsuccess = () => {
      const items = request.result.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        size: item.size,
        lastModified: item.lastModified,
        createdAt: item.createdAt,
      }));

      resolve(items);
    };

    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getMediaFile(id) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);

    request.onsuccess = () => {
      const item = request.result;

      resolve(
        item
          ? {
              ...item,
              file: new File(
                [item.blob],
                item.name,
                {
                  type: item.type,
                  lastModified: item.lastModified || Date.now(),
                }
              ),
            }
          : null
      );
    };

    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function deleteMedia(id) {
  await transact("readwrite", (store) => store.delete(id));
}

export async function clearMedia() {
  await transact("readwrite", (store) => store.clear());
}

export async function getMediaBlob(id) {
  const item = await getMediaFile(id);
  return item?.blob || null;
}