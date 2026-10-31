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

function descendants(value, predicate) {
  if (Array.isArray(value)) return value.flatMap(child => descendants(child, predicate))
  if (!React.isValidElement(value)) return []
  return [...(predicate(value) ? [value] : []), ...descendants(value.props.children, predicate)]
}
function cardValues(page, className) {
  return page.nodes(node => node.props.className?.split(/\s+/).includes(className)).map(card => {
    const strong = descendants(card, node => node.type === 'strong')[0]
    const children = strong.props.children
    return String(Array.isArray(children) ? children[0] : children)
  })
}
function capacityButton(page) {
  return page.nodes(node => node.type === 'button' && textOf(node) === '并发与等待')[0]
}
function retry(page) {
  const button = descendants(byClass(page, 'model-runtime-state'), node => node.type === 'button')[0]
  page.act(() => button.props.onClick())
}


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
  assert.equal(cardValues(page, 'model-load-card')[0], '5')
  assert.ok(textOf(byClass(page, 'model-runtime-live')).includes('全站并发上限 16'))
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
    const facts = byClass(page, 'model-runtime-live')
    const recent = byClass(page, 'model-runtime-recent')
    const actions = byClass(page, 'model-runtime-actions')
    const catalogAction = page.nodes((node) => node.props['data-catalog-action'])[0]
    const capacityButton = page.nodes((node) => node.type === 'button' && textOf(node) === '并发与等待')[0]
    for (const node of [facts, recent, actions, catalogAction, capacityButton]) {
      assert.ok(node)
      assert.equal(contains(body, node), false, 'collapsing details must not hide the summary or actions')
    }
    assert.ok(contains(actions, catalogAction))
    assert.ok(contains(actions, capacityButton))
    assert.equal(capacityButton.props.disabled, false)
    assert.equal(cardValues(page, 'model-load-card')[0], '2')
    assert.ok(textOf(facts).includes('全站并发上限 16'))
    toggle(page)
  }
})


test('runtime loading and initial errors do not masquerade as measured zeroes; retry is guarded', async (t) => {
  const page = await mountRuntime(t)
  assert.deepEqual(cardValues(page, 'model-load-card'), ['—', '—'])
  assert.deepEqual(cardValues(page, 'model-runtime-stat'), ['—', '—', '—', '—'])
  assert.equal(capacityButton(page).props.disabled, true)
  page.requests[0].reject(new Error('fixture unavailable'))
  await page.flush()
  const alert = byClass(page, 'model-runtime-state')
  assert.equal(alert.props.role, 'alert')
  assert.ok(textOf(alert).includes('运行状态暂不可用'))
  assert.ok(textOf(alert).includes('fixture unavailable'))
  assert.deepEqual(cardValues(page, 'model-runtime-stat'), ['—', '—', '—', '—'])
  retry(page); retry(page)
  assert.equal(page.requests.length, 2, 'repeat retries share the original in-flight guard')
  page.requests[1].resolve(runtimeData())
  await page.flush()
  assert.equal(byClass(page, 'model-runtime-state'), undefined)
  assert.equal(capacityButton(page).props.disabled, false)
})

test('refresh failures keep clearly marked prior values and retry updates them without closing details', async (t) => {
  const page = await mountRuntime(t)
  page.requests[0].resolve(runtimeData())
  await page.flush()
  toggle(page)
  const id = assertDisclosure(page, true)
  const polling = page.poll()
  page.requests[1].reject(new Error('fixture refresh failed'))
  await polling; await page.flush()
  assertDisclosure(page, true, id)
  assert.deepEqual(cardValues(page, 'model-load-card'), ['2', '1'])
  const alert = byClass(page, 'model-runtime-state')
  assert.ok(textOf(alert).includes('刷新失败，以下显示上次成功读取的数据。'))
  assert.equal(capacityButton(page).props.disabled, true, 'stale policy cannot open for editing')
  retry(page)
  await page.poll()
  assert.equal(page.requests.length, 3, 'polling and retry cannot race')
  page.requests[2].resolve(runtimeData(7))
  await page.flush()
  assert.equal(byClass(page, 'model-runtime-state'), undefined)
  assert.equal(cardValues(page, 'model-load-card')[0], '7')
  assertDisclosure(page, true, id)
})

test('load limits and hourly outcomes have independent numbers; absent wait samples are unavailable', async (t) => {
  const page = await mountRuntime(t)
  page.requests[0].resolve({ ...runtimeData(21), policy: { globalConcurrent: 256, queueSize: 128 },
    lastHour: { started: 5, waitMs: 760, timeout: 17, queueTimeout: 6, rateLimited: 3 } })
  await page.flush()
  assert.equal(byClass(page, 'model-runtime-live').props['aria-label'], '实时负载')
  assert.equal(byClass(page, 'model-runtime-recent').props['aria-label'], '近一小时请求情况')
  assert.deepEqual(cardValues(page, 'model-load-card'), ['21', '1'])
  assert.deepEqual(cardValues(page, 'model-runtime-stat'), ['152', '17', '6', '3'])
  assert.ok(textOf(byClass(page, 'model-runtime-live')).includes('全站并发上限 256'))
  assert.ok(textOf(byClass(page, 'model-runtime-live')).includes('全站排队上限 128'))
  const polling = page.poll()
  page.requests[1].resolve({ ...runtimeData(0, []), queued: 0, policy: { globalConcurrent: 16, queueSize: 0 }, lastHour: { started: 0, waitMs: 0 } })
  await polling; await page.flush()
  assert.deepEqual(cardValues(page, 'model-runtime-stat'), ['—', '0', '0', '0'])
  assert.ok(textOf(byClass(page, 'model-runtime-live')).includes('未启用排队'))
  assert.equal(page.nodes(node => node.type === 'progress').length, 1, 'disabled queue does not produce a zero-capacity progress meter')
})

test('runtime polling pauses in hidden documents and late retries cannot update an unmounted view', async (t) => {
  const page = await mountRuntime(t)
  page.requests[0].resolve(runtimeData())
  await page.flush()
  document.hidden = true
  await page.poll()
  assert.equal(page.requests.length, 1)
  document.hidden = false
  const polling = page.poll()
  page.requests[1].reject(new Error('fixture retry'))
  await polling; await page.flush()
  retry(page)
  assert.equal(page.requests.length, 3)
  page.unmount()
  page.requests[2].resolve(runtimeData(9))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.timers.size, 0)
})
