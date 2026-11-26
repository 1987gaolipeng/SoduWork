import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

test('audit pagination, inclusive local dates and export use the same filters', async t => {
  const reads = [], exports = []
  let total = 932
  const api = {
    audit: async params => { reads.push(params); return { items: [], total } },
    exportAudit: async params => { exports.push(params) },
  }
  const page = await createComponentHarness(new URL('../src/screens/Audit.jsx', import.meta.url), {
    dependencies: {
      '../api.js': { api },
      '../ui.jsx': { Icon: 'Icon', ErrorState: 'ErrorState', Loading: 'Loading', toast() {} },
      '../FilterControls.jsx': { FilterInput: 'FilterInput', FilterSelect: 'FilterSelect' },
      '../ListPager.jsx': 'ListPager', './admin-access-pages.css': {},
      './audit-detail.js': { detailText: () => '' },
      './audit-format.js': { FILTERS: [], actInfo: () => ({}), fmtT: () => '', auditEnvironmentLabel: () => '' },
    },
  })
  t.after(() => page.unmount())
  page.render()
  await page.flush()
  const pager = () => page.nodes(node => node.type === 'ListPager')[0].props
  const field = label => page.nodes(node => node.props['aria-label'] === label)[0]
  const change = (label, value) => page.act(() => field(label).props.onChange({ target: { value } }))
  const exportButton = () => page.nodes(node => node.type === 'button' && node.props.children === '导出 CSV')[0]

  assert.deepEqual(reads.at(-1), { limit: 30, offset: 0 })
  assert.equal(typeof pager().onPageSizeChange, 'function')
  page.act(() => pager().onPageSizeChange(50))
  await page.flush()
  page.act(() => pager().onChange(14))
  await page.flush()
  assert.deepEqual(reads.at(-1), { limit: 50, offset: 650 })
  total = 52
  page.act(() => pager().onChange(15))
  await page.flush()
  await page.flush()
  assert.equal(pager().page, 2)
  assert.deepEqual(reads.at(-1), { limit: 50, offset: 50 })

  change('审计操作类型', 'org.create')
  change('开始日期', '2026-03-08')
  change('结束日期', '2026-03-08')
  change('操作者', '  Example  ')
  await page.flush()
  const filters = { action: 'org.create', actor: 'Example',
    since: new Date(2026, 2, 8).toISOString(), until: new Date(2026, 2, 9).toISOString() }
  assert.deepEqual(reads.at(-1), { ...filters, limit: 50, offset: 0 })
  await exportButton().props.onClick()
  assert.deepEqual(exports, [filters])

  const before = reads.length
  change('开始日期', '2026-03-09')
  await page.flush()
  assert.equal(reads.length, before)
  assert.equal(exportButton().props.disabled, true)
  change('开始日期', '12026-03-09')
  assert.equal(page.nodes(node => node.props.role === 'alert')[0].props.children, '开始日期无效，请重新选择')
})

test('extended pager accepts a valid jump and keeps page-size controls on a single page', async t => {
  const changes = []
  const props = { page: 1, pages: 32, pageSize: 30, total: 932,
    onChange: next => changes.push(next), onPageSizeChange: () => {} }
  const pager = await createComponentHarness(new URL('../src/ListPager.jsx', import.meta.url), {
    props, dependencies: { './list-pager.css': {} },
  })
  t.after(() => pager.unmount())
  const jump = pager.nodes(node => node.type === 'form')[0]
  for (const page of [0, 33, 2.5, 32]) {
    jump.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { pageNumber: { valueAsNumber: page } } } })
  }
  assert.deepEqual(changes, [32])
  pager.render({ ...props, pages: 1, total: 5 })
  assert.equal(pager.nodes(node => node.type === 'select').length, 1)
  pager.render({ ...props, pages: 1, pageSize: undefined, onPageSizeChange: undefined })
  assert.equal(pager.render(), null)
})
