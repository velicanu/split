// Refreshing should land you back where you were, not on the group list. The
// view lives in the URL fragment; these mount Home with a fragment set (which
// is what a refresh looks like) and check the right screen comes back, and
// that moving around keeps the fragment honest. See nav.js.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { Home } from '../src/components/Home.jsx'
import { forgetGroupKeys } from '../src/groupkeys.js'
import { forgetLocalLedger, saveDeviceKey } from '../src/store.js'
import { generateAccountKey, generateDeviceKey } from '../src/crypto.js'
import { act } from 'react'
import { byText, click, mount, settle, text, unmount } from './react.mjs'

// Just enough server for Home and whichever screen it shows to settle.
function fakeApi() {
  const json = (b) => ({ ok: true, json: async () => b })
  globalThis.fetch = async (url) => {
    const p = String(url)
    if (p.endsWith('/ai/settings')) return json({ active: null, providers: {} })
    if (p.endsWith('/api/groups')) return json([{ id: 7, name: 'Trip', members: 2 }])
    if (p.match(/\/api\/groups\/7$/)) return json({ id: 7, name: 'Trip', code: 'abc' })
    if (p.includes('/events')) return json({ version: 0, events: [] })
    if (p.endsWith('/keys')) return json({ keys: [] })
    return json({})
  }
}

const setHash = (h) => {
  window.location.hash = h
}
const user = { id: 1, display_name: 'v' }

beforeEach(() => {
  fakeApi()
  setHash('')
})
afterEach(async () => {
  await unmount()
  forgetGroupKeys()
  await forgetLocalLedger()
  setHash('')
})

describe('restoring the view a refresh started on', () => {
  test('no fragment shows the group list', async () => {
    await mount(<Home user={user} onLogout={() => {}} />)
    assert.ok(text().includes('Total balance'))
  })

  test('#settings comes back to settings, not the list', async () => {
    setHash('#settings')
    await mount(<Home user={user} onLogout={() => {}} />)
    assert.ok(text().includes('Receipt scanning'), 'the settings screen')
    assert.ok(!text().includes('Total balance'), 'and not the list')
  })

  test('#group/7 comes back to that group', async () => {
    setHash('#group/7')
    await mount(<Home user={user} onLogout={() => {}} />)
    assert.ok(byText('h2', 'Trip'), 'the group, by name')
    assert.ok(!text().includes('Total balance'))
  })
})

describe('keeping the fragment in step with the view', () => {
  test('opening settings writes the fragment, so a refresh stays there', async () => {
    await mount(<Home user={user} onLogout={() => {}} />)
    await click(byText('button', 'Settings'))
    assert.equal(window.location.hash, '#settings')
  })

  test('returning to the list clears the fragment', async () => {
    setHash('#settings')
    await mount(<Home user={user} onLogout={() => {}} />)
    // The dock's Groups tab is the way home.
    await click(byText('button', 'Groups'))
    assert.equal(window.location.hash, '')
  })

  test('opening a view pushes history, so back has somewhere to go', async () => {
    // The Android back gesture is a popstate. Before this, navigating replaced
    // the entry instead of pushing, so the stack stayed empty and back exited
    // the app instead of returning to the previous screen.
    await mount(<Home user={user} onLogout={() => {}} />)
    const before = window.history.length
    await click(byText('button', 'Settings'))
    assert.ok(window.history.length > before, 'a new entry to go back to')
  })
})

describe('the back gesture', () => {
  // A back/forward is a popstate with the URL already moved. Simulate it: put
  // the fragment where the browser would leave it, then fire the event.
  const goBackTo = async (hash) => {
    setHash(hash)
    await act(async () => {
      window.dispatchEvent(new window.PopStateEvent('popstate'))
    })
    await settle()
  }

  test('back out of settings returns to where you were', async () => {
    await mount(<Home user={user} onLogout={() => {}} />)
    await click(byText('button', 'Settings'))
    assert.ok(text().includes('Receipt scanning'))

    await goBackTo('') // the list entry the settings push sat on top of
    assert.ok(text().includes('Total balance'), 'back to the list, not out of the app')
    assert.ok(!text().includes('Receipt scanning'))
  })

  test('back out of a group returns to the list', async () => {
    await mount(<Home user={user} onLogout={() => {}} />)
    setHash('#group/7')
    await act(async () => {
      window.dispatchEvent(new window.PopStateEvent('popstate'))
    })
    await settle()
    assert.ok(byText('h2', 'Trip'), 'forward into the group')

    await goBackTo('')
    assert.ok(text().includes('Total balance'))
  })
})

