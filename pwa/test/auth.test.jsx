// The client half of the identity model, against a fake of our own API.
// Real libsodium and real (in-memory) IndexedDB — the point of these is that
// keys are actually generated, stored, and used to sign, so a break in any of
// that shows up here rather than on someone's phone.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import sodium from 'libsodium-wrappers-sumo'

import { changePassword, enrol, resume, signup } from '../src/auth.js'
import {
  forgetDeviceKey,
  loadDeviceKey,
  unwrapAccountKey,
  wrapAccountKey,
} from '../src/crypto.js'

// A server that stores what it is given and verifies signatures for real.
function fakeServer() {
  const state = { users: {}, devices: {}, wraps: {}, session: null, challenges: {} }
  const json = (body) => ({ ok: true, json: async () => body })
  const fail = (status, detail) => ({
    ok: false,
    status,
    json: async () => ({ detail }),
  })

  globalThis.fetch = async (url, options) => {
    const path = String(url).replace('/api/', '')
    const body = options?.body ? JSON.parse(options.body) : null

    if (path === 'signup') {
      if (state.users[body.login_handle]) return fail(409, 'taken')
      state.users[body.login_handle] = {
        id: Object.keys(state.users).length + 1,
        ...body,
      }
      state.wraps[body.login_handle] = body.wraps
      state.devices[body.device_pubkey] = {
        handle: body.login_handle,
        revoked: false,
      }
      state.session = body.login_handle
      return json({ ok: true })
    }
    if (path.startsWith('wraps?')) {
      const handle = decodeURIComponent(path.split('=')[1])
      return json({ wraps: state.wraps[handle] ?? [] })
    }
    if (path === 'wraps' && options.method === 'PUT') {
      state.wraps[state.session] = body.wraps
      return json({ ok: true })
    }
    if (path === 'auth/challenge') {
      const nonce = `nonce-${Object.keys(state.challenges).length}`
      state.challenges[nonce] = body.device_pubkey
      return json({ nonce })
    }
    if (path === 'auth/verify') {
      const issued = state.challenges[body.nonce]
      delete state.challenges[body.nonce]
      const device = state.devices[body.device_pubkey]
      if (issued !== body.device_pubkey || !device || device.revoked) {
        return fail(401, 'authentication failed')
      }
      // Verify for real: a broken signing path must not pass here.
      const ok = sodium.crypto_sign_verify_detached(
        sodium.from_base64(body.signature, sodium.base64_variants.ORIGINAL),
        sodium.from_string(body.nonce),
        sodium.from_base64(body.device_pubkey, sodium.base64_variants.ORIGINAL)
      )
      if (!ok) return fail(401, 'authentication failed')
      state.session = device.handle
      return json({ ok: true })
    }
    if (path === 'devices' && options?.method !== 'DELETE') {
      const owner = Object.values(state.users).find(
        (u) => u.account_pubkey === body.signer_pubkey
      )
      if (body.signed_by !== 'account' || !owner) return fail(401, 'bad auth')
      const ok = sodium.crypto_sign_verify_detached(
        sodium.from_base64(body.signature, sodium.base64_variants.ORIGINAL),
        sodium.from_string(body.pubkey),
        sodium.from_base64(body.signer_pubkey, sodium.base64_variants.ORIGINAL)
      )
      if (!ok) return fail(401, 'bad signature')
      state.devices[body.pubkey] = { handle: owner.login_handle, revoked: false }
      return json({ device_id: 'd2' })
    }
    if (path === 'me') {
      if (!state.session) return fail(401, 'not logged in')
      const u = state.users[state.session]
      return json({
        id: u.id,
        login_handle: u.login_handle,
        display_name: u.display_name,
      })
    }
    if (path === 'logout') {
      state.session = null
      return json({ ok: true })
    }
    return fail(404, `unexpected ${path}`)
  }
  return state
}

afterEach(forgetDeviceKey)

describe('signing up', () => {
  test('keeps a device key locally and sends only public material', async () => {
    const server = fakeServer()
    const me = await signup({
      login_handle: 'v',
      display_name: 'V',
      password: 'correct horse',
    })
    assert.equal(me.display_name, 'V')

    const stored = await loadDeviceKey()
    assert.ok(stored?.privkey, 'the device key must persist')

    const sent = server.users.v
    const body = JSON.stringify(sent)
    assert.ok(!body.includes('correct horse'), 'the password must not be sent')
    assert.ok(!body.includes(stored.privkey), 'the device key must not be sent')
    assert.ok(sent.account_pubkey && sent.device_pubkey)
  })

  test('the stored wrap really is the account key under that password', async () => {
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })

    const wrap = server.wraps.v[0]
    assert.ok(!wrap.ciphertext.includes('pw'))
    const account = await unwrapAccountKey(wrap, 'pw')
    assert.equal(account.pubkey, server.users.v.account_pubkey)
    await assert.rejects(() => unwrapAccountKey(wrap, 'wrong'), /Wrong password/)
  })

  test('leaves no device key behind if the server refuses', async () => {
    fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    await forgetDeviceKey()
    // Same handle again -> 409.
    await assert.rejects(() =>
      signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    )
    assert.equal(await loadDeviceKey(), null)
  })
})

