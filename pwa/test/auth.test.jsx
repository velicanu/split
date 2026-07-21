// The client half of the identity model, against a fake of our own API.
// Real libsodium and real (in-memory) IndexedDB — the point of these is that
// keys are actually generated, stored, and used to sign, so a break in any of
// that shows up here rather than on someone's phone.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import sodium from 'libsodium-wrappers-sumo'

import { changePassword, enrol, logout, resume, signup } from '../src/auth.js'
import {
  forgetLocalLedger,
  localEvents,
  localGroupKey,
  saveGroupKey,
} from '../src/store.js'
import { append } from '../src/sync.js'
import {
  forgetDeviceKey,
  forgetSession,
  loadDeviceKey,
  loadSession,
  saveDeviceKey,
  unwrapAccountKey,
  wrapAccountKey,
} from '../src/crypto.js'

// A server that stores what it is given and verifies signatures for real.
function fakeServer() {
  const state = {
    users: {},
    devices: {},
    wraps: {},
    session: null,
    sessionDevice: null,
    challenges: {},
    // group id -> [{recipient_kind, recipient_id, ciphertext}]
    groupKeys: {},
    groups: [],
    // Flip on to simulate no signal: fetch rejects, as it does in a browser
    // that cannot reach the server, rather than returning an HTTP error.
    offline: false,
  }
  const json = (body) => ({ ok: true, json: async () => body })
  const fail = (status, detail) => ({
    ok: false,
    status,
    json: async () => ({ detail }),
  })

  globalThis.fetch = async (url, options) => {
    if (state.offline) throw new TypeError('Failed to fetch')
    const path = String(url).replace('/api/', '')
    const body = options?.body ? JSON.parse(options.body) : null

    if (path === 'signup') {
      if (state.users[body.login_handle]) return fail(409, 'taken')
      state.users[body.login_handle] = {
        id: Object.keys(state.users).length + 1,
        device_id: 'd1',
        ...body,
      }
      state.wraps[body.login_handle] = body.wraps
      state.devices[body.device_pubkey] = {
        handle: body.login_handle,
        revoked: false,
      }
      state.session = body.login_handle
      state.sessionDevice = body.device_pubkey
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
      state.sessionDevice = body.device_pubkey
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
      owner.device_id = 'd2'
      return json({ device_id: 'd2' })
    }
    if (path === 'groups' && !body) {
      return json(state.groups)
    }
    if (path === 'account/box') {
      const u = state.users[state.session]
      return json({ account_box_pubkey: u.account_box_pubkey })
    }
    if (path.startsWith('groups/') && path.endsWith('/keys')) {
      const gid = Number(path.split('/')[1])
      const rows = state.groupKeys[gid] ?? []
      if (options?.method === 'POST' || body) {
        state.groupKeys[gid] = [...rows, ...body.keys]
        return json({ ok: true })
      }
      // Only rows addressed to the caller's own device/account, as the server
      // does — otherwise a test could 'succeed' by reading someone else's.
      const u = state.users[state.session]
      const mine = rows.filter(
        (r) =>
          (r.recipient_kind === 'account' && r.recipient_id === String(u.id)) ||
          (r.recipient_kind === 'device' && r.recipient_id === u.device_id)
      )
      return json({ keys: mine })
    }
    if (path === 'me') {
      if (!state.session) return fail(401, 'not logged in')
      const u = state.users[state.session]
      return json({
        id: u.id,
        login_handle: u.login_handle,
        display_name: u.display_name,
        device_id: u.device_id,
      })
    }
    if (path === 'logout') {
      // Logging out un-enrols the device, exactly as the server does. A fake
      // that only dropped the session would let the client look safe while
      // leaving a browser anyone could sign back in on.
      delete state.devices[state.sessionDevice]
      state.sessionDevice = null
      state.session = null
      return json({ ok: true })
    }
    return fail(404, `unexpected ${path}`)
  }
  return state
}

afterEach(async () => {
  localStorage.clear()
  await forgetDeviceKey()
  await forgetSession()
  await forgetLocalLedger()
})

