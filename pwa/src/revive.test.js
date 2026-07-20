// The remap is the dangerous part of a revive: a reference it misses does not
// raise, it quietly moves money. So the central assertion here is not a shape
// but an invariant — fold the plan back and every balance must be exactly what
// it was in the group being left. See plan/12.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { computeState } from './ledger.js'
import { planRevive } from './revive.js'

let nextId = 0
const ev = (type, payload, author) => ({ id: (nextId += 1), type, payload, author })
const member = (id, display_name) => ev('member.added', { user_id: id, display_name })
const ghost = (member_id, display_name) =>
  ev('member.ghost_added', { member_id, display_name })

// Ghost ids are minted at random in production; pinning them keeps the
// assertions readable and is the only reason `mint` is injectable.
const pinned = () => {
  let n = 0
  return () => -(1000 + (n += 1))
}

/** Fold `events`, plan a revive as `meId`, then fold the plan.
 *
 *  The reviver's own `member.added` is written by the server when the new
 *  group is created, before anything planned here — so the round trip has to
 *  include it or the reviver would be missing from their own group. */
const roundTrip = (events, meId) => {
  const before = computeState(events)
  const me = before.members.find((m) => m.id === meId)
  const { events: planned } = planRevive(before, meId, { mint: pinned() })
  const after = computeState([
    member(meId, me.display_name),
    ...planned.map((e) => ev(e.type, e.payload, meId)),
  ])
  return { before, after }
}

const netOf = (state, id) =>
  state.balances.find((b) => b.user_id === id)?.net_cents

/** What each *person* is owed, keyed by name — the only thing that has to
 *  survive a revive, since every id on the other side is new. */
const byName = (state) =>
  Object.fromEntries(state.balances.map((b) => [b.display_name, b.net_cents]))

const dinner = ev('expense.created', {
  expense_id: 'e1',
  description: 'Dinner',
  amount_cents: 1000,
  payers: [{ user_id: 1, paid_cents: 1000 }],
  splits: [
    { user_id: 1, share_cents: 500 },
    { user_id: 2, share_cents: 500 },
  ],
  date: '2026-01-01',
})

describe('reviving a two-person group', () => {
  const events = [member(1, 'v'), member(2, 'd'), dinner]

  test('every balance survives exactly', () => {
    const { before, after } = roundTrip(events, 2)
    assert.deepEqual(byName(after), byName(before))
    assert.deepEqual(byName(after), { v: 500, d: -500 })
  })

  test('the reviver keeps their own id and is not a ghost', () => {
    const { after } = roundTrip(events, 2)
    const me = after.members.find((m) => m.id === 2)
    assert.ok(me, 'I am still me')
    assert.ok(!me.ghost, 'and I am live in my own group')
  })

  test('everyone else becomes a ghost, under a fresh negative id', () => {
    const { after } = roundTrip(events, 2)
    const others = after.members.filter((m) => m.id !== 2)
    assert.equal(others.length, 1)
    assert.equal(others[0].display_name, 'v')
    assert.ok(others[0].ghost, 'a name, not an account')
    assert.ok(others[0].id < 0, 'and an id that cannot collide with a real user')
  })

  test('it records where it came from, first', () => {
    const before = computeState(events)
    const { events: planned } = planRevive(before, 2, {
      mint: pinned(),
      from: { group_id: 7, at_event_id: 42 },
    })
    assert.equal(planned[0].type, 'group.revived_from')
    assert.deepEqual(planned[0].payload, { group_id: 7, at_event_id: 42 })
  })
})

describe('what the remap has to reach', () => {
  test('payers, not just splits', () => {
    // If only splits were remapped the payer would stay under an id nobody
    // holds, and the money they laid out would silently vanish.
    const { before, after } = roundTrip([member(1, 'v'), member(2, 'd'), dinner], 2)
    assert.deepEqual(byName(after), byName(before))
    assert.equal(netOf(after, 2), -500)
  })

  test('both ends of a settlement', () => {
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      dinner,
      ev('settlement.created', {
        settlement_id: 's1',
        from: 2,
        to: 1,
        amount_cents: 500,
        date: '2026-01-02',
      }),
    ]
    const { before, after } = roundTrip(events, 2)
    assert.deepEqual(byName(after), byName(before))
    assert.deepEqual(byName(after), { v: 0, d: 0 })
  })

  test('a receipt recipe, so the editor does not name strangers', () => {
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      ev('expense.created', {
        expense_id: 'e1',
        description: 'Dinner',
        amount_cents: 1000,
        payers: [{ user_id: 1, paid_cents: 1000 }],
        splits: [
          { user_id: 1, share_cents: 400 },
          { user_id: 2, share_cents: 600 },
        ],
        split: {
          mode: 'items',
          participants: [1, 2],
          items: [{ id: 'i1', price_cents: 1000, claimed_by: [1] }],
        },
        date: '2026-01-01',
      }),
    ]
    const { after } = roundTrip(events, 2)
    const recipe = after.ledger[0].split
    const ids = after.members.map((m) => m.id)
    assert.ok(recipe.participants.every((id) => ids.includes(id)))
    assert.ok(recipe.items[0].claimed_by.every((id) => ids.includes(id)))
    assert.ok(!recipe.participants.includes(1), 'the old id is gone')
  })

  test('percentage weights', () => {
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      ev('expense.created', {
        expense_id: 'e1',
        description: 'Dinner',
        amount_cents: 1000,
        payers: [{ user_id: 1, paid_cents: 1000 }],
        splits: [
          { user_id: 1, share_cents: 700 },
          { user_id: 2, share_cents: 300 },
        ],
        split: { mode: 'percentage', weights: { 1: 70, 2: 30 } },
        date: '2026-01-01',
      }),
    ]
    const { after } = roundTrip(events, 2)
    const ids = after.members.map((m) => String(m.id))
    assert.ok(Object.keys(after.ledger[0].split.weights).every((k) => ids.includes(k)))
  })
})

