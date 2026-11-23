import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { translateText as tx } from '../src/i18n.js'

test('reloading the user list restores this history entry’s filters for the same administrator', async t => {
  const history = {
    state: { navigationIndex: 3 },
    replaceState(state, title, url) {
      assert.equal(url, undefined, 'a user search must not be included in a shared URL')
      this.state = structuredClone(state)
    },
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { history } })
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window)
  async function open(username) {
    const page = await createComponentHarness(new URL('../src/screens/Users.jsx', import.meta.url), {
      dependencies: {
        '../api.js': { getUser: () => ({ username }) }, './admin-access-pages.css': {},
        '../ui.jsx': { useAsync: () => ({ data: [] }), Icon: 'Icon' },
        '../FilterControls.jsx': { FilterInput: 'FilterInput', FilterSelect: 'FilterSelect' },
      },
    })
    page.render()
    const filter = type => page.nodes(node => node.type === type)[0].props
    const select = name => page.nodes(node => node.type === 'FilterSelect' && node.props['aria-label'] === tx(name))[0].props
    const testFilter = () => page.nodes(node => node.type === 'label' && node.props.children?.includes(tx('测试及疑似账号')))[0].props.children[0].props
    return { page, filter, select, testFilter }
  }
  const first = await open('first-admin')
  first.page.act(() => first.filter('FilterInput').onChange({ target: { value: 'sample-member' } }))
  first.page.act(() => first.filter('FilterSelect').onChange({ target: { value: 'sample-department' } }))
  first.page.act(() => first.select('角色').onChange({ target: { value: 'sample-role' } }))
  first.page.act(() => first.select('状态').onChange({ target: { value: 'disabled' } }))
  first.page.act(() => first.testFilter().onChange({ target: { checked: true } }))
  first.page.unmount()
  const restored = await open('first-admin')
  assert.equal(restored.filter('FilterInput').value, 'sample-member')
  assert.equal(restored.filter('FilterSelect').value, 'sample-department')
  assert.equal(restored.select('角色').value, 'sample-role')
  assert.equal(restored.select('状态').value, 'disabled')
  assert.equal(restored.testFilter().checked, true)
  assert.equal(history.state.navigationIndex, 3)
  restored.page.unmount()
  const other = await open('next-admin')
  assert.equal(other.filter('FilterInput').value, '')
  assert.equal(other.filter('FilterSelect').value, '')
  assert.equal(other.select('角色').value, '')
  assert.equal(other.select('状态').value, '')
  assert.equal(other.testFilter().checked, false)
  other.page.unmount()
  history.state.usersFilters = { account: 'first-admin', q: 'legacy-query', dept: 'legacy-department' }
  const legacy = await open('first-admin')
  assert.equal(legacy.filter('FilterInput').value, 'legacy-query')
  assert.equal(legacy.filter('FilterSelect').value, 'legacy-department')
  assert.equal(legacy.select('角色').value, '')
  assert.equal(legacy.testFilter().checked, false)
  legacy.page.unmount()
})
