// Adding or editing an expense: payers, amount, the split (equal / percentage /
// shares / receipt items), receipts, and AI scanning. ReceiptEditor is the
// per-item claim table used by the items split mode.

import { useEffect, useRef, useState } from 'react'

import { PROVIDERS, extractReceipt } from '../ai'
import { receiptWeights, splitByWeights, splitEqually } from '../ledger'
import { receiptBlob, uploadReceipt } from '../receipts'
import { applyOption, splitOptions } from '../copysplit'
import { dollars, memberIdFor, money, toCents } from '../format'
import { ReceiptThumb } from './ReceiptThumb'

// Line items with per-person claims. Claim an item and it splits between its
// claimants; leave it unclaimed and it splits among everyone on the receipt.
function ReceiptEditor({
  items,
  setItems,
  participants,
  legend = 'items (unclaimed ones split among everyone)',
}) {
  // Functional updates throughout: two edits batched in one tick (e.g. name and
  // price together) must not read the same stale list and clobber each other.
  const update = (idx, patch) =>
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    )
  const toggleClaim = (idx, uid) =>
    setItems((prev) =>
      prev.map((it, i) =>
        i === idx
          ? {
              ...it,
              claimed_by: it.claimed_by.includes(uid)
                ? it.claimed_by.filter((x) => x !== uid)
                : [...it.claimed_by, uid],
            }
          : it
      )
    )

  return (
    <fieldset className="participants receipt">
      <legend>{legend}</legend>
      {items.length === 0 && (
        <p className="muted">No items yet — add the lines off the receipt.</p>
      )}
      {items.map((it, idx) => (
        <div key={it.id} className="item">
          <div className="item-head">
            <input
              placeholder="item"
              value={it.name}
              onChange={(e) => update(idx, { name: e.target.value })}
            />
            <input
              className="pay-amt"
              inputMode="decimal"
              placeholder="0.00"
              value={it.price}
              onChange={(e) => update(idx, { price: e.target.value })}
            />
            <button
              type="button"
              className="link danger"
              onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
            >
              remove
            </button>
          </div>
          {participants.length > 0 && (
            <div className="claims">
              {participants.map((m) => (
                <label key={m.id} className="check">
                  <input
                    type="checkbox"
                    checked={it.claimed_by.includes(m.id)}
                    onChange={() => toggleClaim(idx, m.id)}
                  />
                  {m.display_name}
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        className="link"
        onClick={() =>
          setItems((prev) => [
            ...prev,
            { id: crypto.randomUUID(), name: '', price: '', claimed_by: [] },
          ])
        }
      >
        + add item
      </button>
    </fieldset>
  )
}

export function ExpenseForm({
  groupId,
  members,
  me,
  ai,
  initial,
  savedSplits = [],
  scanOnOpen,
  onSubmit,
  onCancel,
}) {
  const [scanning, setScanning] = useState(false)
  const [uploading, setUploading] = useState(false)
  // Ids of receipt images attached to this expense. Uploading is independent of
  // scanning: no API key is needed to keep a photo of the receipt, and a stored
  // receipt can be scanned later, or scanned again.
  const [receipts, setReceipts] = useState(() => initial?.receipts ?? [])
  const today = new Date().toISOString().slice(0, 10)
  const [description, setDescription] = useState(initial?.description ?? '')
  const [amount, setAmount] = useState(
    initial ? (initial.amount_cents / 100).toFixed(2) : ''
  )
  const [date, setDate] = useState(initial?.date || today)
  const [category, setCategory] = useState(initial?.category ?? '')
  // How to split: equally (default), by percentage, or by shares.
  const [mode, setMode] = useState(initial?.split?.mode || 'equal')
  // Per-member percentage/share inputs, keyed by user id (strings while typing).
  const [weights, setWeights] = useState(() =>
    initial?.split?.weights
      ? Object.fromEntries(
          Object.entries(initial.split.weights).map(([id, v]) => [id, String(v)])
        )
      : {}
  )
  // Receipt line items (prices as strings while typing).
  const [items, setItems] = useState(() =>
    initial?.split?.mode === 'items' && Array.isArray(initial.split.items)
      ? initial.split.items.map((it) => ({
          id: it.id || crypto.randomUUID(),
          name: it.name || '',
          price: ((it.price_cents || 0) / 100).toFixed(2),
          claimed_by: it.claimed_by || [],
        }))
      : []
  )
  // members left OUT of the split (so members who join later default to "in")
  const [excluded, setExcluded] = useState(() => {
    if (!initial) return []
    const all = members.map((m) => m.id)
    // A receipt keeps its own participant set: someone can be on the receipt
    // yet owe nothing, so it can't be re-derived from the resolved splits.
    if (initial.split?.mode === 'items' && Array.isArray(initial.split.participants)) {
      return all.filter((id) => !initial.split.participants.includes(id))
    }
    const inSplit = initial.splits.map((s) => s.user_id)
    return all.filter((id) => !inSplit.includes(id))
  })
  // Tax and tip are recorded for information only — the split is driven by the
  // item weights scaled to the total, so these never enter the maths.
  const [tax, setTax] = useState(dollars(initial?.split?.tax_cents))
  const [tip, setTip] = useState(dollars(initial?.split?.tip_cents))
  // A scan whose items don't add up to the receipt's own subtotal, parked as an
  // editable draft: the misread is usually one line or the subtotal itself, so
  // it's fixable here rather than only acceptable or discardable wholesale.
  const [pending, setPending] = useState(null)
  const [payerIds, setPayerIds] = useState(() =>
    initial ? initial.payers.map((p) => p.user_id) : [memberIdFor(members, me)]
  )
  const [payerAmounts, setPayerAmounts] = useState(() =>
    initial
      ? Object.fromEntries(
          initial.payers.map((p) => [p.user_id, (p.paid_cents / 100).toFixed(2)])
        )
      : {}
  )
  const [error, setError] = useState('')

  const toggle = (list, setList, id) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  // Scan results and the form's own rows share a shape, so a draft can be
  // edited with the same editor and then handed straight to the form.
  const draftFrom = (result) => ({
    items: result.items.map((it) => ({
      id: crypto.randomUUID(),
      name: it.name,
      price: (it.price_cents / 100).toFixed(2),
      claimed_by: [],
    })),
    subtotal: dollars(result.subtotal_cents),
    tax: dollars(result.tax_cents),
    tip: dollars(result.tip_cents),
    total: (result.total_cents / 100).toFixed(2),
  })

  function applyDraft(draft) {
    setItems(draft.items)
    setAmount(draft.total)
    setTax(draft.tax)
    setTip(draft.tip)
    // A scan implies an itemised split, whatever mode you were in.
    setMode('items')
    setPending(null)
  }

  // Scanned output is a *draft*: it fills the editable rows so the user can
  // fix OCR mistakes before anything is saved. Takes any image source, so the
  // same path serves a fresh photo and a re-scan of a stored one.
  async function runScan(image) {
    const config = ai?.providers?.[ai.active]
    if (!config) return
    setScanning(true)
    setError('')
    setPending(null)
    try {
      const result = await extractReceipt({
        provider: ai.active,
        apiKey: config.api_key,
        model: config.model,
        file: image,
      })
      // Items that don't reconcile with the printed subtotal mean something
      // was misread, so let the user look before it touches the form.
      const draft = draftFrom(result)
      if (result.matches) applyDraft(draft)
      else setPending(draft)
    } catch (err) {
      setError(err.message)
    } finally {
      setScanning(false)
    }
  }

  // Stored at the size we'd display it, which is also the size we'd send to a
  // model — a full-resolution phone photo is wasted bytes for a receipt.
  async function upload(file) {
    const id = await uploadReceipt(groupId, file)
    setReceipts((prev) => [...prev, id])
  }

  const pick = (handler) => async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) await handler(file)
  }

  const attach = pick(async (file) => {
    setUploading(true)
    setError('')
    try {
      await upload(file)
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  })

  // Attach and scan in one go. If the upload fails the scan is skipped, so a
  // failure means nothing happened rather than a scan with no receipt kept.
  const scanNew = pick(async (file) => {
    setUploading(true)
    setError('')
    try {
      await upload(file)
    } catch (err) {
      setError(err.message)
      return
    } finally {
      setUploading(false)
    }
    await runScan(file)
  })

  async function rescan(receiptId) {
    setError('')
    try {
      await runScan(await receiptBlob(groupId, receiptId))
    } catch (err) {
      setError(err.message)
    }
  }

  // Opened from the detail view's scan button: read that receipt once, as the
  // form mounts. The ref guards against a second run on re-render.
  const scanned = useRef(false)
  useEffect(() => {
    if (scanOnOpen && !scanned.current) {
      scanned.current = true
      rescan(scanOnOpen)
    }
  }, [scanOnOpen])

  async function submit(e) {
    e.preventDefault()
    setError('')
    const cents = Math.round(parseFloat(amount) * 100)
    if (!description.trim() || !cents || cents <= 0) {
      return setError('Enter a description and a positive amount')
    }
    if (!date) return setError('Pick a date')

    // Resolve the chosen mode down to frozen per-person cents. Whatever the
    // mode, the stored `splits` are what balances use; `split` keeps the recipe.
    let splits
    let split
    if (mode === 'equal') {
      const participants = members
        .map((m) => m.id)
        .filter((id) => !excluded.includes(id))
      if (!participants.length) {
        return setError('Pick at least one person to split between')
      }
      const shares = splitEqually(cents, participants)
      splits = participants.map((uid) => ({
        user_id: uid,
        share_cents: shares[uid],
      }))
      split = { mode: 'equal' }
    } else if (mode === 'items') {
      const participants = members
        .map((m) => m.id)
        .filter((id) => !excluded.includes(id))
      if (!participants.length) return setError('Pick who is on the receipt')
      const parsed = items
        .map((it) => ({
          id: it.id,
          name: it.name.trim(),
          price_cents: Math.round(parseFloat(it.price) * 100) || 0,
          claimed_by: it.claimed_by.filter((id) => participants.includes(id)),
        }))
        .filter((it) => it.price_cents > 0)
      if (!parsed.length) return setError('Add at least one item with a price')
      const w = receiptWeights(parsed, participants)
      const positive = {}
      for (const [id, v] of Object.entries(w)) if (v > 0) positive[id] = v
      const shares = splitByWeights(cents, positive)
      splits = Object.keys(shares)
        .map(Number)
        .sort((a, b) => a - b)
        .map((uid) => ({ user_id: uid, share_cents: shares[uid] }))
      // Subtotal isn't stored — it's just the sum of the items.
      split = {
        mode: 'items',
        participants,
        items: parsed,
        tax_cents: toCents(tax),
        tip_cents: toCents(tip),
      }
    } else {
      const w = {}
      for (const m of members) {
        const v = parseFloat(weights[m.id])
        if (v > 0) w[m.id] = v
      }
      const ids = Object.keys(w)
      if (!ids.length) {
        return setError(
          mode === 'percentage'
            ? 'Enter a percentage for at least one person'
            : 'Enter shares for at least one person'
        )
      }
      if (mode === 'percentage') {
        const sum = ids.reduce((t, id) => t + w[id], 0)
        if (Math.abs(sum - 100) > 0.001) {
          return setError(`Percentages must total 100 (now ${sum})`)
        }
      }
      const shares = splitByWeights(cents, w)
      splits = Object.keys(shares)
        .map(Number)
        .sort((a, b) => a - b)
        .map((uid) => ({ user_id: uid, share_cents: shares[uid] }))
      split = { mode, weights: w }
    }

    if (!payerIds.length) return setError('Pick who paid')
    let payers
    if (payerIds.length === 1) {
      payers = [{ user_id: payerIds[0], paid_cents: cents }]
    } else {
      payers = payerIds.map((uid) => ({
        user_id: uid,
        paid_cents: Math.round(parseFloat(payerAmounts[uid]) * 100) || 0,
      }))
      if (payers.some((p) => p.paid_cents <= 0)) {
        return setError('Each payer must have paid a positive amount')
      }
      const sum = payers.reduce((t, p) => t + p.paid_cents, 0)
      if (sum !== cents) {
        return setError(
          `Payments must add up to ${money(cents)} (now ${money(sum)})`
        )
      }
    }

    try {
      await onSubmit(
        {
          expense_id: initial?.expense_id ?? crypto.randomUUID(),
          description: description.trim(),
          amount_cents: cents,
          payers,
          splits,
          split,
          date,
          category: category.trim(),
          receipts,
          deleted: initial?.deleted ?? false,
          updated_at: Date.now(),
        },
        !!initial
      )
    } catch (err) {
      setError(err.message)
    }
  }

  // Live receipt maths: the gap between the items and the total is the tax/tip
  // (or discount) that gets spread proportionally.
  const amountCents = toCents(amount)
  const itemsTotalCents = items.reduce(
    (t, it) => t + toCents(it.price),
    0
  )
  const taxCents = toCents(tax)
  const tipCents = toCents(tip)
  // The pending scan reconciles live, so fixing a misread line clears the
  // warning as you type rather than only on a re-scan.
  const pendingItemsCents = (pending?.items ?? []).reduce(
    (t, it) => t + toCents(it.price),
    0
  )
  const pendingSubtotalCents = toCents(pending?.subtotal)
  // No subtotal to check against means nothing to reconcile, same as on arrival.
  const pendingGap = pendingSubtotalCents
    ? pendingItemsCents - pendingSubtotalCents
    : 0
  // Whatever the gap isn't explained by the tax and tip the user entered.
  const unexplained = amountCents - itemsTotalCents - taxCents - tipCents
  const unexplainedLabel =
    unexplained < 0 ? 'discount' : taxCents || tipCents ? 'other' : 'tax/tip'

  return (
    <form onSubmit={submit}>
      <h3>{initial ? 'Edit expense' : 'Add an expense'}</h3>
      <input
        placeholder="description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <input
        placeholder="amount (e.g. 42.50)"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label className="field">
        date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <input
        placeholder="category (optional)"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      />

      <fieldset className="participants">
        <legend>paid by</legend>
        {members.map((m) => {
          const checked = payerIds.includes(m.id)
          return (
            <label key={m.id} className="check">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(payerIds, setPayerIds, m.id)}
              />
              {m.display_name}
              {checked && payerIds.length > 1 && (
                <input
                  className="pay-amt"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={payerAmounts[m.id] ?? ''}
                  onChange={(e) =>
                    setPayerAmounts((a) => ({ ...a, [m.id]: e.target.value }))
                  }
                />
              )}
            </label>
          )
        })}
      </fieldset>

      {savedSplits.length > 0 && (
        <label className="field">
          copy a split
          <select
            value=""
            onChange={(e) => {
              const opt = savedSplits.find((o) => o.id === e.target.value)
              if (!opt) return
              // Stamp by value: set the three pieces of split state and let the
              // ordinary submit path resolve them against this amount.
              const s = applyOption(opt, members)
              setMode(s.mode)
              setWeights(s.weights)
              setExcluded(s.excluded)
            }}
          >
            <option value="">reuse a past split…</option>
            {savedSplits.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        split
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="equal">equally</option>
          <option value="percentage">by percentage</option>
          <option value="shares">by shares</option>
          <option value="items">by receipt items</option>
        </select>
      </label>

      {/* Keeping the receipt needs no API key. Scanning is a separate,
          optional step on top — and either one can start an expense, so
          neither is hidden behind picking a split mode first. */}
      {/* No `capture`: it forces the camera on mobile and hides the file
          picker. Without it the OS offers both — take a photo, or choose an
          image you already have — which is what people want for a receipt
          that arrived by email or is already in their camera roll. */}
      <label className="scan">
        {uploading ? 'uploading…' : '📎 add a receipt'}
        <input
          type="file"
          accept="image/*"
          disabled={uploading || scanning}
          onChange={attach}
        />
      </label>
      {ai?.active && (
        <label className="scan">
          {scanning
            ? 'scanning…'
            : uploading
              ? 'uploading…'
              : `📷 add and scan with ${PROVIDERS[ai.active]?.label ?? ai.active}`}
          <input
            type="file"
            accept="image/*"
            disabled={uploading || scanning}
            onChange={scanNew}
          />
        </label>
      )}

      {receipts.length > 0 && (
        <fieldset className="participants receipt">
          <legend>receipts</legend>
          {receipts.map((rid) => (
            <div key={rid} className="receipt-row">
              <ReceiptThumb groupId={groupId} receiptId={rid} />
              {/* No scan button here: re-reading a receipt lives on the
                  expense's detail view, once there's an expense to attach
                  the result to. */}
              <button
                type="button"
                className="link danger"
                onClick={() =>
                  setReceipts((prev) => prev.filter((id) => id !== rid))
                }
              >
                remove
              </button>
            </div>
          ))}
        </fieldset>
      )}

      {pending && (
        <fieldset className="participants receipt">
          <legend>check this scan</legend>
          {pendingGap === 0 ? (
            <p className="muted">
              These items add up to {money(pendingItemsCents)}, matching the
              subtotal.
            </p>
          ) : (
            <p className="error">
              These items add up to {money(pendingItemsCents)}, but the
              receipt&rsquo;s subtotal reads {money(pendingSubtotalCents)} —{' '}
              {money(Math.abs(pendingGap))}{' '}
              {pendingGap > 0 ? 'over' : 'short'}. Fix whichever one is wrong,
              or use it as it is.
            </p>
          )}
          <ReceiptEditor
            legend="scanned items"
            items={pending.items}
            setItems={(update) =>
              setPending((p) => ({
                ...p,
                items: typeof update === 'function' ? update(p.items) : update,
              }))
            }
            // Claiming comes after the receipt is right, in the form proper.
            participants={[]}
          />
          <label className="field">
            subtotal printed on the receipt
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={pending.subtotal}
              onChange={(e) =>
                setPending((p) => ({ ...p, subtotal: e.target.value }))
              }
            />
          </label>
          <p className="muted">
            {pending.tax ? `tax ${money(toCents(pending.tax))} · ` : ''}
            {pending.tip ? `tip ${money(toCents(pending.tip))} · ` : ''}
            total {money(toCents(pending.total))} (editable once you use it)
          </p>
          <div className="row-actions">
            <button type="button" onClick={() => applyDraft(pending)}>
              {pendingGap === 0 ? 'use these items' : 'use them anyway'}
            </button>
            <button
              type="button"
              className="link danger"
              onClick={() => setPending(null)}
            >
              discard scan
            </button>
          </div>
        </fieldset>
      )}

      {(mode === 'equal' || mode === 'items') && (
        <fieldset className="participants">
          <legend>{mode === 'items' ? 'on the receipt' : 'split between'}</legend>
          {members.map((m) => (
            <label key={m.id} className="check">
              <input
                type="checkbox"
                checked={!excluded.includes(m.id)}
                onChange={() => toggle(excluded, setExcluded, m.id)}
              />
              {m.display_name}
            </label>
          ))}
        </fieldset>
      )}

      {mode === 'items' && (
        <>
          <ReceiptEditor
            items={items}
            setItems={setItems}
            participants={members.filter((m) => !excluded.includes(m.id))}
          />
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
          {itemsTotalCents > 0 && (
            <p className="muted">
              items {money(itemsTotalCents)}
              {taxCents ? ` · tax ${money(taxCents)}` : ''}
              {tipCents ? ` · tip ${money(tipCents)}` : ''}
              {unexplained !== 0
                ? ` · ${unexplainedLabel} ${money(Math.abs(unexplained))}`
                : ''}{' '}
              · total {money(amountCents)}
            </p>
          )}
        </>
      )}

      {(mode === 'percentage' || mode === 'shares') && (
        <fieldset className="participants">
          <legend>
            {mode === 'percentage' ? 'percentages (total 100)' : 'shares'}
          </legend>
          {members.map((m) => (
            <label key={m.id} className="check">
              {m.display_name}
              <input
                className="pay-amt"
                inputMode="decimal"
                placeholder={mode === 'percentage' ? '%' : '0'}
                value={weights[m.id] ?? ''}
                onChange={(e) =>
                  setWeights((w) => ({ ...w, [m.id]: e.target.value }))
                }
              />
            </label>
          ))}
        </fieldset>
      )}

      <div className="row-actions">
        <button type="submit">{initial ? 'Save changes' : 'Add expense'}</button>
        {initial && (
          <button type="button" className="link" onClick={onCancel}>
            cancel
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