describe('what a revive absorbs', () => {
  test('existing ghosts come across as ghosts, not as members', () => {
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      ghost(-100, 'Fran'),
      ev('expense.created', {
        expense_id: 'e1',
        description: 'Dinner',
        amount_cents: 900,
        payers: [{ user_id: 2, paid_cents: 900 }],
        splits: [
          { user_id: 1, share_cents: 300 },
          { user_id: 2, share_cents: 300 },
          { user_id: -100, share_cents: 300 },
        ],
        date: '2026-01-01',
      }),
    ]
    const { before, after } = roundTrip(events, 2)
    assert.deepEqual(byName(after), byName(before))
    assert.deepEqual(byName(after), { v: -300, d: 600, Fran: -300 })
  })

  test('being ghosted myself is not replayed', () => {
    // In my own group I am live, and everyone else is a ghost from the start,
    // so there is nothing left for a member.left to say.
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      dinner,
      ev('member.left', { member_id: 2 }, 1),
    ]
    const { before, after } = roundTrip(events, 2)
    const { events: planned } = planRevive(before, 2, { mint: pinned() })
    assert.equal(planned.filter((e) => e.type === 'member.left').length, 0)
    assert.deepEqual(byName(after), byName(before))
    assert.ok(!after.members.find((m) => m.id === 2).ghost)
  })

  test('a claim chain is absorbed rather than replayed', () => {
    // My history is under an id I no longer use; the clone should carry the
    // resolved position, not the claims that produced it.
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      dinner,
      ev('member.added', { user_id: 3, display_name: 'd-again', claims: 2 }),
    ]
    const { before, after } = roundTrip(events, 3)
    assert.deepEqual(byName(after), byName(before))
    assert.deepEqual(byName(after), { v: 500, 'd-again': -500 })
    assert.equal(after.members.length, 2, 'the abandoned id did not come across')
  })

  test('deleted expenses do not come across', () => {
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      dinner,
      ev('expense.updated', {
        expense_id: 'e1',
        description: 'Dinner',
        amount_cents: 1000,
        payers: [{ user_id: 1, paid_cents: 1000 }],
        splits: [
          { user_id: 1, share_cents: 500 },
          { user_id: 2, share_cents: 500 },
        ],
        date: '2026-01-01',
        deleted: true,
      }),
    ]
    const { before, after } = roundTrip(events, 2)
    assert.deepEqual(byName(after), byName(before))
    assert.deepEqual(byName(after), { v: 0, d: 0 })
    assert.equal(after.ledger.length, 0, 'no tombstone in the new log')
  })
})

describe('what stays behind', () => {
  test('receipt images', () => {
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      ev('expense.created', {
        ...dinner.payload,
        receipts: ['a'.repeat(64)],
      }),
    ]
    const before = computeState(events)
    const { events: planned } = planRevive(before, 2, { mint: pinned() })
    const expense = planned.find((e) => e.type === 'expense.created')
    // Sealed under the old group key and keyed by group, so carrying the id
    // would produce a reference to something unreadable. Better to have none.
    assert.deepEqual(expense.payload.receipts, [])
  })

  test('comments', () => {
    // The fold takes a comment's author from the signed event author, so every
    // replayed comment would be attributed to the reviver. Misattributing what
    // people said is worse than not carrying it.
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      dinner,
      ev('comment.created', { comment_id: 'c1', expense_id: 'e1', text: 'mine' }, 1),
    ]
    const before = computeState(events)
    const { events: planned } = planRevive(before, 2, { mint: pinned() })
    assert.equal(planned.filter((e) => e.type.startsWith('comment.')).length, 0)
    assert.ok(!JSON.stringify(planned).includes('mine'))
  })

  test('and neither omission moves a balance', () => {
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      ev('expense.created', { ...dinner.payload, receipts: ['a'.repeat(64)] }),
      ev('comment.created', { comment_id: 'c1', expense_id: 'e1', text: 'mine' }, 1),
    ]
    const { before, after } = roundTrip(events, 2)
    assert.deepEqual(byName(after), byName(before))
  })
})

describe('a bigger group, folded both ways', () => {
  test('nobody gains or loses a cent', () => {
    const events = [
      member(1, 'v'),
      member(2, 'd'),
      member(3, 'm'),
      ghost(-100, 'Fran'),
      ev('expense.created', {
        expense_id: 'e1',
        description: 'Villa',
        amount_cents: 9999,
        payers: [
          { user_id: 1, paid_cents: 5000 },
          { user_id: 3, paid_cents: 4999 },
        ],
        splits: [
          { user_id: 1, share_cents: 2500 },
          { user_id: 2, share_cents: 2500 },
          { user_id: 3, share_cents: 2500 },
          { user_id: -100, share_cents: 2499 },
        ],
        date: '2026-01-01',
      }),
      ev('settlement.created', {
        settlement_id: 's1',
        from: 2,
        to: 1,
        amount_cents: 1234,
        date: '2026-01-02',
      }),
    ]
    const { before, after } = roundTrip(events, 3)
    assert.deepEqual(byName(after), byName(before))
    assert.equal(
      after.balances.reduce((t, b) => t + b.net_cents, 0),
      0,
      'and they still sum to zero'
    )
  })
})
