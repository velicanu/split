// The fold is where a bug silently corrupts what people owe each other, so
// these lean on invariants (shares sum to the total, balances sum to zero,
// transfers settle everyone) rather than only on worked examples.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  computeState,
  receiptWeights,
  simplify,
  splitByWeights,
  splitEqually,
} from './ledger.js'

const sum = (obj) => Object.values(obj).reduce((t, v) => t + v, 0)

describe('splitEqually', () => {
  test('divides evenly when it can', () => {
    assert.deepEqual(splitEqually(900, [1, 2, 3]), { 1: 300, 2: 300, 3: 300 })
  })

  test('gives leftover cents to the lowest ids, whatever order they arrive in', () => {
    // Mirrors the Python reference in server/main.py, which the backend
    // test asserts separately — the two must agree or clients and server
    // would disagree about the same expense.
    assert.deepEqual(splitEqually(1000, [3, 1, 2]), { 1: 334, 2: 333, 3: 333 })
  })

  test('always sums to the amount', () => {
    for (const amount of [1, 2, 7, 99, 1000, 100001]) {
      for (const n of [1, 2, 3, 7]) {
        const ids = Array.from({ length: n }, (_, i) => i + 1)
        assert.equal(sum(splitEqually(amount, ids)), amount, `${amount}/${n}`)
      }
    }
  })

  test('handles an amount smaller than the group', () => {
    assert.deepEqual(splitEqually(2, [1, 2, 3]), { 1: 1, 2: 1, 3: 0 })
  })

  test('gives one person the whole amount', () => {
    assert.deepEqual(splitEqually(1234, [7]), { 7: 1234 })
  })
})

describe('splitByWeights', () => {
  test('splits in proportion to the weights', () => {
    assert.deepEqual(splitByWeights(1000, { 1: 75, 2: 25 }), { 1: 750, 2: 250 })
  })

  test('always sums to the amount, however awkward the weights', () => {
    const cases = [
      [1000, { 1: 1, 2: 1, 3: 1 }],
      [1, { 1: 1, 2: 1 }],
      [10000, { 1: 0.1, 2: 0.2, 3: 0.7 }],
      [4321, { 1: 33.3, 2: 33.3, 3: 33.4 }],
      [999, { 1: 1, 2: 2, 3: 3, 4: 5, 5: 8 }],
    ]
    for (const [amount, weights] of cases) {
      assert.equal(sum(splitByWeights(amount, weights)), amount)
    }
  })

  test('breaks a remainder tie by lowest id, so every client agrees', () => {
    // 1000/3 leaves one cent, and all three fractional parts are identical.
    assert.deepEqual(splitByWeights(1000, { 3: 1, 1: 1, 2: 1 }), {
      1: 334,
      2: 333,
      3: 333,
    })
  })

  test('gives leftover cents to the largest fractional remainder first', () => {
    // Exact shares are 50.0, 33.33, 16.66. The spare cent goes to #3's .66,
    // not to the lowest id — the weights, not the ids, decide.
    assert.deepEqual(splitByWeights(100, { 1: 3, 2: 2, 3: 1 }), {
      1: 50,
      2: 33,
      3: 17,
    })
  })

  test('agrees with splitEqually when the weights are equal', () => {
    for (const amount of [1000, 1001, 1002, 7]) {
      assert.deepEqual(
        splitByWeights(amount, { 1: 1, 2: 1, 3: 1 }),
        splitEqually(amount, [1, 2, 3])
      )
    }
  })

  test('returns nothing rather than dividing by zero', () => {
    assert.deepEqual(splitByWeights(1000, {}), {})
    assert.deepEqual(splitByWeights(1000, { 1: 0, 2: 0 }), {})
  })
})

