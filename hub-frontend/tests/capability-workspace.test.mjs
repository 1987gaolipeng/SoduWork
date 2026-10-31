import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as capabilityCatalogModel from '../src/screens/capability-catalog-model.js'

// Exercise the real JSX and handlers. These checks cover the viewport-owner
// contract and accessibility, not computed CSS or physical monitor switching.
const screen = new URL('../src/screens/Skills.jsx', import.meta.url)
const textOf = (value) => Array.isArray(value) ? value.map(textOf).join('')
  : React.isValidElement(value) ? textOf(value.props.children)
    : value == null || typeof value === 'boolean' ? '' : String(value)
const descendants = (value, predicate) => {
  if (Array.isArray(value)) return value.flatMap((item) => descendants(item, predicate))
  if (!React.isValidElement(value)) return []
  return [...(predicate(value) ? [value] : []), ...descendants(value.props.children, predicate)]
}
const byText = (page, text) => page.nodes((node) => node.type === 'button' && textOf(node) === text)[0]
const hasClass = (node, name) => String(node.props.className || '').split(/\s+/).includes(name)
const skillView = (page) => page.nodes((node) => node.type?.name === 'SkillCatalog')[0]
const policyMetric = (page) => page.nodes((node) => node.type?.name === 'Metric' && node.props.tone === 'ok')[0]
const policyWarnings = (page) => page.nodes((node) => hasClass(node, 'cap-admin-policy-warning'))
const catalog = {
  cfg: { allowed: ['company-skill'], policyVersion: 7 },
  skills: [{ name: 'company-skill', description: '公司能力', scope: 'company', portable: true },
    { name: 'local-skill', description: '个人本机能力', source: 'Codex', portable: false }],
  personalSubmissions: [{ key: 'personal', ownerClientId: 'client-a', name: '个人工作方法', description: '个人用途说明' }],
  mcpTemplates: [], summary: { skills: 2, personalSubmissions: 1 },
}
async function mount(t, options = {}) {
  const { catalog: fixture = catalog, ...harnessOptions } = options
  const viewportRef = () => {}
  const saved = []
  const lifecycle = { reloads: 0 }
  let loadedCatalog = structuredClone(fixture)
  let persistedCatalog = loadedCatalog
  const page = await createComponentHarness(screen, {
    ...harnessOptions,
    dependencies: {
      '../api.js': { api: { capabilityCatalog: () => loadedCatalog,
        saveCapabilityPolicy: async (value) => {
          saved.push(structuredClone(value))
          persistedCatalog = { ...loadedCatalog, cfg: structuredClone(value) }
        } }, can: () => true },
      '../ui.jsx': { Icon: 'Icon', Modal: 'Modal', Loading: 'Loading', ErrorState: 'ErrorState', toast: () => {},
        useAsync: (read) => ({ data: read(), reload() {
          lifecycle.reloads += 1
          loadedCatalog = persistedCatalog
        }, loading: false, error: null }) },
      '../FilterControls.jsx': { FilterInput: 'FilterInput' },
      '../viewport-height.js': { useViewportHeight: () => viewportRef },
      './McpServers.jsx': 'McpServers', './SkillSharing.jsx': 'SkillSharing', './capability-center.css': {},
      './capability-catalog-model.js': capabilityCatalogModel,
    },
  })
  t.after(() => page.unmount())
  page.render()
  return { page, viewportRef, saved, lifecycle }
}

test('the active capability body has one viewport owner and keeps its toolbar outside that budget', async (t) => {
  const { page, viewportRef } = await mount(t)
  const owners = () => page.nodes((node) => node.ref === viewportRef)
  assert.equal(owners().length, 1, 'Skill and personal lists must share one measured parent')
  const owner = owners()[0]
  assert.equal(descendants(owner, (node) => node.type?.name === 'SkillCatalog').length, 1)
  assert.equal(descendants(owner, (node) => textOf(node) === '保存开放策略').length, 0)
  page.act(() => byText(page, '连接器').props.onClick())
  assert.equal(owners().length, 1)
  assert.equal(descendants(owners()[0], (node) => node.type?.name === 'McpArea').length, 1)
})