describe('resuming on a device that already has a key', () => {
  test('signs the challenge and needs no password', async () => {
    fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    assert.equal((await resume())?.login_handle, 'v')
  })

  test('gives up and forgets the key when the device is revoked', async () => {
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    const device = await loadDeviceKey()
    server.devices[device.pubkey].revoked = true

    assert.equal(await resume(), null)
    assert.equal(
      await loadDeviceKey(),
      null,
      'a revoked key is dead weight — drop it so the UI offers a sign-in'
    )
  })

  test('returns null on a device that has never enrolled', async () => {
    fakeServer()
    assert.equal(await resume(), null)
  })
})

describe('enrolling a fresh device', () => {
  test('mints a new device key rather than reusing the old one', async () => {
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    const first = await loadDeviceKey()

    // A different browser: same account, no local key.
    await forgetDeviceKey()
    const me = await enrol({ login_handle: 'v', password: 'pw' })
    assert.equal(me.login_handle, 'v')

    const second = await loadDeviceKey()
    assert.notEqual(second.pubkey, first.pubkey, 'each device gets its own key')
    // Both are enrolled and neither displaced the other.
    assert.ok(server.devices[first.pubkey])
    assert.ok(server.devices[second.pubkey])
  })

  test('never persists the account key', async () => {
    fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    const account = await unwrapAccountKey(
      (await (await fetch('/api/wraps?login_handle=v')).json()).wraps[0],
      'pw'
    )
    await forgetDeviceKey()
    await enrol({ login_handle: 'v', password: 'pw' })

    const stored = JSON.stringify(await loadDeviceKey())
    assert.ok(
      !stored.includes(account.privkey),
      'a device that could reach the account key would make revocation pointless'
    )
  })

  test('the wrong password enrols nothing', async () => {
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    const before = Object.keys(server.devices).length
    await forgetDeviceKey()

    await assert.rejects(() => enrol({ login_handle: 'v', password: 'nope' }))
    assert.equal(await loadDeviceKey(), null)
    assert.equal(Object.keys(server.devices).length, before)
  })

  test('an unknown handle fails the same way as a wrong password', async () => {
    fakeServer()
    await assert.rejects(
      () => enrol({ login_handle: 'ghost', password: 'pw' }),
      /Wrong handle or password/
    )
  })
})

describe('changing the password', () => {
  test('re-wraps the same account key under the new one', async () => {
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'old' })
    const before = await unwrapAccountKey(server.wraps.v[0], 'old')

    await changePassword({ login_handle: 'v', current: 'old', next: 'new' })

    const after = server.wraps.v[0]
    await assert.rejects(() => unwrapAccountKey(after, 'old'))
    assert.deepEqual(await unwrapAccountKey(after, 'new'), before)
  })

  test('the wrong current password changes nothing', async () => {
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'old' })
    const original = server.wraps.v[0].ciphertext

    await assert.rejects(() =>
      changePassword({ login_handle: 'v', current: 'wrong', next: 'new' })
    )
    assert.equal(server.wraps.v[0].ciphertext, original)
  })

  test('a new device can be enrolled with the new password only', async () => {
    fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'old' })
    await changePassword({ login_handle: 'v', current: 'old', next: 'new' })
    await forgetDeviceKey()

    await assert.rejects(() => enrol({ login_handle: 'v', password: 'old' }))
    assert.equal((await enrol({ login_handle: 'v', password: 'new' })).login_handle, 'v')
  })
})

describe('wrapping', () => {
  test('two wraps of the same key differ, so the salt is really random', async () => {
    const account = { pubkey: 'p', privkey: 's' }
    const a = await wrapAccountKey(account, 'pw')
    const b = await wrapAccountKey(account, 'pw')
    assert.notEqual(a.ciphertext, b.ciphertext)
    assert.notEqual(a.params, b.params)
    assert.deepEqual(await unwrapAccountKey(a, 'pw'), account)
    assert.deepEqual(await unwrapAccountKey(b, 'pw'), account)
  })

  test('uses Argon2id, not a bare hash', async () => {
    const { params } = await wrapAccountKey({ privkey: 'x' }, 'pw')
    const parsed = JSON.parse(params)
    assert.equal(parsed.alg, sodium.crypto_pwhash_ALG_ARGON2ID13)
    assert.ok(parsed.ops >= 1 && parsed.mem >= 1)
  })
})
