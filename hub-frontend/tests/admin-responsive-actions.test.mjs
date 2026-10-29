import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'

const Confirm = () => null
const viewport = { useViewportHeight: () => undefined }
const uiFile = new URL('../src/ui.jsx', import.meta.url)
const runnerFile = new URL('../src/screens/RunnerBoard.jsx', import.meta.url)
const byClass = (page, name) => page.nodes((node) => node.props.className?.split(/\s+/).includes(name))[0]
const confirmation = (page) => page.nodes((node) => node.type === Confirm)[0]

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function descendants(value, predicate) {
  if (Array.isArray(value)) return value.flatMap((child) => descendants(child, predicate))
  if (!React.isValidElement(value)) return []
  return [...(predicate(value) ? [value] : []), ...descendants(value.props.children, predicate)]
}

function isolatedHost(t, data, methods) {
  const messages = [], reloads = []
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network requests are forbidden in these tests') })
  const api = new Proxy(methods, { get(target, name) {
    assert.ok(name in target, `unexpected API method: ${String(name)}`)
    return target[name]
  } })
  // The list fixture excludes loading/polling, already covered by hook tests.
  // Mutation handlers below execute the real page code against explicit stubs.
  const query = { data, loading: false, error: null, reload: () => reloads.push('reload') }
  const dependencies = {
    '../api.js': { api },
    '../ui.jsx': { Confirm, Icon: () => null, Modal: () => null, Loading: () => null,
      ErrorState: () => null, SelectMenu: () => null, AUTO: {},
      useAsync: () => query, toast: (message) => messages.push(message) },
    '../viewport-height.js': viewport,
    '../ListPager.jsx': 'ListPager',
    './CloudRunnerManagement.jsx': 'CloudRunnerManagement',
    '../FilterControls.jsx': { FilterInput: () => null, FilterSelect: () => null },
    './admin-access-pages.css': {}, './identity-center.css': {}, './runner-board.css': {},
  }
  return { dependencies, query, messages, reloads }
}

async function mountSharedConfirm(t, page) {
  const element = confirmation(page)
  assert.ok(element, 'the action must render the shared Confirm component')
  const dialog = await createComponentHarness(uiFile, {
    exportName: 'Confirm', props: element.props,
    dependencies: { './api.js': { api: {} }, 'react-dom': { createPortal: (node) => node } },
  })
  t.after(() => dialog.unmount())
  const buttons = () => descendants(dialog.render().props.foot, (node) => node.type === 'button')
  return {
    props: element.props,
    cancel: () => buttons()[0].props.onClick(),
    submit: () => buttons()[1].props.onClick(),
    busy: () => Boolean(buttons()[1].props.disabled),
  }
}

test('identity deletion requires a shared confirmation and remains retryable after API failure', async (t) => {
  const row = { id: 'idp-local-fixture', name: 'Fixture identity', key: 'fixture',
    issuer: 'https://example.invalid', clientId: 'fixture-client', ready: true, enabled: false }
  const requests = []
  const host = isolatedHost(t, { providers: [row], orgs: [], roles: [] }, {
    deleteIdentityProvider(id) {
      const request = { id, ...deferred() }
      requests.push(request)
      return request.promise
    },
  })
  const page = await createComponentHarness(new URL('../src/screens/IdentityCenter.jsx', import.meta.url), {
    dependencies: host.dependencies,
  })
  t.after(() => page.unmount())
  const open = () => page.act(() => byClass(page, 'idp-delete').props.onClick())

  open()
  let dialog = await mountSharedConfirm(t, page)
  assert.equal(dialog.props.danger, true)
  assert.ok(dialog.props.text.includes(row.name), 'confirmation identifies the affected identity provider')
  assert.equal(requests.length, 0, 'opening cannot delete the identity provider')
  page.act(() => dialog.cancel())
  assert.equal(confirmation(page), undefined)
  assert.equal(requests.length, 0, 'cancelling cannot request deletion')

  open()
  dialog = await mountSharedConfirm(t, page)
  const failedAttempt = dialog.submit()
  assert.equal(dialog.busy(), true, 'the shared confirmation blocks another click while awaiting deletion')
  assert.deepEqual(requests.map((request) => request.id), [row.id])
  requests[0].reject(new Error('identity still has login bindings'))
  await failedAttempt
  page.render()
  assert.equal(dialog.busy(), false)
  assert.ok(confirmation(page), 'failed deletion leaves the confirmation available for retry')
  assert.ok(byClass(page, 'idp-delete'), 'failed deletion retains the identity provider')
  assert.equal(byClass(page, 'idp-delete').props.disabled, false)
  assert.deepEqual(host.reloads, [], 'a failed deletion does not refresh away the existing row')
  assert.ok(host.messages.some((message) => message.includes('login bindings')))

  const retry = dialog.submit()
  assert.equal(requests.length, 2, 'each explicit confirmation makes exactly one deletion request')
  host.query.data = { ...host.query.data, providers: [] }
  requests[1].resolve({ ok: true })
  await retry
  page.render()
  assert.equal(confirmation(page), undefined)
  assert.equal(byClass(page, 'idp-delete'), undefined)
  assert.deepEqual(host.reloads, ['reload'])
})

