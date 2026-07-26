import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { generateDeviceKey } from './crypto.js'
import { deviceFingerprint } from './fingerprint.js'

describe('device fingerprint', () => {
  test('is six emoji, deterministic for a key', async () => {
    const { pubkey } = await generateDeviceKey()
    const fp = await deviceFingerprint(pubkey)
    assert.equal(fp.split(' ').length, 6, 'six symbols')
    assert.equal(await deviceFingerprint(pubkey), fp, 'same key, same fingerprint')
  })

  test('differs between keys — the whole point of comparing it', async () => {
    const a = await deviceFingerprint((await generateDeviceKey()).pubkey)
    const b = await deviceFingerprint((await generateDeviceKey()).pubkey)
    assert.notEqual(a, b)
  })

  test('both sides of a pairing derive the same string from the same pubkey', async () => {
    // The new device computes it from its own key; the old device from the key
    // it fetched. Same input → same output is what makes the match meaningful.
    const { pubkey } = await generateDeviceKey()
    assert.equal(await deviceFingerprint(pubkey), await deviceFingerprint(pubkey))
  })
})
