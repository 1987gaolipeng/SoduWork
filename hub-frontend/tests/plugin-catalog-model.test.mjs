import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { declaredAccess, pluginIssues, pluginKind, pluginPublication, pluginSource, selectCatalog } from '../src/screens/plugin-catalog-model.js'
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

test('declared access keeps unknown, low-access and mixed permissions distinct', () => {
  assert.equal(declaredAccess({}), '未提供权限清单')
  assert.equal(declaredAccess({ capabilities: { permissionSummary: { riskLevel: 'low' } } }), '未声明额外访问')
  const summary = { runtime: ['files', 'terminal'], network: true, script: true, secretCount: 1 }
  const access = declaredAccess({ capabilities: { mcpServers: ['one'], permissionSummary: summary } })
  for (const label of ['本地文件读写', '命令执行', '连接网络', '密钥引用', '外部连接器']) assert.ok(access.includes(label))
  assert.equal(access.split('命令执行').length, 2)
})

test('review counts count plugins without losing separate version actions', () => {
  const p = make('a', { latestVersion: { trustState: 'quarantined' } })
  const review = ['v1', 'v2'].map(versionId => ({ id: `review:${versionId}`, kind: 'review', pluginId: 'a', versionId }))
  const result = selectCatalog([p], { review }, { status: 'pending' }, { a: { review: 2, attention: 2 } })
  assert.equal(result.counts.all, 1)
  assert.equal(result.counts.pending, 1)
  assert.equal(result.counts.attention, 1)
  assert.equal(result.shown[0].issueCount, 2)
  assert.deepEqual(result.shown[0].issues.map(item => item.versionId), ['v1', 'v2'])
})

test('full governance counts keep plugins beyond the queue preview discoverable', () => {
  const items = Array.from({ length: 40 }, (_, i) => make(`p${i}`))
  const queues = { review: items.slice(0, 30).map(p => ({ id: p.id, kind: 'review', pluginId: p.id })) }
  const pluginCounts = Object.fromEntries(items.map(p => [p.id, { review: 1, attention: 1 }]))
  const result = selectCatalog(items, queues, { status: 'attention' }, pluginCounts)
  assert.equal(result.counts.all, 40)
  assert.equal(result.counts.pending, 40)
  assert.equal(result.counts.attention, 40)
  assert.equal(result.shown.length, 40)
  const last = result.shown.find(row => row.plugin.id === 'p39')
  assert.equal(last.issueCount, 1)
  assert.equal(last.issues.length, 0)
  const filtered = selectCatalog(items, queues, { status: 'pending', query: 'p39' }, pluginCounts)
  assert.equal(filtered.counts.all, 1)
  assert.deepEqual(filtered.shown.map(row => row.plugin.id), ['p39'])
})

test('older pending versions remain reviewable without changing latest publication', () => {
  const p = make('a')
  const queues = { review: [{ id: 'old', kind: 'review', pluginId: 'a', versionId: 'v0' }] }
  for (const counts of [{ a: { review: 1, attention: 1 } }, undefined]) {
    const result = selectCatalog([p], queues, { status: 'pending' }, counts)
    assert.equal(result.counts.pending, 1)
    assert.equal(result.counts.published, 1)
    assert.equal(result.shown[0].publication.key, 'published')
  }
  const reviewed = selectCatalog([p], {}, {}, { a: { review: 0, attention: 0 } })
  assert.equal(reviewed.counts.pending, 0)
  assert.equal(reviewed.counts.attention, 0)
})

test('many action items on one plugin do not inflate catalog plugin counts', () => {
  const result = selectCatalog([make('a')], {}, {}, { a: { review: 40, attention: 45 } })
  assert.equal(result.counts.all, 1)
  assert.equal(result.counts.pending, 1)
  assert.equal(result.counts.attention, 1)
  assert.equal(result.shown[0].issueCount, 45)
})
