// Publishing a shared bill from the signed-in app: scan (or type) the receipt,
// name the diners, say who paid, and get a link. Everything here is the static
// half of the bill — once published it never changes; only claiming does. The
// claim side is BillClaim.jsx. See bill.js, plan/15.

import { useState } from 'react'

import { PROVIDERS, extractReceipt } from '../ai'
import { createBill, newParticipantId } from '../bill'
import { buildBillLink } from '../billlink'
import { dollars, money, toCents } from '../format'

export function BillCreate({ ai, onBack }) {
  const [description, setDescription] = useState('')
  const [receiptFile, setReceiptFile] = useState(null)
  const [items, setItems] = useState([])
  const [tax, setTax] = useState('')
  const [tip, setTip] = useState('')
  const [amount, setAmount] = useState('')
  // Seeded diners: a client id and a name. Whoever paid is picked among them.
  const [participants, setParticipants] = useState([])
  const [payerIds, setPayerIds] = useState([])
  const [payerAmounts, setPayerAmounts] = useState({})
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)

  const addItem = () =>
    setItems((prev) => [...prev, { id: crypto.randomUUID(), name: '', price: '' }])
  const updateItem = (idx, patch) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  const removeItem = (idx) =>
    setItems((prev) => prev.filter((_, i) => i !== idx))

  function addParticipant() {
    setParticipants((prev) => [
      ...prev,
      { participant_id: newParticipantId(), name: '' },
    ])
  }
  const renameParticipant = (id, name) =>
    setParticipants((prev) =>
      prev.map((p) => (p.participant_id === id ? { ...p, name } : p))
    )
  function removeParticipant(id) {
    setParticipants((prev) => prev.filter((p) => p.participant_id !== id))
    setPayerIds((prev) => prev.filter((x) => x !== id))
  }
  const togglePayer = (id) =>
    setPayerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )

  // A scan fills the editable rows; the creator reviews before publishing, so
  // it goes straight in rather than through a reconcile step.
  async function scan(file) {
    const config = ai?.providers?.[ai.active]
    if (!config) return
    setScanning(true)
    setError('')
    try {
      const result = await extractReceipt({
        provider: ai.active,
        apiKey: config.api_key,
        model: config.model,
        file,
      })
      setItems(
        result.items.map((it) => ({
          id: crypto.randomUUID(),
          name: it.name,
          price: dollars(it.price_cents),
        }))
      )
      setTax(dollars(result.tax_cents))
      setTip(dollars(result.tip_cents))
      setAmount((result.total_cents / 100).toFixed(2))
    } catch (err) {
      setError(err.message)
    } finally {
      setScanning(false)
    }
  }

  const pick = (handler) => async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) await handler(file)
  }
  const attach = pick(async (file) => {
    setReceiptFile(file)
    setError('')
  })
  const attachAndScan = pick(async (file) => {
    setReceiptFile(file)
    await scan(file)
  })

  const itemsTotalCents = items.reduce((t, it) => t + toCents(it.price), 0)
  const totalCents = toCents(amount) || itemsTotalCents + toCents(tax) + toCents(tip)

  async function publish(e) {
    e.preventDefault()
    setError('')

    const parsedItems = items
      .map((it) => ({
        id: it.id,
        name: it.name.trim(),
        price_cents: toCents(it.price),
      }))
      .filter((it) => it.price_cents > 0)
    if (!parsedItems.length) return setError('Add at least one item with a price')

    const named = participants
      .map((p) => ({ participant_id: p.participant_id, name: p.name.trim() }))
      .filter((p) => p.name)
    if (!named.length) return setError('Add at least one person')

    if (totalCents <= 0) return setError('The total must be more than zero')

    if (!payerIds.length) return setError('Pick who paid')
    const payerSet = new Set(named.map((p) => p.participant_id))
    if (payerIds.some((id) => !payerSet.has(id))) {
      return setError('A payer was removed — pick who paid again')
    }
    let payers
    if (payerIds.length === 1) {
      payers = [{ participant_id: payerIds[0], paid_cents: totalCents }]
    } else {
      payers = payerIds.map((id) => ({
        participant_id: id,
        paid_cents: toCents(payerAmounts[id]),
      }))
      if (payers.some((p) => p.paid_cents <= 0)) {
        return setError('Each payer must have paid a positive amount')
      }
      const sum = payers.reduce((t, p) => t + p.paid_cents, 0)
      if (sum !== totalCents) {
        return setError(
          `Payments must add up to ${money(totalCents)} (now ${money(sum)})`
        )
      }
    }

    setBusy(true)
    try {
      const { billId, token, key } = await createBill({
        snapshot: {
          description: description.trim(),
          items: parsedItems,
          payers,
          tax_cents: toCents(tax),
          tip_cents: toCents(tip),
          total_cents: totalCents,
        },
        participants: named,
        receiptFile,
      })
      setLink(buildBillLink(window.location.origin, { billId, key, token }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (link) {
    return (
      <section>
        <h3>Your bill is ready</h3>
        <p className="muted">
          Send this link to the table. Anyone who opens it can claim their items
          — no account needed. The scan and who-paid are fixed; only claiming
          changes.
        </p>
        <input
          className="invite"
          readOnly
          value={link}
          onFocus={(e) => e.target.select()}
        />
        <div className="row-actions">
          <button className="link" onClick={copy}>
            {copied ? 'copied' : 'copy'}
          </button>
          <button
            onClick={() => {
              // Open the bill as a claimer, so the creator can claim their own
              // items too — they are a diner like everyone else.
              window.location.href = link
              window.location.reload()
            }}
          >
            Open it
          </button>
          <button className="link" onClick={onBack}>
            done
          </button>
        </div>
      </section>
    )
  }

  return (
    <form onSubmit={publish}>
      <h3>Split a bill</h3>
      <p className="muted">
        Scan a receipt, list who&rsquo;s here and who paid, then share a link for
        everyone to claim their items.
      </p>
      <input
        placeholder="what was it? (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      <label className="scan">
        {receiptFile ? '📎 receipt attached' : '📎 add a receipt'}
        <input
          type="file"
          accept="image/*"
          disabled={scanning || busy}
          onChange={attach}
        />
      </label>
      {ai?.active && (
        <label className="scan">
          {scanning
            ? 'scanning…'
            : `📷 add and scan with ${PROVIDERS[ai.active]?.label ?? ai.active}`}
          <input
            type="file"
            accept="image/*"
            disabled={scanning || busy}
            onChange={attachAndScan}
          />
        </label>
      )}

      <fieldset className="participants receipt">
        <legend>items</legend>
        {items.length === 0 && (
          <p className="muted">No items yet — add the lines off the receipt.</p>
        )}
        {items.map((it, idx) => (
          <div key={it.id} className="item">
            <div className="item-head">
              <input
                placeholder="item"
                value={it.name}
                onChange={(e) => updateItem(idx, { name: e.target.value })}
              />
              <input
                className="pay-amt"
                inputMode="decimal"
                placeholder="0.00"
                value={it.price}
                onChange={(e) => updateItem(idx, { price: e.target.value })}
              />
              <button
                type="button"
                className="link danger"
                onClick={() => removeItem(idx)}
              >
                remove
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="link" onClick={addItem}>
          + add item
        </button>
      </fieldset>

      <div className="cols">
        <label className="field">
          tax (optional)
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
          />
        </label>
        <label className="field">
          tip (optional)
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={tip}
            onChange={(e) => setTip(e.target.value)}
          />
        </label>
      </div>
      <input
        placeholder="total charged (defaults to items + tax + tip)"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      {itemsTotalCents > 0 && (
        <p className="muted">
          items {money(itemsTotalCents)}
          {toCents(tax) ? ` · tax ${money(toCents(tax))}` : ''}
          {toCents(tip) ? ` · tip ${money(toCents(tip))}` : ''} · total{' '}
          {money(totalCents)}
        </p>
      )}

      <fieldset className="participants">
        <legend>who&rsquo;s here</legend>
        {participants.length === 0 && (
          <p className="muted">
            Add the people you know — others can add themselves from the link.
          </p>
        )}
        {participants.map((p) => (
          <div key={p.participant_id} className="item-head">
            <input
              placeholder="name"
              value={p.name}
              onChange={(e) => renameParticipant(p.participant_id, e.target.value)}
            />
            <button
              type="button"
              className="link danger"
              onClick={() => removeParticipant(p.participant_id)}
            >
              remove
            </button>
          </div>
        ))}
        <button type="button" className="link" onClick={addParticipant}>
          + add person
        </button>
      </fieldset>

      <fieldset className="participants">
        <legend>paid by</legend>
        {participants.filter((p) => p.name.trim()).length === 0 && (
          <p className="muted">Add people first, then say who paid.</p>
        )}
        {participants
          .filter((p) => p.name.trim())
          .map((p) => {
            const checked = payerIds.includes(p.participant_id)
            return (
              <label key={p.participant_id} className="check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => togglePayer(p.participant_id)}
                />
                {p.name}
                {checked && payerIds.length > 1 && (
                  <input
                    className="pay-amt"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={payerAmounts[p.participant_id] ?? ''}
                    onChange={(e) =>
                      setPayerAmounts((a) => ({
                        ...a,
                        [p.participant_id]: e.target.value,
                      }))
                    }
                  />
                )}
              </label>
            )
          })}
      </fieldset>

      <div className="row-actions">
        <button type="submit" disabled={busy || scanning}>
          {busy ? 'publishing…' : 'Publish and get link'}
        </button>
        <button type="button" className="link" onClick={onBack}>
          cancel
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
