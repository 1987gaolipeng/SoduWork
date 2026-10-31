import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import fs from 'node:fs'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale, translateText as tx } from '../src/i18n.js'
import * as metrics from '../src/screens/insights-metrics.js'
import english, { ja, ko } from '../src/locales/insights-metrics.js'
import { messages } from '../src/locales/messages.js'
import { messagesByLocale } from '../src/locales/extra-languages.js'

const screenFile = new URL('../src/screens/OperationsInsights.jsx', import.meta.url)
const chartFile = new URL('../src/screens/operations-insights-charts.jsx', import.meta.url)
function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (React.isValidElement(value)) return textOf(value.props.children)
  return value == null || typeof value === 'boolean' ? '' : String(value)
}
function descendants(value, predicate) {
  if (Array.isArray(value)) return value.flatMap(child => descendants(child, predicate))
  if (!React.isValidElement(value)) return []
  return [...(predicate(value) ? [value] : []), ...descendants(value.props.children, predicate)]
}
const byClass = (host, className) => host.nodes(node => node.props.className?.split(/\s+/).includes(className))[0]
function dependencies(data) {
  return {
    '../api.js': { api: { operationsInsights: () => data } },
    '../ui.jsx': { AUTO: 5000, Icon: 'svg', Modal: 'dialog', useAsync: read => ({ data: read(), loading: false }) },
    '../FilterControls.jsx': { FilterInput: 'input', FilterSelect: 'select' },
    '../ListPager.jsx': 'ListPager',
    './operations-insights-charts.jsx': { UsageTrend: 'UsageTrend' },
    './insights-metrics.js': metrics,
    './operations-center.css': {}, './operations-insights.css': {},
  }
}
function trendFor(values) {
  return values.map((value, index) => ({
    date: '2026-10-' + String(index + 1).padStart(2, '0'),
    aiSessions: value, tasksCreated: 2, tasksDone: 1, activeClients: 1,
    automationRuns: 0, automationFailed: 0, automationCompleted: 0,
  }))
}
async function mount(t, file, options) {
  const host = await createComponentHarness(file, options)
  t.after(() => host.unmount())
  host.render()
  return host
}

for (const fixture of [
  { name: '30 natural days disagree with the rolling counter', values: [40, 30, 28, ...Array(27).fill(0)], total: 98, average: 3.3, peak: 40 },
  { name: 'one natural day uses one day as denominator', values: [7], total: 7, average: 7, peak: 7 },
  { name: 'zero-activity days remain measured zeroes', values: Array(30).fill(0), total: 0, average: 0, peak: 0 },
  { name: 'missing trend remains unavailable rather than using the rolling counter', values: [], total: null, average: null, peak: null },
]) {
  test('AI card and chart share the same daily series: ' + fixture.name, async (t) => {
    setLocale('zh-CN'); t.after(() => setLocale('zh-CN'))
    const trend = trendFor(fixture.values)
    const data = { output: { aiSessions30d: 102 }, trend, plugins: [] }
    const original = structuredClone(data)
    const host = await mount(t, screenFile, { dependencies: dependencies(data) })
    const card = byClass(host, 'oi-metrics').props.children[2]
    assert.equal(card.props.value, fixture.total, 'the card must use calendar-day buckets instead of output.aiSessions30d')
    const stat = await mount(t, screenFile, {
      dependencies: dependencies(data), privateExports: ['Stat'], exportName: 'Stat', props: card.props,
    })
    const cardValue = descendants(byClass(stat, 'oi-stat-line'), node => node.type === 'b')[0]
    assert.equal(textOf(cardValue), fixture.total == null ? '—' : String(fixture.total))
    const cardSub = textOf(byClass(stat, 'oi-stat-sub'))
    if (fixture.average == null) {
      assert.equal(cardSub, '暂无趋势数据')
      assert.doesNotMatch(cardSub, /3\.4|102|NaN/)
    } else {
      assert.equal(cardSub, '日均 ' + fixture.average + ' 场')
    }
    const chart = await mount(t, chartFile, { exportName: 'UsageTrend', props: { trend }, dependencies: dependencies(data) })
    const numbers = descendants(byClass(chart, 'oi-trend-summary'), node => node.type === 'b').map(textOf)
    assert.deepEqual(numbers, [fixture.average, fixture.peak].map(value => value == null ? '—' : String(value)))
    assert.deepEqual(data, original, 'rendering must preserve server data')
  })
}

test('changing trend tabs preserves the matching AI average when returning', async (t) => {
  setLocale('zh-CN'); t.after(() => setLocale('zh-CN'))
  const trend = trendFor([40, 30, 28, ...Array(27).fill(0)])
  const host = await mount(t, chartFile, { exportName: 'UsageTrend', props: { trend }, dependencies: dependencies({}) })
  const average = () => textOf(descendants(byClass(host, 'oi-trend-summary'), node => node.type === 'b')[0])
  const tab = (key) => host.nodes(node => node.type === 'button' && node.key === key)[0]
  assert.equal(average(), '3.3')
  host.act(() => tab('tasksCreated').props.onClick())
  assert.equal(average(), '2')
  host.act(() => tab('aiSessions').props.onClick())
  assert.equal(average(), '3.3')
})

