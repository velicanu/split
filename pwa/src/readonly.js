// Loading a group as an anonymous read-only viewer: no account, no device key,
// nothing persisted. The read token reaches the encrypted feed; the group key
// from the share link decrypts it. See viewlink.js and plan/14.

import { api } from './api'
import { decryptPayload } from './crypto'
import { computeState } from './ledger'

/** Fetch the group name and folded state for a view link. Throws if the link
 *  is no longer valid (revoked token, deleted group). */
export async function loadReadOnly({ groupId, gk, readToken }) {
  const headers = { 'X-Read-Token': readToken }
  const meta = await api(`groups/${groupId}`, undefined, 'GET', headers)
  const res = await api(`groups/${groupId}/events?since=0`, undefined, 'GET', headers)

  const events = []
  let unreadable = 0
  for (const e of res.events) {
    // member.added is server-written and in the clear, like in the app proper.
    if (!e.payload?.enc) {
      events.push(e)
      continue
    }
    try {
      events.push({ ...e, payload: await decryptPayload(gk, e.payload.enc) })
    } catch {
      // A wrong key (a malformed link) or an altered blob — skip it rather than
      // blanking the whole view.
      unreadable += 1
    }
  }

  return {
    name: meta.name,
    state: computeState(events),
    version: res.version,
    unreadable,
  }
}
