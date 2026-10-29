import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

const uiFile = new URL('../src/ui.jsx', import.meta.url)
function host(t) {
  const previousDocument = globalThis.document, previousWindow = globalThis.window
  const trigger = { focus() {}, isConnected: true }, layers = []
  globalThis.document = { activeElement: trigger }
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  t.after(() => { globalThis.document = previousDocument; globalThis.window = previousWindow })
  return { trigger, layers, dependencies: {
    './api.js': { api: {} },
    './dialog-focus.js': { registerDialogLayer(options) {
      const entry = { ...options, removed: 0 }; layers.push(entry)
      return () => entry.removed++
    } },
  } }
}

test('Modal has a stable labelled dialog, a named close button and a focus fallback', async (t) => {
  const { dependencies } = host(t)
  const props = { title: 'Edit plugin', onClose() {}, children: 'Plugin form' }
  const page = await createComponentHarness(uiFile, { dependencies, exportName: 'Modal', props })
  t.after(() => page.unmount())
  const dialog = page.nodes((node) => node.props.className === 'modal')[0]
  assert.equal(dialog.props.role, 'dialog')
  assert.equal(dialog.props['aria-modal'], true)
  assert.equal(dialog.props.tabIndex, -1)
  const titleId = dialog.props['aria-labelledby']
  assert.ok(titleId)
  assert.equal(page.nodes((node) => node.props.id === titleId)[0].props.children, props.title)
  const close = page.nodes((node) => node.props.className === 'mx')[0]
  assert.equal(close.props.type, 'button')
  assert.ok(close.props['aria-label'])
  page.render({ ...props, title: 'Updated plugin' })
  assert.equal(page.nodes((node) => node.props.role === 'dialog')[0].props['aria-labelledby'], titleId)
})

test('Modal keeps one focus registration while callback identity and field content change', async (t) => {
  const { dependencies, layers, trigger } = host(t)
  const calls = []
  const page = await createComponentHarness(uiFile, { dependencies, exportName: 'Modal',
    props: { title: 'Edit', children: 'a', onClose: () => calls.push('initial') } })
  page.render()
  assert.equal(layers.length, 1)
  assert.equal(layers[0].returnFocus, trigger)
  page.render({ title: 'Edit', children: 'ab', onClose: () => calls.push('latest') })
  assert.equal(layers.length, 1, 'typing must not restart focus management')
  layers[0].onClose()
  assert.deepEqual(calls, ['latest'])
  page.unmount()
  assert.equal(layers[0].removed, 1)
})

test('legacy useEscClose shares keyboard ownership and keeps the latest callback without rebinding', async (t) => {
  const { dependencies, layers } = host(t)
  const calls = []
  const page = await createComponentHarness(uiFile, { dependencies, exportName: 'useEscClose',
    props: () => calls.push('initial') })
  page.render()
  assert.equal(layers.length, 1)
  page.render(() => calls.push('latest'))
  assert.equal(layers.length, 1)
  layers[0].onClose()
  assert.deepEqual(calls, ['latest'])
  page.unmount()
  assert.equal(layers[0].removed, 1)
})

test('Modal renders legacy footer actions and gives foot explicit precedence', async (t) => {
  const { dependencies } = host(t)
  const props = { title: 'Attach repository', onClose() {}, footer: 'Save repository' }
  const page = await createComponentHarness(uiFile, { dependencies, exportName: 'Modal', props })
  t.after(() => page.unmount())
  assert.equal(page.nodes((node) => node.props.className === 'modal-foot')[0]?.props.children, 'Save repository')
  page.render({ ...props, foot: 'Preferred action' })
  assert.equal(page.nodes((node) => node.props.className === 'modal-foot')[0]?.props.children, 'Preferred action')
})

test('Modal portals to body and consumes clicks before React propagates to an outer layer', async (t) => {
  const { dependencies } = host(t)
  const body = {}, portals = [], closed = [], propagated = []
  globalThis.document.body = body
  const page = await createComponentHarness(uiFile, { exportName: 'Modal',
    dependencies: { ...dependencies, 'react-dom': { createPortal(element, target) { portals.push(target); return element } } },
    props: { title: 'Inner decision', onClose: () => closed.push('inner') } })
  t.after(() => page.unmount())
  const mask = page.nodes((node) => node.props.className === 'modal-mask')[0]
  assert.deepEqual(portals, [body])
  const inside = { stopPropagation: () => propagated.push('stopped'), target: {}, currentTarget: {} }
  page.act(() => mask.props.onMouseDown(inside))
  page.act(() => mask.props.onClick(inside))
  assert.deepEqual(closed, [], 'content clicks cannot dismiss the dialog')
  const backdrop = {}
  page.act(() => mask.props.onMouseDown({ stopPropagation: () => propagated.push('stopped'), target: backdrop, currentTarget: backdrop }))
  page.act(() => mask.props.onClick({ stopPropagation: () => propagated.push('stopped'), target: backdrop, currentTarget: backdrop }))
  assert.deepEqual(closed, ['inner'])
  assert.deepEqual(propagated, ['stopped', 'stopped'], 'neither content nor backdrop clicks may close a React ancestor')
})
test('Modal ignores text-selection drags that start inside and release on the mask', async (t) => {
  const { dependencies } = host(t)
  const closed = []
  const page = await createComponentHarness(uiFile, { exportName: 'Modal',
    dependencies, props: { title: 'Select me', onClose: () => closed.push('closed') } })
  t.after(() => page.unmount())
  const mask = page.nodes((node) => node.props.className === 'modal-mask')[0]
  const stop = () => {}
  const modalNode = page.nodes((node) => node.props.className === 'modal')[0]
  // Simulate text selection beginning inside the dialog and ending on the backdrop.
  // Its common-ancestor click must not dismiss the dialog.
  page.act(() => mask.props.onMouseDown({ target: modalNode, currentTarget: mask }))
  page.act(() => mask.props.onClick({ stopPropagation: stop, target: mask, currentTarget: mask }))
  assert.deepEqual(closed, [], 'a selection drag released on the mask must not close the dialog')
  // A press and release both on the backdrop still dismiss it.
  const self = {}
  page.act(() => mask.props.onMouseDown({ target: self, currentTarget: self }))
  page.act(() => mask.props.onClick({ stopPropagation: stop, target: self, currentTarget: self }))
  assert.deepEqual(closed, ['closed'], 'a genuine mask click must still close the dialog')
})
