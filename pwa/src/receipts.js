// Receipt images: encrypted here, stored by the server as opaque bytes under
// the hash of that ciphertext, and decrypted here again to be displayed.
//
// Two consequences of content addressing worth knowing:
//   * fetching verifies — bytes that don't hash to the id you asked for are
//     rejected, so the server can't substitute one receipt for another;
//   * uploading twice is free, because the second upload is the same address.

import { api } from './api'
import { contentId, decryptBytes, encryptBytes } from './crypto'
import { prepareImage } from './ai'
import { groupKey } from './groupkeys'

// prepareImage always re-encodes to JPEG, so this is the only type we ever
// store. Pinning it here means a decrypted blob can never talk us into
// rendering it as something scriptable.
const MEDIA_TYPE = 'image/jpeg'

const b64 = (bytes) => {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

/** Downscale, encrypt, upload. Returns the content id to put on the expense. */
export async function uploadReceipt(groupId, file) {
  const key = await groupKey(groupId)
  if (!key) throw new Error('No key for this group on this device')

  const { base64 } = await prepareImage(file)
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const sealed = await encryptBytes(key, raw)
  const receipt_id = await contentId(sealed)

  await api(`groups/${groupId}/receipts`, {
    receipt_id,
    ciphertext: b64(sealed),
  })
  return receipt_id
}

/** Fetch, verify, decrypt. Returns the plaintext image bytes.
 *
 *  `access` lets a read-only share-link viewer read receipts too: they have no
 *  stored group key and no session, so the key comes from the link and the read
 *  token authorises the fetch. Absent it, the normal member path — this device's
 *  stored key, its session cookie. See readonly.js. */
export async function fetchReceipt(groupId, receiptId, access = {}) {
  const key = access.key || (await groupKey(groupId))
  if (!key) throw new Error('No key for this group on this device')

  const res = await fetch(`/api/groups/${groupId}/receipts/${receiptId}`, {
    headers: access.readToken ? { 'X-Read-Token': access.readToken } : {},
  })
  if (!res.ok) throw new Error("Couldn't load that receipt")
  const sealed = new Uint8Array(await res.arrayBuffer())

  // The id is the hash of the ciphertext, so this is checkable rather than
  // taken on trust: a server that swapped one blob for another is caught here.
  if ((await contentId(sealed)) !== receiptId) {
    throw new Error('That receipt does not match its address')
  }
  return decryptBytes(key, sealed)
}

// Object URLs are per-image and must be revoked, so they are cached and handed
// out rather than minted per render.
const urls = new Map()

export async function receiptUrl(groupId, receiptId, access) {
  if (urls.has(receiptId)) return urls.get(receiptId)
  // The id is the content hash and the group key is the same however it was
  // obtained, so the decrypted result is identical — caching by id alone is safe.
  const bytes = await fetchReceipt(groupId, receiptId, access)
  const url = URL.createObjectURL(new Blob([bytes], { type: MEDIA_TYPE }))
  urls.set(receiptId, url)
  return url
}

export async function receiptBlob(groupId, receiptId) {
  return new Blob([await fetchReceipt(groupId, receiptId)], { type: MEDIA_TYPE })
}

export function forgetReceipts() {
  for (const url of urls.values()) URL.revokeObjectURL(url)
  urls.clear()
}