// An invite arriving in the fragment is the one thing that is *not* a view to
// restore, and the two kinds part company here: a link that names a member is
// accepted on sight, a group link has a question to ask first. See invite.js,
// JoinGroup and plan/12.
describe('arriving on an invite link', () => {
  const joined = []

  async function inviteApi() {
    joined.length = 0
    await saveDeviceKey(await generateDeviceKey())
    const account = await generateAccountKey()
    const json = (b) => ({ ok: true, json: async () => b })
    globalThis.fetch = async (url, opts) => {
      const p = String(url)
      const body = opts?.body ? JSON.parse(opts.body) : null
      if (p.endsWith('/ai/settings')) return json({ active: null, providers: {} })
      if (p.includes('/api/groups/preview')) {
        return json({
          id: 7,
          name: 'Trip',
          joined: false,
          events: [{ id: 1, type: 'member.added', payload: { user_id: 1, display_name: 'Val' } }],
        })
      }
      if (p.endsWith('/api/groups/join')) {
        joined.push(body)
        return json({ id: 7, name: 'Trip', code: 'abc' })
      }
      if (p.endsWith('/api/me')) return json({ id: 9, device_id: 'd1' })
      if (p.endsWith('/api/account/box')) {
        return json({ account_box_pubkey: account.box_pubkey })
      }
      if (p.endsWith('/api/groups')) return json([{ id: 7, name: 'Trip', members: 2 }])
      if (p.match(/\/api\/groups\/7$/)) return json({ id: 7, name: 'Trip', code: 'abc' })
      if (p.includes('/events')) return json({ version: 0, events: [] })
      if (p.endsWith('/keys')) return json({ keys: [] })
      return json({})
    }
  }

  test('the member list is fetched once, not on every re-render', async () => {
    // Home re-renders when the AI settings land, and the chooser reloads its
    // member list whenever its props change identity. Inline callbacks made
    // that every render.
    await inviteApi()
    const real = globalThis.fetch
    let previews = 0
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('/api/groups/preview')) previews += 1
      return real(url, opts)
    }
    setHash('#join=abc&gk=deadbeef')
    await mount(<Home user={user} onLogout={() => {}} />)

    assert.equal(previews, 1)
  })

  test('a group link asks who you are instead of joining you', async () => {
    await inviteApi()
    setHash('#join=abc&gk=deadbeef')
    await mount(<Home user={user} onLogout={() => {}} />)

    assert.ok(text().includes('Who are you?'), 'the chooser, not the group')
    assert.deepEqual(joined, [], 'and nothing was joined behind their back')
  })

  test('the group key is out of the address bar while the question is open', async () => {
    // The fragment *is* the key. It is captured in state on the first render,
    // so there is no reason to leave it somewhere a screenshot or a shoulder
    // can pick it up while the joiner decides.
    await inviteApi()
    setHash('#join=abc&gk=deadbeef')
    await mount(<Home user={user} onLogout={() => {}} />)

    assert.equal(window.location.hash, '')
  })

  test('a link that names a member is still accepted on arrival', async () => {
    await inviteApi()
    setHash('#join=abc&gk=deadbeef&as=-100')
    await mount(<Home user={user} onLogout={() => {}} />)

    assert.deepEqual(joined, [{ code: 'abc', claims: -100 }])
    assert.ok(!text().includes('Who are you?'), 'no question to ask — the link answered it')
    assert.equal(window.location.hash, '#group/7', 'and it lands in the group')
  })
})
