// Fetch → verify → decrypt → cache for a receipt image, shared by group
// receipts and bill receipts. Both store ciphertext addressed by the BLAKE2b
// hash of that ciphertext and differ only in the URL and the auth header
// (session / X-Read-Token for a group, X-Bill-Token for a bill), so everything
// below is common. See receipts.js and bill.js for the two callers.

import { contentId, decryptBytes } from './crypto'

// prepareImage always re-encodes to JPEG, so this is the only type we store.
// Pinning it means a decrypted blob can never talk us into rendering it as
// something scriptable.
const MEDIA_TYPE = 'image/jpeg'

/** Fetch the ciphertext at `url` with `headers`, check it hashes to `id`, and
 *  decrypt it with `key`. The verify is what content addressing buys: a server
 *  that swapped one blob for another is caught here. */
export async function fetchReceiptImage({ url, id, key, headers = {} }) {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error("Couldn't load that receipt")
  const sealed = new Uint8Array(await res.arrayBuffer())
  if ((await contentId(sealed)) !== id) {
    throw new Error('That receipt does not match its address')
  }
  return decryptBytes(key, sealed)
}

// Object URLs are per-image and must be revoked, so they are cached and handed
// out rather than minted per render. Keyed by content id alone is safe: an id is
// the hash of the ciphertext (which carries a random nonce), so it is unique per
// upload — the same plaintext under two keys hashes to two ids.
const urls = new Map()

/** An object URL for a receipt image, decrypting via `load` on first use. */
export async function receiptImageUrl(id, load) {
  if (urls.has(id)) return urls.get(id)
  const url = URL.createObjectURL(new Blob([await load()], { type: MEDIA_TYPE }))
  urls.set(id, url)
  return url
}

export function receiptImageBlob(bytes) {
  return new Blob([bytes], { type: MEDIA_TYPE })
}

/** Revoke and drop every cached object URL — on logout, or a view teardown. */
export function forgetReceiptImages() {
  for (const url of urls.values()) URL.revokeObjectURL(url)
  urls.clear()
}
