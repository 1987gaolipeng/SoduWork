import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

const orgs = [
  { id: 'org-first', name: '第一组织' },
  { id: 'org-home', name: '所属组织' },
  { id: 'org-other', name: '其他组织' },
]
const catalog = (orgId, name) => ({
  professions: [], workflows: [],
  scenarios: [{ id: `${orgId}-scenario`, orgId, name, enabled: true }],
})

async function mountCatalog(me = { orgId: 'org-home' }) {
  const calls = [], notices = []
  const page = await createComponentHarness(new URL('../src/screens/WorkCatalog.jsx', import.meta.url), {
    props: { me },
    dependencies: {
      '../BusinessRecords.jsx': { useBusinessRecords: () => ({ matches: () => true }) },
      '../api.js': { can: () => true, api: {
        orgs: async () => orgs,
        workCatalog(orgId) {
          let resolve, reject
          const promise = new Promise((yes, no) => { resolve = yes; reject = no })
          calls.push({ orgId, resolve, reject })
          return promise
        },
      } },
      '../FilterControls.jsx': { FilterInput: 'FilterInput', FilterSelect: 'FilterSelect' },
      '../ui.jsx': { Confirm: 'Confirm', Icon: 'Icon', Loading: 'Loading', Modal: 'Modal', SelectMenu: 'SelectMenu', toast: (message) => notices.push(message) },
      './work-catalog.css': {},
    },
  })
  page.render()
  await page.flush()
  const filter = () => page.nodes((node) => node.type === 'FilterSelect' && node.props['aria-label'] === '选择组织')[0]
  return {
    ...page, calls, notices, filter,
    choose(value) { page.act(() => filter().props.onChange({ target: { value } })) },
    names() { return page.nodes((node) => node.type === 'div' && node.props.className === 'wc-primary').map((node) => node.props.children[0].props.children[0].props.children) },
  }
}

const workflowGuide = (node) => node.type?.name === 'WorkflowGuide'

test('empty catalog offers setup only after loading and unavailable rows identify their own workflow', async () => {
  const page = await mountCatalog()
  assert.equal(page.nodes(workflowGuide).length, 0)
  const data = catalog('org-home', '场景')
  const disabled = { id: 'local', key: 'flow', enabled: false, name: 'Flow' }
  data.workflows = [disabled]
  data.scenarios[0].defaultPluginKey = disabled.key
  page.calls[0].resolve(data)
  await page.flush()
  assert.deepEqual(page.nodes(workflowGuide).map(node => node.props.workflow), [undefined, disabled])

  page.choose('org-other')
  assert.equal(page.nodes(workflowGuide).length, 0)
  page.calls[1].resolve({ ...catalog('org-other', '其他场景'), workflows: [{ ...disabled, enabled: true }] })
  await page.flush()
  assert.equal(page.nodes(workflowGuide).length, 0)
  page.unmount()
})

test('workflow setup uses plugin permission and preserves the editor when leaving is canceled', async (t) => {
  const destinations = []
  let permitted = false
  const props = { workflow: { id: 'local-flow' }, inEditor: true }
  const guide = await createComponentHarness(new URL('../src/screens/WorkCatalog.jsx', import.meta.url), {
    exportName: 'WorkflowGuide', privateExports: ['WorkflowGuide'], props,
    dependencies: {
      '../api.js': { can: key => permitted && key === 'plugin.manage' },
      '../BusinessRecords.jsx': {},
      '../ui.jsx': { navTo: (...args) => destinations.push(args) },
      '../FilterControls.jsx': {}, './work-catalog.css': {},
    },
  })
  assert.match(guide.render().props.children, /请联系插件管理员/)
  assert.equal(guide.nodes(node => node.type === 'button').length, 0)
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete globalThis.window
  })
  permitted = true
  let leave = false
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => leave } })
  guide.render({ ...props }).props.onClick()
  assert.deepEqual(destinations, [])
  leave = true
  guide.render().props.onClick()
  assert.deepEqual(destinations, [['plugins', { workflowPluginId: 'local-flow' }]])
  guide.unmount()
})

