// The service worker cannot run under node, but the options that carry a rule
// can still be checked. These guard the two mistakes that would actually hurt:
// caching the E2E API, and losing the fallback that lets the app open offline.
// See plan/08.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { pwaOptions } from './pwa.js'

describe('the service worker', () => {
  test('precaches the app shell, so the app can open offline', () => {
    // Without the shell in the cache, launching with no network is a blank
    // page and there is nothing to render the local ledger with.
    const patterns = pwaOptions.workbox.globPatterns.join(' ')
    for (const kind of ['html', 'js', 'css']) {
      assert.ok(patterns.includes(kind), `${kind} is precached`)
    }
  })

  test('serves the shell for any path when offline', () => {
    // Single page, no server routes — a cold offline load of anything is the
    // one HTML file.
    assert.equal(pwaOptions.workbox.navigateFallback, '/index.html')
  })

  test('keeps the API out of the worker entirely', () => {
    // The regression that would matter: a sealed API response served from a
    // cache, or an offline API call resolving to the fallback HTML instead of
    // failing so sync.js can fall back to IndexedDB.
    const denied = pwaOptions.workbox.navigateFallbackDenylist
    assert.ok(
      denied.some((re) => re.test('/api/groups/1/events')),
      'the fallback does not swallow API requests'
    )
    assert.ok(!('runtimeCaching' in pwaOptions.workbox), 'nothing caches /api')
  })

  test('updates itself rather than pinning users to old code', () => {
    // Safe now only because a reload loses nothing — writes are in the outbox,
    // not in page state. See plan/04.
    assert.equal(pwaOptions.registerType, 'autoUpdate')
    assert.ok(!pwaOptions.selfDestroying, 'the worker actually caches again')
  })

  test('installs to the home screen as a standalone app', () => {
    assert.equal(pwaOptions.manifest.display, 'standalone')
    assert.ok(pwaOptions.manifest.icons.length >= 1)
  })
})
