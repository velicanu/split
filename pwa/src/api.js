// One HTTP helper for the whole app.

/** Turn a failed response into something a person can act on.
 *
 *  FastAPI reports validation failures as a *list* of objects, which stringifies
 *  to "[object Object],[object Object]…" if you drop it into a message — which
 *  is exactly what users saw after PR A. Worse, the underlying meaning was
 *  hidden: this client builds every request body itself, so a body the server
 *  can't parse means the tab is running an old bundle, not that the user did
 *  anything wrong.
 */
export function describeError(res, data) {
  const detail = data?.detail
  if (typeof detail === 'string' && detail) return detail

  if (Array.isArray(detail)) {
    if (res.status === 422) {
      const fields = detail
        .map((e) => e?.loc?.[e.loc.length - 1])
        .filter((f) => typeof f === 'string')
        .join(', ')
      return (
        'This tab is running an old version of Split — reload the page.' +
        (fields ? ` (the server did not recognise: ${fields})` : '')
      )
    }
    const messages = detail.map((e) => e?.msg).filter(Boolean)
    if (messages.length) return messages.join('; ')
  }

  return res.statusText || `Request failed (${res.status})`
}

export async function api(path, body, method, headers) {
  let res
  try {
    res = await fetch(`/api/${path}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        // A read token lets someone with a share link but no account fetch the
        // encrypted feed. It goes in a header, not the query string, so it does
        // not end up in server logs or a Referer. See viewlink.js.
        ...(headers || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    // fetch only rejects when the request never completed — offline, DNS,
    // connection refused. That is not the server saying no, and callers need
    // to tell the two apart: signing out on "couldn't reach the server" would
    // drop this device's key on every refresh with no signal.
    const offline = new Error('offline')
    offline.offline = true
    throw offline
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(describeError(res, data))
  return data
}
