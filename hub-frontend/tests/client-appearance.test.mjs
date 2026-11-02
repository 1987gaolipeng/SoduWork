import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as appearance from '../src/client-appearance.js'
import { setLocale } from '../src/i18n.js'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const client = { id: 'device-a', name: 'Test device', online: true, authState: 'active', config: appearance.skinConfig('diamond-ice') }
async function fixture(t, api = {}, permissions = ['client.control']) {
  setLocale('zh-CN')
  const calls = [], notices = []
  const page = await createComponentHarness(new URL('../src/screens/Clients.jsx', import.meta.url), {
    exportName: 'ClientDetail', privateExports: ['ClientDetail'], props: { client }, dependencies: {
      '../api.js': { can: permission => permissions.includes(permission), api: {
        clientDetail: async () => structuredClone(client), pushClient: async (...args) => { calls.push(args); return { delivered: true } }, ...api,
      } },
      '../ui.jsx': { Icon: 'Icon', Modal: 'Modal', Confirm: 'Confirm', SelectMenu: 'SelectMenu', toast: text => notices.push(text) },
      '../FilterControls.jsx': {}, '../ListPager.jsx': {}, './RunnerBoard.jsx': {}, './ClientAccessPolicy.jsx': {}, './MailSettings.jsx': {},
      './client-updates.css': {}, './execution-network.css': {}, '../client-appearance.js': appearance,
    },
  })
  page.render(); await page.flush()
  t.after(() => page.unmount())
  const button = text => page.nodes(node => node.type === 'button' && node.props.children === text)[0]
  return { page, calls, notices, button }
}

test('admin presets match the desktop registry and selection includes palette and tube', () => {
  const source = fs.readFileSync(new URL('../../client/core/skin-registry.js', import.meta.url), 'utf8')
  const registry = vm.runInNewContext(source + '\nSkinRegistry')
  for (const id of appearance.remoteSkins) {
    const skin = registry.getSkin(id), patch = appearance.skinConfig(id)
    assert.equal(patch.character, skin.character); assert.equal(patch.theme, skin.palette); assert.equal(patch.tube, skin.tube)
    assert.equal(appearance.selectedSkin(patch), id)
  }
  assert.equal(appearance.selectedSkin({ character: 'bear', theme: 'cnbm' }), '')
  assert.equal(appearance.selectedSkin({ character: 'bear', tube: 'neon' }), '')
  assert.throws(() => appearance.skinConfig('unknown'))
})

test('remote skin clicks persist the complete setting, serialize requests and reflect only successful writes', async t => {
  const request = deferred(), calls = []
  const h = await fixture(t, { pushClient: async (...args) => { calls.push(args); return request.promise } })
  const first = h.button('玻璃').props.onClick()
  const duplicate = h.button('五彩盒子').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(h.button('玻璃').props.disabled, true)
  assert.equal(h.button('钻石').props['aria-pressed'], true)
  request.resolve({ delivered: false }); await first; await duplicate; await h.page.flush()
  assert.deepEqual(calls[0], [client.id, { type: 'config.patch', patch: appearance.skinConfig('bear-vivid') }])
  assert.equal(h.button('玻璃').props['aria-pressed'], true)
  assert.equal(h.button('钻石').props['aria-pressed'], false)
  assert.ok(h.notices.some(text => text.includes('上线后生效')))
})

test('a failed change retains the actual selection and allows a retry', async t => {
  let fail = true
  const h = await fixture(t, { pushClient: async () => { if (fail) throw Error('offline transport'); return { delivered: true } } })
  await h.button('五彩盒子').props.onClick(); await h.page.flush()
  assert.equal(h.button('钻石').props['aria-pressed'], true)
  assert.equal(h.button('五彩盒子').props.disabled, false)
  fail = false; await h.button('五彩盒子').props.onClick(); await h.page.flush()
  assert.equal(h.button('五彩盒子').props['aria-pressed'], true)
})

test('closing a device dialog while a skin request completes cannot update an unmounted dialog', async t => {
  const request = deferred()
  const h = await fixture(t, { pushClient: () => request.promise })
  const result = h.button('玻璃').props.onClick()
  h.page.unmount(); request.resolve({ delivered: true })
  assert.equal(await result, false)
  assert.equal(h.notices.length, 0)
})

test('a late response for device A cannot change device B or release its request lock', async t => {
  const requests = [deferred(), deferred()]
  let index = 0
  const h = await fixture(t, { pushClient: () => requests[index++].promise })
  const first = h.button('玻璃').props.onClick()
  h.page.render({ client: { ...client, id: 'device-b' } }); await h.page.flush()
  const second = h.button('五彩盒子').props.onClick()
  requests[0].resolve({ delivered: true }); await first; await h.page.flush()
  assert.equal(h.button('五彩盒子').props.disabled, true)
  assert.equal(h.button('玻璃').props['aria-pressed'], false)
  requests[1].resolve({ delivered: true }); await second; await h.page.flush()
  assert.equal(h.button('五彩盒子').props['aria-pressed'], true)
})

test('a detail reload started during a skin update cannot overwrite the confirmed selection', async t => {
  const request = deferred(), detail = deferred()
  let reads = 0
  const h = await fixture(t, { pushClient: () => request.promise,
    clientDetail: async () => ++reads === 1 ? structuredClone(client) : detail.promise,
    users: async () => [{ id: 'member-b', displayName: 'Other member' }], assignClient: async () => ({ authState: 'active' }),
  }, ['client.control', 'client.assign'])
  const skin = h.button('玻璃').props.onClick()
  h.page.nodes(node => node.type === 'SelectMenu')[0].props.onChange({ target: { value: 'member-b' } })
  const save = h.page.nodes(node => node.type === 'button' && node.props.onClick?.name === 'saveOwner')[0].props.onClick()
  await h.page.flush()
  assert.equal(reads, 2)
  request.resolve({ delivered: true }); await skin
  detail.resolve(structuredClone(client)); await save; await h.page.flush()
  assert.equal(h.button('玻璃').props['aria-pressed'], true)
  assert.equal(h.button('钻石').props['aria-pressed'], false)
})
