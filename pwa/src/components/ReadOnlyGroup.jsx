// The account-less read-only view behind a share link: fetch with the read
// token, decrypt with the key from the link, fold, and show it read-only.

import { useEffect, useMemo, useState } from 'react'

import { api } from '../api'
import { publishGroupKey } from '../groupkeys'
import { loadReadOnly } from '../readonly'
import { money } from '../format'
import { ExpenseDetail } from './ExpenseDetail'

// The account-less read-only view behind a share link: fetch with the read
// token, decrypt with the key from the link, fold, and show it — no edit
// controls anywhere. An account-holder gets a Join affordance; anyone else is
// pointed at signing in. See viewlink.js, readonly.js, plan/14.
export function ReadOnlyGroup({ link, user, onExit }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [joining, setJoining] = useState(false)
  const [viewing, setViewing] = useState(null)
  // How a viewer reads receipts: the key from the link, and the read token for
  // the members-only blob endpoint. Stable, so ReceiptThumb's effect doesn't
  // re-fetch on every render.
  const receiptAccess = useMemo(
    () => ({ key: link.gk, readToken: link.readToken }),
    [link.gk, link.readToken]
  )

  useEffect(() => {
    let live = true
    loadReadOnly(link)
      .then((d) => live && setData(d))
      .catch(
        () =>
          live &&
          setError('This link is not valid — read-sharing may have been turned off.')
      )
    return () => {
      live = false
    }
  }, [link])

  async function join(claims) {
    setJoining(true)
    setError('')
    try {
      await api('groups/join', { code: link.code, claims: claims ?? null })
      // Seal the key (from the link) to this account and device, so the group
      // is readable the normal way from now on.
      await publishGroupKey(link.groupId, link.gk)
      window.location.href = `${window.location.pathname}#group/${link.groupId}`
      window.location.reload()
    } catch (err) {
      setError(err.message)
      setJoining(false)
    }
  }

  if (error && !data) {
    return (
      <main className="app">
        <header>
          <strong className="brand" onClick={onExit}>
            Split
          </strong>
        </header>
        <p className="error">{error}</p>
        <button className="link" onClick={onExit}>
          go to Split
        </button>
      </main>
    )
  }
  if (!data) return null

  const { name, state, unreadable } = data
  const ghosts = state.members.filter((m) => m.ghost)

  return (
    <main className="app">
      <header>
        <strong className="brand" onClick={onExit}>
          Split
        </strong>
        <span className="spacer" />
        <span className="muted">read-only</span>
      </header>
      <h2>{name}</h2>

      {link.code && user ? (
        <section>
          <p className="muted">
            You&rsquo;re viewing this group. Join to add and edit expenses.
          </p>
          {ghosts.length > 0 && (
            <p className="muted">
              If you&rsquo;re already in the split, join as that person:
            </p>
          )}
          <div className="cols">
            {ghosts.map((g) => (
              <button key={g.id} disabled={joining} onClick={() => join(g.id)}>
                I&rsquo;m {g.display_name}
              </button>
            ))}
            <button disabled={joining} onClick={() => join(null)}>
              Join as a new member
            </button>
          </div>
        </section>
      ) : link.code ? (
        <p className="muted">
          Sign in to join this group.{' '}
          <button className="link" onClick={onExit}>
            Open Split
          </button>
        </p>
      ) : (
        <p className="muted">A read-only view of this group.</p>
      )}
      {error && <p className="error">{error}</p>}

      <h3>Balances</h3>
      <ul className="list">
        {state.balances.map((b) => (
          <li key={b.user_id} className="row static">
            <span>{b.display_name}</span>
            <span className={b.net_cents >= 0 ? 'pos' : 'neg'}>
              {b.net_cents === 0
                ? 'settled up'
                : b.net_cents > 0
                  ? `is owed ${money(b.net_cents)}`
                  : `owes ${money(-b.net_cents)}`}
            </span>
          </li>
        ))}
      </ul>

      <h3>Expenses</h3>
      {state.ledger.length === 0 && <p className="muted">No expenses yet.</p>}
      <ul className="list">
        {state.ledger.map((x) => (
          <li key={x.expense_id}>
            <button className="row" onClick={() => setViewing(x)}>
              <div className="expense">
                <span>
                  {x.description}
                  {x.deleted ? ' (deleted)' : ''}
                </span>
                <span className="muted">
                  {x.payer_names.join(', ')} paid {money(x.amount_cents)} ·
                  split {x.ways} way{x.ways === 1 ? '' : 's'}
                  {x.date ? ` · ${x.date}` : ''}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>

      {viewing && (
        <ExpenseDetail
          groupId={link.groupId}
          expense={viewing}
          members={state.members}
          meId={null}
          readOnly
          receiptAccess={receiptAccess}
          onClose={() => setViewing(null)}
        />
      )}

      {state.payments.length > 0 && (
        <>
          <h3>Payments</h3>
          <ul className="list">
            {state.payments.map((p) => (
              <li key={p.settlement_id} className="row static">
                <span>
                  {p.from_name} → {p.to_name}
                </span>
                <span className="muted">
                  {money(p.amount_cents)}
                  {p.date ? ` · ${p.date}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {unreadable > 0 && (
        <p className="error">
          {unreadable} entr{unreadable === 1 ? 'y' : 'ies'} couldn&rsquo;t be
          decrypted and {unreadable === 1 ? 'is' : 'are'} missing here.
        </p>
      )}
    </main>
  )
}
