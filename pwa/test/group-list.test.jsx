// The group list has to survive with no network — it is the app's front page,
// and a blank one made the whole app look broken offline even though every
// group page worked. The bug: it only ever fetched, so when the fetch threw
// the list stayed null and nothing rendered. See plan/04.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { GroupList } from '../src/components/GroupList.jsx'
import { forgetLocalLedger, localGroups, setMeta } from '../src/store.js'
import { $$, byText, mount, text, unmount } from './react.mjs'

// Online, then off: the second call to fetch (and every one after) fails, the
// way a tab does when the signal drops.
function server(groups) {
  let online = true
  globalThis.fetch = async (url) => {
    if (!online) throw new TypeError('Failed to fetch')
    if (String(url).endsWith('/api/groups')) {
      return { ok: true, json: async () => groups }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { goOffline: () => (online = false) }
}

const rows = () => $$('.list .row').map((b) => b.textContent)

afterEach(async () => {
  await forgetLocalLedger()
  await unmount()
})

describe('the group list', () => {
  test('shows what the server returns', async () => {
    server([
      { id: 1, name: 'Trip', members: 3 },
      { id: 2, name: 'Flat', members: 2 },
    ])
    await mount(<GroupList onOpen={() => {}} />)

    assert.deepEqual(rows(), ['Trip3 members', 'Flat2 members'])
  })

  test('caches each group so it is there with no network', async () => {
    server([{ id: 1, name: 'Trip', members: 3 }])
    await mount(<GroupList onOpen={() => {}} />)
    // Going through the list once is what caches it.
    const cached = await localGroups()
    assert.deepEqual(cached, [{ id: 1, cursor: 0, name: 'Trip', members: 3 }])
  })

  test('renders the cached list offline instead of a blank page', async () => {
    // The actual bug: with the fetch failing, this used to stay null forever
    // and the page rendered nothing at all.
    await setMeta(7, { name: 'Trip', members: 3 })
    const net = server([])
    net.goOffline()

    await mount(<GroupList onOpen={() => {}} />)
    assert.deepEqual(rows(), ['Trip3 members'], 'listed, with the cached count')
  })

  test('offline, a group cached before member counts were stored says so', async () => {
    // An older cache entry has a name but no count. Better to say "offline"
    // than to render "undefined members" or an alarming zero.
    await setMeta(7, { name: 'Trip' })
    const net = server([])
    net.goOffline()

    await mount(<GroupList onOpen={() => {}} />)
    assert.ok(byText('span', 'Trip'), 'the group is listed')
    assert.ok(text().includes('offline'), 'and the count reads as not current')
  })

  test('offline, hides groups it only holds events for but has no name yet', async () => {
    // A group we have synced events into but never opened has a cursor and no
    // name — there is nothing to label it with, so it is not shown.
    await setMeta(7, { name: 'Trip', members: 3 })
    await setMeta(9, { cursor: 40 })
    const net = server([])
    net.goOffline()

    await mount(<GroupList onOpen={() => {}} />)
    assert.deepEqual(rows(), ['Trip3 members'])
  })

  test('an online refresh replaces the offline placeholder', async () => {
    // Cached from a previous session, then the network comes back.
    await setMeta(1, { name: 'Trip' }) // no member count cached
    server([{ id: 1, name: 'Trip', members: 5 }])

    await mount(<GroupList onOpen={() => {}} />)
    assert.deepEqual(rows(), ['Trip5 members'], 'the real count, not "offline"')
  })
})
