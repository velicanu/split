// The list of your groups, plus create/join. Local-first: the server list is
// authoritative online, cached names show it offline.

import { useCallback, useEffect, useState } from 'react'

import { api } from '../api'
import { createGroupKey } from '../groupkeys'
import { parseInvite } from '../invite'
import { localGroups, setMeta as setLocalMeta } from '../store'
import { acceptInvite } from '../join'

export function GroupList({ onOpen }) {
  const [groups, setGroups] = useState(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  // Local-first, like a group's own page. The server list is authoritative
  // when reachable — it knows member counts and which groups you have hidden —
  // and every entry is cached on the way through, so with no network the list
  // is still whatever this device last saw rather than a blank page. plan/04.
  const load = useCallback(async () => {
    try {
      const fresh = await api('groups')
      setGroups(fresh)
      for (const g of fresh) {
        await setLocalMeta(g.id, { name: g.name, members: g.members })
      }
    } catch {
      // Offline. Show the groups this device already knows the name of; a row
      // with no name is one we hold events for but have never opened, and has
      // nothing to show yet.
      const local = await localGroups()
      setGroups(local.filter((g) => g.name))
    }
  }, [])
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
                {typeof g.members === 'number'
                  ? `${g.members} member${g.members === 1 ? '' : 's'}`
                  : 'offline'}
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
            placeholder="paste invite link"
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
