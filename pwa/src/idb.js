// A tiny promise wrapper over IndexedDB for plain key/value stores — the device
// key, the session. The ledger (store.js) keeps its own multi-store,
// index-backed helper; this is only for the simple get/put/delete cases, which
// used to hand-roll the same request-to-promise boilerplate in crypto.js.

function open(dbName, storeName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(storeName)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** A single-store key/value view over one IndexedDB database. */
export function keyval(dbName, storeName) {
  const tx = (mode, fn) =>
    open(dbName, storeName).then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeName, mode)
          const req = fn(t.objectStore(storeName))
          t.oncomplete = () => resolve(req?.result ?? null)
          t.onerror = () => reject(t.error)
        })
    )
  return {
    get: (key) => tx('readonly', (s) => s.get(key)).then((v) => v ?? null),
    put: (key, value) => tx('readwrite', (s) => s.put(value, key)),
    delete: (key) => tx('readwrite', (s) => s.delete(key)),
  }
}
