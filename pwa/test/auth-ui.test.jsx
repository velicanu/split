// The three-page auth front door: sign in / sign up / pair, with methods laid
// out as peers. The auth *logic* is covered in auth.test.jsx; here it's the page
// structure and navigation. jsdom has no WebAuthn, so passkeySupported() is
// false and the passkey method is absent — password and recovery are asserted.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { Auth } from '../src/components/Auth.jsx'
import { $, $$, byText, click, mount, submit, text, unmount } from './react.mjs'

const tab = (label) => $$('.segmented button').find((b) => b.textContent === label)
const methodButtons = () => $$('.method button').map((b) => b.textContent)

afterEach(unmount)

describe('the auth front door', () => {
  test('defaults to sign in, with password and recovery as equal methods', async () => {
    await mount(<Auth onAuth={() => {}} />)
    assert.deepEqual(
      ['Sign in', 'Sign up', 'Pair'].map((l) => !!tab(l)),
      [true, true, true],
      'three equally-present page buttons'
    )
    const methods = methodButtons()
    assert.ok(methods.includes('Sign in with password'))
    assert.ok(methods.includes('Sign in with recovery code'))
  })

  test('the current page is grayed in both the tabs and the bottom links', async () => {
    await mount(<Auth onAuth={() => {}} />)
    assert.ok(tab('Sign in').disabled, 'the current tab is inert')
    // The bottom link row renders the current page as a plain span, others links.
    const current = $('.authnav .current')
    assert.equal(current.textContent, 'Sign in')
    assert.equal(byText('.authnav a', 'Sign in'), undefined, 'current page is not a link')
    assert.ok(byText('.authnav a', 'Pair'), 'the others are links')
  })

  test('sign up drops recovery and adds a display name', async () => {
    await mount(<Auth onAuth={() => {}} />)
    await click(tab('Sign up'))
    const methods = methodButtons()
    assert.ok(methods.includes('Sign up with password'))
    assert.ok(!methods.some((m) => m.includes('recovery')), 'no recovery method on sign up')
    assert.ok($('input[placeholder="display name (optional)"]'), 'display name field')
    assert.ok(text().includes('recovery code is created for you'))
  })

  test('needs a handle before a method runs', async () => {
    await mount(<Auth onAuth={() => {}} />)
    // The password method is a form; submitting it without a handle is refused.
    await submit($$('form.method')[0])
    assert.ok(text().includes('Enter your handle'))
  })

  test('pair opens the new-device flow', async () => {
    globalThis.fetch = async (url, opts = {}) => {
      const p = String(url)
      if (p.endsWith('/api/pairings') && (opts.method || 'POST') === 'POST') {
        return { ok: true, json: async () => ({ code: 'PAIRXY' }) }
      }
      if (p.includes('/api/pairings/')) {
        return { ok: true, json: async () => ({ approved: false }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    await mount(<Auth onAuth={() => {}} />)
    await click(tab('Pair'))
    assert.ok(text().includes('PAIRXY'), 'shows the pairing code')
    assert.ok($('.fingerprint'), 'and the fingerprint to compare')
  })
})
