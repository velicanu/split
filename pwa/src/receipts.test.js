// The receipt pipeline end to end: encrypt, address by content hash, upload,
// fetch, verify, decrypt. Against a fake server that stores what it is given.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import {
  contentId,
  generateDeviceKey,
  generateGroupKey,
  saveDeviceKey,
  sealTo,
} from './crypto.js'
import { forgetGroupKeys } from './groupkeys.js'
import { forgetLocalLedger } from './store.js'
import { fetchReceipt, forgetReceipts, uploadReceipt } from './receipts.js'

// What the canvas stub in test/setup.mjs produces: base64 'QUFB' -> 'AAA'.
const PLAINTEXT = [65, 65, 65]

async function serve() {
  forgetGroupKeys()
  await forgetLocalLedger()
  forgetReceipts()
  const device = await generateDeviceKey()
  await saveDeviceKey(device)
  const key = await generateGroupKey()
  const sealedKey = await sealTo(device.box_pubkey, key)
  const store = { blobs: new Map(), uploaded: [], key, readTokenSeen: undefined }

  globalThis.fetch = async (url, options) => {
    const path = String(url)
    const body = options?.body ? JSON.parse(options.body) : null
    if (path.endsWith('/keys')) {
      return {
        ok: true,
        json: async () => ({
          keys: [
            { recipient_kind: 'device', recipient_id: 'd1', ciphertext: sealedKey },
          ],
        }),
      }
    }
    if (path.endsWith('/receipts')) {
      const bytes = Uint8Array.from(atob(body.ciphertext), (c) => c.charCodeAt(0))
      if ((await contentId(bytes)) !== body.receipt_id) {
        return { ok: false, status: 400, json: async () => ({ detail: 'bad id' }) }
      }
      store.uploaded.push(bytes)
      store.blobs.set(body.receipt_id, bytes)
      return { ok: true, json: async () => ({ receipt_id: body.receipt_id }) }
    }
    if (path.includes('/receipts/')) {
      store.readTokenSeen = options?.headers?.['X-Read-Token']
      const bytes = store.blobs.get(path.split('/receipts/')[1])
      if (!bytes) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(0) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return store
}

afterEach(forgetReceipts)

describe('uploading a receipt', () => {
  test('sends ciphertext, never the image', async () => {
    const store = await serve()
    await uploadReceipt(7, { name: 'receipt.jpg' })

    const [sent] = store.uploaded
    assert.ok(sent.length > PLAINTEXT.length, 'nonce and tag must be present')
    // The plaintext must not appear anywhere in what was sent.
    const bytes = [...sent].join(',')
    assert.ok(
      !bytes.includes(PLAINTEXT.join(',')),
      'the image bytes went up in the clear'
    )
  })

  test('names the blob by the hash of its ciphertext', async () => {
    const store = await serve()
    const id = await uploadReceipt(7, { name: 'receipt.jpg' })
    assert.match(id, /^[0-9a-f]{64}$/)
    assert.equal(id, await contentId(store.uploaded[0]))
  })

  test('round trips back to the original image', async () => {
    await serve()
    const id = await uploadReceipt(7, { name: 'receipt.jpg' })
    assert.deepEqual([...(await fetchReceipt(7, id))], PLAINTEXT)
  })

  test('two uploads of the same image get different addresses', async () => {
    // Fresh nonce each time, so the server cannot tell they are the same photo.
    await serve()
    const first = await uploadReceipt(7, { name: 'receipt.jpg' })
    const second = await uploadReceipt(7, { name: 'receipt.jpg' })
    assert.notEqual(first, second)
  })

  test('refuses to upload without a key for the group', async () => {
    await serve()
    globalThis.fetch = async (url) =>
      String(url).endsWith('/keys')
        ? { ok: true, json: async () => ({ keys: [] }) }
        : { ok: false, status: 500, json: async () => ({}) }
    await assert.rejects(
      () => uploadReceipt(7, { name: 'receipt.jpg' }),
      /No key for this group/
    )
  })
})

describe('fetching a receipt', () => {
  test('rejects bytes that are not what the address promised', async () => {
    // Content addressing is only worth something if the client checks it —
    // otherwise a server could hand back any blob it liked.
    const store = await serve()
    const id = await uploadReceipt(7, { name: 'receipt.jpg' })
    const substitute = await uploadReceipt(7, { name: 'other.jpg' })
    store.blobs.set(id, store.blobs.get(substitute))

    await assert.rejects(
      () => fetchReceipt(7, id),
      /does not match its address/
    )
  })

  test('surfaces a missing receipt rather than hanging', async () => {
    await serve()
    await assert.rejects(() => fetchReceipt(7, 'a'.repeat(64)), /Couldn't load/)
  })

  test('cannot decrypt a blob sealed under another group key', async () => {
    const store = await serve()
    const id = await uploadReceipt(7, { name: 'receipt.jpg' })
    // Same address, but the bytes were sealed with a key this device lacks.
    const foreign = await serve()
    foreign.blobs.set(id, store.blobs.get(id))
    await assert.rejects(() => fetchReceipt(7, id), /Could not decrypt/)
  })
})


describe('a share-link viewer reading a receipt', () => {
  test('uses the key from the link and sends the read token', async () => {
    // The viewer has no device key or session: the key comes from the link and
    // the read token authorises the members-only blob endpoint. See readonly.js.
    const store = await serve()
    const id = await uploadReceipt(7, { name: 'r.jpg' })

    // Forget the device/group key entirely — the viewer never had one.
    forgetGroupKeys()
    await import('./crypto.js').then((m) => m.forgetDeviceKey())

    const bytes = await fetchReceipt(7, id, { key: store.key, readToken: 'rt-secret' })
    assert.deepEqual([...bytes], PLAINTEXT, 'decrypted with the link key')
    assert.equal(store.readTokenSeen, 'rt-secret', 'and the token went in the header')
  })
})
