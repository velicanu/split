// Settling up: suggested payments to clear balances, and the list of payments
// already recorded.

import { useState } from 'react'

import { money } from '../format'

// Suggested minimal transfers. One click opens an editable amount (prefilled
// with the suggested default); confirm records it as a settlement.
export function SettleUp({ suggestions, onRecord }) {
  const [activeKey, setActiveKey] = useState(null)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')

  async function confirm(t) {
    const cents = Math.round(parseFloat(amount) * 100)
    if (!cents || cents <= 0) return setError('Enter a positive amount')
    try {
      await onRecord(t.from, t.to, cents)
      setActiveKey(null)
      setError('')
    } catch {
      // error is surfaced by the parent
    }
  }

  if (!suggestions.length) {
    return <p className="muted">Everyone is settled up 🎉</p>
  }
  return (
    <>
      <ul className="list">
        {suggestions.map((t) => {
          const key = `${t.from}-${t.to}`
          return (
            <li key={key} className="row static">
              <span>
                {t.from_name} → {t.to_name}
              </span>
              {activeKey === key ? (
                <span className="settle-edit">
                  <input
                    className="pay-amt"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <button type="button" className="link" onClick={() => confirm(t)}>
                    confirm
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setActiveKey(null)}
                  >
                    cancel
                  </button>
                </span>
              ) : (
                <button
                  className="link"
                  onClick={() => {
                    setActiveKey(key)
                    setAmount((t.amount_cents / 100).toFixed(2))
                    setError('')
                  }}
                >
                  {money(t.amount_cents)} · settle
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {error && <p className="error">{error}</p>}
    </>
  )
}

// Recorded payments. Only the member who initiated one may edit or delete it.
export function Payments({ payments, onEdit, onDelete }) {
  const [editId, setEditId] = useState(null)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')

  if (!payments.length) return <p className="muted">No payments yet.</p>
  return (
    <>
      <ul className="list">
        {payments.map((s) => {
          const active = editId === s.settlement_id
          return (
            <li key={s.settlement_id} className="row static">
              <div className="expense">
                <span>
                  {s.from_name} paid {s.to_name} {money(s.amount_cents)}
                </span>
                <span className="muted">{s.date}</span>
              </div>
              {active ? (
                  <span className="settle-edit">
                    <input
                      className="pay-amt"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                    <button
                      type="button"
                      className="link"
                      onClick={async () => {
                        const cents = Math.round(parseFloat(amount) * 100)
                        if (!cents || cents <= 0) {
                          return setError('Enter a positive amount')
                        }
                        try {
                          await onEdit(s, cents)
                          setEditId(null)
                          setError('')
                        } catch {
                          // surfaced by parent
                        }
                      }}
                    >
                      save
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setEditId(null)}
                    >
                      cancel
                    </button>
                  </span>
                ) : (
                  <div className="row-actions">
                    <button
                      className="link"
                      onClick={() => {
                        setEditId(s.settlement_id)
                        setAmount((s.amount_cents / 100).toFixed(2))
                        setError('')
                      }}
                    >
                      edit
                    </button>
                    <button
                      className="link danger"
                      onClick={() => onDelete(s)}
                    >
                      delete
                    </button>
                  </div>
                )}
            </li>
          )
        })}
      </ul>
      {error && <p className="error">{error}</p>}
    </>
  )
}