describe('receiptWeights', () => {
  const items = [
    { price_cents: 1000, claimed_by: [1] },
    { price_cents: 600, claimed_by: [1, 2] },
    { price_cents: 400, claimed_by: [] },
  ]

  test('claimed items go to the claimers, unclaimed to everyone', () => {
    // 1000 to #1; 600 halved; 400 split three ways.
    const w = receiptWeights(items, [1, 2, 3])
    assert.equal(w[1], 1000 + 300 + 400 / 3)
    assert.equal(w[2], 300 + 400 / 3)
    assert.equal(w[3], 400 / 3)
  })

  test('the weights add up to the items subtotal', () => {
    // Weights are deliberately fractional (an item split three ways), so this
    // only holds to floating-point tolerance. That drift never reaches a
    // balance: splitByWeights re-normalises and allocates whole cents, which
    // is asserted to sum exactly above.
    assert.ok(Math.abs(sum(receiptWeights(items, [1, 2, 3])) - 2000) < 1e-6)
  })

  test('someone on the receipt who claimed nothing still shares unclaimed items', () => {
    const w = receiptWeights([{ price_cents: 900, claimed_by: [] }], [1, 2, 3])
    assert.deepEqual(w, { 1: 300, 2: 300, 3: 300 })
  })

  test('claims by people not on the receipt are ignored', () => {
    // #9 isn't a participant, so the item falls back to the claimers who are.
    const w = receiptWeights([{ price_cents: 1000, claimed_by: [9, 2] }], [1, 2])
    assert.deepEqual(w, { 1: 0, 2: 1000 })
  })

  test('an item claimed only by outsiders falls back to everyone', () => {
    const w = receiptWeights([{ price_cents: 900, claimed_by: [9] }], [1, 2, 3])
    assert.deepEqual(w, { 1: 300, 2: 300, 3: 300 })
  })

  test('free and negative line items are skipped', () => {
    const w = receiptWeights(
      [
        { price_cents: 0, claimed_by: [1] },
        { price_cents: -500, claimed_by: [1] },
        { price_cents: 600, claimed_by: [] },
      ],
      [1, 2]
    )
    assert.deepEqual(w, { 1: 300, 2: 300 })
  })
})

describe('a receipt end to end', () => {
  // The rule: line items decide the shares, the total decides what is owed.
  const items = [
    { price_cents: 1000, claimed_by: [1] },
    { price_cents: 2000, claimed_by: [2] },
  ]

  test('spreads tax and tip in proportion to what each person ordered', () => {
    // $30 of items, $36 charged: each person carries 20% more than they ordered.
    const shares = splitByWeights(3600, receiptWeights(items, [1, 2]))
    assert.deepEqual(shares, { 1: 1200, 2: 2400 })
    assert.equal(sum(shares), 3600)
  })

  test('spreads a discount the same way', () => {
    const shares = splitByWeights(2700, receiptWeights(items, [1, 2]))
    assert.deepEqual(shares, { 1: 900, 2: 1800 })
  })

  test('still sums to the total when the maths is not clean', () => {
    const shares = splitByWeights(3333, receiptWeights(items, [1, 2]))
    assert.equal(sum(shares), 3333)
  })

  test('someone on the receipt who ordered nothing owes nothing', () => {
    // A weight of 0 must not become a share of the tax.
    const weights = receiptWeights(items, [1, 2, 3])
    const positive = Object.fromEntries(
      Object.entries(weights).filter(([, v]) => v > 0)
    )
    const shares = splitByWeights(3600, positive)
    assert.equal(shares[3], undefined)
    assert.equal(sum(shares), 3600)
  })
})

// --- computeState ------------------------------------------------------

let nextId = 0
const ev = (type, payload, author) => ({
  id: (nextId += 1),
  type,
  payload,
  author,
})
const member = (id, username) => ev('member.added', { user_id: id, username })
const expense = (expense_id, over = {}) =>
  ev('expense.created', {
    expense_id,
    description: 'thing',
    amount_cents: 1000,
    payers: [{ user_id: 1, paid_cents: 1000 }],
    splits: [
      { user_id: 1, share_cents: 500 },
      { user_id: 2, share_cents: 500 },
    ],
    date: '2026-01-01',
    ...over,
  })
const netOf = (state, id) =>
  state.balances.find((b) => b.user_id === id).net_cents

describe('computeState members', () => {
  test('collects members in order and ignores repeats', () => {
    const state = computeState([member(1, 'v'), member(2, 'd'), member(1, 'v')])
    assert.deepEqual(state.members, [
      { id: 1, username: 'v' },
      { id: 2, username: 'd' },
    ])
  })
})

