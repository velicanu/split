// Receipt images: encrypted here, stored by the server as opaque bytes under
// the hash of that ciphertext, and decrypted here again to be displayed.
//
// Two consequences of content addressing worth knowing:
//   * fetching verifies — bytes that don't hash to the id you asked for are
//     rejected, so the server can't substitute one receipt for another;
//   * uploading twice is free, because the second upload is the same address.

import { api } from './api'
import { contentId, encryptBytes } from './crypto'
import { prepareImage } from './ai'
import { base64ToBytes, bytesToBase64 } from './bytes'
import { groupKey } from './groupkeys'
import {
  fetchReceiptImage,
  forgetReceiptImages,
  receiptImageBlob,
  receiptImageUrl,
} from './receiptimage'

/** Downscale, encrypt, upload. Returns the content id to put on the expense. */
export async function uploadReceipt(groupId, file) {
  const key = await groupKey(groupId)
  if (!key) throw new Error('No key for this group on this device')

  const { base64 } = await prepareImage(file)
  const sealed = await encryptBytes(key, base64ToBytes(base64))
  const receipt_id = await contentId(sealed)

  await api(`groups/${groupId}/receipts`, {
    receipt_id,
    ciphertext: bytesToBase64(sealed),
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
  return fetchReceiptImage({
    url: `/api/groups/${groupId}/receipts/${receiptId}`,
    id: receiptId,
    key,
    headers: access.readToken ? { 'X-Read-Token': access.readToken } : {},
  })
}

export async function receiptUrl(groupId, receiptId, access) {
  return receiptImageUrl(receiptId, () => fetchReceipt(groupId, receiptId, access))
}

export async function receiptBlob(groupId, receiptId) {
  return receiptImageBlob(await fetchReceipt(groupId, receiptId))
}

// The object-URL cache is shared with bill receipts (both are content-addressed
// images), so forgetting one forgets all — a single invalidation point.
export const forgetReceipts = forgetReceiptImages
