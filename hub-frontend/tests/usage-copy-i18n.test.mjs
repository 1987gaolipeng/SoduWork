import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale, translateText as tx } from '../src/i18n.js'
import english, { ja, ko } from '../src/locales/usage-center.js'
import { messages } from '../src/locales/messages.js'
import { messagesByLocale } from '../src/locales/extra-languages.js'
import * as format from '../src/screens/usage-center-format.js'

const screen = new URL('../src/screens/UsageCenter.jsx', import.meta.url)
const chart = new URL('../src/screens/usage-center-charts.jsx', import.meta.url)
const sources = ['对话', '需求执行', '自动化工作流', '定时自动化', '平台运行']
const keys = ['chat', 'task', 'workflow', 'automation', 'system']
function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (React.isValidElement(value)) return textOf(value.props.children)
  return value == null || typeof value === 'boolean' ? '' : String(value)
}
const dependencies = data => ({
  '../api.js': { api: { usageOverview: () => Promise.resolve(data) } },
  '../ui.jsx': { Icon: 'svg' },
  '../FilterControls.jsx': { FilterSelect: 'select' },
  './usage-center-charts.jsx': { Empty: 'Empty', PanelHead: 'PanelHead', SceneLedger: 'SceneLedger', TrendPanel: 'TrendPanel' },
  './usage-center-format.js': format,
  './usage-center.css': {},
})
async function mount(t, file, options) {
  const host = await createComponentHarness(file, options)
  t.after(() => host.unmount())
  host.render()
  return host
}

test('the cost card preserves a priced zero when other records lack a price', async t => {
  setLocale('zh-CN'); t.after(() => setLocale('zh-CN'))
  const pulse = await mount(t, screen, { privateExports: ['Pulse'], exportName: 'Pulse', dependencies: dependencies({}), props: {
    data: { summary: { sessions: 2, costMicrousd: 0 }, costQuality: {
      records: 2, knownUsd: 1, knownMicrousd: 0, unknown: 1, unknownAnomalous: 1, unknownTokens: '1000000000000000001',
    }, anomalies: { records: 1, tokenLimit: 1000000000 } },
  } })
  const costs = pulse.nodes(node => node.props.label === '已知模型成本')[0]
  assert.equal(costs.props.value, '$0.00')
  assert.equal(format.precise('1000000000000000001'), '1,000,000,000,000,000,001')
})

test('a manually entered rate and budget produce a separate, optional cost scenario', async t => {
  setLocale('zh-CN'); t.after(() => setLocale('zh-CN'))
  const estimate = await mount(t, screen, { privateExports: ['CostEstimate'], exportName: 'CostEstimate', dependencies: dependencies({}),
    props: { costs: { knownMicrousd: 2000000, unknownTokens: '1500000' } },
  })
  const [rate, budget] = estimate.nodes(node => node.type === 'input')
  const output = () => textOf(estimate.nodes(node => node.type === 'output')[0])
  assert.equal(output(), '')
  estimate.act(() => rate.props.onChange({ target: { value: '2' } }))
  assert.match(output(), /未计价成本估算上限约 \$3\.00/)
  estimate.act(() => budget.props.onChange({ target: { value: '4' } }))
  assert.match(output(), /预算的 125%/)
  estimate.act(() => budget.props.onChange({ target: { value: '0' } }))
  assert.doesNotMatch(output(), /%|Infinity|NaN/)
  estimate.act(() => rate.props.onChange({ target: { value: '-1' } }))
  assert.equal(output(), '请输入有效的正数单价。')
})

test('diagnostic pages query all matching ledger records with the selected filters', async t => {
  const calls = []
  const filters = { days: 7, userId: 'member-a', source: 'chat', agent: 'codex' }
  const deps = dependencies({})
  deps['../api.js'].api.usageOverview = async query => {
    calls.push(query)
    return { recent: [{ id: 'fact-' + query.page }], detailPage: { total: 31, pageSize: 30, page: query.page } }
  }
  const diagnostic = await mount(t, screen, { privateExports: ['UsageDiagnostics'], exportName: 'UsageDiagnostics', dependencies: deps,
    props: { mode: 'anomalous', filters, tokenLimit: 1000000000 },
  })
  await diagnostic.flush()
  const ledger = () => diagnostic.nodes(node => node.type?.name === 'RecentLedger')[0]
  assert.deepEqual(calls, [{ ...filters, detail: 'anomalous', page: 1 }])
  assert.equal(ledger().props.rows[0].id, 'fact-1')
  diagnostic.act(() => ledger().props.onPage(2))
  await diagnostic.flush()
  assert.deepEqual(calls[1], { ...filters, detail: 'anomalous', page: 2 })
  assert.equal(ledger().props.rows[0].id, 'fact-2')
})