describe('computeState expenses', () => {
  test('splits an expense into balances', () => {
    const state = computeState([member(1, 'v'), member(2, 'd'), expense('e1')])
    assert.equal(netOf(state, 1), 500)
    assert.equal(netOf(state, 2), -500)
  })

  test('balances always sum to zero', () => {
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      member(3, 'm'),
      expense('e1'),
      expense('e2', {
        amount_cents: 999,
        payers: [
          { user_id: 1, paid_cents: 400 },
          { user_id: 3, paid_cents: 599 },
        ],
        splits: [
          { user_id: 1, share_cents: 333 },
          { user_id: 2, share_cents: 333 },
          { user_id: 3, share_cents: 333 },
        ],
      }),
    ])
    assert.equal(
      state.balances.reduce((t, b) => t + b.net_cents, 0),
      0
    )
  })

  test('a later edit of the same expense wins', () => {
    const created = expense('e1')
    const edited = ev('expense.updated', {
      ...created.payload,
      amount_cents: 2000,
      payers: [{ user_id: 1, paid_cents: 2000 }],
      splits: [
        { user_id: 1, share_cents: 1000 },
        { user_id: 2, share_cents: 1000 },
      ],
    })
    const state = computeState([member(1, 'v'), member(2, 'd'), created, edited])
    assert.equal(state.ledger.length, 1, 'an edit must not add a second row')
    assert.equal(state.ledger[0].amount_cents, 2000)
    assert.equal(netOf(state, 2), -1000)
  })

  test('a stale revision cannot overwrite a newer one', () => {
    // Same expense, but the older revision is folded last. Server sequence
    // decides, not arrival order — otherwise clients could diverge.
    const older = expense('e1')
    const newer = ev('expense.updated', { ...older.payload, amount_cents: 2000 })
    const state = computeState([member(1, 'v'), member(2, 'd'), newer, older])
    assert.equal(state.ledger[0].amount_cents, 2000)
  })

  test('a member who joins later does not change existing splits', () => {
    // The bug that prompted frozen splits: an expense between v and d must
    // not retroactively involve m.
    const events = [member(1, 'v'), member(2, 'd'), expense('e1')]
    const before = computeState(events)
    const after = computeState([...events, member(3, 'm')])

    assert.equal(netOf(after, 1), netOf(before, 1))
    assert.equal(netOf(after, 2), netOf(before, 2))
    assert.equal(netOf(after, 3), 0, 'a newcomer owes nothing for old expenses')
  })

  test('deleted expenses stop counting but stay visible', () => {
    const created = expense('e1')
    const removed = ev('expense.updated', { ...created.payload, deleted: true })
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      created,
      removed,
    ])
    assert.equal(netOf(state, 1), 0)
    assert.equal(netOf(state, 2), 0)
    assert.equal(state.ledger.length, 1)
    assert.equal(state.ledger[0].deleted, true)
  })

  test('restoring a deleted expense brings the balance back', () => {
    const created = expense('e1')
    const removed = ev('expense.updated', { ...created.payload, deleted: true })
    const restored = ev('expense.updated', {
      ...created.payload,
      deleted: false,
    })
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      created,
      removed,
      restored,
    ])
    assert.equal(netOf(state, 1), 500)
    assert.equal(state.ledger[0].deleted, false)
  })

  test('malformed rows are skipped rather than crashing the fold', () => {
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      ev('expense.created', null),
      ev('expense.created', { description: 'no id' }),
      ev('expense.created', { expense_id: 'x', payers: [] }), // no splits
      ev('expense.created', { expense_id: 'y', splits: [] }), // no payers
      expense('e1'),
    ])
    assert.equal(state.ledger.length, 1)
    assert.equal(netOf(state, 1), 500)
  })

  test('splits for people who are not members are ignored', () => {
    const state = computeState([
      member(1, 'v'),
      expense('e1', {
        splits: [
          { user_id: 1, share_cents: 500 },
          { user_id: 99, share_cents: 500 },
        ],
      }),
    ])
    assert.equal(netOf(state, 1), 500)
    assert.equal(state.balances.length, 1)
  })

  test('orders the ledger newest date first, newest event first within a date', () => {
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      expense('a', { date: '2026-01-01' }),
      expense('b', { date: '2026-03-01' }),
      expense('c', { date: '2026-01-01' }),
    ])
    assert.deepEqual(
      state.ledger.map((x) => x.expense_id),
      ['b', 'c', 'a']
    )
  })
})

