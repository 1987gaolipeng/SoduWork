import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

const orgs = [
  { id: 'org-first', name: '第一组织' },
  { id: 'org-home', name: '所属组织' },
  { id: 'org-other', name: '其他组织' },
]
const catalog = (orgId, name) => ({
  professions: [], workflows: [],
  scenarios: [{ id: `${orgId}-scenario`, orgId, name, enabled: true }],
})

async function mountCatalog(me = { orgId: 'org-home' }) {
  const calls = [], notices = []
  const page = await createComponentHarness(new URL('../src/screens/WorkCatalog.jsx', import.meta.url), {
    props: { me },
    dependencies: {
      '../api.js': { api: {
        orgs: async () => orgs,
        workCatalog(orgId) {
          let resolve, reject
          const promise = new Promise((yes, no) => { resolve = yes; reject = no })
          calls.push({ orgId, resolve, reject })
          return promise
        },
      } },
      '../FilterControls.jsx': { FilterInput: 'FilterInput', FilterSelect: 'FilterSelect' },
      '../ui.jsx': { Confirm: 'Confirm', Icon: 'Icon', Loading: 'Loading', Modal: 'Modal', SelectMenu: 'SelectMenu', toast: (message) => notices.push(message) },
      './work-catalog.css': {},
    },
  })
  page.render()
  await page.flush()
  const filter = () => page.nodes((node) => node.type === 'FilterSelect' && node.props['aria-label'] === '选择组织')[0]
  return {
    ...page, calls, notices, filter,
    choose(value) { page.act(() => filter().props.onChange({ target: { value } })) },
    names() { return page.nodes((node) => node.type === 'div' && node.props.className === 'wc-primary').map((node) => node.props.children[0].props.children[0].props.children) },
  }
}

test('organization changes refresh immediately and clearing restores the user organization', async () => {
  const page = await mountCatalog()
  assert.deepEqual(page.calls.map((call) => call.orgId), ['org-home'])
  assert.equal(page.filter().props.resetValue, 'org-home')
  page.choose('org-other')
  assert.deepEqual(page.calls.map((call) => call.orgId), ['org-home', 'org-other'])
  assert.equal(page.filter().props.value, 'org-other', 'the organization control remains available during loading')
  page.calls[1].resolve(catalog('org-other', '其他组织场景')); await page.flush()
  assert.deepEqual(page.names(), ['其他组织场景'])
  page.choose(page.filter().props.resetValue)
  assert.equal(page.calls.at(-1).orgId, 'org-home')
  assert.equal(page.filter().props.value, 'org-home')
  page.calls.at(-1).resolve(catalog('org-home', '所属组织场景')); await page.flush()
  assert.deepEqual(page.names(), ['所属组织场景'])
  page.unmount()
})

test('old organization results and errors cannot overwrite the latest selection', async () => {
  const page = await mountCatalog()
  page.calls[0].resolve(catalog('org-home', '所属组织场景')); await page.flush()
  page.choose('org-first')
  page.choose('org-other')
  page.calls[2].resolve(catalog('org-other', '最新组织场景')); await page.flush()
  page.calls[1].resolve(catalog('org-first', '过期组织场景')); await page.flush()
  assert.deepEqual(page.names(), ['最新组织场景'])
  assert.equal(page.filter().props.value, 'org-other')
  page.choose('org-home')
  page.choose('org-first')
  page.calls[4].resolve(catalog('org-first', '第一组织场景')); await page.flush()
  page.calls[3].reject(new Error('过期组织读取失败')); await page.flush()
  assert.deepEqual(page.names(), ['第一组织场景'])
  assert.deepEqual(page.notices, [])
  page.unmount()
})

test('without a user organization, clearing returns to the first available organization', async () => {
  const page = await mountCatalog(null)
  assert.deepEqual(page.calls.map((call) => call.orgId), ['org-first'])
  assert.equal(page.filter().props.resetValue, 'org-first')
  page.choose('org-other')
  page.choose(page.filter().props.resetValue)
  assert.deepEqual(page.calls.map((call) => call.orgId), ['org-first', 'org-other', 'org-first'])
  page.calls.at(-1).resolve(catalog('org-first', '默认组织场景')); await page.flush()
  assert.deepEqual(page.names(), ['默认组织场景'])
  page.unmount()
})
