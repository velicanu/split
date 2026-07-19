import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { computeState, simplify, splitByWeights, splitEqually } from './ledger'

async function api(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: body ? 'POST' : 'GET',
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

  async function logout() {
    await api('logout', {})
    onLogout()
  }

  return (
    <main className="app">
      <header>
        <strong className="brand" onClick={() => setGroupId(null)}>
          Split
        </strong>
        <span className="spacer" />
        <span className="muted">{user.username}</span>
        <button className="link" onClick={logout}>
          Log out
        </button>
      </header>
      {groupId ? (
        <GroupView groupId={groupId} me={user} onBack={() => setGroupId(null)} />
      ) : (
        <GroupList onOpen={setGroupId} />
      )}
    </main>
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

function GroupView({ groupId, me, onBack }) {
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

function ExpenseForm({ members, me, initial, onSubmit, onCancel }) {
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
  // members left OUT of the split (so members who join later default to "in")
  const [excluded, setExcluded] = useState(() => {
    if (!initial) return []
    const inSplit = initial.splits.map((s) => s.user_id)
    return members.map((m) => m.id).filter((id) => !inSplit.includes(id))
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
        </select>
      </label>

      {mode === 'equal' ? (
        <fieldset className="participants">
          <legend>split between</legend>
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
      ) : (
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
