import assert from 'node:assert/strict'
import test from 'node:test'
import { detailText } from '../src/screens/audit-detail.js'
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

  // Empty detail renders empty so the table falls back to the dash.
  assert.equal(detailText({ action: 'org.delete', detail: {} }), '')
})

test('regression lock: unknown actions must never lose their detail dict', () => {
  // The original defect: any action outside the curated list rendered '—'
  // even though the backend had recorded facts. Lock the fallback in place.
  for (const action of ['mcp.upsert', 'runner.configure', 'binding.upsert', 'alert.config']) {
    const out = detailText({ action, detail: { name: '示例', mode: 'x' } })
    assert.ok(out.length > 0, `${action} details must not render empty`)
  }
})