test('scenario editor checks only selected workflows and saves valid selections', async () => {
  const workflows = [
    { id: 'enabled-id', key: 'enabled', enabled: true, name: 'Enabled' },
    { id: 'disabled-id', key: 'disabled', enabled: false, name: 'Disabled' },
  ]
  const writes = [], notices = []
  const row = { id: 'existing', orgId: 'org-home', name: 'Scenario', enabled: false, defaultPluginKey: 'missing' }
  const editor = await createComponentHarness(new URL('../src/screens/WorkCatalog.jsx', import.meta.url), {
    exportName: 'ScenarioEditor', privateExports: ['ScenarioEditor'],
    props: { orgId: row.orgId, row, workflows, professions: [], onDone() {} },
    dependencies: {
      '../api.js': { api: { updateWorkScenario: async (id, body) => writes.push([id, body.defaultPluginKey]) } },
      '../BusinessRecords.jsx': {},
      '../FilterControls.jsx': {}, '../ui.jsx': { Modal: 'Modal', SelectMenu: 'SelectMenu', toast: text => notices.push(text) },
      './work-catalog.css': {},
    },
  })
  const select = () => editor.nodes(n => n.type === 'SelectMenu')[0]
  const choose = key => editor.act(() => select().props.onChange({ target: { value: key } }))
  const checks = text => editor.nodes(n => n.type === 'li' && n.props.children.includes(text)).map(n => n.props.className)
  const save = () => editor.render().props.foot.props.children[1].props.onClick()
  for (const key of ['missing', 'disabled']) {
    choose(key)
    assert.deepEqual(checks('默认流程不可用'), ['warn'])
    assert.ok(editor.nodes(n => n.type === 'option' && n.props.value === key)[0].props.disabled)
    assert.equal(editor.nodes(workflowGuide).length, 1)
    await save()
  }
  assert.equal(writes.length, 0)
  assert.equal(notices.length, 2)

  choose('')
  assert.deepEqual(checks('默认流程不可用'), [])
  assert.deepEqual(checks('默认流程当前可用'), [])
  await save()
  choose('enabled')
  assert.deepEqual(checks('默认流程当前可用'), ['ok'])
  assert.equal(editor.nodes(workflowGuide).length, 0)
  await save()
  assert.deepEqual(writes, [['existing', ''], ['existing', 'enabled']])
  editor.unmount()
})

test('organization changes refresh immediately and clearing restores the user organization', async () => {
  const page = await mountCatalog()
  assert.deepEqual(page.calls.map((call) => call.orgId), ['org-home'])
  assert.equal(page.filter().props.resetValue, 'org-home')
  page.choose('org-other')
  assert.deepEqual(page.calls.map((call) => call.orgId), ['org-home', 'org-other'])
  assert.equal(page.filter().props.value, 'org-other', 'the organization control remains available during loading')
  page.calls[1].resolve(catalog('org-other', '其他组织场景')); await page.flush()
  assert.deepEqual(page.names(), ['其他组织场景'])
  page.choose(page.filter().props.resetValue)
  assert.equal(page.calls.at(-1).orgId, 'org-home')
  assert.equal(page.filter().props.value, 'org-home')
  page.calls.at(-1).resolve(catalog('org-home', '所属组织场景')); await page.flush()
  assert.deepEqual(page.names(), ['所属组织场景'])
  page.unmount()
})

test('old organization results and errors cannot overwrite the latest selection', async () => {
  const page = await mountCatalog()
  page.calls[0].resolve(catalog('org-home', '所属组织场景')); await page.flush()
  page.choose('org-first')
  page.choose('org-other')
  page.calls[2].resolve(catalog('org-other', '最新组织场景')); await page.flush()
  page.calls[1].resolve(catalog('org-first', '过期组织场景')); await page.flush()
  assert.deepEqual(page.names(), ['最新组织场景'])
  assert.equal(page.filter().props.value, 'org-other')
  page.choose('org-home')
  page.choose('org-first')
  page.calls[4].resolve(catalog('org-first', '第一组织场景')); await page.flush()
  page.calls[3].reject(new Error('过期组织读取失败')); await page.flush()
  assert.deepEqual(page.names(), ['第一组织场景'])
  assert.deepEqual(page.notices, [])
  page.unmount()
})

test('without a user organization, clearing returns to the first available organization', async () => {
  const page = await mountCatalog(null)
  assert.deepEqual(page.calls.map((call) => call.orgId), ['org-first'])
  assert.equal(page.filter().props.resetValue, 'org-first')
  page.choose('org-other')
  page.choose(page.filter().props.resetValue)
  assert.deepEqual(page.calls.map((call) => call.orgId), ['org-first', 'org-other', 'org-first'])
  page.calls.at(-1).resolve(catalog('org-first', '默认组织场景')); await page.flush()
  assert.deepEqual(page.names(), ['默认组织场景'])
  page.unmount()
})
