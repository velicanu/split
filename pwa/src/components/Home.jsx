// The signed-in shell: header, and whichever screen the URL fragment names
// (list / a group / settings). Consumes an invite link on arrival.

import { useCallback, useEffect, useState } from 'react'

import { loadAiSettings } from '../aikeys'
import { logout as signOut } from '../auth'
import { parseInvite } from '../invite'
import { readView } from '../nav'
import { acceptInvite } from '../join'
import { useView } from '../useView'
import { Settings } from './Settings'
import { GroupList } from './GroupList'
import { GroupView } from './GroupView'
import { BillCreate } from './BillCreate'

export function Home({ user, onLogout }) {
  // The fragment at load: an invite to consume, or a view to restore. Captured
  // once, because the invite key is cleared from the address bar below.
  const openedAt = useState(() => window.location.hash)[0]
  const [pendingInvite] = useState(() => parseInvite(openedAt))
  // An invite takes over the fragment, so while one is pending there is no view
  // to restore — land on the list and let the invite move us.
  const [view, navigate] = useView(
    pendingInvite ? { view: 'list' } : readView(openedAt)
  )
  const groupId = view.view === 'group' ? view.id : null
  const showSettings = view.view === 'settings'
  const showNewBill = view.view === 'newbill'
  // null until loaded; { active, providers } after. No key => no provider.
  const [ai, setAi] = useState(null)

  // Ask the browser not to evict the offline ledger. Only here — once someone
  // is signed in and has data worth keeping — so an account-less read-only
  // visitor isn't hit with a storage-permission prompt for nothing. Best-effort
  // and evictable either way; the server plus key recovery are the durable copy
  // (plan/04).
  useEffect(() => {
    navigator.storage?.persist?.().catch(() => {})
  }, [])

  // Keys arrive sealed and are opened here; the server never held a readable
  // copy to send.
  const loadAi = useCallback(
    () =>
      loadAiSettings()
        .then(setAi)
        .catch(() => {}),
    []
  )
  useEffect(() => {
    loadAi()
  }, [loadAi])

  useEffect(() => {
    if (!pendingInvite) return
    let cancelled = false
    ;(async () => {
      try {
        const g = await acceptInvite(pendingInvite)
        if (!cancelled) navigate({ view: 'group', id: g.id }, { replace: true })
      } catch {
        // Already a member, or a stale link — the groups list still works.
        if (!cancelled) navigate({ view: 'list' }, { replace: true })
      }
      // Either way this replaces the invite fragment, taking its key out of the
      // address bar. Replace, not push: arriving from a link is a redirect, so
      // back should not return to a half-consumed invite URL.
    })()
    return () => {
      cancelled = true
    }
  }, [pendingInvite, navigate])

  async function logout() {
    // Un-enrols this browser as well as ending the session: the device key
    // alone can sign in, so anything less would leave a shared computer signed
    // in for whoever sits down next. Coming back needs the password.
    await signOut()
    onLogout()
  }

  return (
    <main className="app">
      <header>
        <strong
          className="brand"
          onClick={() => navigate({ view: 'list' })}
        >
          Split
        </strong>
        <span className="spacer" />
        <span className="muted">{user.display_name}</span>
        <button className="link" onClick={() => navigate({ view: 'settings' })}>
          settings
        </button>
        <button className="link" onClick={logout}>
          Log out
        </button>
      </header>
      {showSettings ? (
        <Settings
          ai={ai}
          user={user}
          onChanged={loadAi}
          onClose={() => navigate({ view: 'list' })}
        />
      ) : showNewBill ? (
        <BillCreate ai={ai} onBack={() => navigate({ view: 'list' })} />
      ) : groupId != null ? (
        <GroupView
          groupId={groupId}
          me={user}
          ai={ai}
          onBack={() => navigate({ view: 'list' })}
          onOpen={(id) => navigate({ view: 'group', id })}
        />
      ) : (
        <>
          <div className="row-actions">
            {/* A one-off receipt split, standalone from any group. See plan/15. */}
            <button className="link" onClick={() => navigate({ view: 'newbill' })}>
              Split a bill
            </button>
          </div>
          <GroupList onOpen={(id) => navigate({ view: 'group', id })} />
        </>
      )}
    </main>
  )
}
