// Identity and device keys. See plan/11-identity-and-devices.md.
//
// Three levels, and the separation between them is the whole point:
//
//   account key  — never persisted on a device. The server holds it wrapped
//                  under the password; it exists in memory only long enough to
//                  enrol a device, then is dropped.
//   device key   — generated on this device, stays in IndexedDB, never leaves.
//   group key    — later (PR B), wrapped to the account key and to each device.
//
// A device must never be able to reach the account key. If it could, extracting
// the device key would yield the account key, and revoking a stolen device
// would mean nothing.

import sodium from 'libsodium-wrappers-sumo'

const ready = sodium.ready

const DB = 'split-keys'
const STORE = 'keys'
const DEVICE_KEY = 'device'

export const b64 = (bytes) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
export const unb64 = (text) =>
  sodium.from_base64(text, sodium.base64_variants.ORIGINAL)

// --- device key storage ------------------------------------------------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key) {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(key, value) {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbDelete(key) {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// --- keys --------------------------------------------------------------

/** A device keypair: Ed25519 to authenticate, X25519 to receive wrapped keys. */
export async function generateDeviceKey() {
  await ready
  const sign = sodium.crypto_sign_keypair()
  const box = sodium.crypto_box_keypair()
  return {
    pubkey: b64(sign.publicKey),
    privkey: b64(sign.privateKey),
    box_pubkey: b64(box.publicKey),
    box_privkey: b64(box.privateKey),
  }
}

/** The account keypair. Ed25519 so it can authorise a device enrolment;
 *  X25519 so group keys can be wrapped to it for the recovery path. */
export async function generateAccountKey() {
  await ready
  const sign = sodium.crypto_sign_keypair()
  const box = sodium.crypto_box_keypair()
  return {
    pubkey: b64(sign.publicKey),
    privkey: b64(sign.privateKey),
    box_pubkey: b64(box.publicKey),
    box_privkey: b64(box.privateKey),
  }
}

export const loadDeviceKey = () => idbGet(DEVICE_KEY)
export const saveDeviceKey = (key) => idbPut(DEVICE_KEY, key)
export const forgetDeviceKey = () => idbDelete(DEVICE_KEY)

export async function sign(privkeyB64, message) {
  await ready
  const bytes = typeof message === 'string' ? sodium.from_string(message) : message
  return b64(sodium.crypto_sign_detached(bytes, unb64(privkeyB64)))
}

// --- password wrapping -------------------------------------------------

// Deliberately expensive: GET /api/wraps hands this ciphertext to anyone who
// knows a login handle, so Argon2id is the only thing between a leaked blob and
// the account key. INTERACTIVE is the libsodium preset sized for a login-time
// delay; MODERATE would be better still but is painful on low-end phones.
const KDF_OPS = () => sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE
const KDF_MEM = () => sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE

async function kdf(password, saltB64) {
  await ready
  return sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    unb64(saltB64),
    KDF_OPS(),
    KDF_MEM(),
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )
}

/** Wrap the account key under a password. Returns what the server stores —
 *  all of it opaque to the server, which never sees the password. */
export async function wrapAccountKey(accountKey, password) {
  await ready
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)
  const params = JSON.stringify({
    salt: b64(salt),
    ops: KDF_OPS(),
    mem: KDF_MEM(),
    alg: sodium.crypto_pwhash_ALG_ARGON2ID13,
  })
  const key = await kdf(password, b64(salt))
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const sealed = sodium.crypto_secretbox_easy(
    sodium.from_string(JSON.stringify(accountKey)),
    nonce,
    key
  )
  return {
    method: 'password',
    params,
    ciphertext: JSON.stringify({ nonce: b64(nonce), body: b64(sealed) }),
  }
}

export async function unwrapAccountKey(wrap, password) {
  await ready
  const params = JSON.parse(wrap.params)
  const { nonce, body } = JSON.parse(wrap.ciphertext)
  const key = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    unb64(params.salt),
    params.ops,
    params.mem,
    params.alg
  )
  let plain
  try {
    plain = sodium.crypto_secretbox_open_easy(unb64(body), unb64(nonce), key)
  } catch {
    throw new Error('Wrong password')
  }
  if (!plain) throw new Error('Wrong password')
  return JSON.parse(sodium.to_string(plain))
}
