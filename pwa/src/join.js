// Accept an invite: join the group (optionally claiming a member) and seal the
// group key — from the link's fragment — to this account and device.

import { api } from './api'
import { publishGroupKey } from './groupkeys'

export async function acceptInvite(invite) {
  // Joining and claiming are a single server-side act: the claim rides on the
  // member.added event the server writes, so there is no window in between and
  // no second call that could fail on its own. See plan/12.
  const g = await api('groups/join', {
    code: invite.code,
    claims: invite.member_id ?? null,
  })
  // The key came from the URL fragment, which the server never saw; seal it to
  // this account and device so it survives.
  await publishGroupKey(g.id, invite.gk)
  return g
}