test('pricing inputs use the same successful snapshot as unpriced detail rows', async t => {
  const current = { unknownTokens: '51000000', knownMicrousd: 124000 }
  let finish
  const deps = dependencies({})
  deps['../api.js'].api.usageOverview = () => new Promise(resolve => { finish = resolve })
  const diagnostic = await mount(t, screen, { privateExports: ['UsageDiagnostics'], exportName: 'UsageDiagnostics',
    dependencies: deps,
    props: { mode: 'unpriced', filters: { days: 7 } },
  })
  const estimate = () => diagnostic.nodes(node => node.type?.name === 'CostEstimate')[0]
  assert.equal(estimate(), undefined)
  finish({ recent: [], detailPage: { total: 0, pageSize: 30, page: 1 }, costQuality: current })
  await diagnostic.flush()
  assert.equal(estimate().props.costs, current)
})

test('trend keyboard readout matches the exact daily token and pricing status', async t => {
  setLocale('zh-CN'); t.after(() => setLocale('zh-CN'))
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  const today = day.format(new Date()), yesterday = day.format(Date.now() - 86400000)
  const trend = await mount(t, chart, { exportName: 'TrendPanel', dependencies: dependencies({}), props: { days: 2, points: [
    { key: yesterday, sessions: 1, tokens: 100, knownUsd: 1, costMicrousd: 0 },
    { key: today, sessions: 1, tokens: 1e18, tokensExact: '1000000000000000017', knownUsd: 0, costMicrousd: 0 },
  ] } })
  const svg = () => trend.nodes(node => node.type === 'svg' && node.props.onFocus)[0]
  const tooltip = () => textOf(trend.nodes(node => node.props.className?.includes('ugc-chart-tip'))[0])
  trend.act(() => svg().props.onFocus())
  for (const display of [tooltip(), svg().props['aria-label']]) assert.match(display, /1,000,000,000,000,000,017 Tokens/)
  trend.act(() => trend.nodes(node => node.type === 'button' && textOf(node) === '已知成本')[0].props.onClick())
  trend.act(() => svg().props.onFocus())
  for (const display of [tooltip(), svg().props['aria-label']]) assert.match(display, /— USD/)
})

test('usage and cost fixed copy has direct English, Japanese and Korean translations', t => {
  const required = new Set([...sources, 'Token 用量', '已知成本', '模型请求', '次'])
  for (const file of ['UsageCenter.jsx', 'usage-center-charts.jsx', 'usage-center-format.js']) {
    const source = fs.readFileSync(new URL('../src/screens/' + file, import.meta.url), 'utf8')
    for (const match of source.matchAll(/tx\(\s*["']([^"']+)["']/g)) {
      if (/[\u3400-\u9fff]/.test(match[1])) required.add(match[1].trim())
    }
  }
  const slots = value => [...new Set(value.match(/\{\d+\}/g) || [])].sort()
  const wired = { 'en-US': messages, 'ja-JP': messagesByLocale['ja-JP'], 'ko-KR': messagesByLocale['ko-KR'] }
  for (const [locale, catalog] of Object.entries({ 'en-US': english, 'ja-JP': ja, 'ko-KR': ko })) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), locale)
    assert.deepEqual([...required].filter(key => !Object.hasOwn(catalog, key)), [], locale + ': page coverage')
    for (const key of required) {
      assert.ok(Object.hasOwn(wired[locale], key), locale + ': no fallback for ' + key)
      assert.equal(tx(key, [], locale), catalog[key], locale + ': wired translation')
      assert.deepEqual(slots(catalog[key]), slots(key), key)
    }
  }
  t.diagnostic('Authored usage labels checked: ' + required.size)
})