describe('computeState settlements', () => {
  const paid = (settlement_id, over = {}) =>
    ev('settlement.created', {
      settlement_id,
      from: 2,
      to: 1,
      amount_cents: 500,
      date: '2026-01-02',
      ...over,
    })

  test('a payment clears the debt it covers', () => {
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      expense('e1'),
      paid('s1'),
    ])
    assert.equal(netOf(state, 1), 0)
    assert.equal(netOf(state, 2), 0)
  })

  test('payments keep balances summing to zero', () => {
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      expense('e1'),
      paid('s1', { amount_cents: 123 }),
    ])
    assert.equal(
      state.balances.reduce((t, b) => t + b.net_cents, 0),
      0
    )
  })

  test('an edited payment uses the latest amount', () => {
    const first = paid('s1')
    const edit = ev('settlement.updated', {
      ...first.payload,
      amount_cents: 200,
    })
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      expense('e1'),
      first,
      edit,
    ])
    assert.equal(netOf(state, 2), -300)
    assert.equal(state.payments.length, 1)
  })

  test('a deleted payment stops counting and disappears from the list', () => {
    const first = paid('s1')
    const gone = ev('settlement.updated', { ...first.payload, deleted: true })
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      expense('e1'),
      first,
      gone,
    ])
    assert.equal(netOf(state, 2), -500)
    assert.equal(state.payments.length, 0)
  })

  test('names both sides of a payment', () => {
    const state = computeState([member(1, 'v'), member(2, 'd'), paid('s1')])
    assert.equal(state.payments[0].from_name, 'd')
    assert.equal(state.payments[0].to_name, 'v')
  })
})

describe('computeState comments', () => {
  const comment = (comment_id, author, over = {}) =>
    ev('comment.created', { comment_id, expense_id: 'e1', text: 'hi', ...over }, author)
  const commentsOn = (state, id) =>
    state.ledger.find((x) => x.expense_id === id).comments

  test('hangs comments off their expense in the order they were written', () => {
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      expense('e1'),
      comment('c1', 1, { text: 'first' }),
      comment('c2', 2, { text: 'second' }),
    ])
    assert.deepEqual(
      commentsOn(state, 'e1').map((c) => c.text),
      ['first', 'second']
    )
    assert.equal(commentsOn(state, 'e1')[0].author_name, 'v')
  })

  test('an edit keeps the original author and position', () => {
    // The edit is authored by the same person but arrives last; it must not
    // jump to the end of the thread or be re-attributed.
    const first = comment('c1', 1, { text: 'first' })
    const second = comment('c2', 2, { text: 'second' })
    const edit = ev(
      'comment.updated',
      { comment_id: 'c1', expense_id: 'e1', text: 'edited' },
      1
    )
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      expense('e1'),
      first,
      second,
      edit,
    ])
    const comments = commentsOn(state, 'e1')
    assert.deepEqual(
      comments.map((c) => c.text),
      ['edited', 'second']
    )
    assert.equal(comments[0].author, 1)
    assert.equal(comments[0].author_name, 'v')
  })

  test('deleted comments disappear', () => {
    const first = comment('c1', 1)
    const gone = ev(
      'comment.updated',
      { comment_id: 'c1', expense_id: 'e1', text: 'hi', deleted: true },
      1
    )
    const state = computeState([
      member(1, 'v'),
      expense('e1'),
      first,
      gone,
    ])
    assert.deepEqual(commentsOn(state, 'e1'), [])
  })

  test('malformed comments are skipped', () => {
    const state = computeState([
      member(1, 'v'),
      expense('e1'),
      ev('comment.created', { text: 'no ids' }, 1),
      ev('comment.created', { comment_id: 'c9', text: 'no expense' }, 1),
    ])
    assert.deepEqual(commentsOn(state, 'e1'), [])
  })

  test('expenses with no comments get an empty list', () => {
    const state = computeState([member(1, 'v'), expense('e1')])
    assert.deepEqual(commentsOn(state, 'e1'), [])
  })
})

