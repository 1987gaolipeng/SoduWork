import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

test('date drafts survive catalog conflicts and retry with the latest revision', async t => {
  const original = { id: 'report', name: 'Report', note: 'Summarize', enabled: true, every: 'daily',
    updatedAt: '2030-01-01', requiredCapabilities: [], startDate: '2030-12-01', endDate: '2030-12-31' }
  const other = { ...original, id: 'other', name: 'Updated by another administrator' }
  let reads = 0
  const writes = []
  const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
    dependencies: {
      '../api.js': { api: {
        automationTemplates: async () => ({ items: ++reads === 1 ? [original] : [original, other], revision: `v${reads}` }),
        saveAutomationTemplates: async (items, revision) => {
          writes.push({ items, revision })
          if (writes.length === 1) throw Object.assign(new Error('Conflict'), { status: 409 })
          return { items, revision: 'v3' }
        },
      } },
      '../ui.jsx': { Confirm: () => null, Icon: () => null, Loading: () => null, Modal: () => null, SelectMenu: () => null, toast() {} },
      '../components/LocalesEditor.jsx': () => null, './automation-templates.css': {},
    },
  })
  t.after(() => page.unmount())
  await page.flush()
  page.act(() => page.nodes(n => n.props.className === 'admin-card-action is-primary')[0].props.onClick())
  const editor = () => page.nodes(n => typeof n.props.onReload === 'function')[0]
  page.act(() => editor().props.onChange({ ...editor().props.value, endDate: '2031-01-31' }))
  await editor().props.onSave(); page.render()
  assert.equal(editor().props.conflict, true)
  assert.equal(editor().props.value.endDate, '2031-01-31')
  await editor().props.onSave()
  assert.equal(writes.length, 1, 'conflict blocks repeated stale writes')
  await editor().props.onReload(); await page.flush()
  assert.equal(editor().props.conflict, false)
  assert.equal(editor().props.value.endDate, '2031-01-31')
  await editor().props.onSave(); page.render()
  assert.equal(writes[1].revision, 'v2')
  assert.equal(writes[1].items[0].startDate, '2030-12-01')
  assert.equal(writes[1].items[0].endDate, '2031-01-31')
  assert.deepEqual(writes[1].items[1], other, 'reloading preserves other administrators\' catalog changes')
})

test('stale publication changes stop until latest catalog is loaded', async t => {
  let reads = 0
  const writes = []
  const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
    dependencies: {
      '../api.js': { api: {
        automationTemplates: async () => ({ items: [{ id: 'report', name: 'Report', enabled: true, every: 'daily' }], revision: `v${++reads}` }),
        saveAutomationTemplates: async (items, revision) => { writes.push(revision); throw Object.assign(new Error('Conflict'), { status: 409 }) },
      } },
      '../ui.jsx': { Confirm: () => null, Icon: () => null, Loading: () => null, Modal: () => null, SelectMenu: () => null, toast: () => {} },
      '../components/LocalesEditor.jsx': () => null, './automation-templates.css': {},
    },
  })
  t.after(() => page.unmount())
  page.render(); await page.flush()
  const toggle = () => page.nodes(n => n.props.className?.includes('at-toggle'))[0]
  await toggle().props.onClick(); page.render()
  assert.deepEqual(writes, ['v1'])
  await toggle().props.onClick()
  assert.equal(writes.length, 1)
  const alert = page.nodes(n => n.props.role === 'alert')[0]
  assert.ok(alert)
  const reload = page.nodes(n => n.type === 'button' && n.props.className === 'btn btn-ghost')[0]
  reload.props.onClick(); await page.flush()
  await toggle().props.onClick()
  assert.deepEqual(writes, ['v1', 'v2'])
})
