import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale, translateText } from '../src/i18n.js'
import messages from '../src/locales/model-capabilities.js'

test('capability checks prevent duplicate calls and retry network failures without declaring unsupported', async t => {
  let resolve, calls = 0, fail = false
  const responses = []
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'ModelCapabilityStatus', props: { model: { providerId: 'org', name: 'vision' }, onChecked: data => responses.push(data) },
    dependencies: { '../api.js': { api: { checkModelCapabilities: body => {
      calls++; assert.deepEqual(body, { providerId: 'org', model: 'vision', checks: ['connection', 'imageInput', 'toolCalling', 'streaming'] })
      return fail ? Promise.reject(new Error('Network timeout')) : new Promise(done => { resolve = done })
    } } } },
  })
  t.after(() => page.unmount())
  const button = () => page.nodes(n => n.type === 'button')[0]
  const pending = button().props.onClick(); await button().props.onClick()
  assert.equal(calls, 1); assert.equal(button().props.disabled, true)
  const result = { checks: { imageInput: { status: 'passed', code: 'verified' } } }
  resolve(result); await pending; await page.flush()
  assert.equal(responses.length, 1); assert.equal(Boolean(button().props.disabled), false)
  fail = true; await button().props.onClick(); await page.flush()
  assert.equal(page.nodes(n => n.props.role === 'alert')[0].props.children, 'Network timeout')
  assert.equal(responses.length, 1)
  fail = false; const retry = button().props.onClick(); resolve(result); await retry; await page.flush()
  assert.equal(page.nodes(n => n.props.role === 'alert').length, 0)
})

test('old check responses cannot update a removed or changed model row', async () => {
  let done, applied = 0
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'ModelCapabilityStatus', props: { model: { providerId: 'org', name: 'vision' }, onChecked: () => applied++ },
    dependencies: { '../api.js': { api: { checkModelCapabilities: () => new Promise(resolve => { done = resolve }) } } },
  })
  const pending = page.nodes(n => n.type === 'button')[0].props.onClick()
  page.unmount(); done({ checks: {} }); await pending
  assert.equal(applied, 0)
})

test('legacy native capability is configured, not falsely marked verified', async t => {
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityBadges', props: { model: { config: { imageRouting: 'native' } } }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => { page.unmount(); setLocale('zh-CN') })
  setLocale('en-US'); page.render({ model: { config: { imageRouting: 'native' } } })
  const badges = page.nodes(n => n.type === 'span')
  assert.equal(badges[0].props.title, 'Existing configuration')
  assert.equal(badges[1].props.title, 'Unknown')
})

test('all authored capability copy has an English translation', () => {
  for (const [source, english] of Object.entries(messages)) assert.equal(translateText(source, [], 'en-US'), english)
})
