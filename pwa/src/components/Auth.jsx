// The front door: three equally-weighted pages — Sign in, Sign up, Pair — with
// the methods laid out as peers rather than a primary plus hidden links. Sign in
// offers passkey / password / recovery code, in that order; sign up offers
// passkey / password (a recovery code is minted automatically). The 3-way nav is
// invariant in order and layout, top and bottom, with the current page grayed.
// See plan/16, plan/17.

import { useState } from 'react'

import {
  enrol,
  enrolWithPasskey,
  enrolWithRecovery,
  signup,
  signupWithPasskey,
} from '../auth'
import { passkeySupported } from '../webauthn'
import { PairNewDevice } from './PairNewDevice'

const PAGES = [
  ['signin', 'Sign in'],
  ['signup', 'Sign up'],
  ['pair', 'Pair'],
]

export function Auth({ onAuth }) {
  const [page, setPage] = useState('signin')
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // After signup: the recovery code to show once, and the user to hand back.
  const [recovery, setRecovery] = useState(null)

  const go = (id) => {
    setError('')
    setPage(id)
  }

  // Wrap a method: require the handle, manage busy/error, surface failures.
  const run = (fn) => async (e) => {
    e?.preventDefault?.()
    setError('')
    if (!handle.trim()) return setError('Enter your handle')
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const signupArgs = () => ({
    login_handle: handle.trim(),
    display_name: displayName.trim() || handle.trim(),
  })
  const afterSignup = ({ recoveryCode, ...me }) => setRecovery({ code: recoveryCode, me })

  const withPasskey = run(async () => onAuth(await enrolWithPasskey({ login_handle: handle.trim() })))
  const withPassword = run(async () => {
    if (!password) return setError('Enter your password')
    onAuth(await enrol({ login_handle: handle.trim(), password }))
  })
  const withRecovery = run(async () => {
    if (!code.trim()) return setError('Enter your recovery code')
    onAuth(await enrolWithRecovery({ login_handle: handle.trim(), code }))
  })
  const signupPasskey = run(async () => afterSignup(await signupWithPasskey(signupArgs())))
  const signupPassword = run(async () => {
    if (!password) return setError('Enter a password')
    afterSignup(await signup({ ...signupArgs(), password }))
  })

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(recovery.code)
    } catch {
      // no clipboard — the code is on screen to copy by hand
    }
  }

  // Shown once, right after signup. The server never held the code, so there is
  // no second chance to show it.
  if (recovery) {
    return (
      <main>
        <h1>Save your recovery code</h1>
        <p className="muted">
          This is the one way back into your account if you lose your other
          sign-in methods and your devices. Write it down or put it in a password
          manager — we can&rsquo;t show it again, and nobody can reset it for you.
        </p>
        <input
          className="invite"
          readOnly
          value={recovery.code}
          onFocus={(e) => e.target.select()}
        />
        <div className="row-actions">
          <button className="link" onClick={copyCode}>
            copy
          </button>
          <button onClick={() => onAuth(recovery.me)}>I&rsquo;ve saved it</button>
        </div>
      </main>
    )
  }

  const tabs = (
    <div className="segmented">
      {PAGES.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={page === id ? 'active' : ''}
          disabled={page === id}
          onClick={() => go(id)}
        >
          {label}
        </button>
      ))}
    </div>
  )
  const links = (
    <p className="authnav muted">
      {PAGES.map(([id, label], i) => (
        <span key={id}>
          {i > 0 && ' · '}
          {page === id ? (
            <span className="current">{label}</span>
          ) : (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                go(id)
              }}
            >
              {label}
            </a>
          )}
        </span>
      ))}
    </p>
  )

  return (
    <main>
      <h1>Split</h1>
      {tabs}

      {page === 'pair' ? (
        <PairNewDevice onPaired={onAuth} onCancel={() => go('signin')} />
      ) : (
        <>
          <input
            placeholder="handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            autoComplete="username"
          />
          {page === 'signup' && (
            <input
              placeholder="display name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}

          <div className="methods">
            {passkeySupported() && (
              <div className="method">
                <button
                  type="button"
                  onClick={page === 'signin' ? withPasskey : signupPasskey}
                  disabled={busy}
                >
                  {page === 'signin' ? 'Sign in with a passkey' : 'Sign up with a passkey'}
                </button>
              </div>
            )}
            <form className="method" onSubmit={page === 'signin' ? withPassword : signupPassword}>
              <input
                type="password"
                placeholder="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={page === 'signin' ? 'current-password' : 'new-password'}
              />
              <button disabled={busy}>
                {page === 'signin' ? 'Sign in with password' : 'Sign up with password'}
              </button>
            </form>
            {page === 'signin' && (
              <form className="method" onSubmit={withRecovery}>
                <input
                  placeholder="recovery code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                />
                <button disabled={busy}>Sign in with recovery code</button>
              </form>
            )}
          </div>

          {page === 'signup' && (
            <p className="muted">
              A recovery code is created for you and shown once after you sign up.
            </p>
          )}
        </>
      )}

      {error && <p className="error">{error}</p>}
      <p className="muted">
        Your secrets never leave this device — they unlock your keys here, so
        nobody can reset them for you.
      </p>
      {links}
    </main>
  )
}
