// The bill client against a fake server that stores what it is given, the way
// receipts.test.js does. It exercises the real seal/fold: createBill seals a
// snapshot the fake never reads, and loadBill folds the claims back into a
// split — including the group rule that unclaimed items spread across everyone.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import {
  claimGhost,
  createBill,
  joinBill,
  loadBill,
  loadMe,
  rememberMe,
  setClaims,
} from './bill.js'

// A minimal, faithful bill server: it enforces the same things the real one
// does (the token gate, claim-once, secret-gated claim edits) so the client is
// tested against the same rules, not a pushover.
function serve() {
  const bills = new Map()
  let seq = 0
  const bad = (status, detail) => ({
    ok: false,
    status,
    json: async () => ({ detail }),
  })
  const ok = (body) => ({ ok: true, json: async () => body })

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^\/api\//, '')
    const method = options.method || (options.body ? 'POST' : 'GET')
    const body = options.body ? JSON.parse(options.body) : null
    const token = options.headers?.['X-Bill-Token']

    if (path === 'bills' && method === 'POST') {
      const id = `b${(seq += 1)}`
      const bill = { id, token: `tok-${id}`, snapshot: body.snapshot, participants: [] }
      for (const p of body.participants || []) {
        bill.participants.push({ ...p, claims: null, secret: null })
      }
      bill.receipts = body.receipts || []
      bills.set(id, bill)
      return ok({ id, token: bill.token })
    }

    const m = path.match(/^bills\/([^/]+)(.*)$/)
    if (!m) return bad(404, 'not found')
    const bill = bills.get(m[1])
    // The token gate: same opaque 404 the real server gives.
    if (!bill || token !== bill.token) return bad(404, 'bill not found')
    const rest = m[2]

    if (rest === '' && method === 'GET') {
      return ok({
        id: bill.id,
        snapshot: bill.snapshot,
        participants: bill.participants.map((p) => ({
          participant_id: p.participant_id,
          name: p.name,
          claims: p.claims,
          claimed: p.secret !== null,
        })),
      })
    }
    if (rest === '/participants' && method === 'POST') {
      if (bill.participants.some((p) => p.participant_id === body.participant_id)) {
        return bad(409, 'that participant id is taken')
      }
      bill.participants.push({
        participant_id: body.participant_id,
        name: body.name,
        claims: null,
        secret: body.secret,
      })
      return ok({ participant_id: body.participant_id })
    }
    const claim = rest.match(/^\/participants\/(\d+)\/claim$/)
    if (claim && method === 'POST') {
      const p = bill.participants.find((x) => x.participant_id === Number(claim[1]))
      if (!p) return bad(404, 'no such person on this bill')
      if (p.secret !== null) return bad(409, 'that person has already been claimed')
      p.secret = body.secret
      return ok({ participant_id: p.participant_id })
    }
    const claims = rest.match(/^\/participants\/(\d+)\/claims$/)
    if (claims && method === 'PUT') {
      const p = bill.participants.find((x) => x.participant_id === Number(claims[1]))
      if (!p || p.secret === null) return bad(404, 'no such person on this bill')
      if (p.secret !== body.secret) return bad(403, 'not your claims')
      p.claims = body.claims
      return ok({ ok: true })
    }
    return bad(404, 'not found')
  }
  return { bills }
}

const SNAPSHOT = {
  items: [
    { id: 'a', name: 'Pizza', price_cents: 1000 },
    { id: 'b', name: 'Beer', price_cents: 600 },
    { id: 'c', name: 'Water', price_cents: 400 },
  ],
  payers: [{ participant_id: 1, paid_cents: 2000 }],
  tax_cents: 0,
  tip_cents: 0,
  total_cents: 2000,
}
const SEEDS = [
  { participant_id: 1, name: 'Alex' },
  { participant_id: 2, name: 'Sam' },
]

afterEach(() => {
  try {
    localStorage.clear()
  } catch {
    // no storage in this environment
  }
})

describe('publishing a bill', () => {
  test('the server never sees the items or the names in the clear', async () => {
    const store = serve()
    await createBill({ snapshot: SNAPSHOT, participants: SEEDS })
    const stored = JSON.stringify([...store.bills.values()])
    assert.ok(!stored.includes('Pizza'), 'items are sealed')
    assert.ok(!stored.includes('Alex'), 'seeded names are sealed')
    assert.ok(!stored.includes('2000'), 'even the total is sealed')
  })

  test('hands back the link parts, key included', async () => {
    serve()
    const { billId, token, key } = await createBill({ snapshot: SNAPSHOT })
    assert.ok(billId && token && key)
  })
})

describe('loading and folding a bill', () => {
  test('claimed items narrow, unclaimed items spread across everyone', async () => {
    serve()
    const link = await createBill({ snapshot: SNAPSHOT, participants: SEEDS })

    // Alex claims the pizza, Sam the beer; the water is left unclaimed.
    const alex = await claimGhost(link, 1)
    await setClaims(link, 1, alex.secret, ['a'])
    const sam = await claimGhost(link, 2)
    await setClaims(link, 2, sam.secret, ['b'])

    const { split, items } = await loadBill(link)
    // Pizza 1000 to Alex, Beer 600 to Sam, Water 400 split 200/200.
    assert.equal(split.owed[1], 1200)
    assert.equal(split.owed[2], 800)
    // Alex paid 2000, owes 1200 -> +800; Sam owes 800 -> -800.
    assert.deepEqual(split.transfers, [
      { from: 2, from_name: 'Sam', to: 1, to_name: 'Alex', amount_cents: 800 },
    ])
    assert.deepEqual(
      items.find((it) => it.id === 'a').claimed_by,
      [1],
      'the item carries who claimed it'
    )
  })

  test('with nothing claimed, the whole bill splits evenly', async () => {
    serve()
    const link = await createBill({ snapshot: SNAPSHOT, participants: SEEDS })
    const { split } = await loadBill(link)
    // Every item unclaimed -> 2000 split two ways.
    assert.equal(split.owed[1], 1000)
    assert.equal(split.owed[2], 1000)
  })
})

describe('joining', () => {
  test('a newcomer self-joins and shows up as a participant', async () => {
    serve()
    const link = await createBill({ snapshot: SNAPSHOT, participants: SEEDS })
    const me = await joinBill(link, 'Robin')

    const { participants } = await loadBill(link)
    const robin = participants.find((p) => p.participant_id === me.participant_id)
    assert.equal(robin.name, 'Robin')
    assert.equal(robin.claimed, true)
  })

  test('a ghost can only be claimed once', async () => {
    serve()
    const link = await createBill({ snapshot: SNAPSHOT, participants: SEEDS })
    await claimGhost(link, 1)
    await assert.rejects(() => claimGhost(link, 1), /already been claimed/)
  })

  test('only the secret holder can rewrite a participant’s claims', async () => {
    serve()
    const link = await createBill({ snapshot: SNAPSHOT, participants: SEEDS })
    await claimGhost(link, 1)
    await assert.rejects(
      () => setClaims(link, 1, 'not-the-secret', ['a']),
      /not your claims|403/i
    )
  })
})

describe('remembering who I am on a bill', () => {
  test('round-trips through storage, per bill', async () => {
    rememberMe('b1', { participant_id: 5, secret: 'k' })
    assert.deepEqual(loadMe('b1'), { participant_id: 5, secret: 'k' })
    assert.equal(loadMe('other'), null)
  })
})
