import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as healthVersion from '../src/health-version.js'
import * as adminHistory from '../src/admin-history.js'
import { setLocale, t as translate } from '../src/i18n.js'

function browserHistory(events, hash) {
  const location = new URL('https://hub.example.test/admin/?ui=1' + hash)
  const entries = [{ url: location.href, state: { other: 'existing' } }]
  let index = 0
  return { location, entries,
    get state() { return entries[index].state },
    replaceState(state, title, url) {
      if (url !== undefined) location.href = new URL(url, location).href
      entries[index] = { url: location.href, state }
    },
    pushState(state, title, url) {
      entries.splice(++index)
      this.replaceState(state, title, url)
    },
    go(delta) {
      queueMicrotask(() => {
        assert.ok(entries[index + delta], 'traversal must stay in the browser stack')
        index += delta
        location.href = entries[index].url
        events.dispatchEvent(new Event('popstate'))
        events.dispatchEvent(new Event('hashchange'))
      })
    },
  }
}

const click = node => node.props.onClick({ button: 0, preventDefault() {} })

async function mount(t, { permissions = ['identity.manage', 'task.view'], cachedPermissions = permissions, loadUser = async u => u,
  active = 'overview', isSuper = false, hash = '', token = 'fixture' } = {}) {
  setLocale('zh-CN')
  const values = new Map([['soduwork-hub-screen', active]])
  const descriptors = new Map(['window', 'document', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const events = new EventTarget()
  const history = browserHistory(events, hash)
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: history.location, history,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setInterval() { return 1 }, clearInterval() {}, scrollTo() {},
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    hidden: false, documentElement: {}, addEventListener() {}, removeEventListener() {},
  } })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value),
  } })
  const user = { username: 'admin-fixture', displayName: 'Fixture Admin', isSuper, permissions }
  let cachedUser = token ? { ...user, permissions: cachedPermissions } : null
  const page = await createComponentHarness(new URL('../src/App.jsx', import.meta.url), { dependencies: {
    './api.js': { api: { me: () => loadUser(user), health: async () => ({ ok: true }) }, getToken: () => token,
      getUser: () => cachedUser, setUser: u => { cachedUser = u }, setToken: value => { token = value },
      can: permission => cachedUser?.isSuper || cachedUser?.permissions.includes(permission) },
    './Login.jsx': 'Login', './LocaleSettings.jsx': 'LocaleSettings', './Landing.jsx': 'Landing',
    './ui.jsx': { Icon: 'Icon', Loading: 'Loading', ThemeToggle: 'ThemeToggle', ToastHost: 'ToastHost' },
    './health-version.js': healthVersion,
    './admin-history.js': adminHistory,
  } })
  page.render(); await page.flush()
  t.after(() => {
    page.unmount()
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  })
  const links = () => page.nodes(node => node.type === 'a' && String(node.props.className).startsWith('nav-item'))
  const account = () => links().find(node => node.props.href === '#/account-security')
  const screen = () => page.nodes(node => node.props.className === 'app')[0]?.props['data-screen']
  const legal = () => links().find(node => node.props.href === '#/legal-documents')
  return { page, account, legal, screen, values, events, history, links }
}

test('identity administrator can open account security from the visible organization navigation', async t => {
  const { page, account, screen, values } = await mount(t)
  assert.ok(account(), 'mail configuration needs a reachable navigation entry')
  page.act(() => click(account()))
  assert.equal(screen(), 'account-security')
  assert.equal(account().props['aria-current'], 'page')
  assert.equal(values.get('soduwork-hub-screen'), 'account-security')
})

test('saved account security selection reopens the configured page after refresh', async t => {
  const { account, screen } = await mount(t, { active: 'account-security', isSuper: true })
  assert.ok(account())
  assert.equal(screen(), 'account-security')
})

test('integration management alone cannot expose or restore the identity-protected page', async t => {
  const { account, screen } = await mount(t, { permissions: ['integration.manage', 'task.view'], active: 'account-security' })
  assert.equal(account(), undefined)
  assert.equal(screen(), 'overview')
})

test('ordinary administrators cannot expose or restore superuser-only legal management', async t => {
  const regular = await mount(t, { active: 'legal-documents' })
  assert.equal(regular.legal(), undefined)
  assert.equal(regular.screen(), 'overview')
})

