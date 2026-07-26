// The two pairing screens against a fake rendezvous. The QR image and the full
// cross-endpoint approve/complete are exercised elsewhere (the live test); here
// we check the screens show the right things and drive the flow. See plan/17.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { PairNewDevice } from '../src/components/PairNewDevice.jsx'
import { PairOldDevice } from '../src/components/PairOldDevice.jsx'
import { deviceFingerprint } from '../src/fingerprint.js'
import { generateDeviceKey } from '../src/crypto.js'
import { forgetDeviceKey, saveDeviceKey } from '../src/store.js'
import { $, byText, change, click, mount, settle, submit, text, unmount } from './react.mjs'

// A rendezvous that stores one pending pairing and lets the old side approve it.
function serve() {
  const store = { pending: null, approved: false, approvedBody: null }
  const ok = (b) => ({ ok: true, json: async () => b })
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^\/api\//, '')
    const body = options.body ? JSON.parse(options.body) : null
    const method = options.method || (options.body ? 'POST' : 'GET')

    if (path === 'pairings' && method === 'POST') {
      store.pending = body
      return ok({ code: 'PAIR99' })
    }
    if (path === 'pairings/PAIR99' && method === 'GET') {
      return ok({ ...store.pending, approved: store.approved })
    }
    // The old device's approve path: add_device -> seal keys -> approve. Faked
    // to just record and flip; the real chain is in the live test.
    if (path === 'devices' && method === 'POST') return ok({ device_id: 'dN' })
    if (path === 'groups' && method === 'GET') return ok([])
    if (path === 'pairings/PAIR99/approve' && method === 'POST') {
      store.approved = true
      return ok({ ok: true })
    }
    if (path === 'me') return ok({ id: 1, login_handle: 'v', display_name: 'V', device_id: 'dN' })
    if (path === 'auth/challenge') return ok({ nonce: 'n' })
    if (path === 'auth/verify') return ok({ ok: true })
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return store
}

afterEach(async () => {
  await unmount()
  await forgetDeviceKey()
})

describe('the new device screen', () => {
  test('shows the code and a six-emoji fingerprint, then finishes on approval', async () => {
    serve()
    let paired = null
    await mount(<PairNewDevice onPaired={(me) => (paired = me)} onCancel={() => {}} />)

    assert.ok(text().includes('PAIR99'), 'the pairing code')
    const fp = $('.fingerprint').textContent.trim()
    assert.equal(fp.split(' ').length, 6, 'six emoji to compare')
    assert.ok(text().includes('Waiting for approval'))
    // Approval + completion is driven by a timer/poll — covered by the live test.
    assert.equal(paired, null, 'not done until approved')
  })
})

describe('the old device screen', () => {
  test('looks up a code, shows the matching fingerprint, and approves', async () => {
    const store = serve()
    // This device is signed in (holds a device key to sign the enrolment with).
    await saveDeviceKey(await generateDeviceKey())
    // Seed a pending pairing whose fingerprint we can predict.
    const nk = await generateDeviceKey()
    store.pending = { new_pubkey: nk.pubkey, new_box_pubkey: nk.box_pubkey, label: 'phone' }
    const expected = await deviceFingerprint(nk.pubkey)

    await mount(<PairOldDevice onClose={() => {}} />)
    await change($('input[placeholder="pairing code"]'), 'PAIR99')
    await submit($('form'))

    assert.ok($('.fingerprint'), 'the fingerprint to confirm is shown')
    assert.equal($('.fingerprint').textContent.trim(), expected, 'derived from the fetched key')

    await click(byText('button', 'They match — add the device'))
    assert.ok(text().includes('Device added'))
    assert.equal(store.approved, true, 'the rendezvous was approved')
  })

  test('a pre-filled code from a scanned link looks itself up', async () => {
    const store = serve()
    const nk = await generateDeviceKey()
    store.pending = { new_pubkey: nk.pubkey, new_box_pubkey: nk.box_pubkey, label: 'phone' }

    await mount(<PairOldDevice code="PAIR99" onClose={() => {}} />)
    await settle()
    assert.ok($('.fingerprint'), 'went straight to the confirm step')
  })
})
