// Changing a display name reaches two places that cannot be one write: the
// account row on the server, and a `member.renamed` appended to every group
// this device can open. These drive the real rename.js against a fake server,
// because the half that is easy to get wrong is the fan-out, not the form.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { DisplayName } from '../src/components/Settings.jsx'
import { RenameGhost } from '../src/components/members.jsx'
import { generateGroupKey, decryptPayload } from '../src/crypto.js'
import { forgetGroupKeys } from '../src/groupkeys.js'
import { forgetLocalLedger, pending, saveGroupKey } from '../src/store.js'
import { $, byText, change, click, mount, submit, text, unmount } from './react.mjs'

const me = { id: 9, display_name: 'v', login_handle: 'v' }

// Groups 1 and 2 exist; the key for whichever ids are passed is on this device,
// so those are the ones a rename can be sealed for.
async function serve({ groups = [1, 2], keyed = [1, 2], fail = false } = {}) {
  const calls = { name: [] }
  for (const id of keyed) await saveGroupKey(id, await generateGroupKey())
  const json = (b) => ({ ok: true, json: async () => b })
  globalThis.fetch = async (url, opts) => {
    const p = String(url)
    const body = opts?.body ? JSON.parse(opts.body) : null
    if (p.endsWith('/api/account/name')) {
      if (fail) return { ok: false, status: 400, json: async () => ({ detail: 'display name required' }) }
      calls.name.push(body.display_name)
      return json({ display_name: body.display_name.trim() })
    }
    if (p.endsWith('/api/me')) return json(me)
    if (p.endsWith('/api/groups')) return json(groups.map((id) => ({ id, name: `g${id}` })))
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return calls
}

// What was queued for sending, decrypted — i.e. what the groups will actually
// be told, not what the component thinks it did.
async function queued(groupId, key) {
  const rows = await pending(groupId)
  return Promise.all(
    rows.map(async (r) => ({ type: r.type, payload: await decryptPayload(key, r.payload.enc) }))
  )
}

afterEach(async () => {
  await unmount()
  forgetGroupKeys()
  await forgetLocalLedger()
})

describe('renaming yourself', () => {
  test('saves the account and tells every group this device can open', async () => {
    const key1 = await generateGroupKey()
    const key2 = await generateGroupKey()
    await saveGroupKey(1, key1)
    await saveGroupKey(2, key2)
    const calls = await serve({ keyed: [] })

    let renamedTo = null
    await mount(<DisplayName user={me} onRenamed={(n) => (renamedTo = n)} />)
    await change($('#display-name'), 'Dragos')
    await submit($('form'))

    assert.deepEqual(calls.name, ['Dragos'], 'the account row was updated once')
    assert.equal(renamedTo, 'Dragos', 'and the app was told, so the screen follows')
    for (const [id, key] of [
      [1, key1],
      [2, key2],
    ]) {
      assert.deepEqual(
        await queued(id, key),
        [{ type: 'member.renamed', payload: { member_id: 9, display_name: 'Dragos' } }],
        `group ${id} was told`
      )
    }
  })

  test('a group whose key this device lacks is reported, not silently skipped', async () => {
    // The rename still stands everywhere else — one unreachable group must not
    // take the others down with it, and a half-rename that says nothing shows
    // up later as one group calling you the wrong thing.
    const key = await generateGroupKey()
    await saveGroupKey(1, key)
    await serve({ groups: [1, 2], keyed: [] })

    await mount(<DisplayName user={me} onRenamed={() => {}} />)
    await change($('#display-name'), 'Dragos')
    await submit($('form'))

    assert.equal((await queued(1, key)).length, 1, 'the reachable group was told')
    assert.ok(text().includes('1 group still shows the old name'), text())
  })

  test('nothing is appended if the account call is refused', async () => {
    const key = await generateGroupKey()
    await saveGroupKey(1, key)
    await serve({ groups: [1], keyed: [], fail: true })

    await mount(<DisplayName user={me} onRenamed={() => {}} />)
    await change($('#display-name'), 'Dragos')
    await submit($('form'))

    assert.ok(text().includes('display name required'))
    assert.deepEqual(await queued(1, key), [], 'no group was told a rename that did not happen')
  })

  test('saving is inert until the name actually changes', async () => {
    await serve({ groups: [], keyed: [] })
    await mount(<DisplayName user={me} onRenamed={() => {}} />)

    assert.ok(byText('button', 'Save').disabled, 'unchanged')
    await change($('#display-name'), '   ')
    assert.ok(byText('button', 'Save').disabled, 'and blank is not a change either')
    await change($('#display-name'), 'Dragos')
    assert.ok(!byText('button', 'Save').disabled)
  })
})

describe('fixing a ghost’s name', () => {
  const ghosts = [
    { id: 1, display_name: 'v' },
    { id: -100, display_name: 'Smaa', ghost: true },
  ]

  test('offers the ghosts and renames the one picked', async () => {
    const asked = []
    await mount(
      <RenameGhost members={ghosts} onRename={(...a) => asked.push(a)} />
    )

    await click(byText('button', 'Smaa'))
    await change($('input'), 'Sam')
    await submit($('form'))

    assert.deepEqual(asked, [[-100, 'Sam']])
  })

  test('is absent when there is nobody to fix', async () => {
    await mount(<RenameGhost members={[ghosts[0]]} onRename={() => {}} />)
    assert.ok(!text().includes('Fix a name'))
  })

  test('refuses a blank name rather than appending one', async () => {
    const asked = []
    await mount(
      <RenameGhost members={ghosts} onRename={(...a) => asked.push(a)} />
    )
    await click(byText('button', 'Smaa'))
    await change($('input'), '  ')
    await submit($('form'))

    assert.deepEqual(asked, [])
    assert.ok(text().includes('Give them a name'))
  })
})
