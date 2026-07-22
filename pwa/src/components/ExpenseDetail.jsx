// The read view of one expense: who paid, the receipt items, who owes what, and
// comments. Editing controls hide in readOnly (share-link viewers).

import { useState } from 'react'

import { money } from '../format'
import { ReceiptThumb } from './ReceiptThumb'

// Detail overlay for one expense: per-person paid/owed, plus comments (anyone
// can post; you may edit/delete your own).
export function ExpenseDetail({
  groupId,
  expense,
  members,
  meId,
  ai,
  onScan,
  onClose,
  onPost,
  onEdit,
  onDelete,
  // A share-link viewer sees the same detail with nothing to act on. The rescan
  // and comment edit/delete controls are already gated (no ai, no meId for a
  // viewer); readOnly additionally drops the comment form. Receipt images are
  // shown either way, but a viewer reaches them with `receiptAccess` — the key
  // from the link and the read token — since they have no stored key or session.
  readOnly = false,
  receiptAccess,
}) {
  const nameById = Object.fromEntries(members.map((m) => [m.id, m.display_name]))
  const [text, setText] = useState('')
  const [editId, setEditId] = useState(null)
  const [editText, setEditText] = useState('')
  const [error, setError] = useState('')

  async function post(e) {
    e.preventDefault()
    if (!text.trim()) return
    try {
      await onPost(expense.expense_id, text.trim())
      setText('')
    } catch {
      setError('Could not post comment')
    }
  }
  async function saveEdit(c) {
    if (!editText.trim()) return
    try {
      await onEdit(c, editText.trim())
      setEditId(null)
    } catch {
      setError('Could not save comment')
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="link close" onClick={onClose}>
          ×
        </button>
        <h3>
          {expense.description}
          {expense.deleted ? ' (deleted)' : ''}
        </h3>
        <p className="muted">
          {money(expense.amount_cents)}
          {expense.date ? ` · ${expense.date}` : ''}
          {expense.category ? ` · ${expense.category}` : ''}
          {expense.split?.mode && expense.split.mode !== 'equal'
            ? ` · by ${expense.split.mode}`
            : ''}
        </p>

        {expense.receipts?.length > 0 && (
          <>
            <h4>Receipts</h4>
            <div className="receipt-strip">
              {expense.receipts.map((rid) => (
                <div key={rid} className="receipt-cell">
                  <ReceiptThumb
                    groupId={groupId}
                    receiptId={rid}
                    access={receiptAccess}
                  />
                  {/* Re-reading a receipt belongs with the receipt, on the
                      expense it's attached to — not on the add form, which
                      has no business holding one past creation. */}
                  {ai?.active && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => onScan(rid)}
                    >
                      {expense.split?.mode === 'items' ? 'rescan' : 'scan'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <h4>Paid</h4>
        <ul className="list">
          {expense.payers.map((p) => (
            <li key={p.user_id} className="row static">
              <span>{nameById[p.user_id] || '?'}</span>
              <span>{money(p.paid_cents)}</span>
            </li>
          ))}
        </ul>

        {expense.split?.mode === 'items' &&
          Array.isArray(expense.split.items) && (
            <>
              <h4>Receipt</h4>
              <ul className="list">
                {expense.split.items.map((it) => (
                  <li key={it.id} className="row static">
                    <div className="expense">
                      <span>{it.name || 'item'}</span>
                      <span className="muted">
                        {it.claimed_by?.length
                          ? it.claimed_by
                              .map((id) => nameById[id] || '?')
                              .join(', ')
                          : 'everyone'}
                      </span>
                    </div>
                    <span>{money(it.price_cents)}</span>
                  </li>
                ))}
              </ul>
              {(() => {
                const sub = expense.split.items.reduce(
                  (t, it) => t + (it.price_cents || 0),
                  0
                )
                const tax = expense.split.tax_cents || 0
                const tip = expense.split.tip_cents || 0
                const rest = expense.amount_cents - sub - tax - tip
                const label =
                  rest < 0 ? 'discount' : tax || tip ? 'other' : 'tax/tip'
                return (
                  <p className="muted">
                    items {money(sub)}
                    {tax ? ` · tax ${money(tax)}` : ''}
                    {tip ? ` · tip ${money(tip)}` : ''}
                    {rest !== 0 ? ` · ${label} ${money(Math.abs(rest))}` : ''}
                  </p>
                )
              })()}
            </>
          )}

        <h4>Owes</h4>
        <ul className="list">
          {expense.splits.map((s) => (
            <li key={s.user_id} className="row static">
              <span>{nameById[s.user_id] || '?'}</span>
              <span>{money(s.share_cents)}</span>
            </li>
          ))}
        </ul>

        <h4>Comments</h4>
        {expense.comments.length === 0 && (
          <p className="muted">No comments yet.</p>
        )}
        <ul className="list">
          {expense.comments.map((c) => {
            const active = editId === c.comment_id
            return (
              <li key={c.comment_id} className="row static">
                {active ? (
                  <span className="settle-edit">
                    <input
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                    />
                    <button
                      type="button"
                      className="link"
                      onClick={() => saveEdit(c)}
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
                  <>
                    <div className="expense">
                      <span>{c.text}</span>
                      <span className="muted">{c.author_name}</span>
                    </div>
                    {c.author === meId && (
                      <div className="row-actions">
                        <button
                          className="link"
                          onClick={() => {
                            setEditId(c.comment_id)
                            setEditText(c.text)
                          }}
                        >
                          edit
                        </button>
                        <button
                          className="link danger"
                          onClick={() => onDelete(c)}
                        >
                          delete
                        </button>
                      </div>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>

        {!readOnly && (
          <form onSubmit={post}>
            <input
              placeholder="add a comment"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit">Post</button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
