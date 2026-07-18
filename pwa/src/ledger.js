// Client-side fold over a group's event log. Every client holds the same
// ledger and folds it deterministically, so they all derive the same state.
// splitEqually mirrors the Python reference in server/main.py exactly — they
// are the same spec and must stay in sync.

export function splitEqually(amountCents, memberIds) {
  const ids = [...memberIds].sort((a, b) => a - b)
  const n = ids.length
  const base = Math.floor(amountCents / n)
  const remainder = amountCents - base * n
  const shares = {}
  ids.forEach((uid, i) => {
    shares[uid] = base + (i < remainder ? 1 : 0)
  })
  return shares
}

// Fold events (in ascending id / total order) into the displayable state.
export function computeState(events) {
  const members = []
  const memberIds = []
  // expense_id -> its latest event. An edit is just a new expense.updated row
  // with the same expense_id; the latest one wins (append order is the total
  // order). Both payers and splits are frozen per revision.
  const latest = {}
  // settlement_id -> latest revision (anyone can record/edit/delete a payment)
  const settle = {}

  for (const e of events) {
    if (e.type === 'member.added') {
      if (!memberIds.includes(e.payload.user_id)) {
        members.push({ id: e.payload.user_id, username: e.payload.username })
        memberIds.push(e.payload.user_id)
      }
    } else if (e.type === 'expense.created' || e.type === 'expense.updated') {
      const p = e.payload
      // A well-formed expense carries a stable id, its payers, and its splits.
      // Rows from older models (single paid_by, no expense_id) are ignored —
      // WIP data is disposable, no backfill.
      if (!p || !p.expense_id) continue
      if (!Array.isArray(p.payers) || !Array.isArray(p.splits)) continue
      const prev = latest[p.expense_id]
      if (!prev || e.id > prev.id) latest[p.expense_id] = e
    } else if (
      e.type === 'settlement.created' ||
      e.type === 'settlement.updated'
    ) {
      const p = e.payload
      if (!p || !p.settlement_id) continue
      const prev = settle[p.settlement_id]
      if (!prev || e.id > prev.id) settle[p.settlement_id] = e
    }
  }

  const expenses = Object.values(latest).map((e) => {
    const p = e.payload
    return {
      id: e.id,
      expense_id: p.expense_id,
      description: p.description,
      amount_cents: p.amount_cents,
      payers: p.payers,
      splits: p.splits,
      date: p.date || '',
      category: p.category || '',
      // Soft delete: the row stays in the log with its data intact so it can
      // be shown struck-through and restored; it just stops counting.
      deleted: !!p.deleted,
    }
  })

  const nameById = Object.fromEntries(members.map((m) => [m.id, m.username]))

  const paid = {}
  const owed = {}
  for (const uid of memberIds) {
    paid[uid] = 0
    owed[uid] = 0
  }
  for (const x of expenses) {
    if (x.deleted) continue // deleted expenses don't affect balances
    for (const pay of x.payers) {
      if (pay.user_id in paid) paid[pay.user_id] += pay.paid_cents
    }
    for (const s of x.splits) {
      if (s.user_id in owed) owed[s.user_id] += s.share_cents
    }
  }

  const settlements = Object.values(settle).map((ev) => ({
    id: ev.id,
    settlement_id: ev.payload.settlement_id,
    from: ev.payload.from,
    to: ev.payload.to,
    amount_cents: ev.payload.amount_cents,
    date: ev.payload.date || '',
    deleted: !!ev.payload.deleted,
  }))
  // A payment moves money: the payer's net rises, the receiver's falls.
  for (const s of settlements) {
    if (s.deleted) continue
    if (s.from in paid) paid[s.from] += s.amount_cents
    if (s.to in paid) paid[s.to] -= s.amount_cents
  }

  const byDateDesc = (a, b) =>
    a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1
  const balances = members.map((m) => ({
    user_id: m.id,
    username: m.username,
    net_cents: paid[m.id] - owed[m.id],
  }))
  const ledger = expenses
    .map((x) => ({
      ...x,
      payer_names: x.payers.map((p) => nameById[p.user_id] || '?'),
      ways: x.splits.length,
    }))
    .sort(byDateDesc)
  const payments = settlements
    .filter((s) => !s.deleted)
    .map((s) => ({
      ...s,
      from_name: nameById[s.from] || '?',
      to_name: nameById[s.to] || '?',
    }))
    .sort(byDateDesc)

  return { members, balances, ledger, payments }
}

// Deterministic greedy min-cash-flow: repeatedly match the biggest debtor with
// the biggest creditor until everyone nets to zero. Every client folds the same
// balances and sorts with a stable user_id tiebreak, so all clients suggest the
// identical payments. Near-minimal (true minimum is NP-hard), which is fine.
export function simplify(balances) {
  const debtors = balances
    .filter((b) => b.net_cents < 0)
    .map((b) => ({ id: b.user_id, name: b.username, net: b.net_cents }))
    .sort((a, b) => a.net - b.net || a.id - b.id)
  const creditors = balances
    .filter((b) => b.net_cents > 0)
    .map((b) => ({ id: b.user_id, name: b.username, net: b.net_cents }))
    .sort((a, b) => b.net - a.net || a.id - b.id)

  const transfers = []
  let i = 0
  let j = 0
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(-debtors[i].net, creditors[j].net)
    transfers.push({
      from: debtors[i].id,
      from_name: debtors[i].name,
      to: creditors[j].id,
      to_name: creditors[j].name,
      amount_cents: amt,
    })
    debtors[i].net += amt
    creditors[j].net -= amt
    if (debtors[i].net === 0) i += 1
    if (creditors[j].net === 0) j += 1
  }
  return transfers
}
