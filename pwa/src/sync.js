// Reconciling this device's copy of the log with the server's.
//
// Push first, then pull. Pushing first means our own events come back in the
// same pull carrying their real server ids, so there is never a window where
// the local copy disagrees with the order everyone else will see.
//
// The server assigns the total order and is idempotent on `event_id`, which is
// what makes this safe to retry: pushing the same event twice returns the id
// it already has. See plan/04.

import { api } from './api'
import {
  localEvents,
  meta,
  pending,
  putEvents,
  queue,
  setMeta,
  unqueue,
} from './store'

// Unsent events sort after everything the server has issued, because from this
// device they are the newest thing that happened. Well clear of any real id,
// and still an ordinary number so the fold's `a - b` comparisons hold.
export const PENDING_ID = Number.MAX_SAFE_INTEGER - 1e6

let nextPending = 0
const provisionalId = () => PENDING_ID + (nextPending += 1)

/** Write an event: store it locally, show it immediately, send it when we can.
 *
 *  Returns as soon as it is durable *here*. The caller re-folds and the user
 *  sees their expense whether or not anything reached the network. */
export async function append(groupId, { event_id, type, payload }) {
  const row = {
    group_id: groupId,
    event_id,
    type,
    payload,
    id: provisionalId(),
    pending: true,
    queued_at: Date.now(),
  }
  await putEvents([row])
  await queue(row)
  return row
}

/** Send everything queued for a group, oldest first.
 *
 *  Stops at the first event the network refuses, leaving the rest queued —
 *  order is part of the meaning, so a later edit must not overtake the create
 *  it depends on. */
export async function flush(groupId, { onRejected } = {}) {
  const rows = await pending(groupId)
  let sent = 0
  for (const row of rows) {
    try {
      const res = await api(`groups/${groupId}/events`, {
        event_id: row.event_id,
        type: row.type,
        payload: row.payload,
      })
      // Idempotent on the server, so a duplicate is a success: it tells us the
      // id our event already has.
      await putEvents([{ ...row, id: res.id, pending: false }])
      await unqueue(row.event_id)
      sent += 1
    } catch (err) {
      if (isPermanent(err)) {
        // It will never be accepted — a stale bundle, or writing to a group we
        // have been ghosted out of. Leaving it queued would block every write
        // behind it forever, so drop it and say so rather than retrying into
        // a wall.
        await unqueue(row.event_id)
        onRejected?.(row, err)
        continue
      }
      break // offline, or the server is unwell: try again later
    }
  }
  return sent
}

// A refusal we can never satisfy by waiting. `api()` throws Errors carrying
// the server's own message, so match on what the server actually says.
function isPermanent(err) {
  const m = String(err?.message ?? '')
  return (
    /no longer part of this group/i.test(m) ||
    /written by the server/i.test(m) ||
    /old version of Split/i.test(m) ||
    /event_id and type required/i.test(m)
  )
}

/** Pull everything since our cursor and fold it in. */
export async function pull(groupId) {
  const { cursor } = await meta(groupId)
  const res = await api(`groups/${groupId}/events?since=${cursor}`)
  if (res.events.length) {
    await putEvents(
      res.events.map((e) => ({ ...e, group_id: groupId, pending: false }))
    )
  }
  // The version is the group's position in the log even when nothing came
  // back, so record it either way.
  await setMeta(groupId, { cursor: res.version })
  return res
}

/** Push then pull. Returns the events this device now holds, in order.
 *
 *  Never throws for want of a network: an offline sync is a no-op that still
 *  hands back the local log, because the whole point is that the UI does not
 *  care. */
export async function sync(groupId, { onRejected } = {}) {
  let online = true
  try {
    await flush(groupId, { onRejected })
    await pull(groupId)
  } catch {
    online = false
  }
  return { events: await localEvents(groupId), online }
}
