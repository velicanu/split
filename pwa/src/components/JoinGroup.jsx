// The screen behind a group link: one link for the whole group, so the person
// opening it is the one who says who they are — somebody the group has already
// been splitting with ("I'm Sam"), or somebody new. Same choice a shared bill
// offers (BillClaim), for the same reason: the group has been naming them in
// splits for weeks and that history should attach to their account rather than
// sit beside it.
//
// Claiming is part of joining and cannot be done afterwards (plan/12), so the
// choice has to be made here, before the join call. That is why this screen
// exists at all instead of the link simply joining you.

import { useEffect, useState } from 'react'

import { acceptInvite } from '../join'
import { loadJoinPreview } from '../preview'

export function JoinGroup({ invite, onJoined, onCancel }) {
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadJoinPreview(invite)
      .then((p) => {
        if (cancelled) return
        // Already in: there is no claim left to offer — claiming is part of
        // joining and they have joined — so skip the question entirely.
        if (p.joined) return onJoined(p.id)
        setPreview(p)
      })
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [invite, onJoined])

  async function join(memberId) {
    setBusy(true)
    setError('')
    try {
      const g = await acceptInvite({ ...invite, member_id: memberId })
      onJoined(g.id)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  if (error && !preview) {
    return (
      <main>
        <h1>This link didn&rsquo;t work</h1>
        <p className="muted">{error}</p>
        <button onClick={onCancel}>Back to my groups</button>
      </main>
    )
  }
  if (!preview) return null

  return (
    <main>
      <h1>Join {preview.name}</h1>
      <section>
        <h3>Who are you?</h3>
        {preview.ghosts.length > 0 && (
          <>
            <p className="muted">
              If the group has been splitting with you already, take over your
              share of the history — it only attaches to your account this way.
            </p>
            <div className="cols">
              {preview.ghosts.map((g) => (
                <button key={g.id} disabled={busy} onClick={() => join(g.id)}>
                  I&rsquo;m {g.display_name}
                </button>
              ))}
            </div>
          </>
        )}
        <p className="muted">
          {preview.ghosts.length > 0
            ? 'Otherwise start fresh — you can still be added to anything from here on.'
            : 'Nobody in this group is waiting to be claimed, so you join as yourself.'}
        </p>
        <button className="tonal" disabled={busy} onClick={() => join(null)}>
          I&rsquo;m someone new
        </button>
      </section>
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={onCancel}>
        not now
      </button>
    </main>
  )
}
