// Sign in or sign up. Every path resolves to a device key that can sign the
// server's challenge (auth.js): a password, or — on a fresh device — a recovery
// code. Signing up mints the account key and shows a recovery code once. See
// plan/11, plan/16.

import { useState } from 'react'

import { enrol, enrolWithPasskey, enrolWithRecovery, signup } from '../auth'
import { passkeySupported } from '../webauthn'

export function Auth({ onAuth }) {
  const [mode, setMode] = useState('signin')
  // On a fresh device you can sign in with the password or a recovery code.
  const [method, setMethod] = useState('password')
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // After signup: the code to show once, and the user to hand back once it's
  // acknowledged.
  const [recovery, setRecovery] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!handle.trim()) return setError('Enter your handle')
    setBusy(true)
    try {
      if (mode === 'signup') {
        if (!password) return setError('Enter a password')
        const { recoveryCode, ...me } = await signup({
          login_handle: handle.trim(),
          display_name: displayName.trim() || handle.trim(),
          password,
        })
        setRecovery({ code: recoveryCode, me })
      } else if (method === 'recovery') {
        if (!code.trim()) return setError('Enter your recovery code')
        onAuth(await enrolWithRecovery({ login_handle: handle.trim(), code }))
      } else {
        if (!password) return setError('Enter your password')
        onAuth(await enrol({ login_handle: handle.trim(), password }))
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function usePasskey() {
    setError('')
    if (!handle.trim()) return setError('Enter your handle first')
    setBusy(true)
    try {
      onAuth(await enrolWithPasskey({ login_handle: handle.trim() }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(recovery.code)
    } catch {
      // no clipboard — the code is on screen to copy by hand
    }
  }

  // Shown once, right after signup. There is no second chance: the server never
  // held the code, so it cannot show it again.
  if (recovery) {
    return (
      <main>
        <h1>Save your recovery code</h1>
        <p className="muted">
          This is the one way back into your account if you forget your password
          and lose your devices. Write it down or put it in a password manager —
          we can&rsquo;t show it again, and nobody can reset it for you.
        </p>
        <input className="invite" readOnly value={recovery.code} onFocus={(e) => e.target.select()} />
        <div className="row-actions">
          <button className="link" onClick={copyCode}>
            copy
          </button>
          <button onClick={() => onAuth(recovery.me)}>I&rsquo;ve saved it</button>
        </div>
      </main>
    )
  }

  const recoveryMode = mode === 'signin' && method === 'recovery'

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
        {recoveryMode ? (
          <input
            placeholder="recovery code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
          />
        ) : (
          <input
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />
        )}
        <button type="submit" disabled={busy}>
          {busy
            ? 'working…'
            : mode === 'signup'
              ? 'Sign up'
              : 'Sign in on this device'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      {mode === 'signin' && (
        <p className="muted">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              setError('')
              setMethod(method === 'recovery' ? 'password' : 'recovery')
            }}
          >
            {recoveryMode ? 'Use your password instead' : 'Use a recovery code instead'}
          </a>
          {passkeySupported() && (
            <>
              {' · '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  usePasskey()
                }}
              >
                Use a passkey
              </a>
            </>
          )}
        </p>
      )}
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
            setMethod('password')
            setMode(mode === 'signup' ? 'signin' : 'signup')
          }}
        >
          {mode === 'signup' ? 'Sign in' : 'Sign up'}
        </a>
      </p>
    </main>
  )
}
