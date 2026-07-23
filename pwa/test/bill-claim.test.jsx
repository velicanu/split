// The account-less claim view: open a shared-bill link with no account, claim a
// ghost or join as new, tick your items, and watch the split fall out. Against
// a fake bill server that stores what it is given. See bill.js, BillClaim.jsx.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { BillClaim } from '../src/components/BillClaim.jsx'
import { forgetBillReceipts } from '../src/bill.js'
import {
  contentId,
  encryptBytes,
  encryptPayload,
  generateGroupKey,
} from '../src/crypto.js'
import { $, byText, change, click, mount, submit, text, unmount } from './react.mjs'

const sealName = (key, name) => encryptPayload(key, { display_name: name })

// A bill sealed under `key`: Alex (paid $16) and Sam are seeded ghosts, Pizza
// $10 and Beer $6 are the items. Optionally with a receipt image.
async function serve(key, { receipt = false } = {}) {
  const receipts = []
  const blobs = new Map()
  if (receipt) {
    const sealed = await encryptBytes(key, new Uint8Array([1, 2, 3, 4]))
    const rid = await contentId(sealed)
    blobs.set(rid, sealed)
    receipts.push(rid)
  }
  const bill = {
    id: 'bill1',
    token: 'tok1',
    snapshot: await encryptPayload(key, {
      description: 'Dinner',
      items: [
        { id: 'a', name: 'Pizza', price_cents: 1000 },
        { id: 'b', name: 'Beer', price_cents: 600 },
      ],
      payers: [{ participant_id: 1, paid_cents: 1600 }],
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1600,
      receipts,
    }),
    participants: [
      { participant_id: 1, name: await sealName(key, 'Alex'), claims: null, secret: null },
      { participant_id: 2, name: await sealName(key, 'Sam'), claims: null, secret: null },
    ],
  }
  const ok = (body) => ({ ok: true, json: async () => body })
  const bad = (status) => ({ ok: false, status, json: async () => ({}) })

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^\/api\//, '')
    const method = options.method || (options.body ? 'POST' : 'GET')
    const body = options.body ? JSON.parse(options.body) : null
    if (options.headers?.['X-Bill-Token'] !== bill.token) return bad(404)

    if (path === 'bills/bill1' && method === 'GET') {
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
    const claim = path.match(/^bills\/bill1\/participants\/(\d+)\/claim$/)
    if (claim && method === 'POST') {
      const p = bill.participants.find((x) => x.participant_id === Number(claim[1]))
      if (p.secret !== null) return bad(409)
      p.secret = body.secret
      return ok({ participant_id: p.participant_id })
    }
    if (path === 'bills/bill1/participants' && method === 'POST') {
      bill.participants.push({
        participant_id: body.participant_id,
        name: body.name,
        claims: null,
        secret: body.secret,
      })
      return ok({ participant_id: body.participant_id })
    }
    const claims = path.match(/^bills\/bill1\/participants\/(\d+)\/claims$/)
    if (claims && method === 'PUT') {
      const p = bill.participants.find((x) => x.participant_id === Number(claims[1]))
      if (p.secret !== body.secret) return bad(403)
      p.claims = body.claims
      return ok({ ok: true })
    }
    if (path.startsWith('bills/bill1/receipts/')) {
      const bytes = blobs.get(path.split('/receipts/')[1])
      if (!bytes) return bad(404)
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(0) }
    }
    return bad(404)
  }
  return bill
}

const link = (key) => ({ billId: 'bill1', key, token: 'tok1' })

afterEach(async () => {
  await unmount()
  forgetBillReceipts()
  localStorage.clear()
})

describe('the shared-bill claim view', () => {
  test('shows the receipt facts and asks who you are', async () => {
    const key = await generateGroupKey()
    await serve(key)
    await mount(<BillClaim link={link(key)} onExit={() => {}} />)

    assert.ok(text().includes('Dinner'), 'the description')
    assert.ok(text().includes('Pizza'), 'the items, decrypted')
    assert.ok(text().includes('paid $16.00'), 'who paid')
    // No account: it offers claiming a ghost or joining as new.
    assert.ok(byText('button', 'I’m Alex'))
    assert.ok(byText('button', 'I’m Sam'))
    assert.ok(byText('button', 'Join to claim your items'))
  })

  test('claiming a ghost then ticking an item updates the split', async () => {
    const key = await generateGroupKey()
    await serve(key)
    await mount(<BillClaim link={link(key)} onExit={() => {}} />)

    await click(byText('button', 'I’m Sam'))
    assert.ok(text().includes('claiming as'), 'now identified as Sam')

    // Sam claims the beer. Pizza stays unclaimed, so it splits across both.
    const beer = byText('.item', 'Beer')
    await change(beer.querySelector('input[type=checkbox]'), '')
    assert.ok(byText('.claims', 'claimed by you'), 'the beer is now yours')
    // Beer 600 to Sam + half the unclaimed pizza (500) = 1100.
    assert.ok(text().includes('$11.00'), 'Sam’s share reflects the claim')
    // Settlement: Sam owes Alex the 1100 Alex fronted.
    assert.ok(byText('li', 'Sam → Alex'))
  })

  test('a newcomer can join as someone new', async () => {
    const key = await generateGroupKey()
    await serve(key)
    await mount(<BillClaim link={link(key)} onExit={() => {}} />)

    await change($('input[placeholder="your name"]'), 'Robin')
    await submit($('form'))
    assert.ok(text().includes('claiming as'))
    assert.ok(text().includes('Robin'))
  })

  test('shows the receipt image, fetched with the bill token', async () => {
    const key = await generateGroupKey()
    await serve(key, { receipt: true })
    const realCreate = URL.createObjectURL
    URL.createObjectURL = () => 'blob:stub'
    try {
      await mount(<BillClaim link={link(key)} onExit={() => {}} />)
      assert.ok($('img.receipt-thumb'), 'the receipt decrypted and rendered')
    } finally {
      URL.createObjectURL = realCreate
    }
  })

  test('a dead link says so instead of blanking', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
    await mount(<BillClaim link={link('badkey')} onExit={() => {}} />)
    assert.ok(text().includes('not valid'))
  })
})
