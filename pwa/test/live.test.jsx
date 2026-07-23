// The real client modules against a real server process.
//
// Every unit test in this repo talks to a fake server, and a fake can only
// ever agree with whoever wrote it. Two shipped bugs lived exactly in that
// gap: the fake accepted `member.ghost_added` while the real server rejected
// every `member.*` event, so adding a ghost — and therefore inviting anyone —
// 400'd in production with both suites green.
//
// This file closes that gap for the handful of flows where client and server
// have to agree. It is not a second copy of the unit tests: it only asserts
// things a fake cannot tell us.
//
// Skipped unless SPLIT_LIVE points at a running server:
//
//   scripts/live.sh            # starts one, runs this, tears it down
//   SPLIT_LIVE=http://127.0.0.1:8011 npm run test:live
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { signup } from '../src/auth.js'
import { api } from '../src/api.js'
import { encryptPayload } from '../src/crypto.js'
import { createGroupKey, groupKey } from '../src/groupkeys.js'
import { buildInviteLink, parseInvite } from '../src/invite.js'
import {
  claimGhost,
  createBill,
  loadBill,
  newParticipantId,
  setClaims,
} from '../src/bill.js'

const BASE = process.env.SPLIT_LIVE
const skip = BASE ? false : 'set SPLIT_LIVE to a running server'

// The client calls fetch('/api/...') and lets the browser carry the session
// cookie. Node does neither, so point relative URLs at the server and keep a
// cookie jar. Nothing else about the client is changed — that is the point.
let jar = ''
if (BASE) {
  const real = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const target = String(url).startsWith('/') ? BASE + url : url
    const res = await real(target, {
      ...options,
      headers: { ...(options?.headers ?? {}), ...(jar ? { cookie: jar } : {}) },
    })
    const set = res.headers.getSetCookie?.() ?? []
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ')
    return res
  }
}

// Unique per run: the server keeps its database between runs of this file.
const handle = (name) => `live-${name}-${process.pid}-${Date.now()}`

