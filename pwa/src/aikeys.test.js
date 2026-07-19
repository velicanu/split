// Real libsodium: this is where "the server never sees the key" is actually
// demonstrated. The backend tests can only show it stores what it was given.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { adoptApiKeysForNewDevice, loadAiSettings, saveApiKey } from './aikeys.js'
import {
  forgetDeviceKey,
  generateAccountKey,
  generateDeviceKey,
  saveDeviceKey,
} from './crypto.js'

const API_KEY = 'sk-live-do-not-leak-me'

async function serve({ devices = 1 } = {}) {
  const account = await generateAccountKey()
  const deviceKeys = []
  for (let i = 0; i < devices; i += 1) deviceKeys.push(await generateDeviceKey())
  // This browser is the first device.
  await saveDeviceKey(deviceKeys[0])

  const store = { keys: [], providers: {}, active: null }
  const json = (body) => ({ ok: true, json: async () => body })

  globalThis.fetch = async (url, options) => {
    const path = String(url).replace('/api/', '')
    const body = options?.body ? JSON.parse(options.body) : null

    if (path === 'me') return json({ id: 7, device_id: 'd0' })
    if (path === 'account/box') {
      return json({ account_box_pubkey: account.box_pubkey })
    }
    if (path === 'devices') {
      return json({
        devices: deviceKeys.map((k, i) => ({
          id: `d${i}`,
          box_pubkey: k.box_pubkey,
          revoked_at: null,
        })),
      })
    }
    if (path.endsWith('/keys') && body) {
      const provider = path.split('/')[2]
      for (const k of body.keys) {
        store.keys = store.keys.filter(
          (e) =>
            !(
              e.provider === provider &&
              e.recipient_kind === k.recipient_kind &&
              e.recipient_id === k.recipient_id
            )
        )
        store.keys.push({ provider, ...k })
      }
      store.providers[provider] = store.providers[provider] ?? 'gpt-5.4-nano'
      store.active = provider
      return json({ ok: true })
    }
    if (path.endsWith('/keys')) {
      const provider = path.split('/')[2]
      return json({ keys: store.keys.filter((k) => k.provider === provider) })
    }
    if (path === 'ai/settings') {
      const providers = {}
      for (const [id, model] of Object.entries(store.providers)) {
        const mine = store.keys.find(
          (k) =>
            k.provider === id &&
            k.recipient_kind === 'device' &&
            k.recipient_id === 'd0'
        )
        providers[id] = { model, sealed_key: mine?.ciphertext ?? null }
      }
      return json({ active: store.active, providers })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { store, account, deviceKeys }
}

afterEach(forgetDeviceKey)

describe('saving an API key', () => {
  test('nothing that leaves the browser contains the key', async () => {
    const { store } = await serve()
    await saveApiKey('openai', API_KEY)

    const everything = JSON.stringify(store.keys)
    assert.ok(everything.length > 0, 'something was stored')
    assert.ok(!everything.includes(API_KEY), 'the key went up in the clear')
    assert.ok(!everything.includes('sk-live'))
  })

  test('seals a copy to the account and to every live device', async () => {
    const { store } = await serve({ devices: 3 })
    await saveApiKey('openai', API_KEY)

    const kinds = store.keys.map((k) => `${k.recipient_kind}:${k.recipient_id}`)
    assert.deepEqual(kinds.sort(), [
      'account:7',
      'device:d0',
      'device:d1',
      'device:d2',
    ])
    // Each sealed independently, so no two copies are byte-identical.
    assert.equal(new Set(store.keys.map((k) => k.ciphertext)).size, 4)
  })

  test('comes back readable on the device that saved it', async () => {
    await serve()
    await saveApiKey('openai', API_KEY)

    const settings = await loadAiSettings()
    assert.equal(settings.active, 'openai')
    assert.equal(settings.providers.openai.api_key, API_KEY)
    assert.equal(settings.providers.openai.model, 'gpt-5.4-nano')
  })
})

describe('a device that cannot open the key', () => {
  test('reports no key rather than a broken one', async () => {
    const { deviceKeys } = await serve()
    await saveApiKey('openai', API_KEY)

    // Same account, but this browser now holds a different device key —
    // the copy on the server was sealed to someone else's.
    await saveDeviceKey(await generateDeviceKey())
    const settings = await loadAiSettings()
    assert.equal(settings.providers.openai.api_key, null)
    assert.ok(deviceKeys[0].box_privkey, 'the original key still exists elsewhere')
  })

  test('picks the key up during enrolment, from the account copy', async () => {
    const { account } = await serve()
    await saveApiKey('openai', API_KEY)

    // A brand-new device: it can open nothing until enrolment re-seals to it.
    const fresh = await generateDeviceKey()
    await saveDeviceKey(fresh)
    assert.equal((await loadAiSettings()).providers.openai.api_key, null)

    await adoptApiKeysForNewDevice(account)
    assert.equal((await loadAiSettings()).providers.openai.api_key, API_KEY)
  })

  test('enrolment without the account key recovers nothing', async () => {
    await serve()
    await saveApiKey('openai', API_KEY)
    await saveDeviceKey(await generateDeviceKey())

    // A different account's key must not unseal this one.
    await adoptApiKeysForNewDevice(await generateAccountKey())
    assert.equal((await loadAiSettings()).providers.openai.api_key, null)
  })
})

describe('replacing a key', () => {
  test('the new key supersedes the old one on this device', async () => {
    await serve()
    await saveApiKey('openai', API_KEY)
    await saveApiKey('openai', 'sk-second-key')

    const settings = await loadAiSettings()
    assert.equal(settings.providers.openai.api_key, 'sk-second-key')
  })
})
