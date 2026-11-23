import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

const Modal = () => null, SelectMenu = () => null
const ui = { Modal, SelectMenu, takeNav: () => null, Confirm: () => null, Icon: () => null, Loading: () => null, ErrorState: () => null, toast() {} }
const capabilities = { CAPABILITY_LABELS: { imageInput: '图片输入', toolCalling: '工具调用', streaming: '流式输出' },
  CAPABILITY_STATES: { unknown: '未确认', supported: '支持', unsupported: '不支持' }, CapabilityBadges() {}, ModelCapabilityStatus() {} }
function children(value) {
  if (Array.isArray(value)) return value.flatMap(children)
  if (!React.isValidElement(value)) return []
  return [value, ...children(value.props.children)]
}

test('editing a model preserves native vision and unrelated config; both routing choices save and translate', async t => {
  const saved = []
  const page = await createComponentHarness(new URL('../src/screens/ModelCatalog.jsx', import.meta.url), {
    exportName: 'ModelForm', privateExports: ['ModelForm'],
    props: { providerId: 'company', initial: { name: 'vision-alias', label: 'Vision', enabled: true, revision: 'original',
      config: { imageRouting: 'native', thinkingMode: 'controllable', thinkingFormat: 'qwen', thinkingLevelMap: { high: 'high' } } }, onClose() {}, onSaved() {} },
    dependencies: { '../api.js': { api: { saveModelDef: async data => saved.push(data) } }, '../ui.jsx': ui,
      './ModelProviderDeletion.jsx': { __esModule: true, default: () => null },
      './LlmSettings.jsx': { default: () => null }, './ModelRuntime.jsx': { default: () => null }, './model-catalog-actions.css': {},
      './ModelCapabilities.jsx': capabilities, './model-capabilities.css': {} },
  })
  t.after(() => { page.unmount(); setLocale('zh-CN') })
  const field = () => page.nodes(node => node.type === SelectMenu && node.props.id === 'model-image-routing')[0]
  async function save() {
    const dialog = page.nodes(node => node.type === Modal)[0]
    const button = children(dialog.props.foot).find(node => node.type === 'button' && node.props.className === 'btn btn-primary')
    await button.props.onClick(); await page.flush()
  }
  assert.equal(field().props.value, 'native')
  await save()
  assert.equal(saved[0].config.imageRouting, 'native')
  assert.deepEqual(saved[0].config.thinkingLevelMap, { high: 'high' })
  assert.equal(saved[0].expectedRevision, 'original')
  page.act(() => field().props.onChange({ target: { value: 'vision-fallback' } }))
  await save()
  assert.equal(saved[1].config.imageRouting, 'vision-fallback')
  setLocale('en-US'); page.render({ providerId: 'company', initial: { name: 'vision-alias' }, onSaved() {} })
  assert.deepEqual(children(field().props.children).map(node => node.props.children), ['Automatic', 'Native vision', 'Separate vision service'])
  page.act(() => field().props.onChange({ target: { value: 'native' } }))
  await save()
  assert.equal(saved[2].config.imageRouting, 'native')
});

async function form(t, initial = null) {
  const saved = [], errors = []
  const page = await createComponentHarness(new URL('../src/screens/ModelCatalog.jsx', import.meta.url), {
    exportName: 'ModelForm', privateExports: ['ModelForm'],
    props: { providerId: 'company', initial, onClose() {}, onSaved() {} },
    dependencies: { '../api.js': { api: { saveModelDef: async data => saved.push(data) } }, '../ui.jsx': { ...ui, toast: text => errors.push(text) },
      './ModelProviderDeletion.jsx': { __esModule: true, default: () => null },
      './LlmSettings.jsx': { default: () => null }, './ModelRuntime.jsx': { default: () => null }, './model-catalog-actions.css': {},
      './ModelCapabilities.jsx': capabilities, './model-capabilities.css': {} },
  })
  t.after(() => { page.unmount(); setLocale('zh-CN') })
  const change = (id, value) => page.act(() => page.nodes(n => n.props.id === id)[0].props.onChange({ target: { value } }))
  const save = async () => {
    const modal = page.nodes(n => n.type === Modal)[0]
    await children(modal.props.foot).find(n => n.props.className === 'btn btn-primary').props.onClick()
    await page.flush()
  }
  return { page, saved, errors, change, save }
}

