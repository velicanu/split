// Base64 for raw bytes — standard and URL-safe. Distinct from crypto.js's
// libsodium base64, which is for keys; this is the plain btoa/atob path for
// ciphertext blobs (receipt uploads) and WebAuthn credential ids, which lived
// copy-pasted in three modules.

export const bytesToBase64 = (bytes) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export const base64ToBytes = (text) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

export const bytesToBase64url = (bytes) =>
  bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
