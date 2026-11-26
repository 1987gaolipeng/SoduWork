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

test('all editor dismissal paths compare the draft, keep the safe choice and leave saving independent', async t => {
  const { dependencies, layers } = host(t)
  let closed = 0, saved = 0
  const original = { name: 'Role', permissions: ['a'], access: { listed: true, scope: 'own' } }
  const props = { title: 'Edit', draft: original, onClose: () => closed++,
    foot: dismiss => [dismiss, () => saved++] }
  const page = await createComponentHarness(uiFile, { exportName: 'Modal', dependencies, props })
  t.after(() => page.unmount())
  const footer = () => page.nodes(node => node.props.className === 'modal-foot')[0].props.children
  const confirm = () => page.nodes(node => node.type?.name === 'Confirm')[0]
  const backdrop = {}
  const actions = [
    () => layers[0].onClose(),
    () => page.nodes(node => node.props.className === 'mx')[0].props.onClick(),
    () => {
      const { onMouseDown, onClick } = page.nodes(node => node.props.className === 'modal-mask')[0].props
      const event = { target: backdrop, currentTarget: backdrop, stopPropagation() {} }
      onMouseDown(event); onClick(event)
    },
    () => footer()[0](),
  ]
  const renderDraft = draft => page.render({ ...props, draft })
  page.render()
  page.render({ ...props, draft: { ...original, name: 'Saving' }, busy: true })
  assert.equal(page.nodes(node => node.props.className === 'mx')[0].props.disabled, true)
  for (const dismiss of actions) {
    page.act(dismiss)
    assert.equal(confirm(), undefined, 'a pending save must not prompt to discard its draft')
    assert.equal(closed, 0)
  }
  renderDraft({ ...original, name: 'Changed' })
  for (const dismiss of actions) {
    page.act(dismiss)
    const prompt = confirm()
    assert.ok(prompt?.props.focusCancel)
    assert.equal(closed, 0)
    page.act(prompt.props.onClose)
    assert.equal(confirm(), undefined)
  }
  page.act(footer()[1])
  assert.equal(saved, 1)
  assert.equal(confirm(), undefined)
  page.act(actions[0])
  page.act(confirm().props.onConfirm)
  assert.equal(closed, 1)
  assert.equal(confirm(), undefined)
  renderDraft({ access: { scope: 'own', listed: true }, permissions: ['a'], name: 'Role' })
  page.act(actions[3])
  assert.equal(closed, 2)
  assert.equal(confirm(), undefined)
  page.render({ ...props, draft: undefined, dirty: true })
  page.act(actions[1])
  assert.ok(confirm())
  page.render({ ...props, dirty: true, busy: true })
  assert.equal(confirm(), undefined, 'starting a save clears an earlier discard prompt')
  page.render({ ...props, dirty: true })
  assert.equal(confirm(), undefined, 'finishing the save must not reopen a stale prompt')
})

test('Confirm keeps its dialog and cancel button busy until the submitted action settles', async t => {
  const { dependencies } = host(t)
  let finish
  const page = await createComponentHarness(uiFile, { exportName: 'Confirm', dependencies,
    props: { onClose() {}, onConfirm: () => new Promise(resolve => { finish = resolve }) } })
  t.after(() => page.unmount())
  const dialog = () => page.nodes(node => node.type?.name === 'Modal')[0]
  const buttons = () => dialog().props.foot(dialog().props.onClose).props.children
  page.act(() => buttons()[1].props.onClick())
  assert.equal(dialog().props.busy, true)
  assert.equal(buttons()[0].props.disabled, true)
  finish()
  await page.flush()
  assert.equal(dialog().props.busy, false)
  assert.equal(buttons()[0].props.disabled, false)
})
