// Offline-first is a promise about what survives: a write made with no signal
// has to still be there after a reload, reach the server when there is one,
// and end up in the order everyone else sees. These lean on that rather than
// on the shape of the calls.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { append, flush, pull, sync, PENDING_ID } from './sync.js'
import {
  forgetLocalLedger,
  localEvents,
  meta,
  pending,
  pendingCount,
} from './store.js'

const GROUP = 7

// A server that behaves like ours: assigns ids, is idempotent on event_id,
// and can be switched off to simulate a tunnel.
function server({ offline = false } = {}) {
  const state = { events: [], nextId: 100, offline, refuse: null, pushes: 0 }

  globalThis.fetch = async (url, options) => {
    if (state.offline) throw new TypeError('Failed to fetch')
    const path = String(url)
    const body = options?.body ? JSON.parse(options.body) : null

    if (path.includes('/events') && body) {
      state.pushes += 1
      if (state.refuse) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ detail: state.refuse }),
        }
      }
      const already = state.events.find((e) => e.event_id === body.event_id)
      if (already) {
        return { ok: true, json: async () => ({ id: already.id, duplicate: true }) }
      }
      const row = { ...body, id: (state.nextId += 1), author: 1 }
      state.events.push(row)
      return { ok: true, json: async () => ({ id: row.id }) }
    }
    if (path.includes('/events')) {
      const since = Number(path.split('since=')[1] ?? 0)
      return {
        ok: true,
        json: async () => ({
          version: state.events.at(-1)?.id ?? since,
          events: state.events.filter((e) => e.id > since),
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return state
}

const event = (n) => ({
  event_id: `evt-${n}`,
  type: 'expense.created',
  payload: { enc: `sealed-${n}` },
})

beforeEach(forgetLocalLedger)
afterEach(forgetLocalLedger)

describe('writing with no network', () => {
  test('the event is kept, and shows up straight away', async () => {
    server({ offline: true })
    await append(GROUP, event(1))

    const local = await localEvents(GROUP)
    assert.equal(local.length, 1)
    assert.equal(local[0].event_id, 'evt-1')
    assert.ok(local[0].pending, 'and is marked as not yet sent')
  })

  test('it survives a reload', async () => {
    // The whole point: IndexedDB, not React state. Nothing here re-mounts a
    // component, so reading it back is exactly what a reload does.
    server({ offline: true })
    await append(GROUP, event(1))
    assert.equal((await localEvents(GROUP)).length, 1)
    assert.equal(await pendingCount(), 1)
  })

  test('syncing offline is a no-op that still returns the local log', async () => {
    server({ offline: true })
    await append(GROUP, event(1))

    const res = await sync(GROUP)
    assert.equal(res.online, false)
    assert.equal(res.events.length, 1, 'the UI still has something to render')
  })

  test('pending events sort after everything the server has issued', async () => {
    const s = server()
    s.events.push({ event_id: 'old', id: 50, type: 'expense.created', payload: {} })
    await pull(GROUP)
    await append(GROUP, event(1))

    const local = await localEvents(GROUP)
    assert.deepEqual(local.map((e) => e.event_id), ['old', 'evt-1'])
    assert.ok(local[1].id > PENDING_ID, 'provisional, and clear of any real id')
  })
})

describe('coming back online', () => {
  test('queued writes reach the server and stop being pending', async () => {
    const s = server({ offline: true })
    await append(GROUP, event(1))
    await append(GROUP, event(2))

    s.offline = false
    const res = await sync(GROUP)

    assert.equal(res.online, true)
    assert.equal(await pendingCount(), 0)
    assert.deepEqual(s.events.map((e) => e.event_id), ['evt-1', 'evt-2'])
  })

  test('they take the ids the server gave them, not the provisional ones', async () => {
    const s = server({ offline: true })
    await append(GROUP, event(1))
    s.offline = false
    await sync(GROUP)

    const local = await localEvents(GROUP)
    assert.equal(local.length, 1, 'one row, not one local and one from the pull')
    assert.ok(local[0].id < PENDING_ID, 'a real id')
    assert.equal(local[0].id, s.events[0].id)
    assert.ok(!local[0].pending)
  })

  test('order is preserved, because an edit must not overtake its create', async () => {
    const s = server({ offline: true })
    for (const n of [1, 2, 3]) await append(GROUP, event(n))
    s.offline = false
    await sync(GROUP)

    assert.deepEqual(s.events.map((e) => e.event_id), ['evt-1', 'evt-2', 'evt-3'])
    assert.deepEqual(
      (await localEvents(GROUP)).map((e) => e.event_id),
      ['evt-1', 'evt-2', 'evt-3']
    )
  })

  test('a half-sent outbox keeps the rest queued, in order', async () => {
    const s = server({ offline: true })
    for (const n of [1, 2, 3]) await append(GROUP, event(n))

    // The tunnel ends halfway through.
    s.offline = false
    let calls = 0
    const real = globalThis.fetch
    globalThis.fetch = async (...args) => {
      if (args[1]?.body && ++calls > 2) throw new TypeError('Failed to fetch')
      return real(...args)
    }
    await sync(GROUP)
    globalThis.fetch = real

    assert.deepEqual(s.events.map((e) => e.event_id), ['evt-1', 'evt-2'])
    assert.deepEqual((await pending(GROUP)).map((e) => e.event_id), ['evt-3'])

    await sync(GROUP)
    assert.equal(await pendingCount(), 0)
    assert.deepEqual(s.events.map((e) => e.event_id), ['evt-1', 'evt-2', 'evt-3'])
  })

  test('a retried push is not a duplicate', async () => {
    // The dangerous crash: we sent it, the reply never arrived, so it is still
    // queued. Sending again must not create a second expense.
    const s = server()
    await append(GROUP, event(1))
    await flush(GROUP)
    // Pretend the reply was lost: put it back in the outbox untouched.
    await append(GROUP, event(1))
    await flush(GROUP)

    assert.equal(s.events.length, 1, 'the server kept one')
    assert.equal((await localEvents(GROUP)).length, 1, 'and so did we')
  })
})

describe('an event the server will never accept', () => {
  test('is dropped rather than blocking everything behind it', async () => {
    const s = server({ offline: true })
    await append(GROUP, event(1))
    await append(GROUP, event(2))

    s.offline = false
    s.refuse = 'you are no longer part of this group'
    const rejected = []
    await flush(GROUP, { onRejected: (row) => rejected.push(row.event_id) })

    assert.deepEqual(rejected, ['evt-1', 'evt-2'], 'both refused and reported')
    assert.equal(await pendingCount(), 0, 'the outbox is not jammed')
  })

  test('but a plain outage keeps everything queued', async () => {
    const s = server({ offline: true })
    await append(GROUP, event(1))

    const rejected = []
    await flush(GROUP, { onRejected: (row) => rejected.push(row.event_id) })

    assert.deepEqual(rejected, [], 'an outage is not a refusal')
    assert.equal(await pendingCount(), 1, 'still ours to send later')
    assert.equal(s.pushes, 0)
  })
})

describe('the cursor', () => {
  test('advances so the next pull asks only for what is new', async () => {
    const s = server()
    s.events.push({ event_id: 'a', id: 10, type: 'x', payload: {} })
    await pull(GROUP)
    assert.equal((await meta(GROUP)).cursor, 10)

    s.events.push({ event_id: 'b', id: 11, type: 'x', payload: {} })
    const res = await pull(GROUP)
    assert.deepEqual(res.events.map((e) => e.event_id), ['b'], 'only the new one')
    assert.equal((await meta(GROUP)).cursor, 11)
  })

  test('an empty pull still records where we are', async () => {
    const s = server()
    s.events.push({ event_id: 'a', id: 10, type: 'x', payload: {} })
    await pull(GROUP)
    await pull(GROUP)
    assert.equal((await meta(GROUP)).cursor, 10)
  })
})

describe('groups are kept apart', () => {
  test('a write to one does not appear in another', async () => {
    server({ offline: true })
    await append(GROUP, event(1))
    await append(99, event(2))

    assert.deepEqual((await localEvents(GROUP)).map((e) => e.event_id), ['evt-1'])
    assert.deepEqual((await localEvents(99)).map((e) => e.event_id), ['evt-2'])
    assert.deepEqual((await pending(GROUP)).map((e) => e.event_id), ['evt-1'])
  })
})
