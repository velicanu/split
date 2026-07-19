// Real libsodium throughout. These are the primitives everything else is
// built on, so a stub here would hide exactly the failures that matter.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  decryptPayload,
  encryptPayload,
  generateAccountKey,
  generateDeviceKey,
  generateGroupKey,
  openSealed,
  sealTo,
} from './crypto.js'

describe('group keys', () => {
  test('seal and open round trip', async () => {
    const key = await generateGroupKey()
    const device = await generateDeviceKey()
    const sealed = await sealTo(device.box_pubkey, key)

    assert.notEqual(sealed, key, 'the key must not travel in the clear')
    assert.equal(
      await openSealed(device.box_pubkey, device.box_privkey, sealed),
      key
    )
  })

  test('only the intended recipient can open it', async () => {
    const key = await generateGroupKey()
    const mine = await generateDeviceKey()
    const theirs = await generateDeviceKey()
    const sealed = await sealTo(mine.box_pubkey, key)

    await assert.rejects(
      () => openSealed(theirs.box_pubkey, theirs.box_privkey, sealed),
      /Could not open/
    )
  })

  test('the account key can open its own copy', async () => {
    // The bootstrap path: a fresh device unwraps the account key, then uses it
    // to read the group key it was sealed to.
    const key = await generateGroupKey()
    const account = await generateAccountKey()
    const sealed = await sealTo(account.box_pubkey, key)
    assert.equal(
      await openSealed(account.box_pubkey, account.box_privkey, sealed),
      key
    )
  })

  test('two group keys differ', async () => {
    assert.notEqual(await generateGroupKey(), await generateGroupKey())
  })
})

describe('payloads', () => {
  const expense = {
    expense_id: 'e1',
    description: 'Dinner at the Anchor',
    amount_cents: 4350,
    payers: [{ user_id: 1, paid_cents: 4350 }],
  }

  test('encrypt and decrypt round trip', async () => {
    const key = await generateGroupKey()
    const blob = await encryptPayload(key, expense)
    assert.deepEqual(await decryptPayload(key, blob), expense)
  })

  test('the ciphertext reveals nothing about the contents', async () => {
    const key = await generateGroupKey()
    const blob = await encryptPayload(key, expense)
    assert.ok(!blob.includes('Dinner'))
    assert.ok(!blob.includes('Anchor'))
    assert.ok(!blob.includes('4350'))
  })

  test('the wrong key cannot read it', async () => {
    const blob = await encryptPayload(await generateGroupKey(), expense)
    const otherKey = await generateGroupKey()
    await assert.rejects(
      () => decryptPayload(otherKey, blob),
      /Could not decrypt/
    )
  })

  test('the same payload encrypts differently each time', async () => {
    // A fresh nonce per message: identical expenses must not be linkable by
    // their ciphertext.
    const key = await generateGroupKey()
    assert.notEqual(
      await encryptPayload(key, expense),
      await encryptPayload(key, expense)
    )
  })

  test('tampering is detected rather than silently accepted', async () => {
    const key = await generateGroupKey()
    const blob = await encryptPayload(key, expense)
    const [nonce, body] = blob.split('.')
    // Flip a character in the ciphertext.
    const flipped = body[0] === 'A' ? `B${body.slice(1)}` : `A${body.slice(1)}`
    await assert.rejects(() => decryptPayload(key, `${nonce}.${flipped}`))
  })

  test('malformed input is rejected, not misread', async () => {
    const key = await generateGroupKey()
    await assert.rejects(() => decryptPayload(key, 'nonsense'), /Malformed/)
    await assert.rejects(() => decryptPayload(key, ''), /Malformed/)
  })
})
