// Changing a display name, in a design where the name lives in two places.
//
// The server holds one copy: `add_member` stamps it into the `member.added` it
// writes, so it is the name a group you join *from now on* will call you. Every
// group you are already in holds its own copy, taken when you joined, inside an
// event the server can neither read nor write. So a rename is an API call plus
// a `member.renamed` appended to each group.
//
// Nothing is rewritten by any of it. The log stays append-only and the fold
// takes the latest rename an id is allowed to have made, exactly the way an
// edited expense is the latest revision of itself. See plan/12.

import { api } from './api'
import { appendSealed } from './sync'

/** Rename a member inside one group.
 *
 *  Ghosts and accounts use the same event. Who may write which is not decided
 *  here — the fold decides, from the author the server stamps on the event,
 *  which is the part a client cannot forge. See computeState. */
export function renameMember(groupId, member_id, display_name) {
  return appendSealed(groupId, 'member.renamed', { member_id, display_name })
}

/** Rename yourself: the account, then every group this device can open.
 *
 *  Returns how many groups it could not write to. Those are groups whose key
 *  this device does not hold — a device problem, not a rename problem — and
 *  they must not stop the rest from landing. Everything else is durable the
 *  moment it is appended, and flushes on the next sync, so being offline is
 *  not a failure here. */
export async function renameMe(display_name) {
  const name = display_name.trim()
  if (!name) throw new Error('Give yourself a name')
  // The account row first: if this is refused, nothing has happened yet.
  const saved = (await api('account/name', { display_name: name })).display_name
  const me = await api('me')
  const groups = await api('groups')

  let missed = 0
  for (const g of groups.groups ?? groups) {
    try {
      await renameMember(g.id, me.id, saved)
    } catch {
      missed += 1
    }
  }
  return { display_name: saved, missed }
}
