import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

const source = new URL('../src/screens/PluginAccessPolicy.jsx', import.meta.url)
const clone = value => structuredClone(value)
const rule = (mode, userIds = [], orgUnitIds = []) => ({ mode, userIds, orgUnitIds })
async function fixture(t, initial) {
  let saved = initial || { use: rule('inherit'), edit: rule('inherit'), updatedAt: 0 }
  const calls = [], pages = []
  const api = {
    pluginAccessPolicy: async () => clone(saved),
    pluginAccessCandidates: async () => ({ items: [{ id: 'employee', name: 'Employee' }], orgUnits: [] }),
    async updatePluginAccessPolicy(id, body) {
      calls.push({ id, body: clone(body) })
      assert.equal(body.expectedUpdatedAt, saved.updatedAt)
      saved = { use: clone(body.use), edit: clone(body.edit), updatedAt: saved.updatedAt + 1 }
      return clone(saved)
    },
  }
  t.after(() => pages.forEach(page => page.unmount()))
  async function open() {
    const page = await createComponentHarness(source, { props: { pluginId: 'plugin' }, dependencies: {
      '../api.js': { api }, '../ui.jsx': { Icon() {}, SelectMenu() {}, toast() {} },
      './plugin-access-policy.css': {},
    } })
    pages.push(page); page.render(); await page.flush(); return page
  }
  return { api, calls, open }
}
const access = (page, kind) => page.nodes(node => node.props.kind === kind)[0]
const saveButton = page => page.nodes(node => node.type === 'button' && node.props.className === 'btn btn-primary')[0]

test('admin grants use and edit independently and reopening reads the saved policy', async t => {
  const f = await fixture(t), page = await f.open()
  access(page, 'use').props.onChange(rule('organization'))
  access(page, 'edit').props.onChange(rule('users', ['employee']))
  await saveButton(page).props.onClick(); await page.flush()
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0], { id: 'plugin', body: {
    use: rule('organization'), edit: rule('users', ['employee']), expectedUpdatedAt: 0,
  } })
  assert.equal(saveButton(page).props.disabled, true)
  const reopened = await f.open()
  assert.equal(access(reopened, 'use').props.value.mode, 'organization')
  assert.deepEqual(access(reopened, 'edit').props.value.userIds, ['employee'])
  assert.equal(saveButton(reopened).props.disabled, true)
})

test('admin revokes both rights and the saved response survives reopening', async t => {
  const f = await fixture(t, { use: rule('organization'), edit: rule('organization'), updatedAt: 7 })
  const page = await f.open()
  for (const kind of ['use', 'edit']) access(page, kind).props.onChange(rule('none'))
  await saveButton(page).props.onClick(); await page.flush()
  assert.equal(f.calls[0].body.expectedUpdatedAt, 7)
  const reopened = await f.open()
  for (const kind of ['use', 'edit']) assert.equal(access(reopened, kind).props.value.mode, 'none')
})

test('a rejected admin save keeps the draft and exposes the error', async t => {
  const f = await fixture(t), page = await f.open()
  f.api.updatePluginAccessPolicy = async () => { throw Error('Concurrent update; reload required') }
  access(page, 'use').props.onChange(rule('none'))
  await saveButton(page).props.onClick(); await page.flush()
  assert.equal(access(page, 'use').props.value.mode, 'none')
  assert.equal(saveButton(page).props.disabled, false)
  const alert = page.nodes(node => node.props.role === 'alert')[0]
  assert.match(alert.props.children[0].props.children, /Concurrent update/)
})
