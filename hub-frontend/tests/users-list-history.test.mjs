import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

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
    return { page, filter }
  }
  const first = await open('first-admin')
  first.page.act(() => first.filter('FilterInput').onChange({ target: { value: 'sample-member' } }))
  first.page.act(() => first.filter('FilterSelect').onChange({ target: { value: 'sample-department' } }))
  first.page.unmount()
  const restored = await open('first-admin')
  assert.equal(restored.filter('FilterInput').value, 'sample-member')
  assert.equal(restored.filter('FilterSelect').value, 'sample-department')
  assert.equal(history.state.navigationIndex, 3)
  restored.page.unmount()
  const other = await open('next-admin')
  assert.equal(other.filter('FilterInput').value, '')
  assert.equal(other.filter('FilterSelect').value, '')
  other.page.unmount()
})