test('platform administrators can open legal publication management', async t => {
  const { page, legal, screen } = await mount(t, { isSuper: true })
  assert.ok(legal())
  page.act(() => click(legal()))
  assert.equal(screen(), 'legal-documents')
})

test('unsaved-page guards can cancel sidebar and cross-page navigation without changing the stored screen', async t => {
  const { page, account, screen, values, events } = await mount(t)
  const keepDraft = event => event.preventDefault()
  events.addEventListener('soduwork-before-admin-leave', keepDraft)
  page.act(() => click(account()))
  assert.equal(screen(), 'overview')
  page.act(() => events.dispatchEvent(new CustomEvent('soduwork-hub-nav', { detail: { screen: 'account-security' } })))
  assert.equal(screen(), 'overview')
  assert.equal(values.get('soduwork-hub-screen'), 'overview')
  events.removeEventListener('soduwork-before-admin-leave', keepDraft)
  page.act(() => click(account()))
  assert.equal(screen(), 'account-security')
})

test('a confirmed asynchronous guard resumes only its requested navigation once', async t => {
  const { page, account, screen, events } = await mount(t)
  let proceed
  const defer = event => { event.preventDefault(); proceed = event.detail.proceed }
  events.addEventListener('soduwork-before-admin-leave', defer)
  page.act(() => click(account()))
  assert.equal(screen(), 'overview')
  assert.equal(typeof proceed, 'function')
  page.act(() => proceed())
  assert.equal(screen(), 'account-security')
  events.removeEventListener('soduwork-before-admin-leave', defer)
  page.act(() => events.dispatchEvent(new CustomEvent('soduwork-hub-nav', { detail: { screen: 'overview' } })))
  page.act(() => proceed())
  assert.equal(screen(), 'overview')
})

test('all 23 admin links share the rendered page title in every supported language', async t => {
  const { page, links, screen, history } = await mount(t, { isSuper: true, hash: '#/identity' })
  assert.equal(screen(), 'identity', 'the URL wins over the remembered overview')
  assert.equal(links().length, 23)
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    page.act(() => setLocale(locale))
    for (const href of links().map(link => link.props.href)) {
      const link = links().find(item => item.props.href === href)
      page.act(() => click(link))
      const id = link.props.href.slice(2)
      assert.equal(history.location.hash, link.props.href)
      assert.equal(screen(), id)
      const label = link.props.children[1].props.children
      assert.equal(document.title, label + ' · ' + translate('brand.admin'))
      assert.equal(page.nodes(node => node.type === 'h1')[0].props.children, label)
    }
  }
})

test('modified and middle clicks use the native link and leave this tab untouched', async t => {
  const { page, account, screen, history } = await mount(t)
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    page.act(() => account().props.onClick({ button: 0, ...modifier, preventDefault: () => assert.fail('new tab/window should use the link') }))
  }
  assert.equal(account().props.href, '#/account-security')
  assert.equal(screen(), 'overview')
  assert.equal(history.entries.length, 1)
})

for (const [hash, permissions, expected] of [
  ['#/nonexistent', ['task.view'], 'overview'],
  ['#/legal-documents', ['identity.manage'], 'account-security'],
  ['#/skills', ['integration.manage'], 'capabilities'],
  ['#/identity', [], undefined],
]) {
  test('replace an unknown, denied or legacy route with the allowed page: ' + hash, async t => {
    const { screen, history, values } = await mount(t, { hash, permissions })
    assert.equal(screen(), expected)
    assert.equal(history.location.hash, expected ? '#/' + expected : '')
    assert.equal(history.location.pathname + history.location.search, '/admin/?ui=1')
    assert.equal(history.entries.length, 1, 'the invalid URL should not remain on Back')
    assert.equal(history.state.other, 'existing')
    if (expected) assert.equal(values.get('soduwork-hub-screen'), expected)
  })
}

test('authentication keeps a shared link across password login and expiration', async t => {
  const { page, history, screen, events, values } = await mount(t, { token: '', hash: '#/identity' })
  const login = () => page.nodes(node => node.type === 'Login')[0]
  assert.ok(login())
  assert.equal(document.title, '登录 SoduWork 管理端')
  assert.equal(values.get('soduwork-hub-screen'), 'identity', 'remember the target before an IdP redirect')
  page.act(() => login().props.onLogin())
  await page.flush()
  assert.equal(screen(), 'identity')
  page.act(() => events.dispatchEvent(new Event('soduwork-hub-unauth')))
  assert.ok(login())
  assert.equal(history.location.hash, '#/identity')
  page.act(() => login().props.onBack())
  assert.ok(page.nodes(node => node.type === 'Landing').length)
  assert.equal(history.location.hash, '')
})

