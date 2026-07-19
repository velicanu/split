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
import { PROVIDERS, extractReceipt } from './ai'
import { api } from './api'
import { changePassword, enrol, logout as signOut, resume, signup } from './auth'
import { decryptPayload, encryptPayload } from './crypto'
import { createGroupKey, groupKey, publishGroupKey } from './groupkeys'
import { buildInviteLink, parseInvite } from './invite'
import { receiptBlob, receiptUrl, uploadReceipt } from './receipts'
import { loadAiSettings, saveApiKey } from './aikeys'
import { downloadJson, exportLedger, ledgerFilename } from './export'


const money = (cents) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`

// Text field <-> cents. A blank or unparseable field counts as nothing.
const toCents = (text) => Math.round(parseFloat(text) * 100) || 0
const dollars = (cents) => (cents ? (cents / 100).toFixed(2) : '')

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

  useEffect(() => {
    // If this device already holds a key there is nothing to type — it signs
    // the server's challenge and we're in.
    resume()
      .then(setUser)
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [])

  if (checking) return null
  if (!user) return <Auth onAuth={setUser} />
  return <Home user={user} onLogout={() => setUser(null)} />
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

function Home({ user, onLogout }) {
  const [groupId, setGroupId] = useState(null)
  // An invite link opened while signed out: the fragment survives sign-in, so
  // pick it up once there's an account to join with.
  const [pendingInvite] = useState(() => parseInvite(window.location.hash))
  const [showSettings, setShowSettings] = useState(false)
  // null until loaded; { active, providers } after. No key => no provider.
  const [ai, setAi] = useState(null)

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
        const g = await api('groups/join', { code: pendingInvite.code })
        await publishGroupKey(g.id, pendingInvite.gk)
        if (!cancelled) setGroupId(g.id)
      } catch {
        // Already a member, or a stale link — the groups list still works.
      } finally {
        // Clear the key out of the address bar either way.
        window.history.replaceState(null, '', window.location.pathname)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pendingInvite])

  async function logout() {
    // Ends the session but keeps this device's key: it's still enrolled, so
    // signing back in needs no password. Revoking is the deliberate act.
    await signOut()
    onLogout()
  }

  return (
    <main className="app">
      <header>
        <strong
          className="brand"
          onClick={() => {
            setGroupId(null)
            setShowSettings(false)
          }}
        >
          Split
        </strong>
        <span className="spacer" />
        <span className="muted">{user.display_name}</span>
        <button className="link" onClick={() => setShowSettings(true)}>
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
          onClose={() => setShowSettings(false)}
        />
      ) : groupId ? (
        <GroupView
          groupId={groupId}
          me={user}
          ai={ai}
          onBack={() => setGroupId(null)}
        />
      ) : (
        <GroupList onOpen={setGroupId} />
      )}
    </main>
  )
}

const maskKey = (key) => `…${String(key).slice(-4)}`

// Provider settings. There is no default provider — with no keys the scanning
// feature simply doesn't exist. Adding a key (or switching) makes it active.
function Settings({ ai, user, onChanged, onClose }) {
  const [drafts, setDrafts] = useState({})
  const [error, setError] = useState('')

  async function run(fn) {
    setError('')
    try {
      await fn()
      await onChanged()
    } catch (err) {
      setError(err.message)
    }
  }
  const saveKey = (id) =>
    run(async () => {
      await saveApiKey(id, drafts[id].trim())
      setDrafts((d) => ({ ...d, [id]: '' }))
    })
  const chooseModel = (id, model) =>
    run(() => api(`ai/providers/${id}`, { model }, 'PUT'))
  const activate = (id) => run(() => api('ai/active', { provider: id }))
  const remove = (id) => run(() => api(`ai/providers/${id}`, undefined, 'DELETE'))

  return (
    <section>
      <button className="link" onClick={onClose}>
        ← back
      </button>
      <h2>Receipt scanning</h2>
      <p className="muted">
        Add an API key to turn on receipt scanning. The key is stored on your
        account and used straight from this browser, so receipt photos go to the
        provider you pick — not through our server.
      </p>

      {Object.entries(PROVIDERS).map(([id, provider]) => {
        const saved = ai?.providers?.[id]
        const isActive = ai?.active === id
        return (
          <fieldset key={id} className="participants receipt">
            <legend>
              {provider.label}
              {isActive ? ' · in use' : ''}
            </legend>
            {saved ? (
              <>
                {saved.api_key ? (
                  <p className="muted">
                    key saved ({maskKey(saved.api_key)}) · readable on this
                    device only
                  </p>
                ) : (
                  // The account has a key but this device cannot open it —
                  // it enrolled before the key was saved. Say so plainly
                  // rather than showing an empty box that looks like no key.
                  <p className="error">
                    A key is saved on your account, but this device can&rsquo;t
                    read it. Paste it again here, or sign in on the device that
                    has it.
                  </p>
                )}
                <label className="field">
                  model
                  <select
                    value={saved.model}
                    onChange={(e) => chooseModel(id, e.target.value)}
                  >
                    {provider.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {m.price}
                      </option>
                    ))}
                    {!provider.models.some((m) => m.id === saved.model) && (
                      <option value={saved.model}>{saved.model}</option>
                    )}
                  </select>
                </label>
                <div className="row-actions">
                  {!isActive && (
                    <button className="link" onClick={() => activate(id)}>
                      use this one
                    </button>
                  )}
                  <button className="link danger" onClick={() => remove(id)}>
                    remove key
                  </button>
                </div>
              </>
            ) : (
              <div className="settle-edit">
                <input
                  type="password"
                  placeholder={`${provider.label} API key`}
                  value={drafts[id] ?? ''}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [id]: e.target.value }))
                  }
                />
                <button
                  type="button"
                  className="link"
                  onClick={() => saveKey(id)}
                  disabled={!(drafts[id] || '').trim()}
                >
                  save
                </button>
              </div>
            )}
            {id === 'openai' && (
              <p className="muted">
                Note: OpenAI doesn&apos;t officially support calls straight from
                a browser, so this can be blocked. Anthropic supports it.
              </p>
            )}
          </fieldset>
        )
      })}

      {ai && !ai.active && (
        <p className="muted">No key yet — receipt scanning is off.</p>
      )}
      {error && <p className="error">{error}</p>}

      <h2>Account</h2>
      <PasswordForm user={user} />
      <Devices />
    </section>
  )
}

function PasswordForm({ user }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState('')
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setError('')
    setDone('')
    if (!next) return setError('Enter a new password')
    if (next !== confirm) return setError('New passwords do not match')
    try {
      // Re-wraps the account key on this device and replaces the stored blob.
      // Other devices keep their own keys and stay signed in — a password is
      // for unlocking a *new* device, not for holding a session open.
      await changePassword({
        login_handle: user.login_handle,
        current,
        next,
      })
      setCurrent('')
      setNext('')
      setConfirm('')
      setDone('Password changed. Use it next time you set up a new device.')
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <form onSubmit={submit}>
      <h3>Change password</h3>
      <input
        type="password"
        placeholder="current password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <input
        type="password"
        placeholder="new password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <input
        type="password"
        placeholder="confirm new password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <button type="submit">Change password</button>
      {done && <p className="muted">{done}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  )
}

// Every device holds its own key, so revoking one is real rather than
// advisory: it can't authenticate afterwards, and it can't enrol a
// replacement because its own key is the only one it ever had.
function Devices() {
  const [devices, setDevices] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(
    () =>
      api('devices')
        .then((r) => setDevices(r.devices))
        .catch((e) => setError(e.message)),
    []
  )
  useEffect(() => {
    load()
  }, [load])

  async function revoke(id) {
    setError('')
    try {
      await api(`devices/${id}`, undefined, 'DELETE')
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  const live = (devices || []).filter((d) => !d.revoked_at)

  return (
    <section>
      <h3>Devices</h3>
      <p className="muted">
        Lost a device? Revoke it here and it loses access immediately. It keeps
        anything it had already downloaded — that can&rsquo;t be undone.
      </p>
      {devices === null && <p className="muted">Loading…</p>}
      <ul className="list">
        {live.map((d) => (
          <li key={d.id} className="row static">
            <div className="expense">
              <span>
                {d.label}
                {d.current ? ' · this device' : ''}
              </span>
              <span className="muted">added {d.created_at}</span>
            </div>
            {!d.current && (
              <button
                className="link danger"
                onClick={() => revoke(d.id)}
              >
                revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </section>
  )
}

// The link carries the group key in its fragment, so it is a secret in a way
// the old invite code was not.
function InviteLink({ groupId, code }) {
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)

  async function reveal() {
    const key = await groupKey(groupId)
    if (!key) return
    setLink(buildInviteLink(window.location.origin, code, key))
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (!link) {
    return (
      <button className="link" onClick={reveal}>
        show invite link
      </button>
    )
  }
  return (
    <div>
      <p className="muted">
        Anyone with this link can read the group — it contains the key. Send it
        somewhere private.
      </p>
      <input className="invite" readOnly value={link} onFocus={(e) => e.target.select()} />
      <button className="link" onClick={copy}>
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  )
}

// Receipts are ciphertext on the server, so a plain <img src> would render
// nothing. Fetch, verify against the content hash, decrypt, then show.
function ReceiptThumb({ groupId, receiptId }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    receiptUrl(groupId, receiptId)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [groupId, receiptId])

  if (failed) {
    return <span className="receipt-thumb muted">unreadable</span>
  }
  if (!url) return <span className="receipt-thumb" />
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img className="receipt-thumb" src={url} alt="receipt" />
    </a>
  )
}

// Recovering an account, from the group's side. Deliberately plain and a
// little grudging: it is an identity-level claim, and while any member can
// already edit any expense, this one is easier to miss after the fact.
function MergeMembers({ members, onMerge }) {
  const [open, setOpen] = useState(false)
  const [oldId, setOldId] = useState('')
  const [newId, setNewId] = useState('')
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setError('')
    const from = Number(oldId)
    const to = Number(newId)
    if (!from || !to) return setError('Pick both people')
    if (from === to) return setError('Those are the same person')
    try {
      await onMerge(from, to)
      setOpen(false)
      setOldId('')
      setNewId('')
    } catch (err) {
      setError(err.message)
    }
  }

  if (members.length < 2) return null
  if (!open) {
    return (
      <button className="link" onClick={() => setOpen(true)}>
        someone lost their account?
      </button>
    )
  }

  const pick = (value, set, label) => (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">choose…</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.display_name}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <form onSubmit={submit}>
      <h4>Same person, new account</h4>
      <p className="muted">
        Their old history moves to the new account and the old one disappears
        from this group. Everyone sees it, and it cannot be undone.
      </p>
      {pick(oldId, setOldId, 'the account they lost')}
      {pick(newId, setNewId, 'the account they use now')}
      <div className="row-actions">
        <button type="submit">Merge them</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          cancel
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  )
}

// Everything the app shows is folded from this. Being able to read it, and
// take it away, is what makes the derivation checkable instead of a promise.
function LedgerLog({ group, version, events, unreadable, members, onClose }) {
  const nameById = Object.fromEntries(
    (members ?? []).map((m) => [m.id, m.display_name])
  )
  const [raw, setRaw] = useState(false)

  const save = () => {
    const now = new Date()
    downloadJson(
      ledgerFilename(group, now),
      exportLedger({ group, version, events, unreadable, now })
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="link close" onClick={onClose}>
          ×
        </button>
        <h3>Ledger</h3>
        <p className="muted">
          {events.length} entr{events.length === 1 ? 'y' : 'ies'} · every
          balance in this group is worked out from these, in this order.
        </p>
        {unreadable > 0 && (
          <p className="error">
            {unreadable} more this device couldn&rsquo;t decrypt, so
            {unreadable === 1 ? ' it is' : ' they are'} missing from the list
            and from anything you download.
          </p>
        )}

        <div className="row-actions">
          <button onClick={save}>Download JSON</button>
          <button className="link" onClick={() => setRaw(!raw)}>
            {raw ? 'readable' : 'raw'}
          </button>
        </div>
        <p className="muted">
          The file is plain text — it holds everything in this group.
        </p>

        <ul className="list">
          {events.map((e) => (
            <li key={e.id} className="row static log-entry">
              <div className="expense">
                <span>
                  <code>#{e.id}</code> {e.type}
                </span>
                <span className="muted">
                  {nameById[e.author] ? `by ${nameById[e.author]}` : ''}
                  {e.created_at ? ` · ${e.created_at}` : ''}
                </span>
                {raw && <pre className="log-payload">{JSON.stringify(e.payload, null, 2)}</pre>}
              </div>
            </li>
          ))}
        </ul>
        {events.length === 0 && <p className="muted">Nothing logged yet.</p>}
      </div>
    </div>
  )
}

function GroupList({ onOpen }) {
  const [groups, setGroups] = useState(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  const load = () => api('groups').then(setGroups).catch((e) => setError(e.message))
  useEffect(() => {
    load()
  }, [])

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
      const g = await api('groups/join', { code: invite.code })
      // Seal the key from the link to this account and device; the server
      // never saw it and could not have given it to us.
      await publishGroupKey(g.id, invite.gk)
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
                {g.members} member{g.members === 1 ? '' : 's'}
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

export function GroupView({ groupId, me, ai, onBack }) {
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
  const versionRef = useRef(0)

  // Pull only what's newer than what we already hold, decrypt it, then append.
  const pull = useCallback(async () => {
    try {
      const res = await api(`groups/${groupId}/events?since=${versionRef.current}`)
      if (!res.events.length) return
      const key = await groupKey(groupId)
      if (!key) {
        setLocked(true)
        return
      }
      setLocked(false)
      const opened = []
      let unreadable = 0
      for (const e of res.events) {
        // member.added is written by the server, which has no key, so it is
        // the one event that is never encrypted.
        if (!e.payload?.enc) {
          opened.push(e)
          continue
        }
        try {
          opened.push({ ...e, payload: await decryptPayload(key, e.payload.enc) })
        } catch {
          // Skip rather than throw: one bad row must not blank the whole group.
          unreadable += 1
        }
      }
      setUnreadable((n) => n + unreadable)
      versionRef.current = res.version
      setVersion(res.version)
      setEvents((prev) => [...prev, ...opened])
    } catch (err) {
      setError(err.message)
    }
  }, [groupId])

  useEffect(() => {
    versionRef.current = 0
    setEvents([])
    setVersion(0)
    setEditing(null)
    setViewingId(null)
    api(`groups/${groupId}`)
      .then(setMeta)
      .catch((e) => setError(e.message))
    pull()
    const timer = setInterval(pull, 5000)
    return () => clearInterval(timer)
  }, [groupId, pull])

  // Everything displayed is folded from the ledger, client-side.
  const state = useMemo(() => computeState(events), [events])
  const suggestions = useMemo(() => simplify(state.balances), [state.balances])
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
      await api(`groups/${groupId}/events`, {
        event_id: crypto.randomUUID(),
        type,
        payload: { enc: await encryptPayload(key, payload) },
      })
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
    await pull()
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
      await pull()
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
      await pull()
    } catch (err) {
      setError(err.message)
      throw err
    }
  }
  // Someone who lost every device signs up again and gets re-invited; this
  // reattaches their history to the account they can actually sign for. See
  // plan/07 — the group vouches for them, because the server cannot.
  const mergeMembers = (old_member_id, new_member_id) =>
    appendEvent('member.merged', {
      old_member_id,
      new_member_id,
      updated_at: Date.now(),
    }).then(pull)

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
      await pull()
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
      <InviteLink groupId={groupId} code={meta.code} />
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

      <MergeMembers members={state.members} onMerge={mergeMembers} />

      {state.members.length > 0 && (
        <ExpenseForm
          key={editing?.expense_id || `new-${formNonce}`}
          groupId={groupId}
          members={state.members}
          me={me}
          ai={ai}
          initial={editing}
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

// Detail overlay for one expense: per-person paid/owed, plus comments (anyone
// can post; you may edit/delete your own).
function ExpenseDetail({
  groupId,
  expense,
  members,
  meId,
  ai,
  onScan,
  onClose,
  onPost,
  onEdit,
  onDelete,
}) {
  const nameById = Object.fromEntries(members.map((m) => [m.id, m.display_name]))
  const [text, setText] = useState('')
  const [editId, setEditId] = useState(null)
  const [editText, setEditText] = useState('')
  const [error, setError] = useState('')

  async function post(e) {
    e.preventDefault()
    if (!text.trim()) return
    try {
      await onPost(expense.expense_id, text.trim())
      setText('')
    } catch {
      setError('Could not post comment')
    }
  }
  async function saveEdit(c) {
    if (!editText.trim()) return
    try {
      await onEdit(c, editText.trim())
      setEditId(null)
    } catch {
      setError('Could not save comment')
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="link close" onClick={onClose}>
          ×
        </button>
        <h3>
          {expense.description}
          {expense.deleted ? ' (deleted)' : ''}
        </h3>
        <p className="muted">
          {money(expense.amount_cents)}
          {expense.date ? ` · ${expense.date}` : ''}
          {expense.category ? ` · ${expense.category}` : ''}
          {expense.split?.mode && expense.split.mode !== 'equal'
            ? ` · by ${expense.split.mode}`
            : ''}
        </p>

        {expense.receipts?.length > 0 && (
          <>
            <h4>Receipts</h4>
            <div className="receipt-strip">
              {expense.receipts.map((rid) => (
                <div key={rid} className="receipt-cell">
                  <ReceiptThumb groupId={groupId} receiptId={rid} />
                  {/* Re-reading a receipt belongs with the receipt, on the
                      expense it's attached to — not on the add form, which
                      has no business holding one past creation. */}
                  {ai?.active && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => onScan(rid)}
                    >
                      {expense.split?.mode === 'items' ? 'rescan' : 'scan'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <h4>Paid</h4>
        <ul className="list">
          {expense.payers.map((p) => (
            <li key={p.user_id} className="row static">
              <span>{nameById[p.user_id] || '?'}</span>
              <span>{money(p.paid_cents)}</span>
            </li>
          ))}
        </ul>

        {expense.split?.mode === 'items' &&
          Array.isArray(expense.split.items) && (
            <>
              <h4>Receipt</h4>
              <ul className="list">
                {expense.split.items.map((it) => (
                  <li key={it.id} className="row static">
                    <div className="expense">
                      <span>{it.name || 'item'}</span>
                      <span className="muted">
                        {it.claimed_by?.length
                          ? it.claimed_by
                              .map((id) => nameById[id] || '?')
                              .join(', ')
                          : 'everyone'}
                      </span>
                    </div>
                    <span>{money(it.price_cents)}</span>
                  </li>
                ))}
              </ul>
              {(() => {
                const sub = expense.split.items.reduce(
                  (t, it) => t + (it.price_cents || 0),
                  0
                )
                const tax = expense.split.tax_cents || 0
                const tip = expense.split.tip_cents || 0
                const rest = expense.amount_cents - sub - tax - tip
                const label =
                  rest < 0 ? 'discount' : tax || tip ? 'other' : 'tax/tip'
                return (
                  <p className="muted">
                    items {money(sub)}
                    {tax ? ` · tax ${money(tax)}` : ''}
                    {tip ? ` · tip ${money(tip)}` : ''}
                    {rest !== 0 ? ` · ${label} ${money(Math.abs(rest))}` : ''}
                  </p>
                )
              })()}
            </>
          )}

        <h4>Owes</h4>
        <ul className="list">
          {expense.splits.map((s) => (
            <li key={s.user_id} className="row static">
              <span>{nameById[s.user_id] || '?'}</span>
              <span>{money(s.share_cents)}</span>
            </li>
          ))}
        </ul>

        <h4>Comments</h4>
        {expense.comments.length === 0 && (
          <p className="muted">No comments yet.</p>
        )}
        <ul className="list">
          {expense.comments.map((c) => {
            const active = editId === c.comment_id
            return (
              <li key={c.comment_id} className="row static">
                {active ? (
                  <span className="settle-edit">
                    <input
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                    />
                    <button
                      type="button"
                      className="link"
                      onClick={() => saveEdit(c)}
                    >
                      save
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setEditId(null)}
                    >
                      cancel
                    </button>
                  </span>
                ) : (
                  <>
                    <div className="expense">
                      <span>{c.text}</span>
                      <span className="muted">{c.author_name}</span>
                    </div>
                    {c.author === meId && (
                      <div className="row-actions">
                        <button
                          className="link"
                          onClick={() => {
                            setEditId(c.comment_id)
                            setEditText(c.text)
                          }}
                        >
                          edit
                        </button>
                        <button
                          className="link danger"
                          onClick={() => onDelete(c)}
                        >
                          delete
                        </button>
                      </div>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>

        <form onSubmit={post}>
          <input
            placeholder="add a comment"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit">Post</button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}

function memberIdFor(members, me) {
  // By id: display names are not unique, so matching on one could silently
  // attribute an expense to the wrong person.
  const mine = members.find((m) => m.id === me?.id)
  return (mine || members[0])?.id
}

// Line items with per-person claims. Claim an item and it splits between its
// claimants; leave it unclaimed and it splits among everyone on the receipt.
function ReceiptEditor({
  items,
  setItems,
  participants,
  legend = 'items (unclaimed ones split among everyone)',
}) {
  // Functional updates throughout: two edits batched in one tick (e.g. name and
  // price together) must not read the same stale list and clobber each other.
  const update = (idx, patch) =>
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    )
  const toggleClaim = (idx, uid) =>
    setItems((prev) =>
      prev.map((it, i) =>
        i === idx
          ? {
              ...it,
              claimed_by: it.claimed_by.includes(uid)
                ? it.claimed_by.filter((x) => x !== uid)
                : [...it.claimed_by, uid],
            }
          : it
      )
    )

  return (
    <fieldset className="participants receipt">
      <legend>{legend}</legend>
      {items.length === 0 && (
        <p className="muted">No items yet — add the lines off the receipt.</p>
      )}
      {items.map((it, idx) => (
        <div key={it.id} className="item">
          <div className="item-head">
            <input
              placeholder="item"
              value={it.name}
              onChange={(e) => update(idx, { name: e.target.value })}
            />
            <input
              className="pay-amt"
              inputMode="decimal"
              placeholder="0.00"
              value={it.price}
              onChange={(e) => update(idx, { price: e.target.value })}
            />
            <button
              type="button"
              className="link danger"
              onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
            >
              remove
            </button>
          </div>
          {participants.length > 0 && (
            <div className="claims">
              {participants.map((m) => (
                <label key={m.id} className="check">
                  <input
                    type="checkbox"
                    checked={it.claimed_by.includes(m.id)}
                    onChange={() => toggleClaim(idx, m.id)}
                  />
                  {m.display_name}
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        className="link"
        onClick={() =>
          setItems((prev) => [
            ...prev,
            { id: crypto.randomUUID(), name: '', price: '', claimed_by: [] },
          ])
        }
      >
        + add item
      </button>
    </fieldset>
  )
}

// Suggested minimal transfers. One click opens an editable amount (prefilled
// with the suggested default); confirm records it as a settlement.
function SettleUp({ suggestions, onRecord }) {
  const [activeKey, setActiveKey] = useState(null)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')

  async function confirm(t) {
    const cents = Math.round(parseFloat(amount) * 100)
    if (!cents || cents <= 0) return setError('Enter a positive amount')
    try {
      await onRecord(t.from, t.to, cents)
      setActiveKey(null)
      setError('')
    } catch {
      // error is surfaced by the parent
    }
  }

  if (!suggestions.length) {
    return <p className="muted">Everyone is settled up 🎉</p>
  }
  return (
    <>
      <ul className="list">
        {suggestions.map((t) => {
          const key = `${t.from}-${t.to}`
          return (
            <li key={key} className="row static">
              <span>
                {t.from_name} → {t.to_name}
              </span>
              {activeKey === key ? (
                <span className="settle-edit">
                  <input
                    className="pay-amt"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <button type="button" className="link" onClick={() => confirm(t)}>
                    confirm
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setActiveKey(null)}
                  >
                    cancel
                  </button>
                </span>
              ) : (
                <button
                  className="link"
                  onClick={() => {
                    setActiveKey(key)
                    setAmount((t.amount_cents / 100).toFixed(2))
                    setError('')
                  }}
                >
                  {money(t.amount_cents)} · settle
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {error && <p className="error">{error}</p>}
    </>
  )
}

// Recorded payments. Only the member who initiated one may edit or delete it.
function Payments({ payments, onEdit, onDelete }) {
  const [editId, setEditId] = useState(null)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')

  if (!payments.length) return <p className="muted">No payments yet.</p>
  return (
    <>
      <ul className="list">
        {payments.map((s) => {
          const active = editId === s.settlement_id
          return (
            <li key={s.settlement_id} className="row static">
              <div className="expense">
                <span>
                  {s.from_name} paid {s.to_name} {money(s.amount_cents)}
                </span>
                <span className="muted">{s.date}</span>
              </div>
              {active ? (
                  <span className="settle-edit">
                    <input
                      className="pay-amt"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                    <button
                      type="button"
                      className="link"
                      onClick={async () => {
                        const cents = Math.round(parseFloat(amount) * 100)
                        if (!cents || cents <= 0) {
                          return setError('Enter a positive amount')
                        }
                        try {
                          await onEdit(s, cents)
                          setEditId(null)
                          setError('')
                        } catch {
                          // surfaced by parent
                        }
                      }}
                    >
                      save
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setEditId(null)}
                    >
                      cancel
                    </button>
                  </span>
                ) : (
                  <div className="row-actions">
                    <button
                      className="link"
                      onClick={() => {
                        setEditId(s.settlement_id)
                        setAmount((s.amount_cents / 100).toFixed(2))
                        setError('')
                      }}
                    >
                      edit
                    </button>
                    <button
                      className="link danger"
                      onClick={() => onDelete(s)}
                    >
                      delete
                    </button>
                  </div>
                )}
            </li>
          )
        })}
      </ul>
      {error && <p className="error">{error}</p>}
    </>
  )
}

export function ExpenseForm({
  groupId,
  members,
  me,
  ai,
  initial,
  scanOnOpen,
  onSubmit,
  onCancel,
}) {
  const [scanning, setScanning] = useState(false)
  const [uploading, setUploading] = useState(false)
  // Ids of receipt images attached to this expense. Uploading is independent of
  // scanning: no API key is needed to keep a photo of the receipt, and a stored
  // receipt can be scanned later, or scanned again.
  const [receipts, setReceipts] = useState(() => initial?.receipts ?? [])
  const today = new Date().toISOString().slice(0, 10)
  const [description, setDescription] = useState(initial?.description ?? '')
  const [amount, setAmount] = useState(
    initial ? (initial.amount_cents / 100).toFixed(2) : ''
  )
  const [date, setDate] = useState(initial?.date || today)
  const [category, setCategory] = useState(initial?.category ?? '')
  // How to split: equally (default), by percentage, or by shares.
  const [mode, setMode] = useState(initial?.split?.mode || 'equal')
  // Per-member percentage/share inputs, keyed by user id (strings while typing).
  const [weights, setWeights] = useState(() =>
    initial?.split?.weights
      ? Object.fromEntries(
          Object.entries(initial.split.weights).map(([id, v]) => [id, String(v)])
        )
      : {}
  )
  // Receipt line items (prices as strings while typing).
  const [items, setItems] = useState(() =>
    initial?.split?.mode === 'items' && Array.isArray(initial.split.items)
      ? initial.split.items.map((it) => ({
          id: it.id || crypto.randomUUID(),
          name: it.name || '',
          price: ((it.price_cents || 0) / 100).toFixed(2),
          claimed_by: it.claimed_by || [],
        }))
      : []
  )
  // members left OUT of the split (so members who join later default to "in")
  const [excluded, setExcluded] = useState(() => {
    if (!initial) return []
    const all = members.map((m) => m.id)
    // A receipt keeps its own participant set: someone can be on the receipt
    // yet owe nothing, so it can't be re-derived from the resolved splits.
    if (initial.split?.mode === 'items' && Array.isArray(initial.split.participants)) {
      return all.filter((id) => !initial.split.participants.includes(id))
    }
    const inSplit = initial.splits.map((s) => s.user_id)
    return all.filter((id) => !inSplit.includes(id))
  })
  // Tax and tip are recorded for information only — the split is driven by the
  // item weights scaled to the total, so these never enter the maths.
  const [tax, setTax] = useState(dollars(initial?.split?.tax_cents))
  const [tip, setTip] = useState(dollars(initial?.split?.tip_cents))
  // A scan whose items don't add up to the receipt's own subtotal, parked as an
  // editable draft: the misread is usually one line or the subtotal itself, so
  // it's fixable here rather than only acceptable or discardable wholesale.
  const [pending, setPending] = useState(null)
  const [payerIds, setPayerIds] = useState(() =>
    initial ? initial.payers.map((p) => p.user_id) : [memberIdFor(members, me)]
  )
  const [payerAmounts, setPayerAmounts] = useState(() =>
    initial
      ? Object.fromEntries(
          initial.payers.map((p) => [p.user_id, (p.paid_cents / 100).toFixed(2)])
        )
      : {}
  )
  const [error, setError] = useState('')

  const toggle = (list, setList, id) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  // Scan results and the form's own rows share a shape, so a draft can be
  // edited with the same editor and then handed straight to the form.
  const draftFrom = (result) => ({
    items: result.items.map((it) => ({
      id: crypto.randomUUID(),
      name: it.name,
      price: (it.price_cents / 100).toFixed(2),
      claimed_by: [],
    })),
    subtotal: dollars(result.subtotal_cents),
    tax: dollars(result.tax_cents),
    tip: dollars(result.tip_cents),
    total: (result.total_cents / 100).toFixed(2),
  })

  function applyDraft(draft) {
    setItems(draft.items)
    setAmount(draft.total)
    setTax(draft.tax)
    setTip(draft.tip)
    // A scan implies an itemised split, whatever mode you were in.
    setMode('items')
    setPending(null)
  }

  // Scanned output is a *draft*: it fills the editable rows so the user can
  // fix OCR mistakes before anything is saved. Takes any image source, so the
  // same path serves a fresh photo and a re-scan of a stored one.
  async function runScan(image) {
    const config = ai?.providers?.[ai.active]
    if (!config) return
    setScanning(true)
    setError('')
    setPending(null)
    try {
      const result = await extractReceipt({
        provider: ai.active,
        apiKey: config.api_key,
        model: config.model,
        file: image,
      })
      // Items that don't reconcile with the printed subtotal mean something
      // was misread, so let the user look before it touches the form.
      const draft = draftFrom(result)
      if (result.matches) applyDraft(draft)
      else setPending(draft)
    } catch (err) {
      setError(err.message)
    } finally {
      setScanning(false)
    }
  }

  // Stored at the size we'd display it, which is also the size we'd send to a
  // model — a full-resolution phone photo is wasted bytes for a receipt.
  async function upload(file) {
    const id = await uploadReceipt(groupId, file)
    setReceipts((prev) => [...prev, id])
  }

  const pick = (handler) => async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) await handler(file)
  }

  const attach = pick(async (file) => {
    setUploading(true)
    setError('')
    try {
      await upload(file)
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  })

  // Attach and scan in one go. If the upload fails the scan is skipped, so a
  // failure means nothing happened rather than a scan with no receipt kept.
  const scanNew = pick(async (file) => {
    setUploading(true)
    setError('')
    try {
      await upload(file)
    } catch (err) {
      setError(err.message)
      return
    } finally {
      setUploading(false)
    }
    await runScan(file)
  })

  async function rescan(receiptId) {
    setError('')
    try {
      await runScan(await receiptBlob(groupId, receiptId))
    } catch (err) {
      setError(err.message)
    }
  }

  // Opened from the detail view's scan button: read that receipt once, as the
  // form mounts. The ref guards against a second run on re-render.
  const scanned = useRef(false)
  useEffect(() => {
    if (scanOnOpen && !scanned.current) {
      scanned.current = true
      rescan(scanOnOpen)
    }
  }, [scanOnOpen])

  async function submit(e) {
    e.preventDefault()
    setError('')
    const cents = Math.round(parseFloat(amount) * 100)
    if (!description.trim() || !cents || cents <= 0) {
      return setError('Enter a description and a positive amount')
    }
    if (!date) return setError('Pick a date')

    // Resolve the chosen mode down to frozen per-person cents. Whatever the
    // mode, the stored `splits` are what balances use; `split` keeps the recipe.
    let splits
    let split
    if (mode === 'equal') {
      const participants = members
        .map((m) => m.id)
        .filter((id) => !excluded.includes(id))
      if (!participants.length) {
        return setError('Pick at least one person to split between')
      }
      const shares = splitEqually(cents, participants)
      splits = participants.map((uid) => ({
        user_id: uid,
        share_cents: shares[uid],
      }))
      split = { mode: 'equal' }
    } else if (mode === 'items') {
      const participants = members
        .map((m) => m.id)
        .filter((id) => !excluded.includes(id))
      if (!participants.length) return setError('Pick who is on the receipt')
      const parsed = items
        .map((it) => ({
          id: it.id,
          name: it.name.trim(),
          price_cents: Math.round(parseFloat(it.price) * 100) || 0,
          claimed_by: it.claimed_by.filter((id) => participants.includes(id)),
        }))
        .filter((it) => it.price_cents > 0)
      if (!parsed.length) return setError('Add at least one item with a price')
      const w = receiptWeights(parsed, participants)
      const positive = {}
      for (const [id, v] of Object.entries(w)) if (v > 0) positive[id] = v
      const shares = splitByWeights(cents, positive)
      splits = Object.keys(shares)
        .map(Number)
        .sort((a, b) => a - b)
        .map((uid) => ({ user_id: uid, share_cents: shares[uid] }))
      // Subtotal isn't stored — it's just the sum of the items.
      split = {
        mode: 'items',
        participants,
        items: parsed,
        tax_cents: toCents(tax),
        tip_cents: toCents(tip),
      }
    } else {
      const w = {}
      for (const m of members) {
        const v = parseFloat(weights[m.id])
        if (v > 0) w[m.id] = v
      }
      const ids = Object.keys(w)
      if (!ids.length) {
        return setError(
          mode === 'percentage'
            ? 'Enter a percentage for at least one person'
            : 'Enter shares for at least one person'
        )
      }
      if (mode === 'percentage') {
        const sum = ids.reduce((t, id) => t + w[id], 0)
        if (Math.abs(sum - 100) > 0.001) {
          return setError(`Percentages must total 100 (now ${sum})`)
        }
      }
      const shares = splitByWeights(cents, w)
      splits = Object.keys(shares)
        .map(Number)
        .sort((a, b) => a - b)
        .map((uid) => ({ user_id: uid, share_cents: shares[uid] }))
      split = { mode, weights: w }
    }

    if (!payerIds.length) return setError('Pick who paid')
    let payers
    if (payerIds.length === 1) {
      payers = [{ user_id: payerIds[0], paid_cents: cents }]
    } else {
      payers = payerIds.map((uid) => ({
        user_id: uid,
        paid_cents: Math.round(parseFloat(payerAmounts[uid]) * 100) || 0,
      }))
      if (payers.some((p) => p.paid_cents <= 0)) {
        return setError('Each payer must have paid a positive amount')
      }
      const sum = payers.reduce((t, p) => t + p.paid_cents, 0)
      if (sum !== cents) {
        return setError(
          `Payments must add up to ${money(cents)} (now ${money(sum)})`
        )
      }
    }

    try {
      await onSubmit(
        {
          expense_id: initial?.expense_id ?? crypto.randomUUID(),
          description: description.trim(),
          amount_cents: cents,
          payers,
          splits,
          split,
          date,
          category: category.trim(),
          receipts,
          deleted: initial?.deleted ?? false,
          updated_at: Date.now(),
        },
        !!initial
      )
    } catch (err) {
      setError(err.message)
    }
  }

  // Live receipt maths: the gap between the items and the total is the tax/tip
  // (or discount) that gets spread proportionally.
  const amountCents = toCents(amount)
  const itemsTotalCents = items.reduce(
    (t, it) => t + toCents(it.price),
    0
  )
  const taxCents = toCents(tax)
  const tipCents = toCents(tip)
  // The pending scan reconciles live, so fixing a misread line clears the
  // warning as you type rather than only on a re-scan.
  const pendingItemsCents = (pending?.items ?? []).reduce(
    (t, it) => t + toCents(it.price),
    0
  )
  const pendingSubtotalCents = toCents(pending?.subtotal)
  // No subtotal to check against means nothing to reconcile, same as on arrival.
  const pendingGap = pendingSubtotalCents
    ? pendingItemsCents - pendingSubtotalCents
    : 0
  // Whatever the gap isn't explained by the tax and tip the user entered.
  const unexplained = amountCents - itemsTotalCents - taxCents - tipCents
  const unexplainedLabel =
    unexplained < 0 ? 'discount' : taxCents || tipCents ? 'other' : 'tax/tip'

  return (
    <form onSubmit={submit}>
      <h3>{initial ? 'Edit expense' : 'Add an expense'}</h3>
      <input
        placeholder="description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <input
        placeholder="amount (e.g. 42.50)"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label className="field">
        date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <input
        placeholder="category (optional)"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      />

      <fieldset className="participants">
        <legend>paid by</legend>
        {members.map((m) => {
          const checked = payerIds.includes(m.id)
          return (
            <label key={m.id} className="check">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(payerIds, setPayerIds, m.id)}
              />
              {m.display_name}
              {checked && payerIds.length > 1 && (
                <input
                  className="pay-amt"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={payerAmounts[m.id] ?? ''}
                  onChange={(e) =>
                    setPayerAmounts((a) => ({ ...a, [m.id]: e.target.value }))
                  }
                />
              )}
            </label>
          )
        })}
      </fieldset>

      <label className="field">
        split
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="equal">equally</option>
          <option value="percentage">by percentage</option>
          <option value="shares">by shares</option>
          <option value="items">by receipt items</option>
        </select>
      </label>

      {/* Keeping the receipt needs no API key. Scanning is a separate,
          optional step on top — and either one can start an expense, so
          neither is hidden behind picking a split mode first. */}
      <label className="scan">
        {uploading ? 'uploading…' : '📎 add a receipt'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          disabled={uploading || scanning}
          onChange={attach}
        />
      </label>
      {ai?.active && (
        <label className="scan">
          {scanning
            ? 'scanning…'
            : uploading
              ? 'uploading…'
              : `📷 add and scan with ${PROVIDERS[ai.active]?.label ?? ai.active}`}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={uploading || scanning}
            onChange={scanNew}
          />
        </label>
      )}

      {receipts.length > 0 && (
        <fieldset className="participants receipt">
          <legend>receipts</legend>
          {receipts.map((rid) => (
            <div key={rid} className="receipt-row">
              <ReceiptThumb groupId={groupId} receiptId={rid} />
              {/* No scan button here: re-reading a receipt lives on the
                  expense's detail view, once there's an expense to attach
                  the result to. */}
              <button
                type="button"
                className="link danger"
                onClick={() =>
                  setReceipts((prev) => prev.filter((id) => id !== rid))
                }
              >
                remove
              </button>
            </div>
          ))}
        </fieldset>
      )}

      {pending && (
        <fieldset className="participants receipt">
          <legend>check this scan</legend>
          {pendingGap === 0 ? (
            <p className="muted">
              These items add up to {money(pendingItemsCents)}, matching the
              subtotal.
            </p>
          ) : (
            <p className="error">
              These items add up to {money(pendingItemsCents)}, but the
              receipt&rsquo;s subtotal reads {money(pendingSubtotalCents)} —{' '}
              {money(Math.abs(pendingGap))}{' '}
              {pendingGap > 0 ? 'over' : 'short'}. Fix whichever one is wrong,
              or use it as it is.
            </p>
          )}
          <ReceiptEditor
            legend="scanned items"
            items={pending.items}
            setItems={(update) =>
              setPending((p) => ({
                ...p,
                items: typeof update === 'function' ? update(p.items) : update,
              }))
            }
            // Claiming comes after the receipt is right, in the form proper.
            participants={[]}
          />
          <label className="field">
            subtotal printed on the receipt
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={pending.subtotal}
              onChange={(e) =>
                setPending((p) => ({ ...p, subtotal: e.target.value }))
              }
            />
          </label>
          <p className="muted">
            {pending.tax ? `tax ${money(toCents(pending.tax))} · ` : ''}
            {pending.tip ? `tip ${money(toCents(pending.tip))} · ` : ''}
            total {money(toCents(pending.total))} (editable once you use it)
          </p>
          <div className="row-actions">
            <button type="button" onClick={() => applyDraft(pending)}>
              {pendingGap === 0 ? 'use these items' : 'use them anyway'}
            </button>
            <button
              type="button"
              className="link danger"
              onClick={() => setPending(null)}
            >
              discard scan
            </button>
          </div>
        </fieldset>
      )}

      {(mode === 'equal' || mode === 'items') && (
        <fieldset className="participants">
          <legend>{mode === 'items' ? 'on the receipt' : 'split between'}</legend>
          {members.map((m) => (
            <label key={m.id} className="check">
              <input
                type="checkbox"
                checked={!excluded.includes(m.id)}
                onChange={() => toggle(excluded, setExcluded, m.id)}
              />
              {m.display_name}
            </label>
          ))}
        </fieldset>
      )}

      {mode === 'items' && (
        <>
          <ReceiptEditor
            items={items}
            setItems={setItems}
            participants={members.filter((m) => !excluded.includes(m.id))}
          />
          <div className="cols">
            <label className="field">
              tax (optional)
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={tax}
                onChange={(e) => setTax(e.target.value)}
              />
            </label>
            <label className="field">
              tip (optional)
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={tip}
                onChange={(e) => setTip(e.target.value)}
              />
            </label>
          </div>
          {itemsTotalCents > 0 && (
            <p className="muted">
              items {money(itemsTotalCents)}
              {taxCents ? ` · tax ${money(taxCents)}` : ''}
              {tipCents ? ` · tip ${money(tipCents)}` : ''}
              {unexplained !== 0
                ? ` · ${unexplainedLabel} ${money(Math.abs(unexplained))}`
                : ''}{' '}
              · total {money(amountCents)}
            </p>
          )}
        </>
      )}

      {(mode === 'percentage' || mode === 'shares') && (
        <fieldset className="participants">
          <legend>
            {mode === 'percentage' ? 'percentages (total 100)' : 'shares'}
          </legend>
          {members.map((m) => (
            <label key={m.id} className="check">
              {m.display_name}
              <input
                className="pay-amt"
                inputMode="decimal"
                placeholder={mode === 'percentage' ? '%' : '0'}
                value={weights[m.id] ?? ''}
                onChange={(e) =>
                  setWeights((w) => ({ ...w, [m.id]: e.target.value }))
                }
              />
            </label>
          ))}
        </fieldset>
      )}

      <div className="row-actions">
        <button type="submit">{initial ? 'Save changes' : 'Add expense'}</button>
        {initial && (
          <button type="button" className="link" onClick={onCancel}>
            cancel
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
