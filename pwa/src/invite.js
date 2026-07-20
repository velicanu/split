// Invite links carry the group key in the URL **fragment**, which browsers
// never send to the server. That is what lets someone join an encrypted group
// without the server ever being able to hand out the key.
//
// The consequence is that an invite link *is* the group key: anywhere a URL is
// logged, previewed or pasted into a chat that unfurls it, the key goes too.
// It is not an ordinary share.

// A link says *who to become*, not just which group to enter: `as` names the
// member id the joiner takes over, so accepting an invite and claiming the
// history are the same act. See plan/12.
export function buildInviteLink(origin, code, groupKey, memberId) {
  const base = `${origin}/#join=${encodeURIComponent(code)}&gk=${encodeURIComponent(groupKey)}`
  return memberId === undefined || memberId === null
    ? base
    : `${base}&as=${encodeURIComponent(memberId)}`
}

/** Pull the code and key out of a pasted link, or out of location.hash.
 *  Accepts a whole URL or a bare fragment, since people paste both. */
export function parseInvite(input) {
  if (!input) return null
  const hash = String(input).includes('#')
    ? String(input).slice(String(input).indexOf('#') + 1)
    : String(input)
  const params = new URLSearchParams(hash)
  const code = params.get('join')
  const gk = params.get('gk')
  if (!code || !gk) return null
  // Numeric because member ids are numbers everywhere. Note Number('') is 0,
  // not NaN, so an empty `as=` would otherwise claim a member id of zero —
  // which no real member ever has, and which would fail confusingly later.
  const as = params.get('as')
  const memberId = Number(as)
  const usable = as !== null && as !== '' && Number.isFinite(memberId) && memberId !== 0
  return { code, gk, member_id: usable ? memberId : null }
}
