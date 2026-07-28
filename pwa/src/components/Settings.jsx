// The settings screen: appearance (theme), receipt-scanning provider keys, and
// account management (password, devices).

import { useCallback, useEffect, useState } from 'react'

import { PROVIDERS } from '../ai'
import { api } from '../api'
import { saveApiKey } from '../aikeys'
import {
  addPasskey,
  addPasswordWrap,
  addRecoveryWrap,
  changePassword,
  listWraps,
  removeWrap,
  unlockWithPasskey,
  unlockWithPassword,
  unlockWithRecovery,
} from '../auth'
import { passkeySupported } from '../webauthn'
import { loadTheme, setTheme } from '../theme'

// Light, dark, or follow the system — a device preference (theme.js). The
// initial paint is themed by an inline script in index.html; this only changes
// it live.
export function ThemeToggle() {
  const [theme, setThemeState] = useState(loadTheme)
  return (
    <label className="field">
      Theme
      <select
        value={theme}
        onChange={(e) => setThemeState(setTheme(e.target.value))}
      >
        <option value="system">System default</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  )
}

const maskKey = (key) => `…${String(key).slice(-4)}`

// Provider settings. There is no default provider — with no keys the scanning
// feature simply doesn't exist. Adding a key (or switching) makes it active.
export function Settings({ ai, user, onChanged, onPair, onLogout, onClose }) {
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
      <h1 className="screen-title">Settings</h1>

      <div className="row static profile">
        <span className="shape" aria-hidden="true">
          🙂
        </span>
        <span className="gitem-main">
          <span className="title">{user.display_name}</span>
          <span className="sub muted">@{user.login_handle}</span>
        </span>
      </div>

      <h2>Appearance</h2>
      <ThemeToggle />

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
      <SignInMethods user={user} />
      <PasswordForm user={user} />
      <Devices onPair={onPair} />

      {onLogout && (
        <button className="tonal danger sign-out" onClick={onLogout}>
          Sign out
        </button>
      )}
    </section>
  )
}

// The ways back into this account: the password, a recovery code, and any
// passkeys. Adding one needs the account key, which this device never holds, so
// each add unlocks it fresh — with *any* method the account still has, not only
// the password. That is what stops "add a passkey, then remove the password"
// from being a dead end. The server always keeps at least one method. See
// plan/16.
const WRAP_LABEL = {
  password: 'Password',
  recovery: 'Recovery code',
}
const labelFor = (w) =>
  WRAP_LABEL[w.method] ?? (JSON.parse(w.params || '{}').label || 'Passkey')

const ADD_VERB = {
  passkey: 'add a passkey',
  recovery: 'make a recovery code',
  password: 'set a password',
}

function SignInMethods({ user }) {
  const [wraps, setWraps] = useState(null)
  // Which add is in flight ('passkey' | 'recovery' | 'password').
  const [adding, setAdding] = useState(null)
  // The secret used to unlock the account key, for whichever method we have.
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  // For adding/replacing the password.
  const [newPassword, setNewPassword] = useState('')
  const [newCode, setNewCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    listWraps(user.login_handle)
      .then(setWraps)
      .catch(() => setWraps([]))
  }, [user.login_handle])
  useEffect(load, [load])

  function start(kind) {
    setError('')
    setNewCode('')
    setPassword('')
    setCode('')
    setNewPassword('')
    setAdding(kind)
  }

  const has = (m) => (wraps || []).some((w) => w.method === m)
  // Unlock with whatever the account still has. Password is simplest when it's
  // there; otherwise a passkey or the recovery code.
  const unlockVia = has('password') ? 'password' : has('passkey') ? 'passkey' : 'recovery'

  async function unlock() {
    const login_handle = user.login_handle
    if (unlockVia === 'password') return unlockWithPassword({ login_handle, password })
    if (unlockVia === 'passkey') return unlockWithPasskey({ login_handle })
    return unlockWithRecovery({ login_handle, code })
  }

  async function confirmAdd(e) {
    e.preventDefault()
    setError('')
    if (adding === 'password' && !newPassword) return setError('Enter a password')
    setBusy(true)
    try {
      const account = await unlock()
      if (adding === 'recovery') setNewCode(await addRecoveryWrap(account))
      else if (adding === 'password') await addPasswordWrap(account, newPassword)
      else await addPasskey(account, { userId: user.id, userName: user.login_handle })
      start(null)
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    setError('')
    try {
      await removeWrap(id)
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  if (wraps === null) return null

  return (
    <div>
      <h3>Sign-in methods</h3>
      <ul className="list">
        {wraps.map((w) => (
          <li key={w.id} className="row static">
            <span>{labelFor(w)}</span>
            {wraps.length > 1 && (
              <button className="link danger" onClick={() => remove(w.id)}>
                remove
              </button>
            )}
          </li>
        ))}
      </ul>

      {newCode && (
        <p className="muted">
          Your new recovery code — save it now, it won&rsquo;t be shown again:
          <br />
          <strong>{newCode}</strong>
        </p>
      )}

      {adding ? (
        <form onSubmit={confirmAdd}>
          {/* Unlock the account key with a method you have, then the new one is
              added. Passkey unlock needs no field — it prompts on confirm. */}
          {unlockVia === 'password' ? (
            <>
              <p className="muted">Enter your password to {ADD_VERB[adding]}.</p>
              <input
                type="password"
                placeholder="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          ) : unlockVia === 'recovery' ? (
            <>
              <p className="muted">Enter your recovery code to {ADD_VERB[adding]}.</p>
              <input
                placeholder="recovery code"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </>
          ) : (
            <p className="muted">
              Confirm with your passkey to {ADD_VERB[adding]}.
            </p>
          )}

          {adding === 'password' && (
            <input
              type="password"
              placeholder="new password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          )}

          <div className="row-actions">
            <button type="submit" disabled={busy}>
              {busy ? 'working…' : 'Confirm'}
            </button>
            <button type="button" className="link" onClick={() => setAdding(null)}>
              cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="row-actions">
          {passkeySupported() && (
            <button className="link" onClick={() => start('passkey')}>
              Add a passkey
            </button>
          )}
          <button className="link" onClick={() => start('recovery')}>
            {has('recovery') ? 'Replace recovery code' : 'Create recovery code'}
          </button>
          {!has('password') && (
            <button className="link" onClick={() => start('password')}>
              Set a password
            </button>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
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
function Devices({ onPair }) {
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

  return (
    <section>
      <h3>Devices</h3>
      {onPair && (
        <div className="row-actions">
          <button onClick={onPair}>Pair a new device</button>
        </div>
      )}
      <p className="muted">
        Lost a device? Revoke it here and it loses access immediately, and
        drops off this list. It keeps anything it had already downloaded —
        that can&rsquo;t be undone.
      </p>
      {devices === null && <p className="muted">Loading…</p>}
      <ul className="list">
        {(devices || []).map((d) => (
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
