// Refreshing should land you back where you were, not on the group list. The
// view lives in the URL fragment; these mount Home with a fragment set (which
// is what a refresh looks like) and check the right screen comes back, and
// that moving around keeps the fragment honest. See nav.js.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { Home } from '../src/components/Home.jsx'
import { forgetGroupKeys } from '../src/groupkeys.js'
import { forgetLocalLedger } from '../src/store.js'
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
    assert.ok(text().includes('Your groups'))
  })

  test('#settings comes back to settings, not the list', async () => {
    setHash('#settings')
    await mount(<Home user={user} onLogout={() => {}} />)
    assert.ok(text().includes('Receipt scanning'), 'the settings screen')
    assert.ok(!text().includes('Your groups'), 'and not the list')
  })

  test('#group/7 comes back to that group', async () => {
    setHash('#group/7')
    await mount(<Home user={user} onLogout={() => {}} />)
    assert.ok(byText('h2', 'Trip'), 'the group, by name')
    assert.ok(!text().includes('Your groups'))
  })
})

describe('keeping the fragment in step with the view', () => {
  test('opening settings writes the fragment, so a refresh stays there', async () => {
    await mount(<Home user={user} onLogout={() => {}} />)
    await click(byText('button', 'settings'))
    assert.equal(window.location.hash, '#settings')
  })

  test('returning to the list clears the fragment', async () => {
    setHash('#settings')
    await mount(<Home user={user} onLogout={() => {}} />)
    // The brand is the way home.
    await click(byText('strong', 'Split'))
    assert.equal(window.location.hash, '')
  })

  test('opening a view pushes history, so back has somewhere to go', async () => {
    // The Android back gesture is a popstate. Before this, navigating replaced
    // the entry instead of pushing, so the stack stayed empty and back exited
    // the app instead of returning to the previous screen.
    await mount(<Home user={user} onLogout={() => {}} />)
    const before = window.history.length
    await click(byText('button', 'settings'))
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
    await click(byText('button', 'settings'))
    assert.ok(text().includes('Receipt scanning'))

    await goBackTo('') // the list entry the settings push sat on top of
    assert.ok(text().includes('Your groups'), 'back to the list, not out of the app')
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
    assert.ok(text().includes('Your groups'))
  })
})
