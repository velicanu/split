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
    }
  })

  const paid = {}
  const owed = {}
  for (const uid of memberIds) {
    paid[uid] = 0
    owed[uid] = 0
  }
  for (const x of expenses) {
    for (const pay of x.payers) {
      if (pay.user_id in paid) paid[pay.user_id] += pay.paid_cents
    }
    for (const s of x.splits) {
      if (s.user_id in owed) owed[s.user_id] += s.share_cents
    }
  }

  const nameById = Object.fromEntries(members.map((m) => [m.id, m.username]))
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
    .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1))

  return { members, balances, ledger }
}
