import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

const Modal = () => null, SelectMenu = () => null
const ui = { Modal, SelectMenu, Confirm: () => null, Icon: () => null, Loading: () => null, ErrorState: () => null, toast() {} }
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
