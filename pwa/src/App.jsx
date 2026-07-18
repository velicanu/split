import { useEffect, useState } from 'react'

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

export default function App() {
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
  const [group, setGroup] = useState(null)
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [paidBy, setPaidBy] = useState('')
  const [error, setError] = useState('')

  const load = () =>
    api(`groups/${groupId}`)
      .then((g) => {
        setGroup(g)
        const mine = g.members.find((m) => m.username === me.username)
        setPaidBy(String((mine || g.members[0]).id))
      })
      .catch((e) => setError(e.message))
  useEffect(() => {
    load()
  }, [groupId])

  async function addExpense(e) {
    e.preventDefault()
    setError('')
    const cents = Math.round(parseFloat(amount) * 100)
    if (!description.trim() || !cents || cents <= 0) {
      setError('Enter a description and a positive amount')
      return
    }
    try {
      await api(`groups/${groupId}/expenses`, {
        description,
        amount_cents: cents,
        paid_by: Number(paidBy),
      })
      setDescription('')
      setAmount('')
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  if (!group) return null

  return (
    <section>
      <button className="link" onClick={onBack}>
        ← groups
      </button>
      <h2>{group.name}</h2>
      <p className="muted">
        Invite code: <code>{group.code}</code>
      </p>

      <h3>Balances</h3>
      <ul className="list">
        {group.balances.map((b) => (
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

      <form onSubmit={addExpense}>
        <h3>Add an expense</h3>
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
          paid by
          <select value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
            {group.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.username}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Add expense</button>
      </form>

      <h3>Ledger</h3>
      {group.expenses.length === 0 && <p className="muted">No expenses yet.</p>}
      <ul className="list">
        {group.expenses.map((e) => (
          <li key={e.id} className="row static">
            <span>{e.description}</span>
            <span className="muted">
              {e.paid_by_name} paid {money(e.amount_cents)}
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </section>
  )
}
