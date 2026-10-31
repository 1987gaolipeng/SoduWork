import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPluginDistributionState } from '../src/screens/plugin-distribution-state.js'

const version = (overrides = {}) => ({
  id: 'v1',
  trustState: 'quarantined',
  enabled: false,
  visibility: 'organization',
  provenance: { signatureState: 'verified' },
  capabilities: { qualitySummary: { caseCount: 2, passedCount: 2, verified: true } },
  ...overrides,
})

test('隔离版本不会误报员工目录或任务绑定已生效', () => {
  const state = buildPluginDistributionState({
    plugin: {
      catalogPolicy: { installation: 'available', configured: true },
      bindings: [{ id: 'b1', versionId: 'v1', enabled: true }],
    },
    version: version(),
  })
  assert.equal(state.review.state, 'waiting')
  assert.equal(state.catalogOpen, false)
  assert.equal(state.taskOpen, false)
  assert.match(state.next, /审查并启用/)
})

test('审核通过后员工目录与任务绑定保持独立通道', () => {
  const approved = version({ trustState: 'approved', enabled: true })
  const noBinding = buildPluginDistributionState({
    plugin: { catalogPolicy: { installation: 'available' }, bindings: [] },
    version: approved,
  })
  assert.equal(noBinding.catalogOpen, true)
  assert.equal(noBinding.taskOpen, false)

  const taskOnly = buildPluginDistributionState({
    plugin: {
      catalogPolicy: { installation: 'not_available' },
      bindings: [{ id: 'b1', versionId: 'v1', enabled: true }],
    },
    version: approved,
  })
  assert.equal(taskOnly.catalogOpen, false)
  assert.equal(taskOnly.taskOpen, true)
})

test('定向受众优先展示接口返回的真实成员数量', () => {
  const state = buildPluginDistributionState({
    plugin: { bindings: [] },
    version: version({ visibility: 'users', audienceCount: 9 }),
    audienceData: { items: [{ id: 'u1' }, { id: 'u2' }] },
  })
  assert.equal(state.audience, '指定 2 位成员')
})

test('撤销版本始终成为阻断态并给出恢复方向', () => {
  const state = buildPluginDistributionState({
    plugin: { bindings: [{ id: 'b1', versionId: 'v1', enabled: true }] },
    version: version({ trustState: 'revoked', enabled: false }),
  })
  assert.equal(state.review.state, 'blocked')
  assert.equal(state.catalogOpen, false)
  assert.equal(state.taskOpen, false)
  assert.match(state.next, /发布新版本/)
})

test('企业无签名插件可人工核对，不强制平台评测', () => {
  const state = buildPluginDistributionState({
    plugin: { bindings: [] },
    version: version({ provenance: { signatureState: 'unsigned' } }),
    lightweight: true,
  })
  assert.match(state.next, /管理员核对来源、用途、权限和使用范围/)
  assert.doesNotMatch(state.next, /代表性发布评测|发布者身份/)
})

test('轻审核仍提示未登记或已撤销的发布身份', () => {
  for (const [signatureState, expected] of [['unknown-key', /登记可信公钥/], ['revoked-key', /有效身份签名/]]) {
    const state = buildPluginDistributionState({ plugin: {}, version: version({ provenance: { signatureState } }), lightweight: true })
    assert.match(state.next, expected)
    assert.equal(state.catalogOpen, false)
  }
})

test('插件整体停用后不会误报员工目录或任务已开放', () => {
  const state = buildPluginDistributionState({ plugin: { enabled: false, bindings: [{ versionId: 'v1', enabled: true }] }, version: version({ trustState: 'approved', enabled: true }) })
  assert.equal(state.catalogOpen, false)
  assert.equal(state.taskOpen, false)
})
