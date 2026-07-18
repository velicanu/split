import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { computeState, splitEqually } from './ledger'

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
    api(`groups/${groupId}`)
      .then(setMeta)
      .catch((e) => setError(e.message))
    pull()
    const timer = setInterval(pull, 5000)
    return () => clearInterval(timer)
  }, [groupId, pull])

  // Everything displayed is folded from the ledger, client-side.
  const state = useMemo(() => computeState(events), [events])

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
          <li key={x.expense_id} className="row static">
            <div className="expense">
              <span>{x.description}</span>
              <span className="muted">
                {x.payer_names.join(', ')} paid {money(x.amount_cents)} · split{' '}
                {x.ways} way{x.ways === 1 ? '' : 's'}
                {x.date ? ` · ${x.date}` : ''}
                {x.category ? ` · ${x.category}` : ''}
              </span>
            </div>
            <button className="link" onClick={() => setEditing(x)}>
              edit
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function memberIdFor(members, me) {
  const mine = members.find((m) => m.username === me.username)
  return (mine || members[0])?.id
}

function ExpenseForm({ members, me, initial, onSubmit, onCancel }) {
  const today = new Date().toISOString().slice(0, 10)
  const [description, setDescription] = useState(initial?.description ?? '')
  const [amount, setAmount] = useState(
    initial ? (initial.amount_cents / 100).toFixed(2) : ''
  )
  const [date, setDate] = useState(initial?.date || today)
  const [category, setCategory] = useState(initial?.category ?? '')
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

    const participants = members
      .map((m) => m.id)
      .filter((id) => !excluded.includes(id))
    if (!participants.length) {
      return setError('Pick at least one person to split between')
    }
    const shares = splitEqually(cents, participants)
    const splits = participants.map((uid) => ({
      user_id: uid,
      share_cents: shares[uid],
    }))

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
          date,
          category: category.trim(),
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
