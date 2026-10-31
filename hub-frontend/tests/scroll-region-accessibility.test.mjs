import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as requirementGovernance from '../src/screens/requirement-governance.js'
import * as operationsCopy from '../src/screens/operations-copy.js'
import * as insightsMetrics from '../src/screens/insights-metrics.js'

// Exercise the real screen JSX. This checks authored focus/region semantics,
// not browser tab order, actual scrolling, computed CSS, or assistive technology.
const byClass = (page, name) => page.nodes((node) => node.props.className?.split(/\s+/).includes(name))[0]
function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (React.isValidElement(value)) return textOf(value.props.children)
  return value == null || typeof value === 'boolean' ? '' : String(value)
}
const overviewData = {
  clients: [{ id: 'client-one', online: true, ownerUserId: 'user-one' }],
  tasks: [{ id: 'task-one', clientId: 'client-one', status: 'doing', origin: 'local' }],
  integrations: [], unassigned: [],
  orgs: [{ id: 'org-one', name: '测试部门' }],
  users: [{ id: 'user-one', orgId: 'org-one' }],
  deliveryBoard: { counts: { attention: 0 } },
}
const insightData = {
  trend: [], adoption: {}, output: {}, plugins: [],
  departments: [{ org: '测试部门', activeUsers7d: 1, tasks30d: 1, done30d: 0 }],
  automation: { failing: [{ id: 'plan-one', title: '测试计划', enabled: true,
    failed7d: 1, lastError: '独立测试错误详情' }], topErrors: [] },
}
const operationData = {
  hub: { nodeId: 'hub-one', modeLabel: '测试节点', service: 'Hub', version: '1', ready: true },
  runners: { items: [] }, work: {}, requests: { routes: [] },
  recentFailures: [{ id: 'failure-one', error: '独立测试失败', taskId: 'task-one' }],
}
async function mountScreen(t, name) {
  const api = Object.fromEntries(Object.entries(overviewData).map(([key, value]) => [key, () => value]))
  api.operationsInsights = () => insightData
  api.operationsOverview = () => operationData
  const page = await createComponentHarness(new URL(`../src/screens/${name}.jsx`, import.meta.url), {
    dependencies: {
      '../api.js': { api, can: () => true },
      './requirement-governance.js': requirementGovernance,
      './operations-copy.js': operationsCopy,
      './insights-metrics.js': insightsMetrics,
      '../ui.jsx': { AUTO: 5000, Icon: 'Icon', Modal: 'Modal', Loading: 'Loading', ErrorState: 'ErrorState',
        navTo: () => {}, useAsync: (read) => ({ data: read(), loading: false, error: null }) },
      '../viewport-height.js': { useViewportHeight: () => null },
      '../FilterControls.jsx': { FilterInput: 'FilterInput', FilterSelect: 'FilterSelect' },
      '../ListPager.jsx': 'ListPager',
      './operations-copy.js': { operationsText: (value) => value },
      './operations-insights-charts.jsx': { UsageTrend: 'UsageTrend' },
      './overview.css': {}, './operations-insights.css': {}, './operations-center.css': {},
    },
  })
  t.after(() => page.unmount())
  page.render()
  return page
}

const cases = [
  ['Overview', 'gov-dept-table', '部门需求态势'],
  ['Overview', 'gov-attention-list', '现在先处理什么'],
  ['OperationsInsights', 'oi-dept-body', '部门采用'],
  ['OperationsInsights', 'oi-fail-list', '最近失败的计划'],
  ['OperationsInsights', 'oi-failure-copy', '自动化失败详情'],
  ['OperationsInsights', 'oi-table-wrap', '插件使用明细，可横向滚动'],
  ['OperationsCenter', 'ops-runner-list', '执行节点列表，可滚动'],
  ['OperationsCenter', 'ops-work-groups', '需求从执行到发布'],
  ['OperationsCenter', 'ops-failures', '最近失败'],
  ['OperationsCenter', 'ops-route-list', '服务请求'],
]
for (const [screen, className, label] of cases) {
  test(`${screen}: keyboard users can focus and identify ${className}`, async (t) => {
    const page = await mountScreen(t, screen)
    if (className === 'oi-failure-copy') {
      page.act(() => byClass(page, 'oi-fail-detail').props.onClick())
      assert.equal(textOf(byClass(page, className)), '独立测试错误详情')
    }
    const region = byClass(page, className)
    assert.ok(region, `${className} must be rendered with representative data`)
    assert.ok(region.props.tabIndex === 0 || region.props.tabIndex === '0', `${className} must enter the native tab sequence`)
    assert.equal(region.props.role, 'region', 'a scrolling wrapper must preserve its content semantics')
    assert.equal(region.props['aria-label'], label, 'the region name must identify its visible purpose')
  })
}