describe('against a real server', { skip }, () => {
  after(() => {
    jar = ''
  })

  test('a new account can create a group and add a ghost', async () => {
    // The exact flow that was broken: hitting invite mints a ghost, and the
    // ghost event has to be one the server will actually accept.
    await signup({
      login_handle: handle('ghost'),
      display_name: 'Live',
      password: 'live-test-password',
    })
    const group = await api('groups', { name: 'Live trip' })
    const key = await createGroupKey(group.id)

    const member_id = -(Math.floor(Math.random() * 2 ** 45) + 1)
    const res = await api(`groups/${group.id}/events`, {
      event_id: crypto.randomUUID(),
      type: 'member.ghost_added',
      payload: { enc: await encryptPayload(key, { member_id, display_name: 'Fran' }) },
    })
    assert.ok(res.id > 0, 'the server accepted the ghost')

    // And leaving, which is the other event the prefix guard used to eat.
    const left = await api(`groups/${group.id}/events`, {
      event_id: crypto.randomUUID(),
      type: 'member.left',
      payload: { enc: await encryptPayload(key, { member_id }) },
    })
    assert.ok(left.id > left.id - 1)
  })

  test('an invite link round-trips through a second account', async () => {
    const owner = handle('owner')
    await signup({
      login_handle: owner,
      display_name: 'Owner',
      password: 'live-test-password',
    })
    const group = await api('groups', { name: 'Invited' })
    const key = await createGroupKey(group.id)
    const ghostId = -(Math.floor(Math.random() * 2 ** 45) + 1)
    await api(`groups/${group.id}/events`, {
      event_id: crypto.randomUUID(),
      type: 'member.ghost_added',
      payload: { enc: await encryptPayload(key, { member_id: ghostId, display_name: 'Sam' }) },
    })

    const link = buildInviteLink('https://split.example', group.code, key, ghostId)
    const invite = parseInvite(link)
    assert.equal(invite.member_id, ghostId, 'the link names the ghost')

    // A second account accepts it. The claim rides on the join, so the server
    // is the thing enforcing claimed-once.
    jar = ''
    await signup({
      login_handle: handle('joiner'),
      display_name: 'Joiner',
      password: 'live-test-password',
    })
    const joined = await api('groups/join', {
      code: invite.code,
      claims: invite.member_id,
    })
    assert.equal(joined.id, group.id)

    const added = (await api(`groups/${group.id}/events?since=0`)).events.filter(
      (e) => e.type === 'member.added'
    )
    assert.equal(added.at(-1).payload.claims, ghostId, 'the claim was recorded')

    // A third account cannot take the same member.
    jar = ''
    await signup({
      login_handle: handle('impostor'),
      display_name: 'Impostor',
      password: 'live-test-password',
    })
    await assert.rejects(
      () => api('groups/join', { code: invite.code, claims: ghostId }),
      /already been claimed/
    )
  })

  test('logging out un-enrols this device for real', async () => {
    await signup({
      login_handle: handle('out'),
      display_name: 'Out',
      password: 'live-test-password',
    })
    await api('logout', {})
    await assert.rejects(() => api('me'), /not logged in|Unauthorized|401/i)
  })

  test('the group key never leaves in the clear', async () => {
    // The one property no fake can vouch for: what the *server* ended up
    // storing. Read the events back and confirm they are opaque.
    await signup({
      login_handle: handle('sealed'),
      display_name: 'Sealed',
      password: 'live-test-password',
    })
    const group = await api('groups', { name: 'Sealed trip' })
    const key = await createGroupKey(group.id)
    await api(`groups/${group.id}/events`, {
      event_id: crypto.randomUUID(),
      type: 'expense.created',
      payload: {
        enc: await encryptPayload(key, {
          expense_id: crypto.randomUUID(),
          description: 'Distinctive dinner description',
          amount_cents: 1234,
          payers: [],
          splits: [],
        }),
      },
    })

    const raw = JSON.stringify(await api(`groups/${group.id}/events?since=0`))
    assert.ok(!raw.includes('Distinctive dinner description'))
    assert.ok(!raw.includes('1234'))
    assert.ok(await groupKey(group.id), 'but this device can still read it')
  })

  test('a read token serves the feed to a session-less reader', async () => {
    // The whole read-only-sharing feature turns on the server accepting a
    // token in place of a membership. Only a real server can confirm that.
    await signup({
      login_handle: handle('share'),
      display_name: 'Sharer',
      password: 'live-test-password',
    })
    const group = await api('groups', { name: 'Shared trip' })
    const key = await createGroupKey(group.id)
    await api(`groups/${group.id}/events`, {
      event_id: crypto.randomUUID(),
      type: 'expense.created',
      payload: { enc: await encryptPayload(key, { expense_id: 'x', description: 'Lunch' }) },
    })
    const { read_token } = await api(`groups/${group.id}/read-sharing`, { enabled: true })
    assert.ok(read_token)

    // Drop the session entirely — a stranger with only the link.
    jar = ''
    const h = { 'X-Read-Token': read_token }
    const feed = await api(`groups/${group.id}/events?since=0`, undefined, 'GET', h)
    assert.ok(feed.events.some((e) => e.type === 'expense.created'), 'the reader gets the feed')
    const meta = await api(`groups/${group.id}`, undefined, 'GET', h)
    assert.equal(meta.read_only, true)
    assert.ok(!('code' in meta), 'and not the join code')

    // Without the token, the session-less reader gets nothing.
    await assert.rejects(() => api(`groups/${group.id}/events?since=0`))
  })

  test('a shared bill: sealed create, account-less claim, folded split', async () => {
    // The bill's whole point is that claiming needs no account. Only a real
    // server can confirm the token gate, claim-once, and the sealed wire.
    await signup({
      login_handle: handle('bill'),
      display_name: 'Host',
      password: 'live-test-password',
    })
    const alex = newParticipantId()
    const sam = newParticipantId()
    const { billId, token, key } = await createBill({
      snapshot: {
        description: 'Live dinner',
        items: [
          { id: 'a', name: 'Distinctive pizza', price_cents: 1000 },
          { id: 'b', name: 'Beer', price_cents: 600 },
        ],
        payers: [{ participant_id: alex, paid_cents: 1600 }],
        tax_cents: 0,
        tip_cents: 0,
        total_cents: 1600,
      },
      participants: [
        { participant_id: alex, name: 'Alexander' },
        { participant_id: sam, name: 'Sam' },
      ],
    })

    // What the server stored is opaque — the item, the name, the description.
    const raw = JSON.stringify(
      await api(`bills/${billId}`, undefined, 'GET', { 'X-Bill-Token': token })
    )
    assert.ok(!raw.includes('Distinctive pizza'), 'items are sealed')
    assert.ok(!raw.includes('Alexander'), 'names are sealed')
    assert.ok(!raw.includes('Live dinner'), 'the description is sealed')

    // Drop the session: a stranger with only the link claims a ghost and their
    // items, and it survives — the token is the whole capability.
    jar = ''
    const me = await claimGhost({ billId, token }, sam)
    await setClaims({ billId, key, token }, sam, me.secret, ['b'])

    const loaded = await loadBill({ billId, key, token })
    // Beer 600 to Sam, plus half the unclaimed pizza (500) = 1100.
    assert.equal(loaded.split.owed[sam], 1100)
    assert.deepEqual(loaded.split.transfers, [
      { from: sam, from_name: 'Sam', to: alex, to_name: 'Alexander', amount_cents: 1100 },
    ])

    // First claim wins: the same ghost cannot be taken twice.
    await assert.rejects(() => claimGhost({ billId, token }, sam), /claimed|409/)
  })
})
