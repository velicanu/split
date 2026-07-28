// The home screen: a total-balance hero across all your groups, then the groups
// themselves — each showing where you stand in it — plus create/join. Local
// first, like a group's own page: the server list is authoritative online,
// cached names show it offline, and every balance is folded from the local
// ledger (overview.js), so the server never sees a number. plan/04, plan/18.

import { useCallback, useEffect, useState } from 'react'

import { api } from '../api'
import { money } from '../format'
import { createGroupKey } from '../groupkeys'
import { parseInvite } from '../invite'
import { acceptInvite } from '../join'
import { loadOverviews, netLabel, totalNet } from '../overview'
import { localGroups, setMeta as setLocalMeta } from '../store'

export function GroupList({ me, onOpen, onNewBill }) {
  const [overviews, setOverviews] = useState(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    let groups
    try {
      groups = await api('groups')
      for (const g of groups) {
        await setLocalMeta(g.id, { name: g.name, members: g.members })
      }
    } catch {
      // Offline: the groups this device already knows a name for.
      groups = (await localGroups()).filter((g) => g.name)
    }
    setOverviews(await loadOverviews(groups, me))
  }, [me])
  useEffect(() => {
    load()
  }, [load])

  async function create(e) {
    e.preventDefault()
    setError('')
    try {
      const g = await api('groups', { name })
      // Mint the key before anything can be written, so there is never a
      // window where an event would have nothing to encrypt under.
      await createGroupKey(g.id)
      setName('')
      onOpen(g.id)
    } catch (err) {
      setError(err.message)
    }
  }

  async function join(e) {
    e.preventDefault()
    setError('')
    const invite = parseInvite(code.trim())
    if (!invite) {
      return setError('Paste the whole invite link — it carries the group key')
    }
    try {
      const g = await acceptInvite(invite)
      setCode('')
      onOpen(g.id)
    } catch (err) {
      setError(err.message)
    }
  }

  if (!overviews) return null

  const total = totalNet(overviews)
  const totalTone = total === 0 ? 'muted' : total > 0 ? 'pos' : 'neg'

  return (
    <section>
      <h1 className="screen-title">Split</h1>

      <div className={`card hero ${total < 0 ? 'owe' : total > 0 ? 'owed' : ''}`}>
        <span className="muted">Total balance</span>
        <strong className={`hero-amt ${totalTone}`}>{money(total)}</strong>
        <span className="muted">
          {total === 0
            ? 'all settled up'
            : total > 0
              ? "you're owed across all groups"
              : 'you owe across all groups'}
        </span>
      </div>

      <h3 className="section-title">Groups</h3>
      {overviews.length === 0 && (
        <p className="muted">No groups yet — create or join one below.</p>
      )}
      <ul className="list">
        {overviews.map((o) => {
          const label = o.state ? netLabel(o.myNet) : { text: 'offline', tone: 'muted' }
          return (
            <li key={o.id}>
              <button className="row gitem" onClick={() => onOpen(o.id)}>
                <span className="shape" aria-hidden="true">
                  👥
                </span>
                <span className="gitem-main">
                  <span className="title">{o.name}</span>
                  <span className="sub muted">
                    {typeof o.members === 'number'
                      ? `${o.members} member${o.members === 1 ? '' : 's'}`
                      : 'offline'}
                  </span>
                </span>
                <span className={`amt ${label.tone}`}>{label.text}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="cols">
        <form onSubmit={create}>
          <h3 className="section-title">Create a group</h3>
          <input
            placeholder="group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit">+ New group</button>
        </form>
        <form onSubmit={join}>
          <h3 className="section-title">Join a group</h3>
          <input
            placeholder="paste invite link"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="tonal" type="submit">
            Join
          </button>
        </form>
      </div>
      {onNewBill && (
        <p className="center">
          <button className="link" onClick={onNewBill}>
            or split a one-off bill
          </button>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
