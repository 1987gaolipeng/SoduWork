import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'

// This executes ModelRuntime's real handlers and polling effect in the logical
// hook host. It does not claim browser keyboard, focus, layout, or CSS coverage.
async function mountRuntime(t) {
  const requests = [], timers = new Map()
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false } })
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else delete globalThis.document
  })
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    const timer = {}
    timers.set(timer, { callback, delay })
    return timer
  })
  t.mock.method(globalThis, 'clearInterval', (timer) => timers.delete(timer))
  const props = {
    providers: [], models: [],
    catalogActions: React.createElement('button', { 'data-catalog-action': true }, '组织默认调用'),
  }
  const dependencies = {
    '../api.js': { api: { modelRuntime() {
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      requests.push({ resolve, reject })
      return promise
    } } },
    '../ui.jsx': { Icon: 'Icon', Modal: 'Modal', SelectMenu: 'SelectMenu', toast: () => {} },
    './model-runtime.css': {},
  }
  const harness = await createComponentHarness(new URL('../src/screens/ModelRuntime.jsx', import.meta.url), { dependencies, props })
  t.after(() => {
    harness.unmount()
    assert.equal(timers.size, 0, 'the polling effect must release its timer')
  })
  harness.render()
  return { ...harness, requests, timers, props, poll() {
    assert.equal(timers.size, 1, 'rerenders must not create duplicate polling timers')
    const timer = [...timers.values()][0]
    assert.equal(timer.delay, 5000)
    return timer.callback()
  } }
}

const runtimeData = (running = 2, groups = [{ provider: 'service-1', model: 'model-1', running, queued: 1 }]) => ({
  running, queued: 1, policy: { globalConcurrent: 16, queueSize: 8 },
  lastHour: { waitMs: 30, started: 3 }, groups,
})
const byClass = (page, name) => page.nodes((node) => node.props.className?.split(/\s+/).includes(name))[0]
function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (React.isValidElement(value)) return textOf(value.props.children)
  return value == null || typeof value === 'boolean' ? '' : String(value)
}
function contains(value, target) {
  if (value === target) return true
  if (Array.isArray(value)) return value.some((child) => contains(child, target))
  return React.isValidElement(value) && contains(value.props.children, target)
}
function assertDisclosure(page, expanded, expectedId) {
  const button = byClass(page, 'model-runtime-services-head')
  const body = byClass(page, 'model-runtime-services-body')
  assert.equal(button.type, 'button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props['aria-expanded'], expanded)
  assert.equal(body.props.hidden, !expanded)
  assert.ok(body.props.id)
  assert.equal(button.props['aria-controls'], body.props.id)
  if (expectedId) assert.equal(body.props.id, expectedId, 'the controlled region ID must survive rerenders')
  assert.equal(textOf(byClass(page, 'model-runtime-services-toggle')), expanded ? '收起' : '展开')
  return body.props.id
}
const toggle = (page) => page.act(() => byClass(page, 'model-runtime-services-head').props.onClick())

test('runtime details start collapsed and the real click handler toggles aria and hidden together', async (t) => {
  const page = await mountRuntime(t)
  const id = assertDisclosure(page, false)
  assert.equal(page.requests.length, 1)
  page.requests[0].resolve(runtimeData())
  await page.flush()
  assertDisclosure(page, false, id)
  assert.equal(textOf(byClass(page, 'model-runtime-services-count')), '1 组')
  toggle(page)
  assertDisclosure(page, true, id)
  toggle(page)
  assertDisclosure(page, false, id)
})

test('catalog props and real polling responses preserve the current disclosure state', async (t) => {
  const page = await mountRuntime(t)
  toggle(page)
  const id = assertDisclosure(page, true)
  page.requests[0].resolve(runtimeData())
  await page.flush()
  assertDisclosure(page, true, id)
  page.render({ ...page.props, providers: [{ id: 'service-1' }], models: [{ id: 'model-1' }] })
  assertDisclosure(page, true, id)
  assert.equal(page.requests.length, 1, 'a props refresh must not restart the mount request')
  const polling = page.poll()
  assert.equal(page.requests.length, 2)
  page.requests[1].resolve(runtimeData(5))
  await polling
  await page.flush()
  assertDisclosure(page, true, id)
  assert.ok(textOf(byClass(page, 'model-runtime-facts')).includes('5 / 16'))
  toggle(page)
  const nextPolling = page.poll()
  page.requests[2].resolve(runtimeData(0, []))
  await nextPolling
  await page.flush()
  assertDisclosure(page, false, id)
  assert.equal(textOf(byClass(page, 'model-runtime-services-count')), '0 组')
})

test('metrics, catalog actions and concurrency settings stay outside the disclosure region', async (t) => {
  const page = await mountRuntime(t)
  page.requests[0].resolve(runtimeData())
  await page.flush()
  for (const expanded of [false, true, false]) {
    assertDisclosure(page, expanded)
    const body = byClass(page, 'model-runtime-services-body')
    const facts = byClass(page, 'model-runtime-facts')
    const actions = byClass(page, 'model-runtime-actions')
    const catalogAction = page.nodes((node) => node.props['data-catalog-action'])[0]
    const capacityButton = page.nodes((node) => node.type === 'button' && textOf(node) === '并发与等待')[0]
    for (const node of [facts, actions, catalogAction, capacityButton]) {
      assert.ok(node)
      assert.equal(contains(body, node), false, 'collapsing details must not hide the summary or actions')
    }
    assert.ok(contains(actions, catalogAction))
    assert.ok(contains(actions, capacityButton))
    assert.equal(capacityButton.props.disabled, false)
    assert.ok(textOf(facts).includes('2 / 16'))
    toggle(page)
  }
})
