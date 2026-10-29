import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'

const Modal = () => null
const Confirm = () => null
const LocalesEditor = () => null
const ui = { Modal, Confirm, Icon: () => null, Loading: () => null, SelectMenu: () => null, toast() {} }
const viewport = { useViewportHeight: () => undefined }
function descendants(value, predicate) {
  if (Array.isArray(value)) return value.flatMap((child) => descendants(child, predicate))
  if (!React.isValidElement(value)) return []
  return [...(predicate(value) ? [value] : []), ...descendants(value.props.children, predicate)]
}

for (const [file, loadMethod, deleteMethod, item, css] of [
  ['AutomationTemplates.jsx', 'automationTemplates', 'saveAutomationTemplates', { id: 'daily-report', name: 'Daily report', every: 'daily', enabled: true, requiredCapabilities: [] }, './automation-templates.css'],
  ['OrgMemory.jsx', 'orgMemories', 'deleteOrgMemory', { id: 'org-memory', title: 'Shared memory', fields: {}, summary: 'Context' }, './org-memory.css'],
]) {
  test(`${file} requires confirmation and preserves the item when deletion fails`, async (t) => {
    const requests = []
    let fail = true
    const api = {
      [loadMethod]: async () => ({ items: [item] }),
      [deleteMethod]: async (payload) => { requests.push(payload); if (fail) throw new Error('offline'); return { items: [] } },
    }
    const page = await createComponentHarness(new URL('../src/screens/' + file, import.meta.url), {
      dependencies: { '../api.js': { api }, '../ui.jsx': ui, '../viewport-height.js': viewport,
        '../components/LocalesEditor.jsx': LocalesEditor, [css]: {} },
    })
    t.after(() => page.unmount())
    page.render(); await page.flush()
    const removeButton = () => page.nodes((node) => node.type === 'button' && node.props.className?.includes('is-danger'))[0]
    page.act(() => removeButton().props.onClick())
    assert.equal(requests.length, 0, 'opening the confirmation cannot mutate data')
    page.act(() => page.nodes((node) => node.type === Confirm)[0].props.onClose())
    assert.equal(requests.length, 0, 'cancelling cannot mutate data')
    page.act(() => removeButton().props.onClick())
    await page.nodes((node) => node.type === Confirm)[0].props.onConfirm()
    page.render()
    assert.equal(requests.length, 1)
    assert.ok(removeButton(), 'failed deletion retains the visible item')
    assert.ok(page.nodes((node) => node.type === Confirm)[0], 'failed deletion keeps the decision available for retry')
    fail = false
    await page.nodes((node) => node.type === Confirm)[0].props.onConfirm()
    page.render()
    assert.equal(requests.length, 2)
    assert.equal(removeButton(), undefined)
    assert.equal(page.nodes((node) => node.type === Confirm).length, 0)
  })
}

for (const [file, className, value, changeProp, css] of [
  ['AutomationTemplates.jsx', 'at-editor', { id: 'daily-report', name: 'Daily report', note: 'Prepare report', every: 'daily', requiredCapabilities: [], enabled: true }, 'onChange', './automation-templates.css'],
  ['OrgMemory.jsx', 'om-editor', { title: 'Shared memory', fields: { summary: 'Confirmed context' } }, 'setValue', './org-memory.css'],
]) {
  test(`${file} keeps required fields and routes the fixed save action through its real form`, async (t) => {
    const calls = [], changes = []
    const props = { value, [changeProp]: (next) => changes.push(next), onSave: () => calls.push('save'),
      onCancel: () => calls.push('close'), onClose: () => calls.push('close'), busy: false }
    const page = await createComponentHarness(new URL('../src/screens/' + file, import.meta.url), {
      exportName: 'Editor', privateExports: ['Editor'], props,
      dependencies: { '../api.js': { api: {} }, '../ui.jsx': ui, '../viewport-height.js': viewport,
        '../components/LocalesEditor.jsx': LocalesEditor, [css]: {} },
    })
    t.after(() => page.unmount())
    const dialog = page.nodes((node) => node.type === Modal)[0]
    assert.ok(dialog, 'editor must use the shared dialog and focus lifecycle')
    const form = page.nodes((node) => node.type === 'form' && node.props.className === className)[0]
    const buttons = descendants(dialog.props.foot, (node) => node.type === 'button')
    const submit = buttons.find((node) => node.props.type === 'submit')
    assert.ok(form.props.id)
    assert.equal(submit?.props.form, form.props.id, 'the visible save action must invoke native form validation')
    assert.ok(page.nodes((node) => node.props.required).length)
    page.act(() => form.props.onSubmit({ preventDefault: () => calls.push('prevent-default') }))
    assert.deepEqual(calls, ['prevent-default', 'save'])
    page.act(() => buttons.find((node) => node.props.type === 'button').props.onClick())
    assert.equal(calls.at(-1), 'close')
    page.render({ ...props, busy: true })
    const busyDialog = page.nodes((node) => node.type === Modal)[0]
    assert.equal(descendants(busyDialog.props.foot, (node) => node.props.type === 'submit')[0].props.disabled, true)
  })
}
