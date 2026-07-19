// Invite links carry the group key in the URL **fragment**, which browsers
// never send to the server. That is what lets someone join an encrypted group
// without the server ever being able to hand out the key.
//
// The consequence is that an invite link *is* the group key: anywhere a URL is
// logged, previewed or pasted into a chat that unfurls it, the key goes too.
// It is not an ordinary share.

export function buildInviteLink(origin, code, groupKey) {
  return `${origin}/#join=${encodeURIComponent(code)}&gk=${encodeURIComponent(groupKey)}`
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
  return code && gk ? { code, gk } : null
}