const plugins = [
  { pluginId: 'chat-only', key: 'chat-only', name: 'Conversation only', enabled: true, installs: 3, runs30d: 0,
    succeeded30d: 0, failed30d: 0, conversationUses30d: 176, successRate: null },
  { pluginId: 'failed', key: 'failed', name: 'Failed workflow', enabled: true, installs: 1, runs30d: 1,
    succeeded30d: 0, failed30d: 1, conversationUses30d: 4, successRate: 0 },
  { pluginId: 'unused', key: 'unused', name: 'Unused', enabled: true, installs: 1, runs30d: 0,
    succeeded30d: 0, failed30d: 0, conversationUses30d: 0, successRate: null },
]
for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
  test(locale + ': plugin success rates explain workflow scope and keep absent data distinct from zero percent', async (t) => {
    setLocale(locale); t.after(() => setLocale('zh-CN'))
    const host = await mount(t, screenFile, { dependencies: dependencies({ trend: [], plugins }) })
    const cells = id => host.nodes(node => node.type === 'tr' && node.key === id)[0].props.children
    for (const id of ['chat-only', 'unused']) {
      const cell = cells(id)[5]
      assert.equal(textOf(cell), '—')
      const hint = descendants(cell, node => typeof node.props.title === 'string' && node.props.title.trim())[0]
      assert.ok(hint, id + ': missing-data mark needs an explanation')
      assert.equal(hint.props.tabIndex, 0, 'keyboard users can reach the explanation')
      assert.ok(hint.props['aria-label'] || hint.props['aria-describedby'], 'assistive technology receives the explanation')
    }
    assert.equal(textOf(cells('chat-only')[4]), '176', 'conversation calls are still present')
    assert.equal(textOf(cells('failed')[5]), '0%', 'all failed workflow runs are a measured 0%, not absent data')
    const header = host.nodes(node => node.type === 'th')[5]
    assert.equal(textOf(header), tx('成功率'))
    const headerHint = descendants(header, node => typeof node.props.title === 'string' && node.props.title.trim())[0]
    assert.ok(headerHint, 'success-rate header explains the scope for measured percentages too')
    assert.equal(headerHint.props.tabIndex, 0)
    assert.ok(headerHint.props['aria-label'] || headerHint.props['aria-describedby'])
  })
}

test('metric-definition translations are wired directly in English, Japanese and Korean with every placeholder intact', () => {
  const slots = value => [...new Set(value.match(/\{\d+\}/g) || [])].sort()
  assert.ok(Object.keys(english).length >= 3, 'new metric definitions must be included')
  for (const [locale, catalog] of Object.entries({ 'en-US': english, 'ja-JP': ja, 'ko-KR': ko })) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), locale)
    for (const [source, translated] of Object.entries(catalog)) {
      assert.ok(translated.trim(), source)
      assert.deepEqual(slots(translated), slots(source), locale + ': ' + source)
      assert.equal(tx(source, [], locale), translated, locale + ': direct catalog is active')
    }
  }
})


test('every authored insights label has a direct English, Japanese and Korean entry without fallback', (t) => {
  const labels = new Set()
  for (const file of [screenFile, chartFile]) {
    const source = fs.readFileSync(file, 'utf8')
    const extracted = [...source.matchAll(/tx\(\s*["']([^"']+)["']/g)]
      .map(match => match[1].trim()).filter(label => /[\u3400-\u9fff]/.test(label))
    assert.ok(extracted.length, file.pathname + ': authored source extraction must not be empty')
    extracted.forEach(label => labels.add(label))
  }
  // These constants are translated by localeMap rather than a literal tx() call.
  const constantLabels = ['研发与交付', '办公文稿', '信息与研究', '日常零活', 'AI 会话', '新建需求', '活跃设备', '场', '项', '台']
  // Shared pagination and filter controls rendered by this page, including reset buttons.
  const controlLabels = ['第 {0} / {1} 页 · 共 {2} {3}', '上一页', '下一页', '清空{0}', '清空', '恢复{0}默认值', '恢复默认值', '请选择']
  for (const label of [...constantLabels, ...controlLabels]) labels.add(label)
  t.diagnostic('Checking ' + labels.size + ' unique authored insights, category, metric and shared-control labels')
  for (const [locale, catalog] of Object.entries({ 'en-US': messages, 'ja-JP': messagesByLocale['ja-JP'], 'ko-KR': messagesByLocale['ko-KR'] })) {
    const missing = [...labels].filter(label => !Object.hasOwn(catalog, label) || !catalog[label]?.trim())
    assert.deepEqual(missing, [], locale + ': direct entries are required; English fallback is not a native translation')
  }
})
