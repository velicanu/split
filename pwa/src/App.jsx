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

export default function App() {
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(true)
  const [mode, setMode] = useState('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    api('me')
      .then(setUser)
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [])

  async function submit(e) {
    e.preventDefault()
    setError('')
    try {
      setUser(await api(mode, { username, password }))
      setPassword('')
    } catch (err) {
      setError(err.message)
    }
  }

  async function logout() {
    await api('logout', {})
    setUser(null)
    setUsername('')
  }

  if (checking) return null

  if (user) {
    return (
      <main>
        <h1>Hello, {user.username}!</h1>
        <button onClick={logout}>Log out</button>
      </main>
    )
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
