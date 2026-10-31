import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { pluginIssues, pluginKind, pluginPublication, pluginSource, selectCatalog } from '../src/screens/plugin-catalog-model.js'
import { setLocale } from '../src/i18n.js'

const make = (id, overrides = {}) => ({ id, name: id, enabled: true, updatedAt: 1,
  latestVersion: { id: id + '-v1', enabled: true, trustState: 'approved', capabilities: {} }, ...overrides })

test('published plugins remain published when there is a runtime issue', () => {
  const p = make('a')
  const queues = { failures: [{ id: 'r1', pluginId: p.id, target: 'runs' }] }
  const data = selectCatalog([p], queues)
  assert.equal(data.counts.published, 1)
  assert.equal(data.counts.attention, 1)
  assert.equal(data.shown[0].publication.label, '已上架')
  assert.equal(selectCatalog([p], queues, { status: 'published' }).shown.length, 1)
})

test('new pending version is not reported as published even if older versions are enabled', () => {
  const p = make('a', { latestVersion: { trustState: 'quarantined', enabled: false } })
  assert.equal(pluginPublication(p).key, 'pending')
  assert.equal(selectCatalog([p], {}, { status: 'published' }).shown.length, 0)
})

test('disabled catalog, missing version and revoked version stay explicit', () => {
  assert.equal(pluginPublication(make('a', { catalogPolicy: { installation: 'not_available' } })).label, '未开放安装')
  assert.equal(pluginPublication(make('b', { latestVersion: null })).label, '暂无版本')
  assert.equal(pluginPublication(make('c', { latestVersion: { trustState: 'revoked' } })).label, '版本已撤销')
  assert.equal(pluginPublication(make('d', { enabled: false })).key, 'disabled')
})

test('source is based on ownership and kind respects explicit no-workflow declaration', () => {
  assert.equal(pluginSource(make('a', { orgId: 'team', sourceKind: 'builtin' })).key, 'enterprise')
  assert.equal(pluginSource(make('b', { sourceKind: 'builtin' })).key, 'builtin')
  assert.equal(pluginSource(make('c', { sourceKind: 'codex' })).key, 'external')
  assert.equal(pluginKind(make('d', { latestVersion: { capabilities: { executionMode: 'workflow', hasWorkflow: false } } })).key, 'skill')
})

test('explicit app type outranks workflow and MCP and shares pending/publication filters', () => {
  const app = make('app', { latestVersion: { manifest: { template: 'app' }, trustState: 'quarantined',
    enabled: false, capabilities: { hasWorkflow: true, mcpServers: ['business'] } } })
  const legacy = make('legacy', { latestVersion: { manifest: { ui: { contributions: [{}] } }, capabilities: { mcpServers: ['business'] } } })
  assert.equal(pluginKind(app).key, 'app')
  assert.equal(pluginKind(legacy).key, 'connector')
  assert.deepEqual(selectCatalog([app, legacy], {}, { kind: 'app', status: 'pending' }).shown.map(r => r.plugin.id), ['app'])
  assert.equal(selectCatalog([app], {}, { query: '应用' }).shown.length, 1)
  assert.equal(pluginKind({ latestVersion: { manifest: {} }, template: 'app' }).key, 'skill')
})

test('application label uses the noun in English without changing the Apply action', () => {
  try {
    setLocale('en-US')
    assert.equal(pluginKind({ latestVersion: { manifest: { template: 'app' } } }).label, 'App')
  } finally { setLocale('zh-CN') }
})

test('catalog tabs partition explicit applications and plugins while preserving other filters', () => {
  const app = make('app', { orgId: 'org', catalogPolicy: { category: 'team', featured: true },
    latestVersion: { enabled: true, trustState: 'approved', manifest: { template: 'app' } } })
  const plugin = make('plugin', { orgId: 'org', catalogPolicy: { category: 'team', featured: true } })
  const rows = [app, plugin, make('other')]
  assert.deepEqual(selectCatalog(rows, {}, { catalogType: 'plugin' }).shown.map(r => r.plugin.id), ['other', 'plugin'])
  const out = selectCatalog(rows, {}, { catalogType: 'app', status: 'featured', source: 'enterprise', category: 'team', query: 'app' })
  assert.deepEqual(out.shown.map(r => r.plugin.id), ['app'])
  assert.equal(out.counts.all, 1)
  assert.equal(out.counts.featured, 1)
  assert.equal(selectCatalog(rows, {}, { catalogType: 'plugin', query: 'app' }).shown.length, 0)
})

test('recommendation remains independent from publication and tracks removal', () => {
  const pending = make('pending', { catalogPolicy: { featured: true }, latestVersion: { trustState: 'quarantined', enabled: false } })
  const published = make('published', { catalogPolicy: { featured: true } })
  const ordinary = make('ordinary')
  const out = selectCatalog([pending, published, ordinary], {}, { status: 'featured' })
  assert.equal(out.shown.length, 2)
  assert.equal(out.counts.featured, 2)
  assert.equal(out.counts.pending, 1)
  assert.equal(out.counts.published, 2)
  published.catalogPolicy.featured = false
  assert.deepEqual(selectCatalog([pending, published], {}, { status: 'featured' }).shown.map(r => r.plugin.id), ['pending'])
})

test('search source type status filters compose and counts reflect the same query', () => {
  const rows = [make('a', { name: '合同审查', orgId: 'org', latestVersion: { enabled: true, trustState: 'approved', capabilities: { hasWorkflow: true, skills: ['contract-review'] } } }), make('b')]
  const out = selectCatalog(rows, {}, { query: 'CONTRACT', source: 'enterprise', kind: 'workflow', status: 'published' })
  assert.deepEqual(out.shown.map((row) => row.plugin.id), ['a'])
  assert.equal(out.counts.all, 1)
})

test('sorting is deterministic without mutating server data', () => {
  const rows = [make('b'), make('a')]
  assert.deepEqual(selectCatalog(rows).shown.map((r) => r.plugin.id), ['a', 'b'])
  assert.deepEqual(rows.map((p) => p.id), ['b', 'a'])
})

test('governance duplicates and malformed queue groups do not inflate card issues', () => {
  const row = { id: 'q1', pluginId: 'a', target: 'versions' }
  assert.equal(pluginIssues({ one: [row], two: [row], unknown: 1 }).a.length, 1)
  assert.deepEqual(selectCatalog([], {}, { query: 'anything' }).shown, [])
})
