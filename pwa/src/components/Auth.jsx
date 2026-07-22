// Sign in or sign up. The three ways a browser gets a session all resolve to a
// device key that can sign the server's challenge (auth.js).

import { useState } from 'react'

import { enrol, signup } from '../auth'

// No password ever reaches the server. Signing up mints an account key and a
// device key; signing in on a *new* device unwraps the account key locally and
// uses it to authorise a fresh device key. See plan/11.
export function Auth({ onAuth }) {
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
