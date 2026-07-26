// The rendezvous-facing bits of pairing, against a tiny fake. The full
// cross-endpoint flow (add_device signed by a device, sealing group keys) is
// covered end-to-end by the live test — that's the client/server agreement a
// fake can't vouch for.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  fetchPairing,
  pairLink,
  pairingApproved,
  parsePairCode,
  startPairing,
} from './pairing.js'

function serve() {
  const store = { pending: null, lastBody: null }
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^\/api\//, '')
    const body = options.body ? JSON.parse(options.body) : null
    const ok = (b) => ({ ok: true, json: async () => b })

    if (path === 'pairings' && (options.method || 'POST') === 'POST') {
      store.lastBody = body
      store.pending = { ...body, approved: false }
      return ok({ code: 'CODE123' })
    }
    if (path === 'pairings/CODE123') {
      return ok({
        new_pubkey: store.pending.new_pubkey,
        new_box_pubkey: store.pending.new_box_pubkey,
        label: store.pending.label,
        approved: store.pending.approved,
      })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return store
}

describe('parsing a pairing code', () => {
  test('from a scanned link or a bare code', () => {
    assert.equal(parsePairCode('https://split.example/#pair=ABC-123'), 'ABC-123')
    assert.equal(parsePairCode(pairLink('https://x', 'ZZZ9')), 'ZZZ9')
    assert.equal(parsePairCode('ABC-123'), 'ABC-123')
    assert.equal(parsePairCode('  short '), null, 'too short to be a code')
    assert.equal(parsePairCode(''), null)
  })
})

describe('the new device', () => {
  test('registers its public keys and gets a code + fingerprint', async () => {
    const store = serve()
    const { code, device, fingerprint } = await startPairing()
    assert.equal(code, 'CODE123')
    assert.equal(store.lastBody.new_pubkey, device.pubkey, 'advertised its own key')
    assert.ok(!store.lastBody.new_box_privkey, 'and no private material')
    assert.equal(fingerprint.split(' ').length, 6)
  })

  test('polls approval', async () => {
    const store = serve()
    await startPairing()
    assert.equal(await pairingApproved('CODE123'), false)
    store.pending.approved = true
    assert.equal(await pairingApproved('CODE123'), true)
  })
})

describe('the old device', () => {
  test('reads the pending keys and computes the same fingerprint', async () => {
    serve()
    const { device, fingerprint } = await startPairing()
    const seen = await fetchPairing('CODE123')
    assert.equal(seen.new_pubkey, device.pubkey)
    assert.equal(seen.fingerprint, fingerprint, 'matches what the new device shows')
  })
})
