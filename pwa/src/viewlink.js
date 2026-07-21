// A read-only share link. Like an invite link it carries the group key in the
// URL fragment (never sent to the server); unlike an invite it also carries a
// read token the server checks to serve the encrypted feed to someone with no
// account, and it does not auto-join — an account-holder opening it sees the
// group read-only and chooses to join.
//
//   #view=<group id>&gk=<group key>&rt=<read token>&jc=<join code?>
//
// gk stays client-side and decrypts; rt goes to the server (as a header, see
// api.js) and gates fetching the ciphertext; jc, if present, is the join code
// an account-holder needs to become a member. It is deliberately not named
// `join`, so parseInvite (invite.js) does not mistake a view link for an invite
// and auto-accept it.

export function buildViewLink(origin, { groupId, gk, readToken, code }) {
  const p = new URLSearchParams()
  p.set('view', String(groupId))
  p.set('gk', gk)
  p.set('rt', readToken)
  if (code) p.set('jc', code)
  return `${origin}/#${p.toString()}`
}

/** Pull a view link out of a pasted URL or a bare fragment, or null if it is
 *  not one. */
export function parseViewLink(input) {
  if (!input) return null
  const s = String(input)
  const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s
  const params = new URLSearchParams(hash)
  const groupId = Number(params.get('view'))
  const gk = params.get('gk')
  const readToken = params.get('rt')
  if (!Number.isInteger(groupId) || groupId <= 0 || !gk || !readToken) return null
  return { groupId, gk, readToken, code: params.get('jc') || null }
}
