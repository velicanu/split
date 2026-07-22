// The raw append-only log, viewable and downloadable — every balance is folded
// from exactly these events.

import { useState } from 'react'

import { downloadJson, exportLedger, ledgerFilename } from '../export'

// Everything the app shows is folded from this. Being able to read it, and
// take it away, is what makes the derivation checkable instead of a promise.
export function LedgerLog({ group, version, events, unreadable, members, onClose }) {
  const nameById = Object.fromEntries(
    (members ?? []).map((m) => [m.id, m.display_name])
  )
  const [raw, setRaw] = useState(false)

  const save = () => {
    const now = new Date()
    downloadJson(
      ledgerFilename(group, now),
      exportLedger({ group, version, events, unreadable, now })
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="link close" onClick={onClose}>
          ×
        </button>
        <h3>Ledger</h3>
        <p className="muted">
          {events.length} entr{events.length === 1 ? 'y' : 'ies'} · every
          balance in this group is worked out from these, in this order.
        </p>
        {unreadable > 0 && (
          <p className="error">
            {unreadable} more this device couldn&rsquo;t decrypt, so
            {unreadable === 1 ? ' it is' : ' they are'} missing from the list
            and from anything you download.
          </p>
        )}

        <div className="row-actions">
          <button onClick={save}>Download JSON</button>
          <button className="link" onClick={() => setRaw(!raw)}>
            {raw ? 'readable' : 'raw'}
          </button>
        </div>
        <p className="muted">
          The file is plain text — it holds everything in this group.
        </p>

        <ul className="list">
          {events.map((e) => (
            <li key={e.id} className="row static log-entry">
              <div className="expense">
                <span>
                  <code>#{e.id}</code> {e.type}
                </span>
                <span className="muted">
                  {nameById[e.author] ? `by ${nameById[e.author]}` : ''}
                  {e.created_at ? ` · ${e.created_at}` : ''}
                </span>
                {raw && <pre className="log-payload">{JSON.stringify(e.payload, null, 2)}</pre>}
              </div>
            </li>
          ))}
        </ul>
        {events.length === 0 && <p className="muted">Nothing logged yet.</p>}
      </div>
    </div>
  )
}
