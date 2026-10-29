import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

const source = new URL('../src/screens/OrgMemory.jsx', import.meta.url)
const Modal = () => null, Confirm = () => null
const current = { id: 'memory-1', title: 'Shared goals', summary: 'Confirmed summary', revision: 7,
  fields: { summary: 'Confirmed summary', goal: 'Deliver reliably', constraints: 'Protect data' } }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const Editor = (page) => page.nodes((node) => typeof node.type === 'function' && node.type.name === 'Editor')[0]
const button = (page, text) => page.nodes((node) => node.type === 'button' &&
  [node.props.children].flat().includes(text))[0]
async function harness(api, t) {
  const page = await createComponentHarness(source, { dependencies: {
    '../api.js': { api }, '../ui.jsx': { Modal, Confirm, Icon: () => null, Loading: () => null, toast() {} }, './org-memory.css': {},
  } })
  t.after(() => page.unmount())
  page.render(); await page.flush()
  return page
}

test('one shared document displays all structured fields; editing updates its ID and revision', async (t) => {
  const calls = []
  const page = await harness({ orgMemories: async () => ({ items: [current] }),
    updateOrgMemory: async (...args) => { calls.push(args); return { item: { ...current, revision: 8 } } },
    createOrgMemory: () => assert.fail('existing memory must not create a second record'),
  }, t)
  assert.equal(page.nodes((node) => node.type === 'article').length, 1)
  assert.equal(page.nodes((node) => node.type === 'input' && node.props.type === 'checkbox').length, 0)
  assert.ok(page.nodes((node) => node.type === 'p' && node.props.children === 'Deliver reliably').length)
  page.act(() => button(page, '补充与修正').props.onClick())
  await Editor(page).props.onSave(); page.render()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], current.id)
  assert.equal(calls[0][1].revision, 7)
  assert.equal(Editor(page), undefined)
})

test('automatically accumulated work is displayed separately and never copied into manual edits', async (t) => {
  const automatic = { ...current, summary: 'Manual addition + generated work', automaticSummary: 'Two delivered team outcomes', sourceCount: 2,
    fields: { summary: 'Manual addition' } }
  let saved
  const page = await harness({ orgMemories: async () => ({ items: [automatic] }),
    updateOrgMemory: async (_id, body) => { saved = body; return { item: automatic } },
  }, t)
  assert.ok(page.nodes(node => node.type === 'p' && node.props.children === automatic.automaticSummary).length)
  page.act(() => button(page, '补充与修正').props.onClick())
  assert.equal(Editor(page).props.value.fields.summary, 'Manual addition')
  await Editor(page).props.onSave()
  assert.equal(saved.fields.summary, 'Manual addition')
  assert.doesNotMatch(JSON.stringify(saved), /generated work|Two delivered/)
})

test('empty organization creates without an invented revision; archived records are not revived', async (t) => {
  const calls = []
  const page = await harness({ orgMemories: async () => ({ items: [{ ...current, archived: true }] }),
    createOrgMemory: async (body) => { calls.push(body); return { item: current } },
  }, t)
  assert.equal(page.nodes((node) => node.type === 'article').length, 0)
  page.act(() => button(page, '补充与修正').props.onClick())
  assert.equal(Editor(page).props.value.id, '')
  await Editor(page).props.onSave(); page.render()
  assert.equal(Object.hasOwn(calls[0], 'revision'), false)
  assert.equal(page.nodes((node) => node.type === 'article').length, 1)
})

test('duplicate active response fails visibly rather than silently choosing data to overwrite', async (t) => {
  const page = await harness({ orgMemories: async () => ({ items: [current, { ...current, id: 'duplicate' }] }) }, t)
  assert.equal(page.nodes((node) => node.props.role === 'alert').length, 1)
  assert.equal(page.nodes((node) => node.type === 'article').length, 0)
  assert.equal(button(page, '补充与修正'), undefined)
})

test('conflict preserves the unsaved draft and prevents duplicate simultaneous submissions', async (t) => {
  const update = deferred(); let calls = 0
  const page = await harness({ orgMemories: async () => ({ items: [current] }),
    updateOrgMemory: () => { ++calls; return update.promise },
  }, t)
  page.act(() => button(page, '补充与修正').props.onClick())
  page.act(() => Editor(page).props.setValue({ ...current, title: 'Unsaved draft' }))
  const save = Editor(page).props.onSave
  const first = save(), second = save()
  assert.equal(calls, 1)
  update.reject(new Error('revision conflict'))
  await Promise.all([first, second]); page.render()
  assert.equal(Editor(page).props.value.title, 'Unsaved draft')
  assert.equal(Editor(page).props.busy, false)
})

test('a slow refresh cannot replace a just-saved current memory', async (t) => {
  const refresh = deferred(); let loads = 0
  const page = await harness({ orgMemories: () => ++loads === 1 ? Promise.resolve({ items: [current] }) : refresh.promise,
    updateOrgMemory: async () => ({ item: { ...current, title: 'Saved revision', revision: 8 } }),
  }, t)
  const loading = button(page, '重新加载').props.onClick()
  page.act(() => button(page, '补充与修正').props.onClick())
  await Editor(page).props.onSave()
  refresh.resolve({ items: [current] }); await loading; page.render()
  assert.equal(page.nodes((node) => node.type === 'h3')[0].props.children, 'Saved revision')
})

test('pending load and save do not update the page after navigation', async () => {
  for (const mode of ['load', 'save']) {
    const pending = deferred()
    const page = await createComponentHarness(source, { dependencies: {
      '../api.js': { api: { orgMemories: () => mode === 'load' ? pending.promise : Promise.resolve({ items: [current] }),
        updateOrgMemory: () => pending.promise } },
      '../ui.jsx': { Modal, Confirm, Icon: () => null, Loading: () => null, toast() {} }, './org-memory.css': {},
    } })
    page.render(); await page.flush()
    let saving
    if (mode === 'save') {
      page.act(() => button(page, '补充与修正').props.onClick())
      saving = Editor(page).props.onSave()
    }
    page.unmount()
    pending.resolve(mode === 'load' ? { items: [current] } : { item: current })
    await saving; await new Promise(resolve => setImmediate(resolve))
  }
})
