import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { translateText as tx } from '../src/i18n.js'

const clone = (value) => structuredClone(value)
const categories = [{ key: 'general', name: 'General', description: '', sort: 10, enabled: true, usageCount: 1 }]
const initialPolicy = { category: 'general', installation: 'available', authentication: 'on_use', featured: false, coverUrl: '', sort: 0 }
const textOf = (node) => Array.isArray(node) ? node.map(textOf).join('')
  : React.isValidElement(node) ? textOf(node.props.children)
    : typeof node === 'string' || typeof node === 'number' ? String(node) : ''

async function policyFixture(t, save) {
  const calls = [], notices = [], changes = []
  const api = {
    pluginCategories: async () => ({ items: clone(categories) }),
    async updatePluginCatalogPolicy(id, body) {
      calls.push({ id, body: clone(body) })
      return save ? save(body) : clone(body)
    },
  }
  const page = await createComponentHarness(new URL('../src/screens/PluginCatalogPolicy.jsx', import.meta.url), {
    exportName: 'PluginCatalogPolicy',
    props: { pluginId: 'catalog-plugin', value: clone(initialPolicy), canManage: true,
      capabilities: { mcpServers: ['connector'] }, onChanged: (value) => changes.push(clone(value)) },
    dependencies: { '../api.js': { api },
      '../ui.jsx': { Icon: 'Icon', SelectMenu: 'SelectMenu', toast: (value) => notices.push(value) },
      './PluginCoverPreview.jsx': { default: 'PluginCoverPreview' },
      './plugin-catalog-policy.css': {} },
  })
  t.after(() => page.unmount())
  page.render(); await page.flush()
  const installation = () => page.nodes((node) => node.type === 'SelectMenu' &&
    ['available', 'installed_by_default', 'not_available'].includes(node.props.value))[0]
  const submit = () => page.nodes((node) => node.props.className === 'plugin-catalog-save')[0]
  return { page, calls, notices, changes, installation, submit }
}

test('unlisting changes only catalog policy and returns the saved policy to its owner', async (t) => {
  const f = await policyFixture(t)
  assert.equal(f.submit().props.disabled, true)
  f.page.act(() => f.installation().props.onChange({ target: { value: 'not_available' } }))
  const text = textOf(f.page.render())
  assert.ok(text.includes(tx('下架只影响员工目录')))
  assert.ok(text.includes(tx('已配置的需求绑定、历史运行和版本记录不会被删除。')))
  await f.submit().props.onClick(); await f.page.flush()
  const saved = { ...initialPolicy, installation: 'not_available' }
  assert.deepEqual(f.calls, [{ id: 'catalog-plugin', body: saved }])
  assert.deepEqual(f.changes, [saved])
  assert.deepEqual(f.notices, [tx('插件已从员工目录下架；已有需求绑定没有改变')])
  f.page.render({ pluginId: 'catalog-plugin', value: saved, canManage: true,
    capabilities: { mcpServers: ['connector'] }, onChanged: (value) => f.changes.push(value) })
  assert.equal(f.submit().props.disabled, true)
})

test('a rejected catalog save keeps the chosen draft and does not report a saved policy', async (t) => {
  const f = await policyFixture(t, async () => { throw Error('Catalog update rejected') })
  f.page.act(() => f.installation().props.onChange({ target: { value: 'installed_by_default' } }))
  await f.submit().props.onClick(); await f.page.flush()
  assert.equal(f.installation().props.value, 'installed_by_default')
  assert.equal(f.submit().props.disabled, false)
  assert.deepEqual(f.changes, [])
  assert.match(f.notices[0], /Catalog update rejected/)
})

async function categoryFixture(t, save) {
  const calls = [], changes = []
  const api = {
    pluginCategories: async () => ({ items: clone(categories) }),
    async updatePluginCategories(items) {
      calls.push(clone(items))
      return save ? save(items) : { items: clone(items) }
    },
  }
  const page = await createComponentHarness(new URL('../src/screens/PluginCategoryManager.jsx', import.meta.url), {
    props: { open: true, onClose() {}, onSaved: (items) => changes.push(clone(items)) },
    dependencies: { '../api.js': { api }, '../ui.jsx': { Icon: 'Icon', Modal: 'Modal' },
      './plugin-category-manager.css': {} },
  })
  t.after(() => page.unmount())
  page.render(); await page.flush()
  const name = () => page.nodes((node) => node.type === 'input' && node.props['aria-label'] === tx('分类名称'))[0]
  const submit = () => React.Children.toArray(page.nodes((node) => node.type === 'Modal')[0].props.foot.props.children)
    .find((node) => node.props.className === 'btn btn-primary')
  return { page, calls, changes, name, submit }
}

test('category save forwards normalized categories, announces synchronization and resets the draft baseline', async (t) => {
  const f = await categoryFixture(t)
  assert.equal(f.submit().props.disabled, true)
  f.page.act(() => f.name().props.onChange({ target: { value: '  Employee tools  ' } }))
  await f.submit().props.onClick(); await f.page.flush()
  const saved = [{ key: 'general', name: 'Employee tools', description: '', sort: 10, enabled: true }]
  assert.deepEqual(f.calls, [saved])
  assert.deepEqual(f.changes, [saved])
  assert.equal(f.name().props.value, 'Employee tools')
  assert.equal(f.submit().props.disabled, true)
  const status = f.page.nodes((node) => node.props.role === 'status')[0]
  assert.ok(textOf(status).includes(tx('分类已保存，客户端目录会自动同步。')))
})

test('a rejected category save keeps the draft and allows retry without a success callback', async (t) => {
  const f = await categoryFixture(t, async () => { throw Error('Categories update rejected') })
  f.page.act(() => f.name().props.onChange({ target: { value: 'Unsaved name' } }))
  await f.submit().props.onClick(); await f.page.flush()
  assert.equal(f.name().props.value, 'Unsaved name')
  assert.equal(f.submit().props.disabled, false)
  assert.deepEqual(f.changes, [])
  assert.ok(textOf(f.page.nodes((node) => node.props.role === 'alert')[0]).includes('Categories update rejected'))
  assert.equal(f.page.nodes((node) => node.props.role === 'status').length, 0)
})
