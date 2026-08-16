// Membership controls that aren't invites: turning a member (or yourself) into a
// ghost, and adding a ghost for someone not using the app.

import { useState } from 'react'

// The name a row was written under, when the person it now belongs to goes by
// something else. Shown beside the current name rather than instead of it:
// claiming a ghost is meant to be a visible act (plan/12), and a history that
// silently relabels itself is the one thing that would hide it.
export function Formerly({ names }) {
  if (!names?.length) return null
  return <span className="muted"> (as {names.join(', ')})</span>
}

// Leaving, and tidying away someone who has stopped using the app. The same
// act either way: they become a ghost, their balances untouched.
export function LeaveOrGhost({ members, meId, onGhost }) {
  const [confirming, setConfirming] = useState(null)
  const [error, setError] = useState('')

  const others = members.filter((m) => !m.ghost && m.id !== meId)

  async function go(id) {
    setError('')
    try {
      await onGhost(id)
    } catch (err) {
      setError(err.message)
      setConfirming(null)
    }
  }

  if (confirming) {
    const mine = confirming.id === meId
    return (
      <section>
        <p className="error">
          {mine
            ? 'Leave this group? You keep it exactly as it stands now, but you won’t see anything the group does after this.'
            : `Make ${confirming.display_name} a ghost? They keep everything up to now, and stop seeing the group after this. Their balances don’t change.`}
        </p>
        <div className="row-actions">
          <button onClick={() => go(confirming.id)}>
            {mine ? 'Leave' : `Yes, ghost ${confirming.display_name}`}
          </button>
          <button className="link" onClick={() => setConfirming(null)}>
            cancel
          </button>
        </div>
      </section>
    )
  }

  return (
    <section>
      <div className="row-actions">
        {meId !== null && (
          <button
            className="link danger"
            onClick={() =>
              setConfirming(members.find((m) => m.id === meId) ?? { id: meId })
            }
          >
            leave this group
          </button>
        )}
        {others.map((m) => (
          <button
            key={m.id}
            className="link"
            onClick={() => setConfirming(m)}
          >
            ghost {m.display_name}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  )
}

// Fixing a ghost's name. Anyone in the group may do it, for the same reason
// anyone may add one or ghost anyone: a ghost has nobody to speak for them, and
// a typo in a name is otherwise permanent. An account, by contrast, can only be
// renamed by itself — the fold checks that against the author the server stamps
// on the event, so it is not a rule this screen has to be trusted to keep.
export function RenameGhost({ members, onRename }) {
  const [editing, setEditing] = useState(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const ghosts = members.filter((m) => m.ghost)
  if (!ghosts.length) return null

  const start = (m) => {
    setError('')
    setEditing(m.id)
    setName(m.display_name)
  }

  async function save(e) {
    e.preventDefault()
    setError('')
    if (!name.trim()) return setError('Give them a name')
    try {
      await onRename(editing, name.trim())
      setEditing(null)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <section className="rename-ghost">
      <h4>Fix a name</h4>
      {editing === null ? (
        <p className="muted">
          Spelled someone wrong?{' '}
          {ghosts.map((m) => (
            <button key={m.id} className="link" onClick={() => start(m)}>
              {m.display_name}
            </button>
          ))}
        </p>
      ) : (
        <form onSubmit={save}>
          <input
            placeholder="their name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="row-actions">
            <button type="submit">Save</button>
            <button className="link" type="button" onClick={() => setEditing(null)}>
              cancel
            </button>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

// A person in the split who isn't in the app. They pay, they owe, they settle
// up — the ledger treats them exactly like anyone else.
export function AddGhost({ onAdd }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!name.trim()) return setError('Give them a name')
    try {
      await onAdd(name.trim())
      setName('')
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <form onSubmit={submit}>
      <h4>Someone not using the app</h4>
      <p className="muted">
        Add them by name and split with them as normal. If they join later,
        their history can be handed over.
      </p>
      <input
        placeholder="their name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit">Add to the group</button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