test('the rendered Chinese usage copy uses 用量 consistently for records, tooltips and share', async t => {
  setLocale('zh-CN'); t.after(() => setLocale('zh-CN'))
  const pulse = await mount(t, screen, { privateExports: ['Pulse'], exportName: 'Pulse', dependencies: dependencies({}), props: {
    data: { days: 90, summary: { tokens: 1000, sessions: 6819, requests: 100 }, users: [] },
  } })
  const metric = pulse.nodes(node => node.type?.name === 'Metric')[0]
  assert.equal(metric.props.note, '近 90 天 · 6,819 条用量记录')
  assert.equal(metric.props.unit, 'Tokens')
  const member = await mount(t, screen, { privateExports: ['MemberLedger'], exportName: 'MemberLedger', dependencies: dependencies({}), props: {
    rows: [{ userId: 'one', label: '客户用药研发项目', sessions: 2, tokens: 1000 }], total: 1000, selected: '', onSelect: () => {},
  } })
  assert.equal(textOf(member.nodes(node => node.type === 'th').at(-1)), '用量占比')
  assert.ok(member.nodes(node => node.type === 'b').some(node => textOf(node) === '客户用药研发项目'), 'authored business names are not globally replaced')
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const trend = await mount(t, chart, { exportName: 'TrendPanel', dependencies: dependencies({}), props: {
    days: 1, points: [{ key: today, tokens: 1000, sessions: 141 }],
  } })
  trend.act(() => trend.nodes(node => node.type === 'svg' && node.props.onFocus)[0].props.onFocus())
  const tooltip = trend.nodes(node => node.props.className?.includes('ugc-chart-tip'))[0]
  assert.match(textOf(tooltip), /141 条用量记录/)
  assert.doesNotMatch(textOf(tooltip), /用药|代币/)
})

for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
  test(locale + ': system scenes localize in filters, chart and recent records without translating business names', async t => {
    setLocale(locale); t.after(() => setLocale('zh-CN'))
    assert.deepEqual(keys.map((key, index) => format.sceneLabel(key, sources[index])), sources.map(label => tx(label)))
    assert.equal(format.sceneLabel('external', '用量占比'), '用量占比')
    const data = { summary: {}, users: [], byAgent: [], bySource: [], recent: [], filters: {
      agents: [], sources: [{ key: 'chat', label: '对话' }, { key: 'external', label: '客户用药研发项目' }],
    } }
    const host = await mount(t, screen, { dependencies: dependencies(data) })
    await host.flush()
    const options = host.nodes(node => node.type === 'option')
    assert.equal(textOf(options.find(node => node.props.value === 'chat')), tx('对话'))
    assert.equal(textOf(options.find(node => node.props.value === 'external')), '客户用药研发项目')
    const scenes = await mount(t, chart, { exportName: 'SceneLedger', dependencies: dependencies({}), props: {
      rows: [{ key: 'chat', label: '对话', tokens: 800 }, { key: 'external', label: '客户用药研发项目', tokens: 200 }], total: 1000, selected: '', onSelect: () => {},
    } })
    const labels = scenes.nodes(node => node.type === 'b').map(textOf)
    assert.ok(labels.includes(tx('对话')))
    assert.ok(labels.includes('客户用药研发项目'))
    const recent = await mount(t, screen, { privateExports: ['RecentLedger'], exportName: 'RecentLedger', dependencies: dependencies({}), props: {
      rows: [
        { id: 'one', title: '客户用药研发项目', sourceType: 'task', sourceLabel: '需求执行', agent: 'pi', model: '客户模型', tokens: 1000 },
        { id: 'two', sourceType: 'chat', sourceVerification: 'unverified' },
        { id: 'three', sourceType: 'chat', sourceVerification: 'verified', sourceId: 'session' },
      ],
    } })
    const details = recent.nodes(node => node.type === 'small').map(textOf)
    for (const label of ['需求执行', '会话来源未核验', '会话来源已核验']) assert.ok(details.includes(tx(label)))
    assert.ok(recent.nodes(node => node.type === 'b').some(node => textOf(node) === '客户用药研发项目'))
    assert.ok(recent.nodes(node => node.type === 'b').some(node => textOf(node) === 'Pi'))
  })
}
