// A single feed across all your groups: every expense added and payment
// recorded, newest first, each a tap back into its group. Purely a read over the
// local decrypted ledgers (overview.js) — no new server data. plan/18.

import { useCallback, useEffect, useState } from 'react'

import { money } from '../format'
import { activityFeed, loadOverviews } from '../overview'
import { api } from '../api'
import { localGroups } from '../store'

// Phrase a settlement from my point of view: "You settled up with Jo", "Jo
// settled up with you", or (not mine) "Jo settled up with Sam".
function settlementText(it) {
  if (it.mine && it.from_name === it.to_name) return 'You settled up' // degenerate
  return `${it.from_name} settled up with ${it.to_name}`
}

export function Activity({ me, onOpen }) {
  const [feed, setFeed] = useState(null)

  const load = useCallback(async () => {
    let groups
    try {
      groups = await api('groups')
    } catch {
      groups = (await localGroups()).filter((g) => g.name)
    }
    setFeed(activityFeed(await loadOverviews(groups, me)))
  }, [me])
  useEffect(() => {
    load()
  }, [load])

  if (!feed) return null

  return (
    <section>
      <h1 className="screen-title">Activity</h1>
      {feed.length === 0 && (
        <p className="muted">Nothing yet — add an expense to get started.</p>
      )}
      <ul className="list">
        {feed.map((it) => (
          <li key={`${it.kind}-${it.groupId}-${it.id}`}>
            <button className="row gitem" onClick={() => onOpen(it.groupId)}>
              <span className="shape" aria-hidden="true">
                {it.kind === 'settlement' ? '🤝' : '🧾'}
              </span>
              <span className="gitem-main">
                <span className="title">
                  {it.kind === 'settlement' ? (
                    settlementText(it)
                  ) : (
                    <>
                      {it.mine ? 'You' : it.actorName || 'Someone'} added “
                      {it.description}”
                    </>
                  )}{' '}
                  in <strong>{it.group}</strong>
                </span>
                <span className="sub muted">{it.date}</span>
              </span>
              <span className="amt">{money(it.amount_cents)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
