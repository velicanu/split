// Run with: node --test pwa/src/
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalize } from './ai.js'

const raw = (over = {}) => ({
  items: [
    { name: 'Burger', price_cents: 1000 },
    { name: 'Wine', price_cents: 2000 },
  ],
  subtotal_cents: 3000,
  tax_cents: 250,
  tip_cents: 600,
  total_cents: 3850,
  ...over,
})

test('a receipt whose items reconcile with the subtotal passes', () => {
  const r = normalize(raw())
  assert.equal(r.matches, true)
  assert.equal(r.items_total_cents, 3000)
  assert.equal(r.subtotal_cents, 3000)
  assert.equal(r.tax_cents, 250)
  assert.equal(r.tip_cents, 600)
  assert.equal(r.total_cents, 3850)
})

test('items that do not add up to the subtotal are flagged', () => {
  // The model dropped a line: items sum to 3000 but the receipt says 3500.
  const r = normalize(raw({ subtotal_cents: 3500 }))
  assert.equal(r.matches, false)
  assert.equal(r.items_total_cents, 3000)
  assert.equal(r.subtotal_cents, 3500)
})

test('a receipt with no subtotal to check against is not flagged', () => {
  // Nothing to reconcile with, so blocking the user would be unanswerable.
  assert.equal(normalize(raw({ subtotal_cents: 0 })).matches, true)
})

test('tax and tip default to zero and never affect the total', () => {
  const r = normalize(raw({ tax_cents: 0, tip_cents: 0, total_cents: 3000 }))
  assert.equal(r.tax_cents, 0)
  assert.equal(r.tip_cents, 0)
  assert.equal(r.total_cents, 3000)
  assert.equal(r.matches, true)
})

test('junk items are dropped, and the check runs on what survives', () => {
  const r = normalize(
    raw({
      items: [
        { name: 'Burger', price_cents: 1000 },
        { name: 'Free refill', price_cents: 0 },
        { name: 'Garbled', price_cents: 'abc' },
        { name: 'Wine', price_cents: 2000 },
      ],
    })
  )
  assert.deepEqual(
    r.items.map((it) => it.name),
    ['Burger', 'Wine']
  )
  assert.equal(r.items_total_cents, 3000)
  assert.equal(r.matches, true)
})

test('a missing total falls back to subtotal + tax + tip', () => {
  const r = normalize(raw({ total_cents: 0 }))
  assert.equal(r.total_cents, 3850)
})

test('a missing total and subtotal falls back to the items sum', () => {
  const r = normalize(
    raw({ total_cents: 0, subtotal_cents: 0, tax_cents: 0, tip_cents: 0 })
  )
  assert.equal(r.total_cents, 3000)
})

test('negative amounts from the model are treated as absent', () => {
  const r = normalize(raw({ tax_cents: -250, subtotal_cents: -1 }))
  assert.equal(r.tax_cents, 0)
  assert.equal(r.subtotal_cents, 0)
  // An unusable subtotal means no check, not a failed one.
  assert.equal(r.matches, true)
})

test('a garbage response yields no items rather than throwing', () => {
  const r = normalize({})
  assert.deepEqual(r.items, [])
  assert.equal(r.items_total_cents, 0)
  assert.equal(r.total_cents, 0)
})
