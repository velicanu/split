import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  computeState,
  receiptWeights,
  simplify,
  splitByWeights,
  splitEqually,
} from './ledger'
import { api } from './api'
import { enrol, logout as signOut, resume, signup } from './auth'
import { decryptPayload, encryptPayload } from './crypto'
import { createGroupKey, groupKey, publishGroupKey } from './groupkeys'
import { parseInvite } from './invite'
import { parseViewLink } from './viewlink'
import { loadReadOnly } from './readonly'
import { splitOptions } from './copysplit'
import { readView, viewHash } from './nav'
import { planRevive } from './revive'
import {
  forgetLocalLedger,
  localEvents,
  localGroups,
  meta as localMeta,
  pendingCount,
  setMeta as setLocalMeta,
} from './store'
import { append, flush, sync } from './sync'
import { loadAiSettings } from './aikeys'
import { memberIdFor, money } from './format'
import { Settings } from './components/Settings'
import { InviteLink, ShareReadOnly } from './components/sharing'
import { ReceiptThumb } from './components/ReceiptThumb'
import { AddGhost, LeaveOrGhost } from './components/members'
import { LedgerLog } from './components/LedgerLog'
import { Payments, SettleUp } from './components/settle'
import { ExpenseDetail } from './components/ExpenseDetail'
import { ExpenseForm } from './components/ExpenseForm'


