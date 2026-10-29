import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'

const filterFile = new URL('../src/FilterControls.jsx', import.meta.url)
const uiFile = new URL('../src/ui.jsx', import.meta.url)
const filterDeps = { './ui.jsx': { Icon: 'Icon', SelectMenu: 'SelectMenu' } }
const clears = (page) => page.nodes((node) => node.props.className === 'filter-clear')
function event() {
  return { prevented: false, stopped: false,
    preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
}

test('search clear dispatches the normal filter change once and returns focus', async () => {
  const changes = [], composition = () => {}, props = {
    value: 'billing', onChange: (e) => changes.push(e.target.value),
    'aria-label': 'Search plugins', onCompositionEnd: composition,
  }
  const page = await createComponentHarness(filterFile, { dependencies: filterDeps, exportName: 'FilterInput', props })
  const input = page.nodes((node) => node.type === 'input')[0]
  let focused = 0
  input.ref.current = { focus() { focused++ } }
  assert.equal(input.props.onCompositionEnd, composition)
  assert.ok(clears(page)[0].props['aria-label'].includes('Search plugins'))
  const click = event()
  page.act(() => clears(page)[0].props.onClick(click))
  assert.deepEqual(changes, [''])
  assert.equal(focused, 1)
  assert.ok(click.prevented && click.stopped)
  page.render({ ...props, value: '' })
  assert.equal(clears(page).length, 0)
  for (const condition of [{ disabled: true }, { readOnly: true }]) {
    page.render({ ...props, ...condition })
    assert.equal(clears(page).length, 0)
  }
  page.unmount()
})

test('select reset retains a nonempty numeric default without changing configuration controls', async () => {
  const changes = [], props = { value: 7, resetValue: 30, clearable: true,
    onChange: (e) => changes.push(e.target.value), 'aria-label': 'Period',
    children: [7, 30, 90].map((days) => React.createElement('option', { key: days, value: days }, String(days))) }
  const page = await createComponentHarness(uiFile, { dependencies: { './api.js': { api: {} } }, exportName: 'SelectMenu', props })
  const trigger = page.nodes((node) => node.props.className === 'select-menu-trigger')[0]
  let focused = 0
  trigger.ref.current = { focus() { focused++ } }
  const click = event()
  page.act(() => clears(page)[0].props.onClick(click))
  assert.deepEqual(changes, ['30'])
  assert.equal(focused, 1)
  assert.ok(click.prevented && click.stopped)
  assert.equal(page.nodes((node) => node.props.role === 'listbox').length, 0)
  for (const state of [{ value: '30' }, { disabled: true }, { clearable: false }]) {
    page.render({ ...props, ...state })
    assert.equal(clears(page).length, 0)
  }
  page.unmount()
})

test('filter select opts into reset and preserves the caller change handler', async () => {
  const onChange = () => {}
  const page = await createComponentHarness(filterFile, { dependencies: filterDeps, exportName: 'FilterSelect',
    props: { value: 'external', resetValue: 'all', onChange, disabled: true } })
  const select = page.nodes((node) => node.type === 'SelectMenu')[0]
  assert.equal(select.props.resetValue, 'all')
  assert.equal(select.props.clearable, true)
  assert.equal(select.props.disabled, true)
  assert.equal(select.props.onChange, onChange)
  page.unmount()
})
