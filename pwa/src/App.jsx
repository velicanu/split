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

async function api(path, body, method) {
  const res = await fetch(`/api/${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || res.statusText)
  return data
}

const money = (cents) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`

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
    api('me')
      .then(setUser)
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [])

  if (checking) return null
  if (!user) return <Auth onAuth={setUser} />
  return <Home user={user} onLogout={() => setUser(null)} />
}

function Auth({ onAuth }) {
  const [mode, setMode] = useState('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setError('')
    try {
      onAuth(await api(mode, { username, password }))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <main>
      <h1>Split</h1>
      <form onSubmit={submit}>
        <input
          placeholder="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />
        <button type="submit">{mode === 'login' ? 'Log in' : 'Sign up'}</button>
      </form>
      {error && <p className="error">{error}</p>}
      <p>
        {mode === 'login' ? 'No account?' : 'Have an account?'}{' '}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault()
            setError('')
            setMode(mode === 'login' ? 'signup' : 'login')
          }}
        >
          {mode === 'login' ? 'Sign up' : 'Log in'}
        </a>
      </p>
    </main>
  )
}

function Home({ user, onLogout }) {
  const [groupId, setGroupId] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  // null until loaded; { active, providers } after. No key => no provider.
  const [ai, setAi] = useState(null)

  const loadAi = useCallback(
    () =>
      api('ai/settings')
        .then(setAi)
        .catch(() => {}),
    []
  )
  useEffect(() => {
    loadAi()
  }, [loadAi])

  async function logout() {
    await api('logout', {})
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
        <span className="muted">{user.username}</span>
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
function Settings({ ai, onChanged, onClose }) {
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
      await api(`ai/providers/${id}`, { api_key: drafts[id] }, 'PUT')
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
                <p className="muted">key saved ({maskKey(saved.api_key)})</p>
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
    </section>
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
      setName('')
      onOpen(g.id)
    } catch (err) {
      setError(err.message)
    }
  }

  async function join(e) {
    e.preventDefault()
    setError('')
    try {
      const g = await api('groups/join', { code: code.trim() })
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
            placeholder="invite code"
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

function GroupView({ groupId, me, ai, onBack }) {
  const [meta, setMeta] = useState(null)
  const [events, setEvents] = useState([])
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState(null) // null = add mode; else an expense
  const [viewingId, setViewingId] = useState(null) // expense_id shown in detail
  const [error, setError] = useState('')
  const versionRef = useRef(0)

  // Pull only what's newer than what we already hold, then append it.
  const pull = useCallback(async () => {
    try {
      const res = await api(`groups/${groupId}/events?since=${versionRef.current}`)
      if (res.events.length) {
        versionRef.current = res.version
        setVersion(res.version)
        setEvents((prev) => [...prev, ...res.events])
      }
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

  // Append a create or update event; an edit reuses the expense's stable id
  // so the fold treats it as the latest revision of the same expense.
  async function submitExpense(payload, isEdit) {
    await api(`groups/${groupId}/events`, {
      event_id: crypto.randomUUID(),
      type: isEdit ? 'expense.updated' : 'expense.created',
      payload,
    })
    setEditing(null)
    await pull()
  }

  // Soft delete / restore is just another revision with the flag flipped.
  async function setDeleted(x, deleted) {
    try {
      await api(`groups/${groupId}/events`, {
        event_id: crypto.randomUUID(),
        type: 'expense.updated',
        payload: {
          expense_id: x.expense_id,
          description: x.description,
          amount_cents: x.amount_cents,
          payers: x.payers,
          splits: x.splits,
          date: x.date,
          category: x.category,
          deleted,
          updated_at: Date.now(),
        },
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
      await api(`groups/${groupId}/events`, {
        event_id: crypto.randomUUID(),
        type: isEdit ? 'settlement.updated' : 'settlement.created',
        payload: { ...payload, updated_at: Date.now() },
      })
      await pull()
    } catch (err) {
      setError(err.message)
      throw err
    }
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
      await api(`groups/${groupId}/events`, {
        event_id: crypto.randomUUID(),
        type: isEdit ? 'comment.updated' : 'comment.created',
        payload: { ...payload, updated_at: Date.now() },
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

  return (
    <section>
      <button className="link" onClick={onBack}>
        ← groups
      </button>
      <h2>{meta.name}</h2>
      <p className="muted">
        Invite code: <code>{meta.code}</code> · synced v{version}
      </p>

      <h3>Balances</h3>
      <ul className="list">
        {state.balances.map((b) => (
          <li key={b.user_id} className="row static">
            <span>{b.username}</span>
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

      {state.members.length > 0 && (
        <ExpenseForm
          key={editing?.expense_id || 'new'}
          members={state.members}
          me={me}
          ai={ai}
          initial={editing}
          onSubmit={submitExpense}
          onCancel={() => setEditing(null)}
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
          expense={viewing}
          members={state.members}
          meId={meId}
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
function ExpenseDetail({ expense, members, meId, onClose, onPost, onEdit, onDelete }) {
  const nameById = Object.fromEntries(members.map((m) => [m.id, m.username]))
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
                const adj = expense.amount_cents - sub
                return (
                  <p className="muted">
                    items {money(sub)} · {adj >= 0 ? 'tax/tip' : 'discount'}{' '}
                    {money(Math.abs(adj))}
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
  const mine = members.find((m) => m.username === me.username)
  return (mine || members[0])?.id
}

// Line items with per-person claims. Claim an item and it splits between its
// claimants; leave it unclaimed and it splits among everyone on the receipt.
function ReceiptEditor({ items, setItems, participants }) {
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
      <legend>items (unclaimed ones split among everyone)</legend>
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
          <div className="claims">
            {participants.map((m) => (
              <label key={m.id} className="check">
                <input
                  type="checkbox"
                  checked={it.claimed_by.includes(m.id)}
                  onChange={() => toggleClaim(idx, m.id)}
                />
                {m.username}
              </label>
            ))}
          </div>
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

function ExpenseForm({ members, me, ai, initial, onSubmit, onCancel }) {
  const [scanning, setScanning] = useState(false)
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

  // Scanned output is a *draft*: it fills the editable rows so the user can
  // fix OCR mistakes before anything is saved.
  async function scan(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const config = ai?.providers?.[ai.active]
    if (!config) return
    setScanning(true)
    setError('')
    try {
      const result = await extractReceipt({
        provider: ai.active,
        apiKey: config.api_key,
        model: config.model,
        file,
      })
      setItems(
        result.items.map((it) => ({
          id: crypto.randomUUID(),
          name: it.name,
          price: (it.price_cents / 100).toFixed(2),
          claimed_by: [],
        }))
      )
      setAmount((result.total_cents / 100).toFixed(2))
    } catch (err) {
      setError(err.message)
    } finally {
      setScanning(false)
    }
  }

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
      split = { mode: 'items', participants, items: parsed }
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
  const amountCents = Math.round(parseFloat(amount) * 100) || 0
  const itemsTotalCents = items.reduce(
    (t, it) => t + (Math.round(parseFloat(it.price) * 100) || 0),
    0
  )
  const adjustment = amountCents - itemsTotalCents

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
              {m.username}
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
              {m.username}
            </label>
          ))}
        </fieldset>
      )}

      {mode === 'items' && (
        <>
          {ai?.active && (
            <label className="scan">
              {scanning
                ? 'scanning…'
                : `📷 scan receipt with ${PROVIDERS[ai.active]?.label ?? ai.active}`}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                disabled={scanning}
                onChange={scan}
              />
            </label>
          )}
          <ReceiptEditor
            items={items}
            setItems={setItems}
            participants={members.filter((m) => !excluded.includes(m.id))}
          />
          {itemsTotalCents > 0 && (
            <p className="muted">
              items {money(itemsTotalCents)} ·{' '}
              {adjustment >= 0 ? 'tax/tip' : 'discount'}{' '}
              {money(Math.abs(adjustment))} · total {money(amountCents)}
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
              {m.username}
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