test('catalog sections expose independent named scroll regions without measuring their own remaining page height', async (t) => {
  const { page, viewportRef } = await mount(t, {
    privateExports: ['SkillCatalog'], exportName: 'SkillCatalog',
    props: { rows: catalog.skills, allowed: new Set(catalog.cfg.allowed), legacy: catalog,
      submissions: catalog.personalSubmissions, onToggle() {} },
  })
  assert.equal(page.nodes((node) => node.ref === viewportRef).length, 0,
    'a child list must not use its sibling height as viewport tail')
  const regions = page.nodes((node) => node.props.role === 'region')
  assert.deepEqual(regions.map((node) => node.props['aria-label']), ['能力列表，可滚动', '员工个人 Skill 列表，可滚动'])
  for (const region of regions) assert.equal(Number(region.props.tabIndex), 0)
  assert.equal(descendants(regions[0], (node) => node.type === 'button').length, 2)
  assert.match(textOf(regions[1]), /个人工作方法/)
})

test('switching capability tabs preserves an unsaved policy and saves the existing configuration fields', async (t) => {
  const { page, saved } = await mount(t)
  const skillView = () => page.nodes((node) => node.type?.name === 'SkillCatalog')[0]
  page.act(() => skillView().props.onToggle('local-skill'))
  page.act(() => byText(page, '连接器').props.onClick())
  page.act(() => byText(page, 'Skill').props.onClick())
  assert.deepEqual([...skillView().props.allowed], ['company-skill', 'local-skill'])
  await byText(page, '保存开放策略').props.onClick()
  await page.flush()
  assert.deepEqual(saved, [{ allowed: ['company-skill', 'local-skill'], policyVersion: 7 }])
})

test('empty search results keep personal submissions reachable in their own scroll region', async (t) => {
  const { page } = await mount(t, {
    privateExports: ['SkillCatalog'], exportName: 'SkillCatalog',
    props: { rows: [], allowed: new Set(), legacy: catalog,
      submissions: catalog.personalSubmissions, onToggle() {} },
  })
  assert.ok(page.nodes((node) => textOf(node) === '没有匹配的 Skill').length)
  const personal = page.nodes((node) => node.props.role === 'region')[0]
  assert.equal(personal.props['aria-label'], '员工个人 Skill 列表，可滚动')
  assert.match(textOf(personal), /个人工作方法/)
})

test('the open count uses unique matching names across the full catalog, independent of search', async (t) => {
  const { page, saved } = await mount(t, { catalog: {
    ...catalog, cfg: { ...catalog.cfg, allowed: ['company-skill', 'company-skill', 'local-skill', 'officecli', 'officecli'] },
  } })
  assert.equal(policyMetric(page).props.value, 2)
  assert.equal(policyMetric(page).props.label, '已开放')
  assert.equal(byText(page, '保存开放策略').props.disabled, true,
    'duplicate stored names must not mark an otherwise unchanged policy as dirty')
  assert.equal(policyWarnings(page).length, 1)
  assert.match(textOf(policyWarnings(page)[0]), /有 1 个开放项未匹配到当前目录/)
  assert.match(textOf(policyWarnings(page)[0]), /officecli/)

  const search = page.nodes((node) => node.type === 'FilterInput')[0]
  page.act(() => search.props.onChange({ target: { value: 'company-skill' } }))
  assert.deepEqual(skillView(page).props.rows.map((item) => item.name), ['company-skill'])
  assert.equal(policyMetric(page).props.value, 2, 'search must not change the global policy count')
  assert.equal(policyMetric(page).props.label, '已开放')
  assert.match(textOf(policyWarnings(page)[0]), /有 1 个开放项未匹配到当前目录/,
    'filtered-out valid skills must not become unmatched policy entries')
  assert.deepEqual(saved, [])
})

test('the open count follows draft switches and distinguishes unsaved changes from the saved policy', async (t) => {
  const { page, saved } = await mount(t)
  assert.equal(policyMetric(page).props.value, 1)
  assert.equal(policyMetric(page).props.label, '已开放')
  page.act(() => skillView(page).props.onToggle('local-skill'))
  assert.equal(policyMetric(page).props.value, 2)
  assert.equal(policyMetric(page).props.label, '待保存开放数')
  assert.equal(byText(page, '保存开放策略').props.disabled, false)
  page.act(() => skillView(page).props.onToggle('local-skill'))
  assert.equal(policyMetric(page).props.value, 1)
  assert.equal(policyMetric(page).props.label, '已开放')
  assert.equal(byText(page, '保存开放策略').props.disabled, true)
  assert.deepEqual(saved, [])
})