describe('signing up', () => {
  test('starts clean, dropping any previous account’s cached ledger', async () => {
    // A brand-new identity inherits nothing on this device — otherwise events
    // an earlier account cached, keyed differently, read as undecryptable.
    fakeServer()
    await saveGroupKey(1, 'old-account-key')
    await append(1, { event_id: 'x', type: 'expense.created', payload: { enc: 'y' } })

    await signup({ login_handle: 'fresh', display_name: 'F', password: 'pw' })
    assert.deepEqual(await localEvents(1), [])
    assert.ok(!(await localGroupKey(1)))
  })

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
    // Distinctive on purpose: the ciphertext is base64, so a short password
    // like "pw" turns up in it by chance often enough to flake the assertion.
    const password = 'correct-horse-battery-staple'
    await signup({ login_handle: 'v', display_name: 'V', password })

    const wrap = server.wraps.v[0]
    assert.ok(!wrap.ciphertext.includes(password))
    const account = await unwrapAccountKey(wrap, password)
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
    delete server.devices[device.pubkey]

    assert.equal(await resume(), null)
    assert.equal(
      await loadDeviceKey(),
      null,
      'a revoked key is dead weight — drop it so the UI offers a sign-in'
    )
  })

  test('stays signed in offline, and keeps the key', async () => {
    // The bug: an offline refresh went through the same path as a rejected
    // key, so resume() returned null *and* deleted the device — signing you
    // out with no way back but the password. Offline is not a rejection.
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })

    server.offline = true
    const me = await resume()
    assert.equal(me?.login_handle, 'v', 'still signed in, from the cached identity')
    assert.ok(await loadDeviceKey(), 'and the key is untouched')
  })

  test('offline before ever reaching the server has nobody to be', async () => {
    // A device key with no cached identity yet — nothing to open against, so
    // fall through to the sign-in screen rather than a half-loaded session.
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    await forgetSession()

    server.offline = true
    assert.equal(await resume(), null)
    assert.ok(await loadDeviceKey(), 'but the key still survives for next time')
  })

  test('a genuine rejection still drops the key', async () => {
    // The distinction has to cut both ways: online and turned away is still a
    // revoked device, and the dead key goes.
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    const device = await loadDeviceKey()
    delete server.devices[device.pubkey]

    assert.equal(await resume(), null)
    assert.equal(await loadDeviceKey(), null)
    assert.equal(await loadSession(), null, 'and the cached identity with it')
  })

  test('returns null on a device that has never enrolled', async () => {
    fakeServer()
    assert.equal(await resume(), null)
  })

  test('a rejected device clears its orphaned local ledger', async () => {
    // The reported bug: offline-first caches the ledger by group id. A server
    // wipe (a dev-time schema bump) resets the DB, reuses group ids, and the
    // old events — under the old key — then surface as undecryptable under the
    // new group. A rejected device means the server is gone from under us, so
    // its cache is orphaned and must go.
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    await saveGroupKey(1, 'stale-key')
    await append(1, { event_id: 'old', type: 'expense.created', payload: { enc: 'x' } })
    assert.equal((await localEvents(1)).length, 1, 'the setup cached something')

    const device = await loadDeviceKey()
    delete server.devices[device.pubkey] // the wipe/revoke

    assert.equal(await resume(), null)
    assert.deepEqual(await localEvents(1), [], 'the stale ledger is gone')
    assert.ok(!(await localGroupKey(1)), 'and the stale key with it')
  })
})

describe('signing out', () => {
  // The bug this replaced: logging out ended the session but kept the device
  // key, and the key alone signs the challenge. So a refresh signed you back
  // in — and on a shared computer, so did whoever sat down next.
  //
  // Logging out therefore un-enrols the browser. Getting back in needs the
  // password, the same as anywhere else.
  test('works with no signal, clearing everything local anyway', async () => {
    // Logging out cannot depend on reaching the server \u2014 on a shared computer
    // that would leave the key and the ledger sitting there. The device row
    // lingers server-side until revoked from elsewhere; the local state does
    // not wait for that.
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    server.offline = true

    await logout() // must not throw
    assert.equal(await loadDeviceKey(), null)
    assert.equal(await loadSession(), null)
  })

  test('forgets this device\u2019s key', async () => {
    fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    await logout()
    assert.equal(await loadDeviceKey(), null)
  })

  test('so a refresh does not sign you back in', async () => {
    fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    await logout()
    assert.equal(await resume(), null)
  })

  test('and the server will not take the old key either', async () => {
    // The property that actually protects a public computer: forgetting the
    // key locally is not enough on its own, because a copy taken beforehand
    // would still work. The device has to be gone server-side.
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'pw' })
    const stolen = await loadDeviceKey()
    await logout()

    // Someone puts the key back \u2014 an extension, a backup, devtools.
    await saveDeviceKey(stolen)
    assert.equal(await resume(), null, 'the server no longer knows this device')
    assert.equal(await loadDeviceKey(), null, 'and the dead key is dropped')
    assert.ok(!server.devices[stolen.pubkey])
  })

  test('getting back in needs the password', async () => {
    fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'distinct-pw' })
    await logout()

    await assert.rejects(
      () => enrol({ login_handle: 'v', password: 'wrong' }),
      /password|handle/i
    )
    assert.equal(
      (await enrol({ login_handle: 'v', password: 'distinct-pw' }))?.login_handle,
      'v'
    )
  })

  test('coming back mints a new device rather than reviving the old one', async () => {
    fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'distinct-pw' })
    const before = await loadDeviceKey()
    await logout()
    await enrol({ login_handle: 'v', password: 'distinct-pw' })

    const after = await loadDeviceKey()
    assert.notEqual(after.pubkey, before.pubkey)
  })

  test('takes the local ledger with it', async () => {
    // The offline copy holds the group key and the group's history. Leaving it
    // on a shared computer after someone has logged out would hand over the
    // whole split, which is the same failure logging out just fixed for the
    // device key. See plan/04.
    fakeServer()
    await signup({ login_handle: 'ledger-user', display_name: 'L', password: 'pw' })
    await saveGroupKey(7, 'a-group-key')
    await append(7, { event_id: 'e1', type: 'expense.created', payload: { enc: 'x' } })
    assert.equal((await localEvents(7)).length, 1, 'the setup stored something')

    await logout()

    assert.deepEqual(await localEvents(7), [], 'the log is gone')
    assert.ok(!(await localGroupKey(7)), 'and so is the key that opened it')
  })

  test('other devices are untouched', async () => {
    // Signing out of a library computer must not sign you out of your phone.
    const server = fakeServer()
    await signup({ login_handle: 'v', display_name: 'V', password: 'distinct-pw' })
    const phone = await loadDeviceKey()

    // A second browser enrols, then signs out.
    await forgetDeviceKey()
    await enrol({ login_handle: 'v', password: 'distinct-pw' })
    await logout()

    assert.ok(server.devices[phone.pubkey], 'the phone is still enrolled')
    await saveDeviceKey(phone)
    assert.equal((await resume())?.login_handle, 'v')
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