test('public download anchors still open the landing page', async t => {
  const { page, history } = await mount(t, { token: '', hash: '#downloads' })
  assert.ok(page.nodes(node => node.type === 'Landing').length)
  assert.equal(history.location.hash, '#downloads')
  assert.equal(document.title, 'SoduWork')
})

for (const allowed of [true, false]) {
  test('wait for current permissions before resolving a link with stale cached access: ' + allowed, async t => {
    let finish
    const withAccess = ['identity.manage', 'task.view'], withoutAccess = ['task.view']
    const { page, history, screen } = await mount(t, { hash: '#/identity',
      permissions: allowed ? withAccess : withoutAccess, cachedPermissions: allowed ? withoutAccess : withAccess,
      loadUser: user => new Promise(resolve => { finish = () => resolve(user) }) })
    assert.equal(screen(), undefined)
    assert.equal(history.location.hash, '#/identity')
    finish()
    await page.flush()
    assert.equal(screen(), allowed ? 'identity' : 'overview')
    assert.equal(history.location.hash, allowed ? '#/identity' : '#/overview')
  })
}

test('typing a same-document fragment creates a traversable route and canonicalizes aliases', async t => {
  const { page, history, screen, events } = await mount(t, { isSuper: true, hash: '#/users' })
  history.pushState(null, '', '#/skills')
  page.act(() => events.dispatchEvent(new Event('hashchange')))
  assert.equal(screen(), 'capabilities')
  assert.equal(history.location.hash, '#/capabilities')
  history.go(-1)
  await page.flush()
  assert.equal(screen(), 'users')
  history.go(1)
  await page.flush()
  assert.equal(screen(), 'capabilities')
})

for (const [hash, success] of [['#sso=synthetic-test-token', true], ['#sso_error=fixture-failure', false]]) {
  test('OIDC ' + (success ? 'success' : 'failure') + ' consumes the callback fragment and restores the requested page', async t => {
    const { page, history, screen } = await mount(t, { token: '', hash, active: 'identity' })
    assert.equal(history.location.hash, '#/identity')
    assert.equal(history.entries.length, 1)
    assert.doesNotMatch(history.entries[0].url, /sso|synthetic|failure/)
    if (success) assert.equal(screen(), 'identity')
    else assert.equal(page.nodes(node => node.type === 'Login')[0].props.initialError, 'fixture-failure')
  })
}

test('Back and Forward restore or resume the precise history entry when a draft blocks navigation', async t => {
  const { page, links, legal, history, screen, events } = await mount(t, { isSuper: true })
  const navigate = id => page.act(() => click(links().find(link => link.props.href === '#/' + id)))
  const move = async delta => { history.go(delta); await page.flush() }
  navigate('users')
  history.replaceState({ ...history.state, filters: { q: 'fixture' } }, '')
  page.act(() => click(legal()))
  assert.equal(history.state.filters, undefined)
  navigate('identity')
  await move(-1)
  assert.equal(screen(), 'legal-documents')
  let proceed
  const keepDraft = event => { event.preventDefault(); proceed = event.detail.proceed }
  events.addEventListener('soduwork-before-admin-leave', keepDraft)
  await move(-1)
  assert.equal(screen(), 'legal-documents')
  assert.equal(history.location.hash, '#/legal-documents')
  await move(1)
  assert.equal(screen(), 'legal-documents')
  assert.equal(history.location.hash, '#/legal-documents')
  proceed()
  await page.flush()
  assert.equal(screen(), 'identity')
  events.removeEventListener('soduwork-before-admin-leave', keepDraft)
  await move(-1)
  events.addEventListener('soduwork-before-admin-leave', keepDraft)
  await move(-1)
  proceed()
  await page.flush()
  assert.equal(screen(), 'users')
  assert.deepEqual(history.state.filters, { q: 'fixture' })
  assert.equal(history.entries.length, 4, 'restoring and resuming must preserve both sides of the stack')
})
