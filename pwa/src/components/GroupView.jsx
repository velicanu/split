// One group: the local-first fold, the balances/ledger/payments, and every
// action (add expense, settle, invite, share, ghost, revive).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../api'
import { decryptPayload, encryptPayload } from '../crypto'
import { createGroupKey, groupKey } from '../groupkeys'
import { computeState, simplify } from '../ledger'
import { splitOptions } from '../copysplit'
import { memberIdFor, money } from '../format'
import { planRevive } from '../revive'
import {
  localEvents,
  meta as localMeta,
  pendingCount,
  setMeta as setLocalMeta,
} from '../store'
import { append, flush, sync } from '../sync'
import { AddGhost, LeaveOrGhost } from './members'
import { ExpenseDetail } from './ExpenseDetail'
import { ExpenseForm } from './ExpenseForm'
import { InviteLink, ShareReadOnly } from './sharing'
import { LedgerLog } from './LedgerLog'
import { Payments, SettleUp } from './settle'

export function GroupView({ groupId, me, ai, onBack, onOpen }) {
  const [meta, setMeta] = useState(null)
  const [events, setEvents] = useState([])
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState(null) // null = add mode; else an expense
  const [viewingId, setViewingId] = useState(null) // expense_id shown in detail
  // Bumped to remount (and so reset) the add-expense form after a create.
  const [formNonce, setFormNonce] = useState(0)
  // A receipt to scan as soon as the edit form opens, set by the detail view.
  const [scanReceipt, setScanReceipt] = useState(null)
  const [error, setError] = useState('')
  // No readable copy of this group's key on this device.
  const [locked, setLocked] = useState(false)
  const [unreadable, setUnreadable] = useState(0)
  const [showLog, setShowLog] = useState(false)
  // Whether the last sync reached the server, and how many of our own writes
  // are still waiting to. Both are shown: an app that quietly holds writes is
  // worse than one that says so.
  const [online, setOnline] = useState(true)
  const [pendingWrites, setPendingWrites] = useState(0)
  // A sync started before this view closed must not keep writing to the store
  // or to state afterwards. Switching groups quickly, or closing one mid-pull,
  // otherwise lets a finished request land in a view that has moved on.
  const alive = useRef(true)

  // Everything the UI shows comes from the local copy of the log. The network
  // only ever adds to it, so the app works the same offline as on. plan/04.
  const openLocal = useCallback(async () => {
    const rows = await localEvents(groupId)
    if (!rows.length || !alive.current) return
    const key = await groupKey(groupId)
    if (!key) {
      setLocked(true)
      return
    }
    setLocked(false)
    const opened = []
    let bad = 0
    for (const e of rows) {
      // member.added is written by the server, which has no key, so it is the
      // one event that is never encrypted.
      if (!e.payload?.enc) {
        opened.push(e)
        continue
      }
      try {
        opened.push({ ...e, payload: await decryptPayload(key, e.payload.enc) })
      } catch {
        // Skip rather than throw: one bad row must not blank the whole group.
        bad += 1
      }
    }
    setUnreadable(bad)
    setEvents(opened)
    setVersion((await localMeta(groupId)).cursor)
  }, [groupId])

  // Push what we have written, pull what we have not seen, then re-read.
  const refresh = useCallback(async () => {
    const { online: reachable } = await sync(groupId, {
      onRejected: (row, err) =>
        setError(`A change could not be saved and was discarded: ${err.message}`),
    })
    if (!alive.current) return
    setOnline(reachable)
    await openLocal()
    if (!alive.current) return
    setPendingWrites(await pendingCount())
  }, [groupId, openLocal])

  useEffect(() => {
    alive.current = true
    setEvents([])
    setVersion(0)
    setEditing(null)
    setViewingId(null)
    setUnreadable(0)
    // Local first, and without waiting for anything: with no signal this is
    // the whole of what the user sees, and with one it beats the round trip.
    openLocal().then(refresh)
    // Cached so the name is there offline too.
    api(`groups/${groupId}`)
      .then((m) => {
        setMeta(m)
        setLocalMeta(groupId, { name: m.name })
      })
      .catch(async () => {
        const { name } = await localMeta(groupId)
        if (name) setMeta({ id: groupId, name })
      })
    const timer = setInterval(refresh, 5000)
    const onOnline = () => refresh()
    window.addEventListener('online', onOnline)
    return () => {
      alive.current = false
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [groupId, openLocal, refresh])

  // Everything displayed is folded from the ledger, client-side.
  const state = useMemo(() => computeState(events), [events])
  const suggestions = useMemo(() => simplify(state.balances), [state.balances])
  // Distinct ratio splits already in this group's ledger, to reuse on a new
  // expense. Excludes the one being edited so it can't copy from itself.
  const savedSplits = useMemo(
    () => splitOptions(state.ledger, state.members, { excludeId: editing?.expense_id }),
    [state.ledger, state.members, editing]
  )
  const meId = memberIdFor(state.members, me)
  // Look the viewed expense up live so edits/new comments show while it's open.
  const viewing = viewingId
    ? state.ledger.find((x) => x.expense_id === viewingId) || null
    : null

  // The only way an event reaches the server: everything is sealed with the
  // group key first, so no caller can forget to encrypt.
  const appendEvent = useCallback(
    async (type, payload) => {
      const key = await groupKey(groupId)
      if (!key) throw new Error('No key for this group on this device')
      // Stored here first, so the write is durable and on screen whether or
      // not there is a network. The id comes back provisional and is replaced
      // by the server's when it lands — which is why ghosting, which needs a
      // real log position, flushes before reading it.
      const row = await append(groupId, {
        event_id: crypto.randomUUID(),
        type,
        payload: { enc: await encryptPayload(key, payload) },
      })
      return row
    },
    [groupId]
  )

  // Append a create or update event; an edit reuses the expense's stable id
  // so the fold treats it as the latest revision of the same expense.
  async function submitExpense(payload, isEdit) {
    await appendEvent(isEdit ? 'expense.updated' : 'expense.created', payload)
    setEditing(null)
    setScanReceipt(null)
    // Leaving an edit already remounts the form (the key changes back), but
    // creating doesn't — so the draft, receipts and all, would otherwise sit
    // there after the expense was filed. Bump the key to get a clean form.
    setFormNonce((n) => n + 1)
    await refresh()
  }

  // Soft delete / restore is just another revision with the flag flipped.
  async function setDeleted(x, deleted) {
    try {
      // Carry every field forward: a revision replaces the expense wholesale,
      // so anything left out here is destroyed by a delete or a restore.
      await appendEvent('expense.updated', {
        expense_id: x.expense_id,
        description: x.description,
        amount_cents: x.amount_cents,
        payers: x.payers,
        splits: x.splits,
        split: x.split,
        date: x.date,
        category: x.category,
        receipts: x.receipts,
        deleted,
        updated_at: Date.now(),
      })
      await refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  // Settlements are ledger events too. Suggestions are derived (never stored);
  // recording/editing/deleting a payment is what actually moves balances.
  async function appendSettlement(payload, isEdit) {
    try {
      await appendEvent(isEdit ? 'settlement.updated' : 'settlement.created', {
        ...payload,
        updated_at: Date.now(),
      })
      await refresh()
    } catch (err) {
      setError(err.message)
      throw err
    }
  }
  // Turn a member into a ghost. Anyone may do this to anyone, themselves
  // included — leaving is ghosting yourself. It takes nothing away: the server
  // keeps serving them the group frozen at this event. See plan/12.
  async function ghostMember(member_id) {
    // The one write that cannot be queued: the cut is a position in the server's
    // log, and a provisional id is not one. So flush, and read back the id the
    // server actually gave the event. Offline this throws, which is right —
    // freezing someone's view is not something to do optimistically.
    const row = await appendEvent('member.left', {
      member_id,
      updated_at: Date.now(),
    })
    await flush(groupId)
    const stored = (await localEvents(groupId)).find(
      (e) => e.event_id === row.event_id
    )
    if (!stored || stored.pending) {
      throw new Error('You need to be online to remove someone from a group')
    }
    const res = await api(`groups/${groupId}/ghost`, {
      member_id,
      at_event_id: stored.id,
    })
    if (member_id === meId || res.deleted) {
      // Either I just left, or nobody is reading this group any more.
      onBack()
      return
    }
    await refresh()
  }

  // Clone what I can still see into a group of my own. The prefix I was served
  // is mine to keep; replaying it is what turns a frozen view into somewhere I
  // can carry on. See plan/12.
  async function revive() {
    setError('')
    try {
      const g = await api('groups', { name: meta.name })
      // Before any event exists, so there is never a window in which one would
      // have nothing to encrypt under.
      const key = await createGroupKey(g.id)
      const { events: planned } = planRevive(state, meId, {
        from: { group_id: groupId, at_event_id: version },
      })
      for (const ev of planned) {
        await api(`groups/${g.id}/events`, {
          event_id: crypto.randomUUID(),
          type: ev.type,
          payload: { enc: await encryptPayload(key, ev.payload) },
        })
      }
      // Only once the clone is safely written. Hiding first would risk losing
      // sight of the original with nothing to show for it.
      await api(`groups/${groupId}/hide`, {})
      onOpen(g.id)
    } catch (err) {
      setError(err.message)
    }
  }

  // Someone who splits expenses with the group but doesn't use the app.
  // Negative ids so they can never collide with a server-issued user id, and
  // still numbers so the split maths keeps working. See plan/12.
  const addGhost = async (display_name) => {
    const member_id = -(Math.floor(Math.random() * 2 ** 45) + 1)
    await appendEvent('member.ghost_added', {
      member_id,
      display_name,
      updated_at: Date.now(),
    })
    await refresh()
    // Returned so an invite can name them: inviting someone is inviting them
    // to be this member.
    return member_id
  }

  const recordSettlement = (from, to, amount_cents) =>
    appendSettlement(
      {
        settlement_id: crypto.randomUUID(),
        from,
        to,
        amount_cents,
        date: new Date().toISOString().slice(0, 10),
        deleted: false,
      },
      false
    )
  const editSettlement = (s, amount_cents) =>
    appendSettlement(
      { settlement_id: s.settlement_id, from: s.from, to: s.to, amount_cents, date: s.date, deleted: false },
      true
    )
  const deleteSettlement = (s) =>
    appendSettlement(
      { settlement_id: s.settlement_id, from: s.from, to: s.to, amount_cents: s.amount_cents, date: s.date, deleted: true },
      true
    )

  // Comments are ledger events attached to an expense; author edits/deletes own.
  async function appendComment(payload, isEdit) {
    try {
      await appendEvent(isEdit ? 'comment.updated' : 'comment.created', {
        ...payload,
        updated_at: Date.now(),
      })
      await refresh()
    } catch (err) {
      setError(err.message)
      throw err
    }
  }
  const postComment = (expense_id, text) =>
    appendComment(
      { comment_id: crypto.randomUUID(), expense_id, text, deleted: false },
      false
    )
  const editComment = (c, text) =>
    appendComment(
      { comment_id: c.comment_id, expense_id: c.expense_id, text, deleted: false },
      true
    )
  const deleteComment = (c) =>
    appendComment(
      { comment_id: c.comment_id, expense_id: c.expense_id, text: c.text, deleted: true },
      true
    )

  if (!meta) return null

  // Ghosted, or claimed away by someone who joined as me. Either way there is
  // nobody here to attribute a new expense to, and picking a stand-in would be
  // worse than refusing.
  const meGhosted = !!state.members.find((m) => m.id === meId)?.ghost
  if (state.members.length > 0 && (meId === null || meGhosted)) {
    return (
      <section>
        <button className="link" onClick={onBack}>
          ← groups
        </button>
        <h2>{meta.name}</h2>
        <p className="muted">
          You&rsquo;re no longer part of this group. What you can see here is
          how it stood when you left; it won&rsquo;t change again.
        </p>
        {meGhosted && (
          <div className="revive">
            <p>
              You can carry on with a copy of your own. Every balance comes
              across exactly as it stands; everyone else becomes a ghost, so
              you can keep splitting with them, invite them, or settle up.
            </p>
            <p className="muted">
              Receipt images and comments stay behind. Nothing owed changes.
            </p>
            <button onClick={revive}>Revive as my own group</button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <LedgerLog
          group={{ id: groupId, name: meta.name }}
          version={version}
          events={events}
          unreadable={unreadable}
          members={state.members}
          onClose={onBack}
        />
      </section>
    )
  }

  if (locked) {
    return (
      <section>
        <button className="link" onClick={onBack}>
          ← groups
        </button>
        <h2>{meta.name}</h2>
        <p className="error">
          This device has no key for this group, so nothing here can be read.
          Open it on a device that does, or ask someone for a fresh invite link.
        </p>
      </section>
    )
  }

  return (
    <section>
      <button className="link" onClick={onBack}>
        ← groups
      </button>
      <h2>{meta.name}</h2>
      <p className="muted">
        synced v{version} ·{' '}
        <button className="link" onClick={() => setShowLog(true)}>
          log
        </button>
      </p>
      <InviteLink
        groupId={groupId}
        code={meta.code}
        members={state.members}
        onAddGhost={addGhost}
      />
      <ShareReadOnly groupId={groupId} code={meta.code} />
      {showLog && (
        <LedgerLog
          group={{ id: groupId, name: meta.name }}
          version={version}
          events={events}
          unreadable={unreadable}
          members={state.members}
          onClose={() => setShowLog(false)}
        />
      )}
      {(!online || pendingWrites > 0) && (
        <p className="muted sync-state">
          {pendingWrites > 0
            ? `${pendingWrites} change${pendingWrites === 1 ? '' : 's'} saved on this device, waiting to sync.`
            : 'Offline — showing what this device already has.'}
        </p>
      )}
      {unreadable > 0 && (
        <p className="error">
          {unreadable} entr{unreadable === 1 ? 'y' : 'ies'} could not be
          decrypted and {unreadable === 1 ? 'was' : 'were'} skipped.
        </p>
      )}

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

      <h3>Settle up</h3>
      <SettleUp suggestions={suggestions} onRecord={recordSettlement} />

      <AddGhost onAdd={addGhost} />
      <LeaveOrGhost members={state.members} meId={meId} onGhost={ghostMember} />

      {state.members.length > 0 && (
        <ExpenseForm
          key={editing?.expense_id || `new-${formNonce}`}
          groupId={groupId}
          members={state.members}
          me={me}
          ai={ai}
          initial={editing}
          savedSplits={savedSplits}
          scanOnOpen={scanReceipt}
          onSubmit={submitExpense}
          onCancel={() => {
            setEditing(null)
            setScanReceipt(null)
          }}
        />
      )}

      <h3>Ledger</h3>
      {state.ledger.length === 0 && <p className="muted">No expenses yet.</p>}
      <ul className="list">
        {state.ledger.map((x) => (
          <li
            key={x.expense_id}
            className={`row static${x.deleted ? ' deleted' : ''}`}
          >
            <div
              className="expense clickable"
              onClick={() => setViewingId(x.expense_id)}
            >
              <span>
                {x.description}
                {x.deleted ? ' (deleted)' : ''}
              </span>
              <span className="muted">
                {x.payer_names.join(', ')} paid {money(x.amount_cents)} · split{' '}
                {x.ways} way{x.ways === 1 ? '' : 's'}
                {x.date ? ` · ${x.date}` : ''}
                {x.category ? ` · ${x.category}` : ''}
                {x.comments.length > 0 ? ` · 💬 ${x.comments.length}` : ''}
              </span>
            </div>
            <div className="row-actions">
              <button
                className="link"
                onClick={() => setEditing(x)}
                disabled={x.deleted}
              >
                edit
              </button>
              {x.deleted ? (
                <button className="link" onClick={() => setDeleted(x, false)}>
                  restore
                </button>
              ) : (
                <button
                  className="link danger"
                  onClick={() => setDeleted(x, true)}
                >
                  delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <h3>Payments</h3>
      <Payments
        payments={state.payments}
        onEdit={editSettlement}
        onDelete={deleteSettlement}
      />
      {error && <p className="error">{error}</p>}

      {viewing && (
        <ExpenseDetail
          groupId={groupId}
          expense={viewing}
          members={state.members}
          meId={meId}
          ai={ai}
          // Scanning a stored receipt opens the expense for editing with the
          // scan already running: the result has to land somewhere editable,
          // and that's the form.
          onScan={(receiptId) => {
            setViewingId(null)
            setEditing(viewing)
            setScanReceipt(receiptId)
          }}
          onClose={() => setViewingId(null)}
          onPost={postComment}
          onEdit={editComment}
          onDelete={deleteComment}
        />
      )}
    </section>
  )
}
