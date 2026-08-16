// Who is already in a group, read *before* joining it.
//
// A group link (invite.js) names no member, so the person opening it is the one
// who says who they are: somebody the group has already been splitting with, or
// somebody new. Claiming only happens at the instant of joining (plan/12), so
// that choice has to be made before the join call — which means the ghost names
// have to be readable first. They are encrypted, so the server cannot offer the
// list itself; it serves the member events to anyone holding the join code and
// the key from the link's fragment opens them here.

import { api } from './api'
import { decryptPayload } from './crypto'
import { computeState } from './ledger'

/** The group behind a group link, and the members someone could claim.
 *
 *  `ghosts` is who is up for grabs: members with nobody attached, which covers
 *  both people who never had an account and people who lost one and were
 *  ghosted so they could be re-invited. The fold drops members that have
 *  already been claimed, so a name here is one no account holds yet. */
export async function loadJoinPreview({ code, gk }) {
  const res = await api(`groups/preview?code=${encodeURIComponent(code)}`)

  const events = []
  for (const e of res.events) {
    // member.added is server-written and in the clear, like everywhere else.
    if (!e.payload?.enc) {
      events.push(e)
      continue
    }
    try {
      events.push({ ...e, payload: await decryptPayload(gk, e.payload.enc) })
    } catch {
      // A malformed link, or a blob sealed under another key. Skipping it costs
      // one name off the list; blanking the whole screen would cost the join.
    }
  }

  const state = computeState(events)
  return {
    id: res.id,
    name: res.name,
    joined: res.joined,
    ghosts: state.members.filter((m) => m.ghost),
  }
}
