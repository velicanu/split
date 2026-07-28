// Cross-group projections (overview.js): the home hero's total and the merged
// Activity feed. loadOverviews touches IndexedDB + crypto and is exercised by
// the live suite; here it's the pure shaping — totalNet, activityFeed, netLabel.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { activityFeed, netLabel, totalNet } from '../src/overview.js'

// A minimal overview as loadOverviews would return one. `state` is null when the
// device can't read the group (no key / no events yet).
const readable = (id, name, myNet, { ledger = [], payments = [], meId = 1 } = {}) => ({
  id,
  name,
  members: 3,
  meId,
  myNet,
  state: { ledger, payments },
})
const unreadable = (id, name) => ({ id, name, members: null, state: null, myNet: null })

const exp = (id, over = {}) => ({
  id,
  expense_id: `e${id}`,
  description: 'Cabin',
  amount_cents: 4200,
  date: '2026-07-24',
  author: 2,
  author_name: 'Maya',
  deleted: false,
  ...over,
})
const pay = (id, over = {}) => ({
  id,
  settlement_id: `s${id}`,
  from: 1,
  to: 2,
  from_name: 'You',
  to_name: 'Maya',
  amount_cents: 2000,
  date: '2026-07-20',
  ...over,
})

describe('totalNet', () => {
  test('sums my balance across readable groups, ignoring unreadable ones', () => {
    const o = [readable(1, 'Ski', -8503), readable(2, 'Flat', 1200), unreadable(3, 'New')]
    assert.equal(totalNet(o), -7303)
  })

  test('is zero with nothing readable', () => {
    assert.equal(totalNet([unreadable(1, 'a')]), 0)
  })
})

describe('activityFeed', () => {
  test('merges expenses and payments across groups, newest first', () => {
    const o = [
      readable(1, 'Ski', -8503, {
        ledger: [exp(10, { date: '2026-07-25' }), exp(5, { date: '2026-07-24' })],
        payments: [pay(7, { date: '2026-07-26' })],
      }),
      readable(2, 'Flat', 0, { ledger: [exp(3, { date: '2026-07-01' })] }),
    ]
    const feed = activityFeed(o)
    assert.deepEqual(
      feed.map((i) => i.date),
      ['2026-07-26', '2026-07-25', '2026-07-24', '2026-07-01'],
      'sorted by date descending across both groups'
    )
    assert.equal(feed[0].kind, 'settlement')
    assert.equal(feed[0].group, 'Ski', 'each item carries its group name')
  })

  test('skips deleted expenses and unreadable groups', () => {
    const o = [
      readable(1, 'Ski', 0, { ledger: [exp(1), exp(2, { deleted: true })] }),
      unreadable(2, 'New'),
    ]
    const feed = activityFeed(o)
    assert.equal(feed.length, 1)
    assert.equal(feed[0].id, 1)
  })

  test('tags whether the entry is mine, from the per-group meId', () => {
    const o = [
      readable(1, 'Ski', 0, {
        meId: 1,
        ledger: [exp(1, { author: 1, author_name: 'You' }), exp(2, { author: 2 })],
        payments: [pay(3, { from: 1, to: 2 }), pay(4, { from: 5, to: 6 })],
      }),
    ]
    const byId = Object.fromEntries(activityFeed(o).map((i) => [i.id, i]))
    assert.equal(byId[1].mine, true, 'I added expense 1')
    assert.equal(byId[2].mine, false, 'Maya added expense 2')
    assert.equal(byId[3].mine, true, 'I am the payer in settlement 3')
    assert.equal(byId[4].mine, false, 'I am neither end of settlement 4')
  })
})

describe('netLabel', () => {
  test('phrases owed / owing / settled with a tone class', () => {
    assert.deepEqual(netLabel(0), { text: 'settled up', tone: 'muted' })
    assert.deepEqual(netLabel(8503), { text: "you're owed $85.03", tone: 'pos' })
    assert.deepEqual(netLabel(-8503), { text: 'you owe $85.03', tone: 'neg' })
  })
})