test('capability edits preserve config and use explicit integer limits', async t => {
  const f = await form(t, { name: 'custom', enabled: true, ctxWindow: 65536, config: { thinkingFormat: 'qwen', custom: 'retained' } })
  f.change('model-cap-imageInput', 'supported'); f.change('model-cap-streaming', 'supported')
  f.change('model-max-output', '32768'); f.change('model-context-window', '10000000')
  await f.save()
  assert.equal(f.saved.length, 1, JSON.stringify(f.errors))
  assert.equal(f.saved[0].ctxWindow, 10000000)
  assert.equal(f.saved[0].config.maxOutputTokens, 32768)
  assert.equal(f.saved[0].config.custom, 'retained')
  assert.equal(f.saved[0].config.thinkingFormat, 'qwen')
  assert.deepEqual(f.saved[0].config.capabilities, { imageInput: 'supported', toolCalling: 'unknown', streaming: 'supported' })
  assert.equal(f.saved[0].config.imageRouting, 'auto')
})

test('conflicting vision, fractional limits, and output beyond context never save', async t => {
  const f = await form(t, { name: 'custom', enabled: true, config: { imageRouting: 'native' } })
  f.change('model-cap-imageInput', 'unsupported'); await f.save(); assert.equal(f.saved.length, 0)
  f.change('model-image-routing', 'auto'); f.change('model-context-window', '2048.5'); await f.save(); assert.equal(f.saved.length, 0)
  f.change('model-context-window', '2048'); f.change('model-max-output', '4096'); await f.save(); assert.equal(f.saved.length, 0)
  f.change('model-context-window', ''); f.change('model-max-output', ''); await f.save(); assert.equal(f.saved.length, 1, JSON.stringify(f.errors))
  assert.equal(f.saved[0].ctxWindow, 0); assert.equal(f.saved[0].config.maxOutputTokens, undefined)
})

test('media generation settings stay separate from chat capabilities', async t => {
  const f = await form(t, { name: 'video', modality: 'video', enabled: true,
    config: { endpointPath: '/videos', statusPath: '/videos/{id}', resultPath: '/videos/{id}/content', defaults: { duration: 8 } } })
  assert.equal(f.page.nodes(n => n.props.id === 'model-image-routing').length, 0)
  await f.save()
  assert.equal(f.saved.length, 1, JSON.stringify(f.errors))
  assert.deepEqual(f.saved[0].config, { endpointPath: '/videos', statusPath: '/videos/{id}', resultPath: '/videos/{id}/content', defaults: { duration: 8 } })
  assert.equal(f.saved[0].ctxWindow, undefined)
})

async function catalogPage(t, getCatalog) {
  const page = await createComponentHarness(new URL('../src/screens/ModelCatalog.jsx', import.meta.url), {
    dependencies: { '../api.js': { api: { modelCatalog: async () => structuredClone(await getCatalog()) } }, '../ui.jsx': ui,
      './ModelProviderDeletion.jsx': { __esModule: true, default: () => null },
      './LlmSettings.jsx': () => null, './ModelRuntime.jsx': () => null, './model-catalog-actions.css': {},
      './ModelCapabilities.jsx': capabilities, './model-capabilities.css': {} },
  })
  t.after(() => page.unmount())
  page.render()
  await page.flush()
  return page
}
const readyProvider = { id: 'org', name: 'Org', enabled: true, keySet: true, baseUrl: 'http://example.test', revision: 'p1' }
const saved = { id: 'saved', revision: 'm1', configRevision: 'c1', providerRevision: 'p1' }
function addDialog(page, index = 0) {
  page.act(() => page.nodes(n => n.type === 'button' && n.props.className === 'admin-card-action is-primary')[index].props.onClick())
  return page.nodes(n => n.type.name === 'ModelForm')[0]
}

test('late creation on one provider preserves the currently open add dialog', async t => {
  const other = { ...readyProvider, id: 'other', name: 'Other' }
  const catalog = { providers: [readyProvider, other], models: [] }
  const page = await catalogPage(t, () => catalog)
  const first = addDialog(page)
  page.act(() => first.props.onClose())
  const next = addDialog(page, 1)
  catalog.models.push({ ...saved, providerId: 'org', name: 'chat', enabled: true })
  page.act(() => first.props.onSaved([saved]))
  await page.flush()
  assert.equal(page.nodes(n => n.type.name === 'ModelForm')[0]?.props.providerId, next.props.providerId)
  assert.equal(typeof page.nodes(n => n.type === capabilities.ModelCapabilityStatus)[0].props.scheduleFirstCheck, 'function')
})

