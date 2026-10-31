import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as format from '../src/screens/usage-center-format.js'
import { createComponentHarness } from './helpers/react-harness.mjs'

// Render the actual component in a small hook host; API promises are controlled
// independently so responses can arrive in an order that a fast server hides.
async function mountUsage() {
  const calls = []
  const dependencies = {
    '../api.js': { api: { usageOverview(filters) {
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      calls.push({ filters, resolve, reject })
      return promise
    } } },
    '../ui.jsx': { Icon: 'Icon', SelectMenu: 'SelectMenu' },
    '../FilterControls.jsx': { FilterSelect: 'FilterSelect' },
    './usage-center-charts.jsx': { Empty: 'Empty', PanelHead: 'PanelHead', SceneLedger: 'SceneLedger', TrendPanel: 'TrendPanel' },
    './usage-center-format.js': format,
    './usage-center.css': {},
  }
  const harness = await createComponentHarness(new URL('../src/screens/UsageCenter.jsx', import.meta.url), { dependencies })
  const { nodes, render } = harness
  return {
    ...harness, calls,
    change(label, value) {
      const control = nodes((node) => node.props['aria-label'] === label)[0]
      assert.ok(control, `missing ${label} filter`)
      control.props.onChange({ target: { value } })
      render()
    },
    selectLedger(name, value) {
      const ledger = nodes((node) => node.type === name || node.type?.name === name)[0]
      ledger.props.onSelect(value)
      render()
    },
  }
}

const result = (tokens) => ({ summary: { tokens }, users: [], bySource: [], byAgent: [], filters: { sources: [], agents: [] } })
const shownTokens = (page) => page.nodes((node) => node.type?.name === 'Pulse')[0]?.props.data.summary.tokens

test('usage filters apply immediately and remain available while loading', async () => {
  const page = await mountUsage()
  page.nodes(() => false)
  assert.deepEqual(page.calls[0].filters, { days: 30, userId: '', source: '', agent: '' })
  page.change('统计周期', '7')
  page.change('成员', 'member-1')
  page.change('工作场景', 'conversation')
  page.change('Agent', 'codex')
  assert.equal(page.calls.length, 5)
  assert.deepEqual(page.calls.at(-1).filters, { days: 7, userId: 'member-1', source: 'conversation', agent: 'codex' })
  assert.equal(page.nodes((node) => node.type === 'FilterSelect').length, 4)
  assert.equal(page.nodes((node) => node.type === 'button' && ['查询', '重置'].includes(node.props.children)).length, 0)
  for (const [label, resetValue] of [['统计周期', 30], ['成员', ''], ['工作场景', ''], ['Agent', '']]) {
    const control = page.nodes((node) => node.props['aria-label'] === label)[0]
    assert.equal(control.props.resetValue, resetValue)
    page.change(label, String(resetValue))
  }
  assert.deepEqual(page.calls.at(-1).filters, { days: 30, userId: '', source: '', agent: '' })
  page.unmount()
})

test('fast selection keeps the latest response and ignores a late failure', async () => {
  const page = await mountUsage()
  page.nodes(() => false)
  page.calls[0].resolve(result(10)); await page.flush()
  page.change('统计周期', '7')
  page.change('统计周期', '90')
  page.calls[2].resolve(result(90)); await page.flush()
  page.calls[1].reject(new Error('outdated failure')); await page.flush()
  assert.equal(shownTokens(page), 90)
  assert.equal(page.nodes((node) => node.props.role === 'alert').length, 0)
  page.change('统计周期', '7')
  page.change('统计周期', '30')
  page.calls[3].resolve(result(7)); await page.flush()
  assert.equal(shownTokens(page), 90, 'an outdated result must not replace the report while the latest request is pending')
  assert.equal(page.nodes((node) => node.props['aria-busy'] === true).length, 1)
  page.calls[4].resolve(result(30)); await page.flush()
  assert.equal(shownTokens(page), 30)
  assert.equal(page.nodes((node) => node.props['aria-busy'] === true).length, 0)
  page.unmount()
})

test('charts share the current filters and requests cannot update after unmount', async () => {
  const page = await mountUsage()
  page.nodes(() => false)
  page.calls[0].resolve(result(10)); await page.flush()
  page.change('统计周期', '90')
  page.selectLedger('MemberLedger', 'member-2')
  page.selectLedger('AgentLedger', 'claude-code')
  page.selectLedger('SceneLedger', 'automation')
  assert.deepEqual(page.calls.at(-1).filters, { days: 90, userId: 'member-2', source: 'automation', agent: 'claude-code' })
  assert.equal(shownTokens(page), 10, 'the previous report stays available during loading')
  page.unmount()
  page.calls.at(-1).resolve(result(100))
  await new Promise((resolve) => setImmediate(resolve))
})
