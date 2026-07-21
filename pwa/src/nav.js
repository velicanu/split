// Which screen you are on, carried in the URL fragment so a refresh lands back
// where you were rather than on the group list.
//
// The fragment is also where an invite link carries its key (see invite.js).
// The two do not clash: an invite is consumed the moment the app opens and the
// fragment is replaced, so a fragment is only ever one thing at a time. An
// invite is recognised by having `join=`; anything else is a view.
//
// Kept to the fragment rather than the path so it needs no server routes and
// works the same offline, where the service worker serves the one shell.

/** Parse a fragment into the view it names. Unknown or empty → the list. */
export function readView(hash = window.location.hash) {
  const h = hash.replace(/^#/, '')
  if (h === 'settings') return { view: 'settings' }
  const group = h.match(/^group\/(-?\d+)$/)
  if (group) return { view: 'group', id: Number(group[1]) }
  return { view: 'list' }
}

/** The fragment for a view. The list has none, so it reads as a clean URL. */
export function viewHash({ view, id }) {
  if (view === 'settings') return '#settings'
  if (view === 'group') return `#group/${id}`
  return ''
}

/** The view implied by the current navigation state. */
export function currentView({ showSettings, groupId }) {
  if (showSettings) return { view: 'settings' }
  if (groupId != null) return { view: 'group', id: groupId }
  return { view: 'list' }
}