describe('simplify', () => {
  const bal = (entries) =>
    entries.map(([user_id, net_cents]) => ({
      user_id,
      username: `u${user_id}`,
      net_cents,
    }))

  // Applying the suggested transfers must leave everyone at zero.
  const settleAll = (balances) => {
    const net = Object.fromEntries(balances.map((b) => [b.user_id, b.net_cents]))
    for (const t of simplify(balances)) {
      net[t.from] += t.amount_cents
      net[t.to] -= t.amount_cents
    }
    return net
  }

  test('matches each debtor to a creditor', () => {
    const transfers = simplify(bal([[1, 1000], [2, -600], [3, -400]]))
    assert.deepEqual(
      transfers.map((t) => [t.from, t.to, t.amount_cents]),
      [
        [2, 1, 600],
        [3, 1, 400],
      ]
    )
  })

  test('settles everyone to zero', () => {
    const cases = [
      [[1, 1000], [2, -600], [3, -400]],
      [[1, 500], [2, 500], [3, -1000]],
      [[1, -333], [2, -333], [3, 666]],
      [[1, 1], [2, -1]],
      [[1, 12345], [2, -1], [3, -12344]],
      [[1, 700], [2, -200], [3, -200], [4, -300]],
    ]
    for (const entries of cases) {
      const net = settleAll(bal(entries))
      for (const [id, value] of Object.entries(net)) {
        assert.equal(value, 0, `${JSON.stringify(entries)} left ${id} at ${value}`)
      }
    }
  })

  test('pairs biggest debtor with biggest creditor to keep transfers down', () => {
    // Matching by size clears two people in one transfer each. Walking the
    // same balances in id order would need three transfers for the same
    // money, which is the whole point of sorting by size.
    // The big debtor and the big creditor both sit at the higher id, so
    // walking either side in id order gives itself away.
    const transfers = simplify(bal([[1, 100], [4, 500], [2, -100], [3, -500]]))
    assert.deepEqual(
      transfers.map((t) => [t.from, t.to, t.amount_cents]),
      [
        [3, 4, 500],
        [2, 1, 100],
      ]
    )
  })

  test('needs no more transfers than there are people, minus one', () => {
    const entries = [[1, 700], [2, -200], [3, -200], [4, -300]]
    assert.ok(simplify(bal(entries)).length <= entries.length - 1)
  })

  test('is deterministic regardless of the order balances arrive in', () => {
    const entries = [[3, -400], [1, 1000], [2, -600]]
    const forwards = simplify(bal(entries))
    const backwards = simplify(bal([...entries].reverse()))
    assert.deepEqual(forwards, backwards)
  })

  test('suggests nothing when everyone is square', () => {
    assert.deepEqual(simplify(bal([[1, 0], [2, 0]])), [])
    assert.deepEqual(simplify([]), [])
  })

  test('carries names so the suggestion can be shown', () => {
    const [t] = simplify(bal([[1, 500], [2, -500]]))
    assert.equal(t.from_name, 'u2')
    assert.equal(t.to_name, 'u1')
  })
})

describe('the whole pipeline', () => {
  test('an expense, an edit, a comment and a payment settle to zero', () => {
    const created = expense('e1', { amount_cents: 3000 })
    const state = computeState([
      member(1, 'v'),
      member(2, 'd'),
      member(3, 'm'),
      created,
      ev('expense.updated', {
        ...created.payload,
        amount_cents: 3000,
        payers: [{ user_id: 1, paid_cents: 3000 }],
        splits: [
          { user_id: 1, share_cents: 1000 },
          { user_id: 2, share_cents: 1000 },
          { user_id: 3, share_cents: 1000 },
        ],
      }),
      ev('comment.created', { comment_id: 'c1', expense_id: 'e1', text: 'ta' }, 2),
      ev('settlement.created', {
        settlement_id: 's1',
        from: 2,
        to: 1,
        amount_cents: 1000,
        date: '2026-01-02',
      }),
    ])

    assert.equal(netOf(state, 2), 0, 'd paid their share back')
    assert.equal(netOf(state, 1), 1000)
    assert.equal(netOf(state, 3), -1000)
    assert.equal(state.ledger[0].comments.length, 1)

    // Whatever simplify suggests must finish the job.
    const net = Object.fromEntries(
      state.balances.map((b) => [b.user_id, b.net_cents])
    )
    for (const t of simplify(state.balances)) {
      net[t.from] += t.amount_cents
      net[t.to] -= t.amount_cents
    }
    assert.deepEqual(net, { 1: 0, 2: 0, 3: 0 })
  })
})
