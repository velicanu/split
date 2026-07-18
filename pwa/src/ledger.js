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
  const expenses = []

  for (const e of events) {
    if (e.type === 'member.added') {
      if (!memberIds.includes(e.payload.user_id)) {
        members.push({ id: e.payload.user_id, username: e.payload.username })
        memberIds.push(e.payload.user_id)
      }
    } else if (e.type === 'expense.created') {
      expenses.push({
        id: e.id,
        description: e.payload.description,
        amount_cents: e.payload.amount_cents,
        paid_by: e.payload.paid_by,
      })
    }
  }

  const paid = {}
  const owed = {}
  for (const uid of memberIds) {
    paid[uid] = 0
    owed[uid] = 0
  }
  for (const x of expenses) {
    if (memberIds.length) {
      const shares = splitEqually(x.amount_cents, memberIds)
      for (const uid of memberIds) owed[uid] += shares[uid]
    }
    if (x.paid_by in paid) paid[x.paid_by] += x.amount_cents
  }

  const nameById = Object.fromEntries(members.map((m) => [m.id, m.username]))
  const balances = members.map((m) => ({
    user_id: m.id,
    username: m.username,
    net_cents: paid[m.id] - owed[m.id],
  }))
  const ledger = expenses
    .map((x) => ({ ...x, paid_by_name: nameById[x.paid_by] || '?' }))
    .sort((a, b) => b.id - a.id)

  return { members, balances, ledger }
}
