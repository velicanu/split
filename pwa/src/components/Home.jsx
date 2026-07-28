// The signed-in shell: header, and whichever screen the URL fragment names
// (list / a group / settings). Consumes an invite link on arrival.

import { useCallback, useEffect, useState } from 'react'

import { loadAiSettings } from '../aikeys'
import { logout as signOut } from '../auth'
import { parseInvite } from '../invite'
import { readView } from '../nav'
import { acceptInvite } from '../join'
import { useView } from '../useView'
import { Activity } from './Activity'
import { Settings } from './Settings'
import { GroupList } from './GroupList'
import { GroupView } from './GroupView'
import { BillCreate } from './BillCreate'
import { PairOldDevice } from './PairOldDevice'

// The three top-level destinations, reached from the bottom dock. Everything
// else (a group, a bill, pairing) is pushed on top and shows a back affordance
// instead of the dock.
const DOCK = [
  ['list', 'Groups', '👥'],
  ['activity', 'Activity', '🧾'],
  ['settings', 'Settings', '⚙️'],
]

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
  const showActivity = view.view === 'activity'
  const showNewBill = view.view === 'newbill'
  const showPair = view.view === 'pairdevice'
  // The dock only rides the three top-level screens; a group / bill / pairing is
  // a pushed screen with a back button of its own.
  const onDock = DOCK.some(([id]) => id === view.view)
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
    <main className={`app${onDock ? ' has-dock' : ''}`}>
      <div className="screen">
        {showSettings ? (
          <Settings
            ai={ai}
            user={user}
            onChanged={loadAi}
            onPair={() => navigate({ view: 'pairdevice' })}
            onLogout={logout}
            onClose={() => navigate({ view: 'list' })}
          />
        ) : showActivity ? (
          <Activity me={user} onOpen={(id) => navigate({ view: 'group', id })} />
        ) : showPair ? (
          <PairOldDevice code={view.code} onClose={() => navigate({ view: 'list' })} />
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
          <GroupList
            me={user}
            onOpen={(id) => navigate({ view: 'group', id })}
            onNewBill={() => navigate({ view: 'newbill' })}
          />
        )}
      </div>

      {onDock && (
        <nav className="dock" aria-label="Sections">
          {DOCK.map(([id, label, glyph]) => (
            <button
              key={id}
              type="button"
              className={view.view === id ? 'on' : ''}
              aria-current={view.view === id ? 'page' : undefined}
              onClick={() => navigate({ view: id })}
            >
              <span className="pill" aria-hidden="true">
                {glyph}
              </span>
              {label}
            </button>
          ))}
        </nav>
      )}
    </main>
  )
}