test('removing unmatched entries only stages a policy change until save, preserves configuration, and reloads', async (t) => {
  const config = { allowed: ['company-skill', 'officecli'], policyVersion: 7,
    roots: ['D:/company-skills'], byRepo: { 'repo-a': ['company-skill'] },
    futurePolicy: { inherited: true } }
  const { page, saved, lifecycle } = await mount(t, { catalog: { ...catalog, cfg: config } })
  assert.equal(policyMetric(page).props.value, 1)
  assert.equal(policyWarnings(page).length, 1)
  assert.deepEqual(saved, [])
  assert.equal(lifecycle.reloads, 0)

  page.act(() => byText(page, '移除未匹配项').props.onClick())
  assert.deepEqual([...skillView(page).props.allowed], ['company-skill'])
  assert.deepEqual(saved, [], 'cleanup must not write policy before the administrator saves')
  assert.equal(lifecycle.reloads, 0)
  assert.equal(policyWarnings(page).length, 0)
  assert.equal(policyMetric(page).props.value, 1)
  assert.equal(policyMetric(page).props.label, '待保存开放数')
  assert.equal(byText(page, '保存开放策略').props.disabled, false)
  assert.deepEqual(config.allowed, ['company-skill', 'officecli'], 'editing must not mutate the loaded configuration')

  await byText(page, '保存开放策略').props.onClick()
  await page.flush()
  assert.deepEqual(saved, [{ ...config, allowed: ['company-skill'] }])
  assert.equal(lifecycle.reloads, 1)
  assert.equal(policyMetric(page).props.label, '已开放')
  assert.equal(policyMetric(page).props.value, 1)
  assert.equal(byText(page, '保存开放策略').props.disabled, true)
  assert.equal(policyWarnings(page).length, 0)
})

test('same-named personal submissions retain each owner and expose distinct source-device labels', async (t) => {
  const owners = ['client-owner-alpha123456', 'client-owner-beta654321', 'client-owner-gamma789012']
  const submissions = owners.map((ownerClientId) => ({ key: 'presales-style', ownerClientId,
    name: 'presales-style', description: '相同名称与说明，来自不同设备' }))
  submissions.push({ key: 'legacy', name: 'legacy-skill', description: '缺失来源信息' })
  const { page } = await mount(t, {
    privateExports: ['SkillCatalog'], exportName: 'SkillCatalog',
    props: { rows: catalog.skills, allowed: new Set(catalog.cfg.allowed), legacy: catalog,
      submissions, onToggle() {} },
  })
  assert.equal(page.nodes((node) => node.type === 'b' && textOf(node) === 'presales-style').length, 3,
    'same-named personal submissions are independent records, not duplicate rows to discard')
  const origins = page.nodes((node) => hasClass(node, 'cap-admin-submit-origin'))
  assert.equal(origins.length, 4)
  const knownOrigins = origins.slice(0, 3)
  for (const [index, origin] of knownOrigins.entries()) {
    assert.match(textOf(origin), /提交设备：SoduWork ·/)
    assert.match(String(origin.props.title), new RegExp(owners[index]))
  }
  assert.equal(new Set(knownOrigins.map(textOf)).size, 3,
    'the visible labels must distinguish the three source devices')
  assert.match(textOf(origins[3]), /来源设备未知/)
  assert.equal(origins[3].props.title, '来源设备未知')
})

test('discarding cleanup and switch changes restores the saved policy without writing it', async (t) => {
  const { page, saved, lifecycle } = await mount(t, { catalog: {
    ...catalog, cfg: { ...catalog.cfg, allowed: ['company-skill', 'officecli'] },
  } })
  page.act(() => byText(page, '移除未匹配项').props.onClick())
  page.act(() => skillView(page).props.onToggle('local-skill'))
  assert.deepEqual([...skillView(page).props.allowed], ['company-skill', 'local-skill'])
  assert.equal(policyMetric(page).props.label, '待保存开放数')
  assert.equal(policyWarnings(page).length, 0)

  page.act(() => byText(page, '放弃改动').props.onClick())
  assert.deepEqual([...skillView(page).props.allowed], ['company-skill', 'officecli'])
  assert.equal(policyMetric(page).props.value, 1)
  assert.equal(policyMetric(page).props.label, '已开放')
  assert.equal(policyWarnings(page).length, 1)
  assert.match(textOf(policyWarnings(page)[0]), /officecli/)
  assert.equal(byText(page, '保存开放策略').props.disabled, true)
  assert.equal(byText(page, '放弃改动'), undefined)
  assert.deepEqual(saved, [])
  assert.equal(lifecycle.reloads, 0)
})
