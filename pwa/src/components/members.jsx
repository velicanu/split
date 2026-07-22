// Membership controls that aren't invites: turning a member (or yourself) into a
// ghost, and adding a ghost for someone not using the app.

import { useState } from 'react'

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
