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

// Split proportionally to weights — percentages, shares, and later a receipt's
// per-person subtotals all resolve through here. Leftover cents go by largest
// fractional remainder with a user_id tiebreak, so it's deterministic and the
// shares always sum to the total. Weights: { user_id: positive number }.
export function splitByWeights(amountCents, weights) {
  const ids = Object.keys(weights).map(Number).sort((a, b) => a - b)
  const total = ids.reduce((t, id) => t + weights[id], 0)
  if (!ids.length || total <= 0) return {}

  const shares = {}
  const fracs = []
  let allocated = 0
  for (const id of ids) {
    const exact = (amountCents * weights[id]) / total
    const base = Math.floor(exact)
    shares[id] = base
    allocated += base
    fracs.push({ id, frac: exact - base })
  }
  fracs.sort((a, b) => b.frac - a.frac || a.id - b.id)
  const remainder = amountCents - allocated
  for (let i = 0; i < remainder; i += 1) shares[fracs[i].id] += 1
  return shares
}

// Receipt claiming -> weights. An item claimed by several people splits equally
// between them; an unclaimed item splits equally among everyone on the receipt.
// The weights sum to the items subtotal; feeding them to splitByWeights with the
// receipt total is what spreads tax/tip (or a discount) proportionally — items
// decide the shares, the total decides what everyone actually owes.
export function receiptWeights(items, participantIds) {
  const weights = {}
  for (const id of participantIds) weights[id] = 0
  for (const item of items) {
    const price = item.price_cents || 0
    if (price <= 0) continue
    const claimed = (item.claimed_by || []).filter((id) =>
      participantIds.includes(id)
    )
    const targets = claimed.length ? claimed : participantIds
    if (!targets.length) continue
    const each = price / targets.length
    for (const id of targets) weights[id] += each
  }
  return weights
}

// Resolve a chain of merges to whoever the person is now. Merges compose —
// lose your account twice and you get A -> B -> C — and a malformed pair could
// name a cycle, so this walks with a guard rather than trusting the data.
function resolver(alias) {
  const cache = new Map()
  return function resolve(id) {
    if (cache.has(id)) return cache.get(id)
    const chain = [id]
    const seen = new Set([id])
    let current = id
    while (alias.has(current)) {
      const next = alias.get(current)
      if (seen.has(next)) {
        // A cycle — nonsense data, but it still has to fold to *something*,
        // and every client must pick the same something. Stopping mid-walk
        // instead would let both ends of a two-way merge vanish, taking their
        // balances with them.
        current = Math.min(...chain.slice(chain.indexOf(next)))
        break
      }
      seen.add(next)
      chain.push(next)
      current = next
    }
    for (const node of chain) cache.set(node, current)
    return current
  }
}

