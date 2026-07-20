// The ledger, on this device.
//
// Until now the log lived only in React state: every load refetched it, and
// with no network there was nothing to show and nothing you could do. This is
// the local copy that makes the app work offline — the founding premise of
// plan/04, finally built.
//
// Three stores, one job each:
//
//   events  every event this device has seen, keyed by `event_id` so an event
//           we wrote and later receive back from the server updates one row
//           rather than appearing twice.
//   meta    per group: the sync cursor, and the group's name.
//   outbox  events written here that the server has not accepted yet.
//
// Payloads are stored exactly as they travel — sealed. Decryption happens on
// read, which keeps what sits on disk the same shape as what sits on the
// server, and means a stolen phone yields no more than a stolen backup.
//
// IndexedDB is evictable (iOS especially), so this is a cache and an outbox,
// never the record. The server plus key recovery remain the durable copy.

const DB = 'split-ledger'
const EVENTS = 'events'
const META = 'meta'
const OUTBOX = 'outbox'
const GKEYS = 'gkeys'

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      // Keyed by event_id, indexed by group so a group reads back in one go.
      const events = db.createObjectStore(EVENTS, { keyPath: 'event_id' })
      events.createIndex('group', 'group_id')
      db.createObjectStore(META)
      const outbox = db.createObjectStore(OUTBOX, { keyPath: 'event_id' })
      outbox.createIndex('group', 'group_id')
      db.createObjectStore(GKEYS)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const req = fn(tx.objectStore(store))
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => resolve(req?.result ?? null)
      })
  )
}

const byGroup = (store, groupId) =>
  run(store, 'readonly', (s) => s.index('group').getAll(groupId))

// --- events -------------------------------------------------------------

/** Everything this device holds for a group, in server order.
 *
 *  Unsent events sort last: they carry a provisional id above any the server
 *  will ever issue, because from here they *are* the most recent thing that
 *  happened. If the server later orders them differently, the next sync says
 *  so — see PENDING_ID. */
export async function localEvents(groupId) {
  const rows = await byGroup(EVENTS, groupId)
  return rows.sort((a, b) => a.id - b.id)
}

/** Insert or update by event_id. Used both for events pulled from the server
 *  and for our own writes coming back with their real id. */
export async function putEvents(rows) {
  if (!rows.length) return
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVENTS, 'readwrite')
    const store = tx.objectStore(EVENTS)
    for (const row of rows) store.put(row)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// --- cursor and metadata ------------------------------------------------

export async function meta(groupId) {
  return (await run(META, 'readonly', (s) => s.get(groupId))) ?? { cursor: 0 }
}

export async function setMeta(groupId, patch) {
  const current = await meta(groupId)
  return run(META, 'readwrite', (s) => s.put({ ...current, ...patch }, groupId))
}

/** Groups this device can show without a network. */
export async function localGroups() {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META, 'readonly')
    const store = tx.objectStore(META)
    const keys = store.getAllKeys()
    const values = store.getAll()
    tx.oncomplete = () =>
      resolve(keys.result.map((id, i) => ({ id, ...values.result[i] })))
    tx.onerror = () => reject(tx.error)
  })
}

// --- outbox -------------------------------------------------------------

/** Events written here that the server has not taken yet, oldest first.
 *  Order matters: an expense and the edit that follows it must arrive in the
 *  order they were made, or last-write-wins picks the wrong one. */
export async function pending(groupId) {
  const rows = await byGroup(OUTBOX, groupId)
  return rows.sort((a, b) => a.queued_at - b.queued_at)
}

export const queue = (row) => run(OUTBOX, 'readwrite', (s) => s.put(row))

export const unqueue = (eventId) =>
  run(OUTBOX, 'readwrite', (s) => s.delete(eventId))

/** How many writes are waiting, across every group — for telling the user. */
export async function pendingCount() {
  return (await run(OUTBOX, 'readonly', (s) => s.count())) ?? 0
}

// --- group keys ---------------------------------------------------------

// Held here so a group can be read with no network at all. The server copy is
// sealed to this device and normally fetched on demand; offline there is
// nobody to fetch it from.
export const localGroupKey = (groupId) =>
  run(GKEYS, 'readonly', (s) => s.get(groupId))

export const saveGroupKey = (groupId, key) =>
  run(GKEYS, 'readwrite', (s) => s.put(key, groupId))

// --- housekeeping -------------------------------------------------------

/** Drop everything. Signing out un-enrols this device, so leaving a decrypted
 *  ledger behind would outlive the credentials that justified it. */
export async function forgetLocalLedger() {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([EVENTS, META, OUTBOX, GKEYS], 'readwrite')
    for (const s of [EVENTS, META, OUTBOX, GKEYS]) tx.objectStore(s).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
