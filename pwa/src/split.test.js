// The money-critical mapping from form inputs to frozen splits/payers, now pure
// and testable on its own (it used to live inside ExpenseForm.submit).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { resolvePayers, resolveSplit } from './split.js'

const members = [
  { id: 1, display_name: 'A' },
  { id: 2, display_name: 'B' },
  { id: 3, display_name: 'C' },
]

describe('resolveSplit', () => {
  test('equal splits across the included, remainder to lowest id', () => {
    const { splits, split } = resolveSplit('equal', 1000, { members })
    assert.deepEqual(split, { mode: 'equal' })
    assert.deepEqual(splits, [
      { user_id: 1, share_cents: 334 },
      { user_id: 2, share_cents: 333 },
      { user_id: 3, share_cents: 333 },
    ])
  })

  test('equal respects exclusions', () => {
    const { splits } = resolveSplit('equal', 1000, { members, excluded: [3] })
    assert.deepEqual(
      splits.map((s) => s.user_id),
      [1, 2]
    )
  })

  test('equal with nobody included is an error, not a crash', () => {
    assert.match(
      resolveSplit('equal', 1000, { members, excluded: [1, 2, 3] }).error,
      /at least one person/
    )
  })

  test('items: claimed items narrow, unclaimed spread, tax/tip ride the total', () => {
    // Pizza 10 → A; Beer 6 → B; Water 4 unclaimed → split A/B/C. Total 24 incl.
    // tax+tip, spread proportionally over the item weights.
    const items = [
      { id: 'a', name: ' Pizza ', price: '10.00', claimed_by: [1] },
      { id: 'b', name: 'Beer', price: '6.00', claimed_by: [2] },
      { id: 'c', name: 'Water', price: '4.00', claimed_by: [] },
    ]
    const { splits, split } = resolveSplit('items', 2400, {
      members,
      items,
      taxCents: 200,
      tipCents: 200,
    })
    assert.equal(split.mode, 'items')
    assert.deepEqual(split.tax_cents, 200)
    assert.equal(split.items[0].name, 'Pizza', 'names trimmed')
    // Weights: A 10+4/3, B 6+4/3, C 4/3 → scaled to 2400.
    const owed = Object.fromEntries(splits.map((s) => [s.user_id, s.share_cents]))
    assert.equal(owed[1] + owed[2] + owed[3], 2400, 'shares sum to the total')
    assert.ok(owed[1] > owed[2] && owed[2] > owed[3], 'A owes most, C least')
  })

  test('items with no priced lines is an error', () => {
    const items = [{ id: 'a', name: 'x', price: '', claimed_by: [] }]
    assert.match(resolveSplit('items', 100, { members, items }).error, /at least one item/)
  })

  test('percentage must total 100', () => {
    const bad = resolveSplit('percentage', 1000, { members, weights: { 1: '60', 2: '30' } })
    assert.match(bad.error, /total 100/)
    const ok = resolveSplit('percentage', 1000, { members, weights: { 1: '70', 2: '30' } })
    assert.deepEqual(ok.splits, [
      { user_id: 1, share_cents: 700 },
      { user_id: 2, share_cents: 300 },
    ])
  })

  test('shares split proportionally with no total constraint', () => {
    const { splits, split } = resolveSplit('shares', 900, { members, weights: { 1: '2', 2: '1' } })
    assert.equal(split.mode, 'shares')
    assert.deepEqual(splits, [
      { user_id: 1, share_cents: 600 },
      { user_id: 2, share_cents: 300 },
    ])
  })
})

describe('resolvePayers', () => {
  test('a single payer covers the whole amount', () => {
    assert.deepEqual(resolvePayers([2], {}, 1000), {
      payers: [{ user_id: 2, paid_cents: 1000 }],
    })
  })

  test('several payers must sum exactly to the amount', () => {
    assert.match(
      resolvePayers([1, 2], { 1: '6.00', 2: '3.00' }, 1000).error,
      /add up to/
    )
    assert.deepEqual(resolvePayers([1, 2], { 1: '6.00', 2: '4.00' }, 1000).payers, [
      { user_id: 1, paid_cents: 600 },
      { user_id: 2, paid_cents: 400 },
    ])
  })

  test('no payer is an error', () => {
    assert.match(resolvePayers([], {}, 1000).error, /who paid/)
  })
})
