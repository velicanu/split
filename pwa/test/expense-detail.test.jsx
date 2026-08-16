// The detail view is where you go to ask "who is this row actually about", so
// it is where a claimed ghost's original name has to surface. Driven through
// the real fold rather than a hand-built expense object: the name and the
// resolved id are computed in ledger.js and rendered here, and a test that
// invented the shape itself could not tell the two apart if they drifted.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { ExpenseDetail } from '../src/components/ExpenseDetail.jsx'
import { computeState } from '../src/ledger.js'
import { $$, mount, text, unmount } from './react.mjs'

let nextId = 0
const ev = (type, payload) => ({ id: (nextId += 1), type, payload })
const member = (id, display_name, claims) =>
  ev('member.added', claims === undefined ? { user_id: id, display_name } : { user_id: id, display_name, claims })
const ghost = (id, display_name) => ev('member.ghost_added', { member_id: id, display_name })

const dinner = (over = {}) =>
  ev('expense.created', {
    expense_id: 'e1',
    description: 'Dinner',
    amount_cents: 1000,
    payers: [{ user_id: 1, paid_cents: 1000 }],
    splits: [
      { user_id: 1, share_cents: 500 },
      { user_id: -100, share_cents: 500 },
    ],
    date: '2026-01-01',
    ...over,
  })

// Whatever the fold makes of these events, shown the way the app shows it.
async function show(events) {
  const state = computeState(events)
  await mount(
    <ExpenseDetail
      groupId={7}
      expense={state.ledger[0]}
      members={state.members}
      meId={1}
      onClose={() => {}}
      onPost={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      readOnly
    />
  )
  return state
}

const rows = () => $$('.list .row.static span:first-child').map((s) => s.textContent)

afterEach(unmount)

describe('an expense that outlived the name it was written under', () => {
  test('shows the account that owns it now, and the ghost it was', async () => {
    await show([member(1, 'v'), ghost(-100, 'Sam'), dinner(), member(5, 'dragos', -100)])

    assert.ok(
      rows().includes('dragos (as Sam)'),
      `expected a row naming both, got ${JSON.stringify(rows())}`
    )
  })

  test('an expense written after the claim says nothing extra', async () => {
    await show([
      member(1, 'v'),
      ghost(-100, 'Sam'),
      member(5, 'dragos', -100),
      dinner({
        splits: [
          { user_id: 1, share_cents: 500 },
          { user_id: 5, share_cents: 500 },
        ],
      }),
    ])

    assert.ok(rows().includes('dragos'), 'the account is named')
    assert.ok(!text().includes('(as '), 'and nothing is claimed about its past')
  })

  test('with no claim in the log, no row is annotated', async () => {
    await show([member(1, 'v'), member(2, 'd'), dinner({
      splits: [
        { user_id: 1, share_cents: 500 },
        { user_id: 2, share_cents: 500 },
      ],
    })])

    assert.ok(!text().includes('(as '))
  })

  test('a receipt item claimed by the ghost is annotated too', async () => {
    // Otherwise the same person reads as two different people inside one
    // expense — annotated on the Owes row, bare on the item they claimed.
    await show([
      member(1, 'v'),
      ghost(-100, 'Sam'),
      dinner({
        split: {
          mode: 'items',
          participants: [1, -100],
          items: [{ id: 'i1', name: 'Wine', price_cents: 1000, claimed_by: [-100] }],
        },
      }),
      member(5, 'dragos', -100),
    ])

    const wine = $$('.list .row.static').find((li) => li.textContent.includes('Wine'))
    assert.ok(wine, 'the item is listed')
    assert.ok(
      wine.textContent.includes('dragos (as Sam)'),
      `expected the item claim to name both, got ${JSON.stringify(wine.textContent)}`
    )
  })
})
