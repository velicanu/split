// Cross-group projections: what every group looks like at a glance, and a single
// merged activity feed. Both are pure reads over the same local, decrypted
// ledgers a group's own page folds (ledger.js) — no new server data, nothing the
// server could read. The home hero and the Activity screen are the two callers.
//
// A group is only summarised if this device can actually read it: it has events
// and a group key. One without (freshly joined, not yet synced, or opened on
// another device) comes back with `state: null` and no balance, shown as such
// rather than as a confident zero.

import { decryptPayload } from './crypto'
import { memberIdFor, money } from './format'
import { groupKey } from './groupkeys'
import { computeState } from './ledger'
import { localEvents } from './store'

/** Open and decrypt a group's local log, or null if unreadable here. */
async function openGroup(groupId) {
  const rows = await localEvents(groupId)
  if (!rows.length) return null
  const key = await groupKey(groupId)
  if (!key) return null
  const opened = []
  for (const e of rows) {
    // member.added is written by the server in the clear (it holds no key).
    if (!e.payload?.enc) {
      opened.push(e)
      continue
    }
    try {
      opened.push({ ...e, payload: await decryptPayload(key, e.payload.enc) })
    } catch {
      // One bad row must not blank the group; skip it, like GroupView does.
    }
  }
  return opened
}

/** Summarise each group for the caller `me`: its folded state (or null if this
 *  device can't read it yet) and my net balance in it. `groups` is the list from
 *  the server (or the local cache offline): `[{ id, name, members? }]`. */
export async function loadOverviews(groups, me) {
  const out = []
  for (const g of groups) {
    const events = await openGroup(g.id)
    if (!events) {
      out.push({ id: g.id, name: g.name, members: g.members ?? null, state: null, myNet: null })
      continue
    }
    const state = computeState(events)
    const meId = memberIdFor(state.members, me)
    const mine = state.balances.find((b) => b.user_id === meId)
    out.push({
      id: g.id,
      name: g.name,
      members: typeof g.members === 'number' ? g.members : state.members.length,
      state,
      meId,
      // No membership row for me yet (just-joined, pre-sync) reads as settled.
      myNet: mine ? mine.net_cents : 0,
    })
  }
  return out
}

/** Sum my balance across the readable groups, ignoring the ones we can't fold. */
export function totalNet(overviews) {
  return overviews.reduce((t, o) => t + (o.state ? o.myNet : 0), 0)
}

// Newest first: by date, then by the event's server id as a stable tiebreak
// within a day — the same order the ledger itself sorts by.
const newestFirst = (a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1)

/** One merged, newest-first feed across every readable group: each expense that
 *  was added and each payment that was recorded, tagged with its group. `meId`
 *  per group lets the caller phrase it as "You added …" vs "Sam added …". */
export function activityFeed(overviews) {
  const items = []
  for (const o of overviews) {
    if (!o.state) continue
    for (const x of o.state.ledger) {
      if (x.deleted) continue
      items.push({
        kind: 'expense',
        id: x.id,
        groupId: o.id,
        group: o.name,
        description: x.description,
        amount_cents: x.amount_cents,
        date: x.date,
        actorId: x.author,
        actorName: x.author_name,
        mine: x.author != null && x.author === o.meId,
      })
    }
    for (const s of o.state.payments) {
      items.push({
        kind: 'settlement',
        id: s.id,
        groupId: o.id,
        group: o.name,
        from_name: s.from_name,
        to_name: s.to_name,
        amount_cents: s.amount_cents,
        date: s.date,
        mine: s.from === o.meId || s.to === o.meId,
      })
    }
  }
  return items.sort(newestFirst)
}

/** How a net balance reads in the UI: sign-tagged text + a class for colour.
 *  Positive = owed to you (good), negative = you owe. */
export function netLabel(cents) {
  if (cents === 0) return { text: 'settled up', tone: 'muted' }
  if (cents > 0) return { text: `you're owed ${money(cents)}`, tone: 'pos' }
  return { text: `you owe ${money(-cents)}`, tone: 'neg' }
}
