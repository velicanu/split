// The screen behind a group link. One link goes to the whole group, so the
// question it has to answer is "who are you" — someone already in the split, or
// someone new — and it has to answer it *before* joining, because claiming is
// part of the join and cannot be done afterwards. See JoinGroup, preview.js and
// plan/12.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { JoinGroup } from '../src/components/JoinGroup.jsx'
import { encryptPayload, generateGroupKey } from '../src/crypto.js'
import { forgetGroupKeys } from '../src/groupkeys.js'
import { forgetLocalLedger, saveDeviceKey } from '../src/store.js'
import { generateDeviceKey, sealTo, generateAccountKey } from '../src/crypto.js'
import { $$, byText, click, mount, text, unmount } from './react.mjs'

const member = (id, name) => ({
  id,
  type: 'member.added',
  payload: { user_id: id, display_name: name },
})

// A ghost's name is encrypted, which is the whole reason the preview exists:
// the server cannot list who is claimable, so the client decrypts and folds.
const ghost = async (key, id, memberId, name) => ({
  id,
  type: 'member.ghost_added',
  payload: { enc: await encryptPayload(key, { member_id: memberId, display_name: name }) },
})

async function serve({ events, joined = false } = {}) {
  const joins = []
  const json = (b) => ({ ok: true, json: async () => b })
  globalThis.fetch = async (url, opts) => {
    const p = String(url)
    const body = opts?.body ? JSON.parse(opts.body) : null
    if (p.includes('/api/groups/preview')) {
      return json({ id: 7, name: 'Trip', events, joined })
    }
    if (p.endsWith('/api/groups/join')) {
      joins.push(body)
      return json({ id: 7, name: 'Trip', code: body.code })
    }
    // publishGroupKey seals the key from the fragment to this account/device.
    if (p.endsWith('/api/me')) return json({ id: 9, device_id: 'd1' })
    if (p.endsWith('/api/account/box')) {
      return json({ account_box_pubkey: accountBoxPubkey })
    }
    if (p.endsWith('/keys')) return json({})
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { joins }
}

// The client seals the group key to itself on the way in, so a real device key
// and a real account key have to exist for the join to complete — sealing to a
// made-up public key throws, and the join would look like it worked right up
// until the key failed to publish.
let accountBoxPubkey = null
async function device() {
  await saveDeviceKey(await generateDeviceKey())
  accountBoxPubkey = (await generateAccountKey()).box_pubkey
}

afterEach(async () => {
  await unmount()
  forgetGroupKeys()
  await forgetLocalLedger()
})

describe('joining from a group link', () => {
  test('offers the unclaimed ghosts by name, and claims the one picked', async () => {
    const key = await generateGroupKey()
    await device()
    const api = await serve({
      events: [member(1, 'Val'), await ghost(key, 2, -100, 'Sam')],
    })

    await mount(
      <JoinGroup invite={{ code: 'c0de', gk: key }} onJoined={() => {}} onCancel={() => {}} />
    )

    assert.ok(text().includes('Join Trip'))
    await click(byText('button', 'I’m Sam'))

    assert.deepEqual(api.joins, [{ code: 'c0de', claims: -100 }])
  })

  test('joining as someone new claims nobody', async () => {
    const key = await generateGroupKey()
    await device()
    const api = await serve({
      events: [member(1, 'Val'), await ghost(key, 2, -100, 'Sam')],
    })
    let landedOn = null

    await mount(
      <JoinGroup
        invite={{ code: 'c0de', gk: key }}
        onJoined={(id) => (landedOn = id)}
        onCancel={() => {}}
      />
    )
    await click(byText('button', 'I’m someone new'))

    assert.deepEqual(api.joins, [{ code: 'c0de', claims: null }])
    assert.equal(landedOn, 7)
  })

  test('a ghost somebody already claimed is not on offer', async () => {
    // The fold drops a member a claim pointed away from, so "already taken"
    // needs no separate rule here — but it is exactly the thing that would let
    // a second person quietly displace the first, so it is asserted.
    const key = await generateGroupKey()
    await device()
    await serve({
      events: [
        member(1, 'Val'),
        await ghost(key, 2, -100, 'Sam'),
        await ghost(key, 3, -101, 'Fran'),
        { id: 4, type: 'member.added', payload: { user_id: 5, display_name: 'Sam', claims: -100 } },
      ],
    })

    await mount(
      <JoinGroup invite={{ code: 'c0de', gk: key }} onJoined={() => {}} onCancel={() => {}} />
    )

    const offered = $$('.cols button').map((b) => b.textContent)
    assert.deepEqual(offered, ['I’m Fran'])
  })

  test('with nobody to claim it just says so', async () => {
    const key = await generateGroupKey()
    await device()
    await serve({ events: [member(1, 'Val')] })

    await mount(
      <JoinGroup invite={{ code: 'c0de', gk: key }} onJoined={() => {}} onCancel={() => {}} />
    )

    assert.equal($$('.cols button').length, 0)
    assert.ok(text().includes('Nobody in this group is waiting to be claimed'))
    assert.ok(byText('button', 'I’m someone new'))
  })

  test('already a member: straight in, with no claim to offer', async () => {
    // Claiming is part of joining, so there is nothing this screen could do for
    // someone who has already joined — asking would only produce a refusal.
    const key = await generateGroupKey()
    await device()
    const api = await serve({ events: [member(1, 'Val')], joined: true })
    let landedOn = null

    await mount(
      <JoinGroup
        invite={{ code: 'c0de', gk: key }}
        onJoined={(id) => (landedOn = id)}
        onCancel={() => {}}
      />
    )

    assert.equal(landedOn, 7)
    assert.deepEqual(api.joins, [], 'no join was attempted')
  })

  test('a link the server does not recognise says so instead of hanging', async () => {
    await device()
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ detail: 'no group with that code' }),
    })

    await mount(
      <JoinGroup
        invite={{ code: 'gone', gk: await generateGroupKey() }}
        onJoined={() => {}}
        onCancel={() => {}}
      />
    )

    assert.ok(text().includes('no group with that code'))
  })
})
