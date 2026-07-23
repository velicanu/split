// A shared-bill link. Like a view link (viewlink.js) it carries the key in the
// URL fragment, which never reaches the server; unlike a view link it is a
// read+join capability, not read-only — the bill token gates reading the bill
// and joining it.
//
//   #bill=<bill id>&k=<bill key>&t=<bill token>
//
// k stays client-side and decrypts; t goes to the server as a header (see
// api.js) and gates every bill request. The bill id is opaque and says nothing
// on its own, so it travels in the clear part of the fragment.

export function buildBillLink(origin, { billId, key, token }) {
  const p = new URLSearchParams()
  p.set('bill', billId)
  p.set('k', key)
  p.set('t', token)
  return `${origin}/#${p.toString()}`
}

/** Pull a bill link out of a pasted URL or a bare fragment, or null if it is
 *  not one. */
export function parseBillLink(input) {
  if (!input) return null
  const s = String(input)
  const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s
  const params = new URLSearchParams(hash)
  const billId = params.get('bill')
  const key = params.get('k')
  const token = params.get('t')
  if (!billId || !key || !token) return null
  return { billId, key, token }
}
