// Sharing a group: the invite link (join, optionally claiming a member) and the
// opt-in read-only link.

import { useCallback, useEffect, useState } from 'react'

import { api } from '../api'
import { groupKey } from '../groupkeys'
import { buildInviteLink } from '../invite'
import { buildViewLink } from '../viewlink'

// The link carries the group key in its fragment, so it is a secret in a way
// the old invite code was not.
// Inviting someone is inviting them to *be* a particular member. If they are
// not in the group yet, a ghost is created for them first, so people can start
// splitting with them before they accept. See plan/12.
// Turn on an opt-in read-only link, and hand it out. The link carries the group
// key (from this device) in its fragment and a server-issued read token; the
// join code rides along so an account-holder opening it can also join. See
// viewlink.js and plan/14.
export function ShareReadOnly({ groupId, code }) {
  const [token, setToken] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  const buildLink = useCallback(
    async (rt) => {
      if (!rt) return setLink('')
      const key = await groupKey(groupId)
      setLink(
        key
          ? buildViewLink(window.location.origin, {
              groupId,
              gk: key,
              readToken: rt,
              code,
            })
          : ''
      )
    },
    [groupId, code]
  )

  useEffect(() => {
    api(`groups/${groupId}/read-sharing`)
      .then((r) => {
        setToken(r.read_token)
        return buildLink(r.read_token)
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [groupId, buildLink])

  async function setSharing(enabled, rotate = false) {
    setBusy(true)
    setError('')
    setCopied(false)
    try {
      const r = await api(`groups/${groupId}/read-sharing`, { enabled, rotate })
      setToken(r.read_token)
      await buildLink(r.read_token)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (!loaded) return null

  return (
    <div>
      <h4>Read-only link</h4>
      {token ? (
        <>
          <p className="muted">
            Anyone with this link can see the group without an account. People
            with an account can also join from it. Turning it off stops new
            views — it can&rsquo;t un-share what someone already saw.
          </p>
          {link && (
            <input
              className="invite"
              readOnly
              value={link}
              onFocus={(e) => e.target.select()}
            />
          )}
          <div className="row-actions">
            <button className="link" onClick={copy} disabled={!link}>
              {copied ? 'copied' : 'copy'}
            </button>
            <button
              className="link"
              onClick={() => setSharing(true, true)}
              disabled={busy}
            >
              new link
            </button>
            <button
              className="link danger"
              onClick={() => setSharing(false)}
              disabled={busy}
            >
              turn off
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            Off. A read-only link lets people see this group without an account.
          </p>
          <button onClick={() => setSharing(true)} disabled={busy}>
            Create read-only link
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

export function InviteLink({ groupId, code, members, onAddGhost }) {
  const [link, setLink] = useState('')
  const [forMember, setForMember] = useState(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  const show = async (memberId, label) => {
    const key = await groupKey(groupId)
    if (!key) return
    setForMember(label)
    setLink(buildInviteLink(window.location.origin, code, key, memberId))
    setCopied(false)
  }

  async function inviteSomeoneNew(e) {
    e.preventDefault()
    setError('')
    if (!name.trim()) return setError('Give them a name')
    setBusy(true)
    try {
      // The ghost exists from this moment, so the group can split with them
      // whether or not they ever accept.
      const memberId = await onAddGhost(name.trim())
      await show(memberId, name.trim())
      setName('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const ghosts = (members ?? []).filter((m) => m.ghost)

  return (
    <div>
      <form onSubmit={inviteSomeoneNew}>
        <h4>Invite someone</h4>
        <input
          placeholder="their name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'working…' : 'Create their invite'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>

      {ghosts.length > 0 && (
        <p className="muted">
          Or invite someone already in the split:{' '}
          {ghosts.map((m) => (
            <button
              key={m.id}
              className="link"
              onClick={() => show(m.id, m.display_name)}
            >
              {m.display_name}
            </button>
          ))}
        </p>
      )}

      {link && (
        <div>
          <p className="muted">
            This link makes whoever opens it <strong>{forMember}</strong>, and
            hands over the group key. It works once. Send it somewhere private.
          </p>
          <input
            className="invite"
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
          />
          <button className="link" onClick={copy}>
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
      )}
    </div>
  )
}
