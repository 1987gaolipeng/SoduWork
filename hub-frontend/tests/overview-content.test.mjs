import test from 'node:test'
import assert from 'node:assert/strict'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'
import * as governance from '../src/screens/requirement-governance.js'

const file = new URL('../src/screens/Overview.jsx', import.meta.url)
const dependencies = {
  '../api.js': { api: {}, can: () => true },
  '../ui.jsx': {}, './overview.css': {}, './requirement-governance.js': governance,
}

test('built-in source types switch languages while external names remain verbatim', async (t) => {
  const host = await createComponentHarness(file, { exportName: 'overviewSourceLabel', dependencies })
  t.after(() => { host.unmount(); setLocale('zh-CN') })
  const expected = {
    'zh-CN': ['本地新建', '平台下发', '定时派活', '云端对话', '对话接力'],
    'en-US': ['Created locally', 'Assigned by platform', 'Scheduled assignment', 'Cloud conversation', 'Conversation handoff'],
  }
  const origins = ['local', 'dispatch', 'automation', 'cloud-conversation', 'conversation-handoff']
  for (const [locale, labels] of Object.entries(expected)) {
    setLocale(locale)
    assert.deepEqual(origins.map(origin => host.render({ origin })), labels)
    assert.equal(host.render({ origin: 'gitlab', source: '客户需求来源' }), '客户需求来源')
    assert.equal(host.render({ origin: 'gitlab', source: '定时派活' }), '定时派活', 'user-authored source name is not a system enum')
    assert.equal(host.render({ source: '定时派活' }), labels[2], 'legacy automation rows without origin are still localized')
  }
})

test('source distribution retains unusual business labels and integration status does not imply incoming work', async (t) => {
  setLocale('en-US')
  const data = {
    clients: [], orgs: [], users: [], unassigned: [], deliveryBoard: {},
    tasks: [{ id: 'a', source: '__proto__', origin: 'external', status: 'todo' }],
    integrations: [{ id: 'empty', name: '客户集成', enabled: true, taskCount: 0 }, { id: 'received', name: 'Other', enabled: true, taskCount: 7 }, { id: 'off', name: 'Off', enabled: false, taskCount: 0 }],
  }
  const host = await createComponentHarness(file, { dependencies: {
    ...dependencies,
    '../api.js': { api: Object.fromEntries(Object.entries(data).map(([key,value]) => [key, () => value])), can: () => true },
    '../ui.jsx': { Icon: 'svg', useAsync: read => ({ data: read(), loading: false }), AUTO: 5000 },
  } })
  t.after(() => { host.unmount(); setLocale('zh-CN') })
  const labels = host.nodes(n => n.props.className === 'gov-source-label')
  assert.equal(labels.length, 1)
  assert.equal(labels[0].props.children, '__proto__')
  assert.equal(labels[0].props.title, '__proto__')
  assert.equal(labels[0].props.tabIndex, 0)
  const list = host.nodes(n => n.props.className === 'gov-integration-list')[0]
  assert.deepEqual(list.props.children.map(row => row.props.children[2].props.children), ['Enabled', 'Enabled', 'Disabled'])
  assert.ok(list.props.children[0].props.children[3].props.title, 'zero records has an explanatory tooltip')
})


test('language changes never merge a system source with an identically named external source', async (t) => {
  const data = {
    clients: [], orgs: [], users: [], unassigned: [], integrations: [], deliveryBoard: {},
    tasks: [{ id: 'cloud', origin: 'cloud-conversation', status: 'todo' },
      { id: 'ticket', origin: 'ticket', source: 'Cloud conversation', status: 'todo' },
      { id: 'ticket-2', origin: 'ticket', source: 'Cloud conversation', status: 'todo' }],
  }
  const host = await createComponentHarness(file, { dependencies: {
    ...dependencies,
    '../api.js': { api: Object.fromEntries(Object.entries(data).map(([key,value]) => [key, () => value])), can: () => true },
    '../ui.jsx': { Icon: 'svg', useAsync: read => ({ data: read(), loading: false }), AUTO: 5000 },
  } })
  t.after(() => { host.unmount(); setLocale('zh-CN') })
  let keys
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    setLocale(locale); host.render({ locale })
    const rows = host.nodes(n => n.props.className === 'gov-source-list')[0].props.children[1]
    assert.equal(rows.length, 2, locale + ': source types stay separate')
    assert.deepEqual(rows.map(row => row.props.children[2].props.children), [2, 1])
    const nextKeys = rows.map(row => row.key)
    if (keys) assert.deepEqual(nextKeys, keys, 'source identity survives locale change')
    keys = nextKeys
  }
})


test('removed delivery gate never loads or contributes to governance risk', async (t) => {
  setLocale('zh-CN')
  let gateRequests = 0
  const data = {
    clients: [], orgs: [], users: [], unassigned: [], integrations: [],
    tasks: [
      { id: 'overdue-and-failed', origin: 'local', status: 'doing', due: 1, ai: { state: 'failed' } },
      { id: 'failed-only', origin: 'local', status: 'todo', ai: { attentionRaised: true } },
      { id: 'already-delivered', origin: 'local', status: 'done', due: 1, ai: { state: 'failed' } },
    ],
  }
  const api = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, () => value]))
  api.deliveryBoard = () => { gateRequests++; return { counts: { attention: 99 } } }
  const host = await createComponentHarness(file, { dependencies: {
    ...dependencies, '../api.js': { api, can: () => true },
    '../ui.jsx': { Icon: 'svg', useAsync: read => ({ data: read(), loading: false }), AUTO: 5000 },
  } })
  t.after(() => { host.unmount(); setLocale('zh-CN') })
  const ledger = host.nodes(node => node.props.className === 'gov-ledger')[0]
  const risk = ledger.props.children.find(node => node.props.label === '待处理风险')
  assert.equal(risk.props.value, 2, 'overlapping overdue and execution risks count once, gates do not count')
  const list = host.nodes(node => node.props.className === 'gov-attention-list')[0]
  const rows = list.props.children.filter(Boolean)
  assert.deepEqual(rows.map(row => [row.props.label, row.props.value]), [['逾期需求', 1], ['执行异常', 2]])
  assert.equal(gateRequests, 0, 'overview must not depend on the removed delivery board endpoint')
})
