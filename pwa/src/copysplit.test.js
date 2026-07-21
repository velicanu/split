import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { applyOption, splitOptions } from './copysplit.js'

const members = [
  { id: 1, display_name: 'A' },
  { id: 2, display_name: 'B' },
  { id: 3, display_name: 'C' },
]

// A ledger entry as computeState produces it: a resolved `splits` plus the
// `split` recipe. Newest first, since that is how the fold sorts the ledger.
const expense = (over) => ({
  expense_id: over.expense_id,
  description: over.description ?? 'thing',
  deleted: false,
  splits: over.splits,
  split: over.split,
})

const equalAmong = (id, ids, description) =>
  expense({
    expense_id: id,
    description,
    splits: ids.map((uid) => ({ user_id: uid, share_cents: 1 })),
    split: { mode: 'equal' },
  })

const byShares = (id, weights, description) =>
  expense({
    expense_id: id,
    description,
    splits: Object.keys(weights).map((uid) => ({
      user_id: Number(uid),
      share_cents: 1,
    })),
    split: { mode: 'shares', weights },
  })

describe('offering past splits', () => {
  test('surfaces the distinct ratio splits, newest first', () => {
    const options = splitOptions(
      [
        byShares('e3', { 1: 2, 2: 1 }, 'Rent'),
        equalAmong('e2', [1, 2], 'Lunch'),
        equalAmong('e1', [1, 2, 3], 'Dinner'),
      ],
      members
    )
    assert.deepEqual(
      options.map((o) => o.label),
      ['Rent · by shares', 'Lunch · equally', 'Dinner · equally']
    )
  })

  test('collapses identical splits to one, keeping the newest label', () => {
    // Three equal-among-everyone expenses are one reusable split.
    const options = splitOptions(
      [
        equalAmong('e3', [1, 2, 3], 'Third'),
        equalAmong('e2', [1, 2, 3], 'Second'),
        equalAmong('e1', [1, 2, 3], 'First'),
      ],
      members
    )
    assert.equal(options.length, 1)
    assert.equal(options[0].label, 'Third · equally')
  })

  test('different weightings are different splits', () => {
    const options = splitOptions(
      [byShares('e2', { 1: 1, 2: 1 }), byShares('e1', { 1: 2, 2: 1 })],
      members
    )
    assert.equal(options.length, 2)
  })

  test('receipt-item and deleted splits are not offered', () => {
    const options = splitOptions(
      [
        expense({
          expense_id: 'items',
          split: { mode: 'items', participants: [1, 2], items: [] },
          splits: [{ user_id: 1, share_cents: 1 }],
        }),
        { ...equalAmong('gone', [1, 2], 'Deleted'), deleted: true },
        equalAmong('ok', [1, 2], 'Kept'),
      ],
      members
    )
    assert.deepEqual(options.map((o) => o.id), ['ok'])
  })

  test('a split among people who have all left is dropped', () => {
    const options = splitOptions([equalAmong('e1', [8, 9], 'Ghosts')], members)
    assert.deepEqual(options, [])
  })

  test('the expense being edited cannot copy from itself', () => {
    const options = splitOptions([equalAmong('e1', [1, 2], 'Self')], members, {
      excludeId: 'e1',
    })
    assert.deepEqual(options, [])
  })
})

describe('stamping an option onto the form', () => {
  test('equal keeps the participants and excludes the rest, no weights', () => {
    const [opt] = splitOptions([equalAmong('e1', [1, 2], 'Lunch')], members)
    assert.deepEqual(applyOption(opt, members), {
      mode: 'equal',
      weights: {},
      excluded: [3],
    })
  })

  test('shares come across as strings, keyed by member, the rest excluded', () => {
    const [opt] = splitOptions([byShares('e1', { 1: 2, 3: 1 }, 'Rent')], members)
    assert.deepEqual(applyOption(opt, members), {
      mode: 'shares',
      weights: { 1: '2', 3: '1' },
      excluded: [2],
    })
  })

  test('a member who has since left is not carried into the stamp', () => {
    // The option was built when 9 was around; they are gone now.
    const opt = { mode: 'equal', participantIds: [1, 9], weights: null }
    assert.deepEqual(applyOption(opt, members), {
      mode: 'equal',
      weights: {},
      excluded: [2, 3], // 1 is in; 9 is not a member so cannot be
    })
  })
})
