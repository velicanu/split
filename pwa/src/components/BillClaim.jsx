// The account-less claim view behind a shared-bill link. Anyone who opens it
// sees the receipt, who paid, the items, who claimed what, and the split — and,
// exactly as in a group, either claims a seeded ghost ("I'm Sam") or joins as
// someone new, then claims the items that were theirs. The only editable thing
// is your own claims. See bill.js, billlink.js, plan/15.

import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  billReceiptUrl,
  claimGhost,
  joinBill,
  loadBill,
  loadMe,
  rememberMe,
  setClaims,
} from '../bill'
import { money } from '../format'

// Same fetch-verify-decrypt-render as ReceiptThumb, but through the bill token
// rather than a group membership.
function BillReceipt({ billId, receiptId, access }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    billReceiptUrl(billId, receiptId, access)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [billId, receiptId, access])
  if (failed) return <span className="receipt-thumb muted">unreadable</span>
  if (!url) return <span className="receipt-thumb" />
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img className="receipt-thumb" src={url} alt="receipt" />
    </a>
  )
}

export function BillClaim({ link, onExit }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  // Who this browser is on this bill, if it has joined before. A refresh comes
  // back as the same person and can keep editing.
  const [me, setMe] = useState(() => loadMe(link.billId))
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  // My claimed item ids, kept optimistically so a tap feels instant, then
  // reconciled against the server on the next load.
  const [myItems, setMyItems] = useState([])

  const access = useMemo(
    () => ({ key: link.key, token: link.token }),
    [link.key, link.token]
  )

  const load = useCallback(async () => {
    try {
      const d = await loadBill(link)
      setData(d)
      return d
    } catch {
      setError('This link is not valid — the bill may have been removed.')
      return null
    }
  }, [link])

  useEffect(() => {
    load()
  }, [load])

  // Resync my claim set whenever the bill reloads (mine may have changed on
  // another device, or a join just happened).
  useEffect(() => {
    if (!data || !me) return
    const mine = data.participants.find((p) => p.participant_id === me.participant_id)
    setMyItems(mine ? mine.claimed_item_ids : [])
  }, [data, me])

  const nameOf = (pid) =>
    data?.participants.find((p) => p.participant_id === pid)?.name || '?'

  async function claimAsGhost(pid) {
    setBusy(true)
    setError('')
    try {
      const identity = await claimGhost(link, pid)
      rememberMe(link.billId, identity)
      setMe(identity)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function joinNew(e) {
    e.preventDefault()
    if (!name.trim()) return setError('Enter your name')
    setBusy(true)
    setError('')
    try {
      const identity = await joinBill(link, name.trim())
      rememberMe(link.billId, identity)
      setMe(identity)
      setName('')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function toggleItem(itemId) {
    if (!me || busy) return
    const next = myItems.includes(itemId)
      ? myItems.filter((x) => x !== itemId)
      : [...myItems, itemId]
    setMyItems(next)
    setBusy(true)
    setError('')
    try {
      await setClaims(link, me.participant_id, me.secret, next)
      await load()
    } catch (err) {
      setError(err.message)
      await load()
    } finally {
      setBusy(false)
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

  const { snapshot, participants, items, split } = data
  const unclaimed = participants.filter((p) => !p.claimed)
  const receipts = snapshot.receipts || []

  return (
    <main className="app">
      <header>
        <strong className="brand" onClick={onExit}>
          Split
        </strong>
        <span className="spacer" />
        <span className="muted">shared bill</span>
      </header>
      <h2>{snapshot.description || 'Split the bill'}</h2>

      {receipts.length > 0 && (
        <fieldset className="participants receipt">
          <legend>receipt</legend>
          {receipts.map((rid) => (
            <BillReceipt
              key={rid}
              billId={link.billId}
              receiptId={rid}
              access={access}
            />
          ))}
        </fieldset>
      )}

      <h3>Paid</h3>
      <ul className="list">
        {(snapshot.payers || []).map((p) => (
          <li key={p.participant_id} className="row static">
            <span>{nameOf(p.participant_id)}</span>
            <span className="muted">paid {money(p.paid_cents)}</span>
          </li>
        ))}
      </ul>

      {!me ? (
        <section>
          <h3>Who are you?</h3>
          {unclaimed.length > 0 && (
            <>
              <p className="muted">If you&rsquo;re already on the bill:</p>
              <div className="cols">
                {unclaimed.map((g) => (
                  <button
                    key={g.participant_id}
                    disabled={busy}
                    onClick={() => claimAsGhost(g.participant_id)}
                  >
                    I&rsquo;m {g.name}
                  </button>
                ))}
              </div>
            </>
          )}
          <form onSubmit={joinNew}>
            <input
              placeholder="your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" disabled={busy}>
              Join to claim your items
            </button>
          </form>
        </section>
      ) : (
        <p className="muted">
          You&rsquo;re claiming as <strong>{nameOf(me.participant_id)}</strong>.
          Tick the items that were yours.
        </p>
      )}
      {error && <p className="error">{error}</p>}

      <h3>Items</h3>
      <fieldset className="participants receipt">
        <legend>who claimed what</legend>
        {items.map((it) => {
          const others = it.claimed_by
            .filter((id) => id !== me?.participant_id)
            .map(nameOf)
          const mine = !!me && myItems.includes(it.id)
          return (
            <div key={it.id} className="item">
              <div className="item-head">
                <span>{it.name || 'item'}</span>
                <span className="pay-amt muted">{money(it.price_cents)}</span>
                {me && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={mine}
                      disabled={busy}
                      onChange={() => toggleItem(it.id)}
                    />
                    mine
                  </label>
                )}
              </div>
              <div className="claims muted">
                {it.claimed_by.length === 0
                  ? 'unclaimed — splits among everyone'
                  : `claimed by ${[mine ? 'you' : null, ...others]
                      .filter(Boolean)
                      .join(', ')}`}
              </div>
            </div>
          )
        })}
      </fieldset>

      <h3>The split</h3>
      <ul className="list">
        {participants.map((p) => (
          <li key={p.participant_id} className="row static">
            <span>
              {p.name}
              {me?.participant_id === p.participant_id ? ' (you)' : ''}
            </span>
            <span className="muted">
              share {money(split.owed[p.participant_id] || 0)}
            </span>
          </li>
        ))}
      </ul>

      {split.transfers.length > 0 && (
        <>
          <h3>Settle up</h3>
          <ul className="list">
            {split.transfers.map((t) => (
              <li key={`${t.from}-${t.to}`} className="row static">
                <span>
                  {t.from_name} → {t.to_name}
                </span>
                <span className="muted">{money(t.amount_cents)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}
