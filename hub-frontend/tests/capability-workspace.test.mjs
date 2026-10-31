import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'

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
const catalog = {
  cfg: { allowed: ['company-skill'], policyVersion: 7 },
  skills: [{ name: 'company-skill', description: '公司能力', scope: 'company', portable: true },
    { name: 'local-skill', description: '个人本机能力', source: 'Codex', portable: false }],
  personalSubmissions: [{ key: 'personal', ownerClientId: 'client-a', name: '个人工作方法', description: '个人用途说明' }],
  mcpTemplates: [], summary: { skills: 2, personalSubmissions: 1 },
}
async function mount(t, options = {}) {
  const viewportRef = () => {}
  const saved = []
  const page = await createComponentHarness(screen, {
    ...options,
    dependencies: {
      '../api.js': { api: { capabilityCatalog: () => catalog,
        saveCapabilityPolicy: async (value) => { saved.push(value) } }, can: () => true },
      '../ui.jsx': { Icon: 'Icon', Modal: 'Modal', Loading: 'Loading', ErrorState: 'ErrorState', toast: () => {},
        useAsync: (read) => ({ data: read(), reload() {}, loading: false, error: null }) },
      '../FilterControls.jsx': { FilterInput: 'FilterInput' },
      '../viewport-height.js': { useViewportHeight: () => viewportRef },
      './McpServers.jsx': 'McpServers', './SkillSharing.jsx': 'SkillSharing', './capability-center.css': {},
    },
  })
  t.after(() => page.unmount())
  page.render()
  return { page, viewportRef, saved }
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
