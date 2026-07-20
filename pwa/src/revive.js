// Cloning a ledger you have been ghosted out of into a group of your own.
//
// The prefix you were served is yours to keep. Revive replays it into a brand
// new group in which you are the only real member and everyone else is a
// ghost — so the fork stops being a special way of reading somebody else's log
// and becomes a group you can actually carry on using.
//
// Replaying rather than opening with a stated balance is the whole point:
// every number in the app derives from the log, and an asserted opening
// balance would be the first that does not. See plan/12.
//
// Planning is kept separate from performing so the remap can be tested without
// a server. The remap is the dangerous part — a reference it misses does not
// raise, it quietly moves money — which is why the tests assert balances
// rather than shapes.

/** Fresh negative id, minted the same way ghosts are minted everywhere else. */
function mintGhostId() {
  return -(Math.floor(Math.random() * 2 ** 45) + 1)
}

/** The events that reproduce `state` in a new group, read as `meId`.
 *
 *  Returns them in the order they should be appended. `mint` is injectable so
 *  tests can pin the ids; nothing else here is random. */
export function planRevive(state, meId, { from, mint = mintGhostId } = {}) {
  const idMap = new Map()
  const events = []

  // Where this ledger came from. Written first so a group that otherwise
  // appears from nowhere says what it is, and so the client knows which group
  // to stop showing.
  if (from) {
    events.push({
      type: 'group.revived_from',
      payload: { group_id: from.group_id, at_event_id: from.at_event_id },
    })
  }

  // Everyone but the reviver becomes a ghost. Members already ghosted are
  // absorbed rather than replayed: `member.left` never makes it into the
  // clone, because in the new group they are ghosts from the start.
  for (const m of state.members) {
    if (m.id === meId) continue
    const id = mint()
    idMap.set(m.id, id)
    events.push({
      type: 'member.ghost_added',
      payload: { member_id: id, display_name: m.display_name },
    })
  }

  const to = (id) => (idMap.has(id) ? idMap.get(id) : id)

  // The recipe is re-edit and display state. It never feeds balances — those
  // come from `splits` below — but leaving stale ids in it would strand people
  // in the receipt editor.
  const remapSplit = (split) => {
    if (!split) return null
    const out = { ...split }
    if (Array.isArray(split.participants)) {
      out.participants = split.participants.map(to)
    }
    if (Array.isArray(split.items)) {
      out.items = split.items.map((it) => ({
        ...it,
        claimed_by: (it.claimed_by || []).map(to),
      }))
    }
    if (split.weights) {
      const weights = {}
      for (const [id, v] of Object.entries(split.weights)) {
        const key = to(Number(id))
        weights[key] = (weights[key] || 0) + v
      }
      out.weights = weights
    }
    return out
  }

  // Chronological, so the new log reads in the order things happened. The fold
  // is order-independent for these, but a log people can read is the point.
  const expenses = state.ledger
    .filter((x) => !x.deleted)
    .sort((a, b) => a.id - b.id)

  for (const x of expenses) {
    events.push({
      type: 'expense.created',
      payload: {
        // Ids carry over. They are unique per expense and the new group has
        // nothing to collide with, so keeping them makes the clone traceable.
        expense_id: x.expense_id,
        description: x.description,
        amount_cents: x.amount_cents,
        payers: x.payers.map((p) => ({
          user_id: to(p.user_id),
          paid_cents: p.paid_cents,
        })),
        splits: x.splits.map((s) => ({
          user_id: to(s.user_id),
          share_cents: s.share_cents,
        })),
        split: remapSplit(x.split),
        date: x.date || '',
        category: x.category || '',
        // Receipts are sealed under the old group key and keyed by group, so
        // carrying them means re-encrypting every one. Deliberately not done —
        // the revive screen has to say so rather than let them vanish quietly.
        receipts: [],
        deleted: false,
      },
    })
  }

  for (const s of state.payments.filter((p) => !p.deleted).sort((a, b) => a.id - b.id)) {
    events.push({
      type: 'settlement.created',
      payload: {
        settlement_id: s.settlement_id,
        from: to(s.from),
        to: to(s.to),
        amount_cents: s.amount_cents,
        date: s.date || '',
        deleted: false,
      },
    })
  }

  return { events, idMap }
}