test('retrying a failed catalog refresh still checks the newly saved model', async t => {
  const catalog = { providers: [readyProvider], models: [] }
  let fail = false
  const page = await catalogPage(t, () => {
    if (fail) throw Error('Synthetic read failure')
    return catalog
  })
  const dialog = addDialog(page)
  catalog.models.push({ ...saved, providerId: 'org', name: 'chat', enabled: true })
  fail = true
  page.act(() => dialog.props.onSaved([saved]))
  await page.flush()
  fail = false
  page.act(() => page.nodes(n => typeof n.props.onRetry === 'function')[0].props.onRetry())
  await page.flush()
  const row = page.nodes(n => n.type === capabilities.ModelCapabilityStatus)[0]
  assert.equal(typeof row.props.scheduleFirstCheck, 'function')
})

test('a catalog read started before a completed check cannot erase its report', async t => {
  const model = { id: 'org:chat', providerId: 'org', name: 'chat', revision: 'm1', configRevision: 'c1', enabled: true }
  const before = { providers: [readyProvider], models: [model] }
  let response = before, finishStaleRead
  const page = await catalogPage(t, () => response)
  const row = () => page.nodes(n => n.type === capabilities.ModelCapabilityStatus)[0]
  response = new Promise(resolve => { finishStaleRead = resolve })
  const dialog = addDialog(page)
  page.act(() => dialog.props.onSaved([]))
  const receipt = { configRevision: 'c1', checks: { streaming: { status: 'passed' } } }
  response = { ...before, models: [{ ...model, capabilityCheck: receipt }] }
  page.act(() => row().props.onChecked(receipt))
  finishStaleRead(before)
  await page.flush()
  assert.deepEqual(row().props.model.capabilityCheck, receipt)
})

test('first checks require a ready unchanged provider and enabled, untested chat model', async t => {
  for (const [providerFields, modelFields] of [
    [{ enabled: false }, {}], [{ baseUrl: '' }, {}], [{ keySet: false }, {}], [{ revision: 'p2' }, {}], [{ kind: 'anthropic' }, {}],
    [{}, { enabled: false }], [{}, { modality: 'image' }], [{}, { capabilityCheck: { checks: {} } }],
    [{}, { revision: 'm2' }], [{}, { configRevision: 'recreated' }],
  ]) {
    const catalog = { providers: [readyProvider], models: [] }
    const page = await catalogPage(t, () => catalog)
    const dialog = addDialog(page)
    catalog.providers = [{ ...readyProvider, ...providerFields }]
    catalog.models = [{ ...saved, providerId: 'org', name: 'chat', enabled: true, ...modelFields }]
    page.act(() => dialog.props.onSaved([saved]))
    await page.flush()
    assert.equal(page.nodes(n => n.type === capabilities.ModelCapabilityStatus && n.props.scheduleFirstCheck).length, 0)
  }
})

test('legacy create responses do not authorize automatic checks', async t => {
  const catalog = { providers: [readyProvider], models: [] }
  const page = await catalogPage(t, () => catalog)
  const dialog = addDialog(page)
  catalog.models = [{ ...saved, providerId: 'org', name: 'chat', enabled: true }]
  page.act(() => dialog.props.onSaved([{ ok: true, id: saved.id }]))
  await page.flush()
  assert.equal(page.nodes(n => n.type === capabilities.ModelCapabilityStatus && n.props.scheduleFirstCheck).length, 0)
})

test('changing thinking mode clears only stale derived reasoning flags', async t => {
  const f = await form(t, { name: 'reasoner', enabled: true,
    config: { thinkingMode: 'always', thinkingAlwaysOn: true, reasoning: true, thinkingLevelMap: { high: 'old' }, thinkingFormat: 'qwen', custom: 'kept' } })
  f.page.act(() => f.page.nodes(n => n.type === 'input' && n.props.name === 'thinking-mode' && n.props.value === 'auto')[0].props.onChange())
  await f.save()
  assert.equal(f.saved[0].config.thinkingMode, undefined)
  assert.equal(f.saved[0].config.reasoning, undefined)
  assert.equal(f.saved[0].config.thinkingAlwaysOn, undefined)
  assert.equal(f.saved[0].config.thinkingLevelMap, undefined)
  assert.equal(f.saved[0].config.thinkingFormat, 'qwen')
  assert.equal(f.saved[0].config.custom, 'kept')
})
