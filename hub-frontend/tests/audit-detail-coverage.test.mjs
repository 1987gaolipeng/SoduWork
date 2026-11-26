import assert from 'node:assert/strict'
import test from 'node:test'
import { detailText } from '../src/screens/audit-detail.js'
import { actInfo, auditEnvironmentLabel, fmtT } from '../src/screens/audit-format.js'
import { setLocale } from '../src/i18n.js'

// The audit details column must render the recorded facts for every action.
// These tests execute the real renderer (same module the table uses) against
// realistic backend detail payloads.
globalThis.document = { documentElement: {} }
setLocale('zh-CN')

test('curated actions render readable detail text instead of an em dash', () => {
  assert.equal(
    detailText({ action: 'plugin.install', detail: { version: '1.2.0', versionId: 'uuid-x',
      installed: true, setupFields: ['apiKey', 'endpoint'], setupState: 'ok', catalogPolicy: {} } }),
    '安装 v1.2.0 · 配置 2 项')
  assert.equal(
    detailText({ action: 'plugin.upgrade', detail: { version: '2.0.0', setupFields: [] } }),
    '升级 v2.0.0')
  assert.equal(
    detailText({ action: 'plugin.conversation_grant', detail: { pluginIds: ['p1', 'p2'],
      versions: ['1.0.0', '1.0.0'], personalMcpServers: [], mcpServers: ['a', 'b', 'c'],
      conversationId: 'conv-1', mode: 'conversation-runtime' } }),
    '授权 2 个插件 · 3 个连接')
  assert.equal(
    detailText({ action: 'team.message', detail: { chars: 128, files: 1, messageId: 'm1' } }),
    '文字 128 字 · 附件 1 个')
  assert.equal(detailText({ action: 'plugin.uninstall', detail: { versionId: 'uuid-y' } }), '已卸载')
})

test('unmapped actions fall back to a generic summary of the recorded facts', () => {
  // mcp.upsert has no curated branch; its detail must still surface readable facts.
  const summary = detailText({ action: 'mcp.upsert', detail: { name: '内网知识库', webhook: 'https://example/hook', serverId: 'srv-9' } })
  assert.equal(summary, '名称 内网知识库')
  assert.ok(!/https?:/.test(summary), 'endpoint and credential keys must stay hidden')

  // Identifier-suffixed keys stay hidden; readable values are kept.
  const ids = detailText({ action: 'org.update', detail: { orgId: 'uuid-1', name: '产品组' } })
  assert.ok(!ids.includes('uuid-1'), 'identifier keys must not leak into the summary')
  assert.ok(ids.includes('产品组'), 'readable values are kept')

  // Long strings are truncated to keep the table cell readable.
  const long = detailText({ action: 'note', detail: { note: 'x'.repeat(120) } })
  assert.ok(long.length < 60, `long values must be truncated, got length ${long.length}`)

  assert.equal(detailText({ action: 'org.delete', detail: {} }), '无附加信息')
})

test('audit preserves seconds and identifies known and future action codes', () => {
  const at = second => new Date(2026, 10, 21, 11, 42, second).valueOf()
  assert.equal(fmtT(at(4)), '2026/11/21 11:42:04')
  assert.equal(fmtT(at(24)), '2026/11/21 11:42:24')
  assert.equal(fmtT(null), '')
  assert.equal(actInfo('org.delete').label, '删除部门')
  assert.equal(actInfo('repository.sync').label, '同步仓库目录')
  for (const code of ['future.operation', 'constructor', '__proto__']) {
    assert.equal(actInfo(code).label, `未知操作（${code}）`)
  }
})

test('department detail distinguishes a root, a recorded parent, absent facts and malformed records', () => {
  assert.equal(detailText({ action: 'org.create', detail: { parentId: null } }), '上级部门：无')
  assert.equal(detailText({ action: 'org.update', detail: { parentId: 'dept-a', sort: 0 } }), '上级部门 ID：dept-a · 排序 0')
  assert.equal(detailText({ action: 'org.create', detail: {} }), '无附加信息')
  assert.equal(detailText({ action: 'org.delete', detail: null }), '无附加信息')
  for (const malformed of [false, '', [], 'legacy invalid detail']) {
    assert.equal(detailText({ action: 'org.create', detail: malformed }), '详情格式异常')
  }
  assert.equal(detailText({ action: 'user.update', detail: { fields: 'name' } }), '详情格式异常')
  assert.equal(detailText({ action: 'org.update', detail: { token: 'private' } }), '无可显示的附加信息')
})

test('translated environment badges describe only an explicitly configured non-production Hub', () => {
  for (const value of ['production', 'customer', 'source-local', undefined]) {
    assert.equal(auditEnvironmentLabel(value), '')
  }
  assert.equal(auditEnvironmentLabel('development'), '当前 Hub 为开发环境')
  assert.equal(auditEnvironmentLabel('qa'), '当前 Hub 为测试环境')
  try {
    for (const [locale, action, fallback, environment] of [
      ['en-US', 'Delete department', 'Unknown action (future.operation)', 'Test Hub'],
      ['ja-JP', '部門を削除', '不明な操作（future.operation）', 'テスト環境の Hub'],
      ['ko-KR', '부서 삭제', '알 수 없는 작업 (future.operation)', '테스트 환경 Hub'],
    ]) {
      setLocale(locale)
      assert.equal(actInfo('org.delete').label, action)
      assert.equal(actInfo('future.operation').label, fallback)
      assert.equal(auditEnvironmentLabel('test'), environment)
    }
  } finally {
    setLocale('zh-CN')
  }
})

test('regression lock: unknown actions must never lose their detail dict', () => {
  // The original defect: any action outside the curated list rendered '—'
  // even though the backend had recorded facts. Lock the fallback in place.
  for (const action of ['mcp.upsert', 'runner.configure', 'binding.upsert', 'alert.config']) {
    const out = detailText({ action, detail: { name: '示例', mode: 'x' } })
    assert.ok(out.length > 0, `${action} details must not render empty`)
  }
})
