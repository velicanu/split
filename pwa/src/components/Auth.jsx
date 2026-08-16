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

// Drawn rather than set in type: the eye emoji renders as a full-colour eyeball
// on most platforms, which is loud next to a monochrome glass field, and there
// is no struck-through eye in Unicode to pair it with. Strokes take their
// colour from the button, so it follows the theme for free.
function Eye({ off }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.75" />
      {off && <path d="M4 20 20 4" />}
    </svg>
  )
}

export function Auth({ onAuth }) {
  const [page, setPage] = useState('signin')
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  // Off on arrival, always: a revealed password is for checking a typo, not a
  // state worth remembering.
  const [revealed, setRevealed] = useState(false)
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
  return (
    <main>
      <h1 className="wordmark">Split</h1>
      {tabs}

      {page === 'pair' ? (
        <PairNewDevice onPaired={onAuth} onCancel={() => go('signin')} />
      ) : (
        <>
          <div className="fields">
            <input
              placeholder="handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              autoComplete="username"
              autoFocus
            />
            {/* Always in the layout so the method cards below don't shift between
                sign in and sign up; only shown (and reachable) on sign up. */}
            <input
              className={page === 'signup' ? undefined : 'invisible'}
              placeholder="display name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              aria-hidden={page !== 'signup'}
              tabIndex={page === 'signup' ? undefined : -1}
            />
          </div>

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
                <span className="muted">
                  {page === 'signin'
                    ? 'Nothing to type — your device unlocks it.'
                    : 'No password to set — your device holds the key.'}
                </span>
              </div>
            )}
            <form className="method" onSubmit={page === 'signin' ? withPassword : signupPassword}>
              <div className="password-field">
                <input
                  type={revealed ? 'text' : 'password'}
                  placeholder="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={page === 'signin' ? 'current-password' : 'new-password'}
                />
                {/* type="button", or it would submit the form it sits in — the
                    one thing a reveal toggle must never do with a half-typed
                    password. */}
                <button
                  type="button"
                  className="reveal"
                  onClick={() => setRevealed((on) => !on)}
                  aria-label={revealed ? 'Hide password' : 'Show password'}
                  aria-pressed={revealed}
                >
                  <Eye off={revealed} />
                </button>
              </div>
              <button className="tonal" disabled={busy}>
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
                <button className="tonal" disabled={busy}>
                  Sign in with recovery code
                </button>
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
    </main>
  )
}