// A crash must never leave a blank screen — show a reload prompt instead.
// (Most likely cause: the app updated and a stale tab is running old code
// against a newer API.)
class ErrorBoundary extends Component {
  state = { crashed: false }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  render() {
    if (this.state.crashed) {
      return (
        <main>
          <h1>Something went wrong</h1>
          <p className="muted">The app may have updated — reload to continue.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </main>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Split />
    </ErrorBoundary>
  )
}

function Split() {
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(true)
  // A read-only share link is handled before the auth gate: the whole point is
  // that someone with no account can still see the group. Captured once.
  const viewLink = useState(() => parseViewLink(window.location.hash))[0]

  useEffect(() => {
    // If this device already holds a key there is nothing to type — it signs
    // the server's challenge and we're in.
    resume()
      .then(setUser)
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [])

  if (checking) return null
  if (viewLink) {
    return (
      <ReadOnlyGroup
        link={viewLink}
        user={user}
        onExit={() => {
          // Drop the view link and reload into the ordinary app.
          window.location.href = window.location.pathname
          window.location.reload()
        }}
      />
    )
  }
  if (!user) return <Auth onAuth={setUser} />
  return <Home user={user} onLogout={() => setUser(null)} />
}

// The account-less read-only view behind a share link: fetch with the read
// token, decrypt with the key from the link, fold, and show it — no edit
// controls anywhere. An account-holder gets a Join affordance; anyone else is
// pointed at signing in. See viewlink.js, readonly.js, plan/14.
export function ReadOnlyGroup({ link, user, onExit }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [joining, setJoining] = useState(false)
  const [viewing, setViewing] = useState(null)
  // How a viewer reads receipts: the key from the link, and the read token for
  // the members-only blob endpoint. Stable, so ReceiptThumb's effect doesn't
  // re-fetch on every render.
  const receiptAccess = useMemo(
    () => ({ key: link.gk, readToken: link.readToken }),
    [link.gk, link.readToken]
  )

  useEffect(() => {
    let live = true
    loadReadOnly(link)
      .then((d) => live && setData(d))
      .catch(
        () =>
          live &&
          setError('This link is not valid — read-sharing may have been turned off.')
      )
    return () => {
      live = false
    }
  }, [link])

  async function join(claims) {
    setJoining(true)
    setError('')
    try {
      await api('groups/join', { code: link.code, claims: claims ?? null })
      // Seal the key (from the link) to this account and device, so the group
      // is readable the normal way from now on.
      await publishGroupKey(link.groupId, link.gk)
      window.location.href = `${window.location.pathname}#group/${link.groupId}`
      window.location.reload()
    } catch (err) {
      setError(err.message)
      setJoining(false)
    }
  }

  if (error && !data) {
    return (
      <main className="app">
        <header>
          <strong className="brand" onClick={onExit}>
            Split
          </strong>
        </header>
        <p className="error">{error}</p>
        <button className="link" onClick={onExit}>
          go to Split
        </button>
      </main>
    )
  }
  if (!data) return null

  const { name, state, unreadable } = data
  const ghosts = state.members.filter((m) => m.ghost)

  return (
    <main className="app">
      <header>
        <strong className="brand" onClick={onExit}>
          Split
        </strong>
        <span className="spacer" />
        <span className="muted">read-only</span>
      </header>
      <h2>{name}</h2>

      {link.code && user ? (
        <section>
          <p className="muted">
            You&rsquo;re viewing this group. Join to add and edit expenses.
          </p>
          {ghosts.length > 0 && (
            <p className="muted">
              If you&rsquo;re already in the split, join as that person:
            </p>
          )}
          <div className="cols">
            {ghosts.map((g) => (
              <button key={g.id} disabled={joining} onClick={() => join(g.id)}>
                I&rsquo;m {g.display_name}
              </button>
            ))}
            <button disabled={joining} onClick={() => join(null)}>
              Join as a new member
            </button>
          </div>
        </section>
      ) : link.code ? (
        <p className="muted">
          Sign in to join this group.{' '}
          <button className="link" onClick={onExit}>
            Open Split
          </button>
        </p>
      ) : (
        <p className="muted">A read-only view of this group.</p>
      )}
      {error && <p className="error">{error}</p>}

      <h3>Balances</h3>
      <ul className="list">
        {state.balances.map((b) => (
          <li key={b.user_id} className="row static">
            <span>{b.display_name}</span>
            <span className={b.net_cents >= 0 ? 'pos' : 'neg'}>
              {b.net_cents === 0
                ? 'settled up'
                : b.net_cents > 0
                  ? `is owed ${money(b.net_cents)}`
                  : `owes ${money(-b.net_cents)}`}
            </span>
          </li>
        ))}
      </ul>

      <h3>Expenses</h3>
      {state.ledger.length === 0 && <p className="muted">No expenses yet.</p>}
      <ul className="list">
        {state.ledger.map((x) => (
          <li key={x.expense_id}>
            <button className="row" onClick={() => setViewing(x)}>
              <div className="expense">
                <span>
                  {x.description}
                  {x.deleted ? ' (deleted)' : ''}
                </span>
                <span className="muted">
                  {x.payer_names.join(', ')} paid {money(x.amount_cents)} ·
                  split {x.ways} way{x.ways === 1 ? '' : 's'}
                  {x.date ? ` · ${x.date}` : ''}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>

      {viewing && (
        <ExpenseDetail
          groupId={link.groupId}
          expense={viewing}
          members={state.members}
          meId={null}
          readOnly
          receiptAccess={receiptAccess}
          onClose={() => setViewing(null)}
        />
      )}

      {state.payments.length > 0 && (
        <>
          <h3>Payments</h3>
          <ul className="list">
            {state.payments.map((p) => (
              <li key={p.settlement_id} className="row static">
                <span>
                  {p.from_name} → {p.to_name}
                </span>
                <span className="muted">
                  {money(p.amount_cents)}
                  {p.date ? ` · ${p.date}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {unreadable > 0 && (
        <p className="error">
          {unreadable} entr{unreadable === 1 ? 'y' : 'ies'} couldn&rsquo;t be
          decrypted and {unreadable === 1 ? 'is' : 'are'} missing here.
        </p>
      )}
    </main>
  )
}

// No password ever reaches the server. Signing up mints an account key and a
// device key; signing in on a *new* device unwraps the account key locally and
// uses it to authorise a fresh device key. See plan/11.
function Auth({ onAuth }) {
  const [mode, setMode] = useState('signin')
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!handle.trim() || !password) {
      return setError('Enter a handle and a password')
    }
    setBusy(true)
    try {
      onAuth(
        mode === 'signup'
          ? await signup({
              login_handle: handle.trim(),
              display_name: displayName.trim() || handle.trim(),
              password,
            })
          : await enrol({ login_handle: handle.trim(), password })
      )
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>Split</h1>
      <form onSubmit={submit}>
        <input
          placeholder="handle"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          autoComplete="username"
        />
        {mode === 'signup' && (
          <input
            placeholder="display name (optional)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        )}
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        />
        <button type="submit" disabled={busy}>
          {busy
            ? 'working…'
            : mode === 'signup'
              ? 'Sign up'
              : 'Sign in on this device'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <p className="muted">
        Your password never leaves this device — it unlocks your keys here. That
        also means nobody can reset it for you.
      </p>
      <p>
        {mode === 'signup' ? 'Have an account?' : 'No account?'}{' '}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault()
            setError('')
            setMode(mode === 'signup' ? 'signin' : 'signup')
          }}
        >
          {mode === 'signup' ? 'Sign in' : 'Sign up'}
        </a>
      </p>
    </main>
  )
}

// The current screen, backed by browser history so a refresh returns here and
// the Android back gesture (and desktop back button) walk the views the way
// they walk pages anywhere else. See nav.js.
//
// History is the source of truth, not React state: `navigate` pushes an entry
// and updates the view, and a back/forward — which is a popstate — reads the
// view back out of the URL. Pushing is what gives back somewhere to go;
// replaceState would leave the stack empty and back would exit the app, which
// is the bug this fixes.
function useView(initial) {
  const [view, setView] = useState(initial)

  useEffect(() => {
    const onPop = () => setView(readView(window.location.hash))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((next, { replace = false } = {}) => {
    const target = viewHash(next)
    const url = target || window.location.pathname
    // Don't stack a second entry for the view we are already on — a repeated
    // tap on "home" should not need two back gestures to undo.
    if (!replace && window.location.hash === target) {
      setView(next)
      return
    }
    window.history[replace ? 'replaceState' : 'pushState'](null, '', url)
    setView(next)
  }, [])

  return [view, navigate]
}

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
      ) : groupId != null ? (
        <GroupView
          groupId={groupId}
          me={user}
          ai={ai}
          onBack={() => navigate({ view: 'list' })}
          onOpen={(id) => navigate({ view: 'group', id })}
        />
      ) : (
        <GroupList onOpen={(id) => navigate({ view: 'group', id })} />
      )}
    </main>
  )
}




/** Accept an invite: join, take the group key from the link, and — if the link
 *  named a member to become — claim that member's history.
 *
 *  Claiming here rather than as a later step means accepting an invite and
 *  taking over the ghost are one act, so there is no window in which the wrong
 *  person could claim it. See plan/12. */
async function acceptInvite(invite) {
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




export function GroupList({ onOpen }) {
  const [groups, setGroups] = useState(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  // Local-first, like a group's own page. The server list is authoritative
  // when reachable — it knows member counts and which groups you have hidden —
  // and every entry is cached on the way through, so with no network the list
  // is still whatever this device last saw rather than a blank page. plan/04.
  const load = useCallback(async () => {
    try {
      const fresh = await api('groups')
      setGroups(fresh)
      for (const g of fresh) {
        await setLocalMeta(g.id, { name: g.name, members: g.members })
      }
    } catch {
      // Offline. Show the groups this device already knows the name of; a row
      // with no name is one we hold events for but have never opened, and has
      // nothing to show yet.
      const local = await localGroups()
      setGroups(local.filter((g) => g.name))
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  async function create(e) {
    e.preventDefault()
    setError('')
    try {
      const g = await api('groups', { name })
      // Mint the key before anything can be written, so there is never a
      // window where an event would have nothing to encrypt under.
      await createGroupKey(g.id)
      setName('')
      onOpen(g.id)
    } catch (err) {
      setError(err.message)
    }
  }

  async function join(e) {
    e.preventDefault()
    setError('')
    const invite = parseInvite(code.trim())
    if (!invite) {
      return setError('Paste the whole invite link — it carries the group key')
    }
    try {
      const g = await acceptInvite(invite)
      setCode('')
      onOpen(g.id)
    } catch (err) {
      setError(err.message)
    }
  }

  if (!groups) return null

  return (
    <section>
      <h2>Your groups</h2>
      {groups.length === 0 && (
        <p className="muted">No groups yet — create or join one below.</p>
      )}
      <ul className="list">
        {groups.map((g) => (
          <li key={g.id}>
            <button className="row" onClick={() => onOpen(g.id)}>
              <span>{g.name}</span>
              <span className="muted">
                {typeof g.members === 'number'
                  ? `${g.members} member${g.members === 1 ? '' : 's'}`
                  : 'offline'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="cols">
        <form onSubmit={create}>
          <h3>Create a group</h3>
          <input
            placeholder="group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit">Create</button>
        </form>
        <form onSubmit={join}>
          <h3>Join a group</h3>
          <input
            placeholder="paste invite link"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit">Join</button>
        </form>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  )
}

export function GroupView({ groupId, me, ai, onBack, onOpen }) {
  const [meta, setMeta] = useState(null)
  const [events, setEvents] = useState([])
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState(null) // null = add mode; else an expense
  const [viewingId, setViewingId] = useState(null) // expense_id shown in detail
  // Bumped to remount (and so reset) the add-expense form after a create.
  const [formNonce, setFormNonce] = useState(0)
  // A receipt to scan as soon as the edit form opens, set by the detail view.
  const [scanReceipt, setScanReceipt] = useState(null)
  const [error, setError] = useState('')
  // No readable copy of this group's key on this device.
  const [locked, setLocked] = useState(false)
  const [unreadable, setUnreadable] = useState(0)
  const [showLog, setShowLog] = useState(false)
  // Whether the last sync reached the server, and how many of our own writes
  // are still waiting to. Both are shown: an app that quietly holds writes is
  // worse than one that says so.
  const [online, setOnline] = useState(true)
  const [pendingWrites, setPendingWrites] = useState(0)
  // A sync started before this view closed must not keep writing to the store
  // or to state afterwards. Switching groups quickly, or closing one mid-pull,
  // otherwise lets a finished request land in a view that has moved on.
  const alive = useRef(true)

  // Everything the UI shows comes from the local copy of the log. The network
  // only ever adds to it, so the app works the same offline as on. plan/04.
  const openLocal = useCallback(async () => {
    const rows = await localEvents(groupId)
    if (!rows.length || !alive.current) return
    const key = await groupKey(groupId)
    if (!key) {
      setLocked(true)
      return
    }
    setLocked(false)
    const opened = []
    let bad = 0
    for (const e of rows) {
      // member.added is written by the server, which has no key, so it is the
      // one event that is never encrypted.
      if (!e.payload?.enc) {
        opened.push(e)
        continue
      }
      try {
        opened.push({ ...e, payload: await decryptPayload(key, e.payload.enc) })
      } catch {
        // Skip rather than throw: one bad row must not blank the whole group.
        bad += 1
      }
    }
    setUnreadable(bad)
    setEvents(opened)
    setVersion((await localMeta(groupId)).cursor)
  }, [groupId])

  // Push what we have written, pull what we have not seen, then re-read.
  const refresh = useCallback(async () => {
    const { online: reachable } = await sync(groupId, {
      onRejected: (row, err) =>
        setError(`A change could not be saved and was discarded: ${err.message}`),
    })
    if (!alive.current) return
    setOnline(reachable)
    await openLocal()
    if (!alive.current) return
    setPendingWrites(await pendingCount())
  }, [groupId, openLocal])

  useEffect(() => {
    alive.current = true
    setEvents([])
    setVersion(0)
    setEditing(null)
    setViewingId(null)
    setUnreadable(0)
    // Local first, and without waiting for anything: with no signal this is
    // the whole of what the user sees, and with one it beats the round trip.
    openLocal().then(refresh)
    // Cached so the name is there offline too.
    api(`groups/${groupId}`)
      .then((m) => {
        setMeta(m)
        setLocalMeta(groupId, { name: m.name })
      })
      .catch(async () => {
        const { name } = await localMeta(groupId)
        if (name) setMeta({ id: groupId, name })
      })
    const timer = setInterval(refresh, 5000)
    const onOnline = () => refresh()
    window.addEventListener('online', onOnline)
    return () => {
      alive.current = false
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [groupId, openLocal, refresh])

  // Everything displayed is folded from the ledger, client-side.
  const state = useMemo(() => computeState(events), [events])
  const suggestions = useMemo(() => simplify(state.balances), [state.balances])
  // Distinct ratio splits already in this group's ledger, to reuse on a new
  // expense. Excludes the one being edited so it can't copy from itself.
  const savedSplits = useMemo(
    () => splitOptions(state.ledger, state.members, { excludeId: editing?.expense_id }),
    [state.ledger, state.members, editing]
  )
  const meId = memberIdFor(state.members, me)
  // Look the viewed expense up live so edits/new comments show while it's open.
  const viewing = viewingId
    ? state.ledger.find((x) => x.expense_id === viewingId) || null
    : null

  // The only way an event reaches the server: everything is sealed with the
  // group key first, so no caller can forget to encrypt.
  const appendEvent = useCallback(
    async (type, payload) => {
      const key = await groupKey(groupId)
      if (!key) throw new Error('No key for this group on this device')
      // Stored here first, so the write is durable and on screen whether or
      // not there is a network. The id comes back provisional and is replaced
      // by the server's when it lands — which is why ghosting, which needs a
      // real log position, flushes before reading it.
      const row = await append(groupId, {
        event_id: crypto.randomUUID(),
        type,
        payload: { enc: await encryptPayload(key, payload) },
      })
      return row
    },
    [groupId]
  )

  // Append a create or update event; an edit reuses the expense's stable id
  // so the fold treats it as the latest revision of the same expense.
  async function submitExpense(payload, isEdit) {
    await appendEvent(isEdit ? 'expense.updated' : 'expense.created', payload)
    setEditing(null)
    setScanReceipt(null)
    // Leaving an edit already remounts the form (the key changes back), but
    // creating doesn't — so the draft, receipts and all, would otherwise sit
    // there after the expense was filed. Bump the key to get a clean form.
    setFormNonce((n) => n + 1)
    await refresh()
  }

  // Soft delete / restore is just another revision with the flag flipped.
  async function setDeleted(x, deleted) {
    try {
      // Carry every field forward: a revision replaces the expense wholesale,
      // so anything left out here is destroyed by a delete or a restore.
      await appendEvent('expense.updated', {
        expense_id: x.expense_id,
        description: x.description,
        amount_cents: x.amount_cents,
        payers: x.payers,
        splits: x.splits,
        split: x.split,
        date: x.date,
        category: x.category,
        receipts: x.receipts,
        deleted,
        updated_at: Date.now(),
      })
      await refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  // Settlements are ledger events too. Suggestions are derived (never stored);
  // recording/editing/deleting a payment is what actually moves balances.
  async function appendSettlement(payload, isEdit) {
    try {
      await appendEvent(isEdit ? 'settlement.updated' : 'settlement.created', {
        ...payload,
        updated_at: Date.now(),
      })
      await refresh()
    } catch (err) {
      setError(err.message)
      throw err
    }
  }
  // Turn a member into a ghost. Anyone may do this to anyone, themselves
  // included — leaving is ghosting yourself. It takes nothing away: the server
  // keeps serving them the group frozen at this event. See plan/12.
  async function ghostMember(member_id) {
    // The one write that cannot be queued: the cut is a position in the server's
    // log, and a provisional id is not one. So flush, and read back the id the
    // server actually gave the event. Offline this throws, which is right —
    // freezing someone's view is not something to do optimistically.
    const row = await appendEvent('member.left', {
      member_id,
      updated_at: Date.now(),
    })
    await flush(groupId)
    const stored = (await localEvents(groupId)).find(
      (e) => e.event_id === row.event_id
    )
    if (!stored || stored.pending) {
      throw new Error('You need to be online to remove someone from a group')
    }
    const res = await api(`groups/${groupId}/ghost`, {
      member_id,
      at_event_id: stored.id,
    })
    if (member_id === meId || res.deleted) {
      // Either I just left, or nobody is reading this group any more.
      onBack()
      return
    }
    await refresh()
  }

  // Clone what I can still see into a group of my own. The prefix I was served
  // is mine to keep; replaying it is what turns a frozen view into somewhere I
  // can carry on. See plan/12.
  async function revive() {
    setError('')
    try {
      const g = await api('groups', { name: meta.name })
      // Before any event exists, so there is never a window in which one would
      // have nothing to encrypt under.
      const key = await createGroupKey(g.id)
      const { events: planned } = planRevive(state, meId, {
        from: { group_id: groupId, at_event_id: version },
      })
      for (const ev of planned) {
        await api(`groups/${g.id}/events`, {
          event_id: crypto.randomUUID(),
          type: ev.type,
          payload: { enc: await encryptPayload(key, ev.payload) },
        })
      }
      // Only once the clone is safely written. Hiding first would risk losing
      // sight of the original with nothing to show for it.
      await api(`groups/${groupId}/hide`, {})
      onOpen(g.id)
    } catch (err) {
      setError(err.message)
    }
  }

  // Someone who splits expenses with the group but doesn't use the app.
  // Negative ids so they can never collide with a server-issued user id, and
  // still numbers so the split maths keeps working. See plan/12.
  const addGhost = async (display_name) => {
    const member_id = -(Math.floor(Math.random() * 2 ** 45) + 1)
    await appendEvent('member.ghost_added', {
      member_id,
      display_name,
      updated_at: Date.now(),
    })
    await refresh()
    // Returned so an invite can name them: inviting someone is inviting them
    // to be this member.
    return member_id
  }

  const recordSettlement = (from, to, amount_cents) =>
    appendSettlement(
      {
        settlement_id: crypto.randomUUID(),
        from,
        to,
        amount_cents,
        date: new Date().toISOString().slice(0, 10),
        deleted: false,
      },
      false
    )
  const editSettlement = (s, amount_cents) =>
    appendSettlement(
      { settlement_id: s.settlement_id, from: s.from, to: s.to, amount_cents, date: s.date, deleted: false },
      true
    )
  const deleteSettlement = (s) =>
    appendSettlement(
      { settlement_id: s.settlement_id, from: s.from, to: s.to, amount_cents: s.amount_cents, date: s.date, deleted: true },
      true
    )

  // Comments are ledger events attached to an expense; author edits/deletes own.
  async function appendComment(payload, isEdit) {
    try {
      await appendEvent(isEdit ? 'comment.updated' : 'comment.created', {
        ...payload,
        updated_at: Date.now(),
      })
      await refresh()
    } catch (err) {
      setError(err.message)
      throw err
    }
  }
  const postComment = (expense_id, text) =>
    appendComment(
      { comment_id: crypto.randomUUID(), expense_id, text, deleted: false },
      false
    )
  const editComment = (c, text) =>
    appendComment(
      { comment_id: c.comment_id, expense_id: c.expense_id, text, deleted: false },
      true
    )
  const deleteComment = (c) =>
    appendComment(
      { comment_id: c.comment_id, expense_id: c.expense_id, text: c.text, deleted: true },
      true
    )

  if (!meta) return null

  // Ghosted, or claimed away by someone who joined as me. Either way there is
  // nobody here to attribute a new expense to, and picking a stand-in would be
  // worse than refusing.
  const meGhosted = !!state.members.find((m) => m.id === meId)?.ghost
  if (state.members.length > 0 && (meId === null || meGhosted)) {
    return (
      <section>
        <button className="link" onClick={onBack}>
          ← groups
        </button>
        <h2>{meta.name}</h2>
        <p className="muted">
          You&rsquo;re no longer part of this group. What you can see here is
          how it stood when you left; it won&rsquo;t change again.
        </p>
        {meGhosted && (
          <div className="revive">
            <p>
              You can carry on with a copy of your own. Every balance comes
              across exactly as it stands; everyone else becomes a ghost, so
              you can keep splitting with them, invite them, or settle up.
            </p>
            <p className="muted">
              Receipt images and comments stay behind. Nothing owed changes.
            </p>
            <button onClick={revive}>Revive as my own group</button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <LedgerLog
          group={{ id: groupId, name: meta.name }}
          version={version}
          events={events}
          unreadable={unreadable}
          members={state.members}
          onClose={onBack}
        />
      </section>
    )
  }

  if (locked) {
    return (
      <section>
        <button className="link" onClick={onBack}>
          ← groups
        </button>
        <h2>{meta.name}</h2>
        <p className="error">
          This device has no key for this group, so nothing here can be read.
          Open it on a device that does, or ask someone for a fresh invite link.
        </p>
      </section>
    )
  }

  return (
    <section>
      <button className="link" onClick={onBack}>
        ← groups
      </button>
      <h2>{meta.name}</h2>
      <p className="muted">
        synced v{version} ·{' '}
        <button className="link" onClick={() => setShowLog(true)}>
          log
        </button>
      </p>
      <InviteLink
        groupId={groupId}
        code={meta.code}
        members={state.members}
        onAddGhost={addGhost}
      />
      <ShareReadOnly groupId={groupId} code={meta.code} />
      {showLog && (
        <LedgerLog
          group={{ id: groupId, name: meta.name }}
          version={version}
          events={events}
          unreadable={unreadable}
          members={state.members}
          onClose={() => setShowLog(false)}
        />
      )}
      {(!online || pendingWrites > 0) && (
        <p className="muted sync-state">
          {pendingWrites > 0
            ? `${pendingWrites} change${pendingWrites === 1 ? '' : 's'} saved on this device, waiting to sync.`
            : 'Offline — showing what this device already has.'}
        </p>
      )}
      {unreadable > 0 && (
        <p className="error">
          {unreadable} entr{unreadable === 1 ? 'y' : 'ies'} could not be
          decrypted and {unreadable === 1 ? 'was' : 'were'} skipped.
        </p>
      )}

      <h3>Balances</h3>
      <ul className="list">
        {state.balances.map((b) => (
          <li key={b.user_id} className="row static">
            <span>{b.display_name}</span>
            <span className={b.net_cents >= 0 ? 'pos' : 'neg'}>
              {b.net_cents === 0
                ? 'settled up'
                : b.net_cents > 0
                  ? `is owed ${money(b.net_cents)}`
                  : `owes ${money(-b.net_cents)}`}
            </span>
          </li>
        ))}
      </ul>

      <h3>Settle up</h3>
      <SettleUp suggestions={suggestions} onRecord={recordSettlement} />

      <AddGhost onAdd={addGhost} />
      <LeaveOrGhost members={state.members} meId={meId} onGhost={ghostMember} />

      {state.members.length > 0 && (
        <ExpenseForm
          key={editing?.expense_id || `new-${formNonce}`}
          groupId={groupId}
          members={state.members}
          me={me}
          ai={ai}
          initial={editing}
          savedSplits={savedSplits}
          scanOnOpen={scanReceipt}
          onSubmit={submitExpense}
          onCancel={() => {
            setEditing(null)
            setScanReceipt(null)
          }}
        />
      )}

      <h3>Ledger</h3>
      {state.ledger.length === 0 && <p className="muted">No expenses yet.</p>}
      <ul className="list">
        {state.ledger.map((x) => (
          <li
            key={x.expense_id}
            className={`row static${x.deleted ? ' deleted' : ''}`}
          >
            <div
              className="expense clickable"
              onClick={() => setViewingId(x.expense_id)}
            >
              <span>
                {x.description}
                {x.deleted ? ' (deleted)' : ''}
              </span>
              <span className="muted">
                {x.payer_names.join(', ')} paid {money(x.amount_cents)} · split{' '}
                {x.ways} way{x.ways === 1 ? '' : 's'}
                {x.date ? ` · ${x.date}` : ''}
                {x.category ? ` · ${x.category}` : ''}
                {x.comments.length > 0 ? ` · 💬 ${x.comments.length}` : ''}
              </span>
            </div>
            <div className="row-actions">
              <button
                className="link"
                onClick={() => setEditing(x)}
                disabled={x.deleted}
              >
                edit
              </button>
              {x.deleted ? (
                <button className="link" onClick={() => setDeleted(x, false)}>
                  restore
                </button>
              ) : (
                <button
                  className="link danger"
                  onClick={() => setDeleted(x, true)}
                >
                  delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <h3>Payments</h3>
      <Payments
        payments={state.payments}
        onEdit={editSettlement}
        onDelete={deleteSettlement}
      />
      {error && <p className="error">{error}</p>}

      {viewing && (
        <ExpenseDetail
          groupId={groupId}
          expense={viewing}
          members={state.members}
          meId={meId}
          ai={ai}
          // Scanning a stored receipt opens the expense for editing with the
          // scan already running: the result has to land somewhere editable,
          // and that's the form.
          onScan={(receiptId) => {
            setViewingId(null)
            setEditing(viewing)
            setScanReceipt(receiptId)
          }}
          onClose={() => setViewingId(null)}
          onPost={postComment}
          onEdit={editComment}
          onDelete={deleteComment}
        />
      )}
    </section>
  )
}