test('runner installation requires confirmation, releases the dialog while running and reports failure before retry', async (t) => {
  const row = { runnerId: 'runner-local-fixture', label: 'Fixture runner', online: true,
    orgId: 'fixture-org', orgName: 'Fixture org', mode: 'accepting', capabilities: {
      reportedAt: 1, items: [{ key: 'office', installed: false, installable: true, targetVersion: '1.0.0' }],
    } }
  const requests = [], polls = [], timers = []
  const host = isolatedHost(t, { items: [row], summary: {}, organizations: [] }, {
    installRunnerComponent(runnerId, key) {
      const request = { runnerId, key, ...deferred() }
      requests.push(request)
      return request.promise
    },
    async runnerComponentJob(runnerId, jobId) {
      polls.push({ runnerId, jobId })
      return { data: { state: 'done', ok: true, detail: 'Fixture installation completed' } }
    },
  })
  const page = await createComponentHarness(runnerFile, { dependencies: host.dependencies })
  t.after(() => page.unmount())
  const capabilityProps = () => page.nodes((node) => typeof node.type === 'function' && node.type.name === 'RunnerCapabilities')[0].props
  const capabilities = await createComponentHarness(runnerFile, {
    exportName: 'RunnerCapabilities', privateExports: ['RunnerCapabilities'],
    props: capabilityProps(), dependencies: host.dependencies,
  })
  t.after(() => capabilities.unmount())
  const syncCapabilities = () => capabilities.render(capabilityProps())
  const open = () => {
    syncCapabilities()
    page.act(() => byClass(capabilities, 'rb-cap-install').props.onClick())
  }

  open()
  let dialog = await mountSharedConfirm(t, page)
  assert.ok(dialog.props.text.includes(row.label), 'confirmation names the target runner')
  assert.equal(requests.length, 0, 'opening cannot start a remote installation')
  page.act(() => dialog.cancel())
  assert.equal(confirmation(page), undefined)
  assert.equal(requests.length, 0, 'cancelling cannot start installation')

  open()
  dialog = await mountSharedConfirm(t, page)
  await dialog.submit()
  assert.deepEqual(requests.map(({ runnerId, key }) => ({ runnerId, key })), [{ runnerId: row.runnerId, key: 'office' }])
  assert.equal(confirmation(page), undefined, 'confirmation closes before the remote installation finishes')
  syncCapabilities()
  assert.equal(byClass(capabilities, 'rb-cap-install').props.disabled, true)
  requests[0].reject(new Error('fixture runner disconnected'))
  await page.flush()
  syncCapabilities()
  assert.equal(byClass(capabilities, 'rb-cap-install').props.disabled, false)
  assert.ok(byClass(capabilities, 'rb-cap-job').props.className.includes('bad'))
  assert.ok(byClass(capabilities, 'rb-cap-job').props.children.includes('disconnected'))
  assert.ok(host.messages.some((message) => message.includes('disconnected')))
  assert.deepEqual(host.reloads, [])

  open()
  dialog = await mountSharedConfirm(t, page)
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 900, 'the remote-job polling cadence stays unchanged')
    timers.push(callback)
    return timers.length
  })
  await dialog.submit()
  assert.equal(requests.length, 2, 'retry starts exactly one new installation')
  assert.equal(confirmation(page), undefined)
  requests[1].resolve({ data: { jobId: 'fixture-job' } })
  await page.flush()
  assert.equal(timers.length, 1)
  timers.shift()()
  await page.flush()
  syncCapabilities()
  assert.deepEqual(polls, [{ runnerId: row.runnerId, jobId: 'fixture-job' }])
  assert.ok(byClass(capabilities, 'rb-cap-job').props.className.includes('ok'))
  assert.equal(byClass(capabilities, 'rb-cap-install').props.disabled, false)
  assert.deepEqual(host.reloads, ['reload'])
  assert.equal(timers.length, 0, 'completed installation leaves no queued poll')
})
