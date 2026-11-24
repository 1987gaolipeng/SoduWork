import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

async function fixture(t, component, props, api) {
  setLocale('en-US')
  const page = await createComponentHarness(new URL('../src/screens/Clients.jsx', import.meta.url), {
    exportName: component, privateExports: [component], props, dependencies: {
      '../api.js': { api, can: p => p === 'client.assign' },
      '../ui.jsx': { Icon: 'Icon', Modal: 'Modal', Confirm: 'Confirm', SelectMenu: 'SelectMenu', toast() {} },
      '../FilterControls.jsx': {}, '../ListPager.jsx': {}, './RunnerBoard.jsx': {}, './ClientAccessPolicy.jsx': {},
      './MailSettings.jsx': {}, './client-updates.css': {}, './execution-network.css': {}, '../client-appearance.js': {},
    },
  })
  page.render()
  await page.flush()
  t.after(() => page.unmount())
  return page
}

test('new pairing requires both an owner and device code and leaves failed approvals open', async t => {
  const calls = []
  let paired = 0
  const page = await fixture(t, 'PairDevice', { onPaired: () => paired++ }, {
    pairClient: async (...args) => { calls.push(args); if (calls.length === 1) throw Error('请向设备使用者索取这台设备的新配对凭据') },
  })
  const submit = () => page.nodes(n => n.type === 'button' && n.props.children === 'Pair and activate', page.render().props.foot)[0]
  assert.ok(submit().props.disabled)
  page.nodes(n => n.type.name === 'OwnerSelect')[0].props.onChange('test-owner')
  assert.ok(submit().props.disabled)
  const enter = token => page.nodes(n => n.type.name === 'PairingTokenInput')[0].props.onChange(token)
  enter(' first-code ')
  await submit().props.onClick()
  assert.equal(paired, 0)
  assert.match(page.nodes(n => n.props.role === 'alert')[0].props.children, /fresh pairing code/)
  enter(' second-code ')
  await submit().props.onClick()
  assert.equal(paired, 1)
  assert.deepEqual(calls, [['test-owner', 'first-code'], ['test-owner', 'second-code']])
})

test('pending activation and active reassignment require device proof, while unassigning clears it', async t => {
  for (const authState of ['pending', 'active', 'revoked']) {
    const client = { id: 'device-a', ownerUserId: 'user-a', authState }
    const assigned = []
    const page = await fixture(t, 'ClientDetail', { client }, {
      clientDetail: async () => client, assignClient: async (...args) => { assigned.push(args); return client },
    })
    const select = owner => page.nodes(n => n.type.name === 'OwnerSelect')[0].props.onChange(owner)
    const submit = () => page.nodes(n => n.type === 'button' && n.props.onClick?.name === 'saveOwner')[0]
    const code = () => page.nodes(n => n.type.name === 'PairingTokenInput')[0]
    assert.ok(submit().props.disabled)
    if (authState !== 'pending') select('user-b')
    assert.ok(submit().props.disabled)
    if (authState === 'revoked') {
      assert.equal(code(), undefined)
    } else {
      code().props.onChange(' fresh-code ')
      assert.equal(submit().props.disabled, false)
      await submit().props.onClick()
      assert.deepEqual(assigned.pop(), ['device-a', authState === 'pending' ? 'user-a' : 'user-b', 'fresh-code'])
    }
    select('')
    assert.equal(code(), undefined)
    await submit().props.onClick()
    assert.deepEqual(assigned.pop(), ['device-a', null, undefined])
  }
})
