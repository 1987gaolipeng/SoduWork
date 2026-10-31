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
      rows: [{ id: 'one', title: '客户用药研发项目', sourceType: 'task', sourceLabel: '需求执行', agent: 'pi', model: '客户模型', tokens: 1000 }],
    } })
    assert.ok(recent.nodes(node => node.type === 'small').some(node => textOf(node) === tx('需求执行')))
    assert.ok(recent.nodes(node => node.type === 'b').some(node => textOf(node) === '客户用药研发项目'))
    assert.ok(recent.nodes(node => node.type === 'b').some(node => textOf(node) === 'Pi'))
  })
}
