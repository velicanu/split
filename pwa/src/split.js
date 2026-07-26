// Resolving an expense's inputs into the frozen numbers the ledger stores: the
// per-person `splits` (what balances actually use) and the `split` recipe (mode
// + inputs, kept for re-editing and display). Pulled out of ExpenseForm so this
// money-critical mapping is pure and unit-tested, and the component just wires
// its state in. Each function returns either its result or `{ error }` — a
// message the form shows — so no UI state leaks in here.
//
// The split maths themselves live in ledger.js (kept import-free); this is the
// orchestration on top, which is why it may lean on format.js.

import { receiptWeights, splitByWeights, splitEqually } from './ledger'
import { money, toCents } from './format'

const sharesToSplits = (shares) =>
  Object.keys(shares)
    .map(Number)
    .sort((a, b) => a - b)
    .map((uid) => ({ user_id: uid, share_cents: shares[uid] }))

/** Resolve a split mode + inputs to `{ splits, split }`, or `{ error }`.
 *  `cents` is the whole expense; `items`/`weights` carry the string-typed form
 *  fields, parsed here. */
export function resolveSplit(
  mode,
  cents,
  { members, excluded = [], items = [], weights = {}, taxCents = 0, tipCents = 0 }
) {
  const included = () =>
    members.map((m) => m.id).filter((id) => !excluded.includes(id))

  if (mode === 'equal') {
    const participants = included()
    if (!participants.length) {
      return { error: 'Pick at least one person to split between' }
    }
    const shares = splitEqually(cents, participants)
    return {
      splits: participants.map((uid) => ({ user_id: uid, share_cents: shares[uid] })),
      split: { mode: 'equal' },
    }
  }

  if (mode === 'items') {
    const participants = included()
    if (!participants.length) return { error: 'Pick who is on the receipt' }
    const parsed = items
      .map((it) => ({
        id: it.id,
        name: it.name.trim(),
        price_cents: toCents(it.price),
        claimed_by: it.claimed_by.filter((id) => participants.includes(id)),
      }))
      .filter((it) => it.price_cents > 0)
    if (!parsed.length) return { error: 'Add at least one item with a price' }
    // Only positive weights make it into splitByWeights; someone on the receipt
    // who claimed nothing and shares no unclaimed item owes nothing.
    const weighted = {}
    for (const [id, v] of Object.entries(receiptWeights(parsed, participants))) {
      if (v > 0) weighted[id] = v
    }
    return {
      splits: sharesToSplits(splitByWeights(cents, weighted)),
      // Subtotal isn't stored — it's just the sum of the items.
      split: { mode: 'items', participants, items: parsed, tax_cents: taxCents, tip_cents: tipCents },
    }
  }

  // percentage / shares
  const w = {}
  for (const m of members) {
    const v = parseFloat(weights[m.id])
    if (v > 0) w[m.id] = v
  }
  const ids = Object.keys(w)
  if (!ids.length) {
    return {
      error:
        mode === 'percentage'
          ? 'Enter a percentage for at least one person'
          : 'Enter shares for at least one person',
    }
  }
  if (mode === 'percentage') {
    const sum = ids.reduce((t, id) => t + w[id], 0)
    if (Math.abs(sum - 100) > 0.001) {
      return { error: `Percentages must total 100 (now ${sum})` }
    }
  }
  return { splits: sharesToSplits(splitByWeights(cents, w)), split: { mode, weights: w } }
}

/** Resolve who paid to `{ payers }`, or `{ error }`. One payer covers the whole
 *  amount; several must each be positive and sum to it exactly. */
export function resolvePayers(payerIds, payerAmounts, cents) {
  if (!payerIds.length) return { error: 'Pick who paid' }
  if (payerIds.length === 1) {
    return { payers: [{ user_id: payerIds[0], paid_cents: cents }] }
  }
  const payers = payerIds.map((uid) => ({
    user_id: uid,
    paid_cents: toCents(payerAmounts[uid]),
  }))
  if (payers.some((p) => p.paid_cents <= 0)) {
    return { error: 'Each payer must have paid a positive amount' }
  }
  const sum = payers.reduce((t, p) => t + p.paid_cents, 0)
  if (sum !== cents) {
    return { error: `Payments must add up to ${money(cents)} (now ${money(sum)})` }
  }
  return { payers }
}