// Fold events (in ascending id / total order) into the displayable state.
export function computeState(events) {
  const members = []
  const memberIds = []
  // old member id -> the account that person uses now. Losing every device
  // means starting a new account; this is what reattaches their history to
  // them instead of stranding it under an identity nobody can sign for.
  const alias = new Map()
  // Members who have been turned into ghosts. They keep their history and
  // their balances; they simply have nobody attached any more.
  const ghosted = new Set()
  // expense_id -> its latest event. An edit is just a new expense.updated row
  // with the same expense_id; the latest one wins (append order is the total
  // order). Both payers and splits are frozen per revision.
  const latest = {}
  // settlement_id -> latest revision (anyone can record/edit/delete a payment)
  const settle = {}
  // comment_id -> { ev: latest revision, createdId, author } (author edits own)
  const commentRev = {}

  // Member ids that have taken part in anything financial. A merge may only
  // name an unused member as the claimer, so that claiming a ghost can never
  // double as a way to net off your own balance. See plan/12.
  const active = new Set()
  const noteActive = (rows, key) => {
    for (const row of rows ?? []) active.add(row[key])
  }

  for (const e of events) {
    if (e.type === 'member.added') {
      if (!memberIds.includes(e.payload.user_id)) {
        members.push({ id: e.payload.user_id, display_name: e.payload.display_name })
        memberIds.push(e.payload.user_id)
      }
    } else if (e.type === 'member.ghost_added') {
      // Someone splitting expenses with the group who doesn't use the app.
      // Identical to a member everywhere the money is concerned.
      const p = e.payload
      if (!p || typeof p.member_id !== 'number') continue
      if (!memberIds.includes(p.member_id)) {
        members.push({
          id: p.member_id,
          display_name: p.display_name || 'someone',
          ghost: true,
        })
        memberIds.push(p.member_id)
      }
    } else if (e.type === 'expense.created' || e.type === 'expense.updated') {
      const p = e.payload
      // A well-formed expense carries a stable id, its payers, and its splits.
      // Rows from older models (single paid_by, no expense_id) are ignored —
      // WIP data is disposable, no backfill.
      if (!p || !p.expense_id) continue
      if (!Array.isArray(p.payers) || !Array.isArray(p.splits)) continue
      noteActive(p.payers, 'user_id')
      noteActive(p.splits, 'user_id')
      const prev = latest[p.expense_id]
      if (!prev || e.id > prev.id) latest[p.expense_id] = e
    } else if (
      e.type === 'settlement.created' ||
      e.type === 'settlement.updated'
    ) {
      const p = e.payload
      if (!p || !p.settlement_id) continue
      active.add(p.from)
      active.add(p.to)
      const prev = settle[p.settlement_id]
      if (!prev || e.id > prev.id) settle[p.settlement_id] = e
    } else if (e.type === 'member.left') {
      // Anyone may ghost anyone, including themselves — leaving is ghosting
      // yourself. What stops this being a hostile act is that it takes nothing
      // away: the server keeps serving the ghosted member the group frozen at
      // this event, so they retain everything they already had. See plan/12.
      const p = e.payload
      if (!p || typeof p.member_id !== 'number') continue
      ghosted.add(p.member_id)
    } else if (e.type === 'member.merged') {
      const p = e.payload
      if (!p || !p.old_member_id || !p.new_member_id) continue
      if (p.old_member_id === p.new_member_id) continue
      // A clean slate only. Otherwise claiming a ghost who is owed money would
      // cancel the claimer's own debt with someone else's credit.
      if (active.has(p.new_member_id)) continue
      // First claim wins. An invite link names a member to become, so a link
      // used twice would otherwise let the second person silently displace the
      // first — who would then be a member with no history and no sign of why.
      if (alias.has(p.old_member_id)) continue
      alias.set(p.old_member_id, p.new_member_id)
    } else if (e.type === 'comment.created' || e.type === 'comment.updated') {
      const p = e.payload
      if (!p || !p.comment_id || !p.expense_id) continue
      const cur = commentRev[p.comment_id]
      if (!cur) commentRev[p.comment_id] = { ev: e, createdId: e.id, author: e.author }
      else if (e.id > cur.ev.id) commentRev[p.comment_id] = { ...cur, ev: e }
    }
  }

  const resolve = resolver(alias)
  // Everyone a merge pointed away from stops being a separate person.
  const mergedAway = new Set(
    [...alias.keys()].filter((id) => resolve(id) !== id)
  )
  const liveMembers = members
    .filter((m) => !mergedAway.has(m.id))
    // A ghosted member is still a member of the split, just not of the app.
    .map((m) => (ghosted.has(m.id) ? { ...m, ghost: true } : m))
  const liveMemberIds = liveMembers.map((m) => m.id)

  // The recipe is display and re-edit state, so its ids need resolving too —
  // otherwise a merged-away person lingers as a ghost in the receipt editor.
  const resolveRecipe = (split) => {
    if (!split) return null
    const out = { ...split }
    if (Array.isArray(split.participants)) {
      out.participants = [...new Set(split.participants.map(resolve))]
    }
    if (Array.isArray(split.items)) {
      out.items = split.items.map((it) => ({
        ...it,
        claimed_by: [...new Set((it.claimed_by || []).map(resolve))],
      }))
    }
    if (split.weights) {
      const weights = {}
      for (const [id, v] of Object.entries(split.weights)) {
        const to = resolve(Number(id))
        weights[to] = (weights[to] || 0) + v
      }
      out.weights = weights
    }
    return out
  }

  // Sum rather than overwrite: after a merge an expense can name both the old
  // identity and the new one, and that person owes the total of the two.
  const mergeRows = (rows, idKey, amountKey) => {
    const totals = new Map()
    for (const row of rows) {
      const id = resolve(row[idKey])
      totals.set(id, (totals.get(id) || 0) + row[amountKey])
    }
    return [...totals.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, amount]) => ({ [idKey]: id, [amountKey]: amount }))
  }

  const expenses = Object.values(latest).map((e) => {
    const p = e.payload
    return {
      id: e.id,
      expense_id: p.expense_id,
      description: p.description,
      amount_cents: p.amount_cents,
      payers: mergeRows(p.payers, 'user_id', 'paid_cents'),
      splits: mergeRows(p.splits, 'user_id', 'share_cents'),
      // How the splits were derived (mode + inputs). Purely for re-editing and
      // display — balances only ever use the resolved `splits` above, so new
      // modes (percentage, shares, later a scanned receipt) never touch the fold.
      split: resolveRecipe(p.split),
      date: p.date || '',
      category: p.category || '',
      // Ids of receipt images, never the images themselves — the log is
      // replicated to every client and must stay small.
      receipts: Array.isArray(p.receipts) ? p.receipts : [],
      // Soft delete: the row stays in the log with its data intact so it can
      // be shown struck-through and restored; it just stops counting.
      deleted: !!p.deleted,
    }
  })

  const nameById = Object.fromEntries(
    liveMembers.map((m) => [m.id, m.display_name])
  )

  const paid = {}
  const owed = {}
  for (const uid of liveMemberIds) {
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
    // Both ends resolved: a payment made by an account someone has since lost
    // is still a payment they made.
    from: resolve(ev.payload.from),
    to: resolve(ev.payload.to),
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
  const balances = liveMembers.map((m) => ({
    user_id: m.id,
    display_name: m.display_name,
    ghost: !!m.ghost,
    net_cents: paid[m.id] - owed[m.id],
  }))
  // Comments grouped under their expense, newest-created last (chronological).
  const commentsByExpense = {}
  for (const c of Object.values(commentRev)) {
    if (c.ev.payload.deleted) continue
    const eid = c.ev.payload.expense_id
    ;(commentsByExpense[eid] ||= []).push({
      comment_id: c.ev.payload.comment_id,
      expense_id: eid,
      text: c.ev.payload.text,
      // Resolved so that after a merge you can still edit what you wrote.
      author: resolve(c.author),
      author_name: nameById[resolve(c.author)] || '?',
      created_id: c.createdId,
    })
  }
  for (const list of Object.values(commentsByExpense)) {
    list.sort((a, b) => a.created_id - b.created_id)
  }

  const ledger = expenses
    .map((x) => ({
      ...x,
      payer_names: x.payers.map((p) => nameById[p.user_id] || '?'),
      ways: x.splits.length,
      comments: commentsByExpense[x.expense_id] || [],
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

  return { members: liveMembers, balances, ledger, payments }
}

// Deterministic greedy min-cash-flow: repeatedly match the biggest debtor with
// the biggest creditor until everyone nets to zero. Every client folds the same
// balances and sorts with a stable user_id tiebreak, so all clients suggest the
// identical payments. Near-minimal (true minimum is NP-hard), which is fine.
export function simplify(balances) {
  const debtors = balances
    .filter((b) => b.net_cents < 0)
    .map((b) => ({ id: b.user_id, name: b.display_name, net: b.net_cents }))
    .sort((a, b) => a.net - b.net || a.id - b.id)
  const creditors = balances
    .filter((b) => b.net_cents > 0)
    .map((b) => ({ id: b.user_id, name: b.display_name, net: b.net_cents }))
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
