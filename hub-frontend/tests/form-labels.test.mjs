import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { getLocale, setLocale, translateText as tx } from '../src/i18n.js'
import { registerDialogLayer } from '../src/dialog-focus.js'

const loginFile = new URL('../src/Login.jsx', import.meta.url)
const usersFile = new URL('../src/screens/Users.jsx', import.meta.url)
const uiFile = new URL('../src/ui.jsx', import.meta.url)
const inert = () => {}
const textOf = (node) => React.Children.toArray(node?.props?.children).map((child) => React.isValidElement(child) ? textOf(child) : String(child)).join('')

function labelledControl(page, labelText) {
  const label = page.nodes((node) => node.type === 'label' && textOf(node) === labelText)[0]
  assert.ok(label, `visible label exists: ${labelText}`)
  assert.ok(label.props.htmlFor, `label points to its control: ${labelText}`)
  const targets = page.nodes((node) => node.props.id === label.props.htmlFor)
  assert.equal(targets.length, 1, `label has exactly one target: ${labelText}`)
  assert.ok(['input', 'SelectMenu'].includes(targets[0].type), 'labels target the field, not its wrapper')
  return targets[0]
}

function assertNamedGroups(page, expected) {
  const groups = page.nodes((node) => node.props.role === 'group')
  assert.equal(groups.length, expected)
  for (const group of groups) {
    assert.ok(group.props['aria-labelledby'], 'each choice group has a visible programmatic name')
    const labels = page.nodes((node) => node.props.id === group.props['aria-labelledby'])
    assert.equal(labels.length, 1)
    assert.ok(textOf(labels[0]).trim())
  }
}

async function mountEditor(t, { user = null, component = 'UserEditor', extraProps = {} } = {}) {
  const calls = []
  const api = {
    positions: async () => [{ id: 'engineer', name: '工程师' }],
    domains: async () => [{ id: 'payments', name: '支付' }],
    createUser: async (body) => calls.push(['create', body]),
    updateUser: async (id, body) => calls.push(['update', id, body]),
  }
  const props = { user, orgs: [{ id: 'engineering', name: '研发' }], roles: [{ id: 'member', name: '成员' }],
    onClose: inert, onDone: inert, domains: [{ id: 'payments', name: '支付' }], ...extraProps }
  const page = await createComponentHarness(usersFile, {
    exportName: component, privateExports: ['UserEditor', 'DomainManager'], props,
    dependencies: {
      '../api.js': { api }, '../FilterControls.jsx': {}, '../viewport-height.js': {},
      '../ui.jsx': { Modal: 'Modal', Confirm: 'Confirm', SelectMenu: 'SelectMenu', toast: inert },
      './admin-access-pages.css': {},
    },
  })
  page.render()
  await page.flush()
  t.after(() => page.unmount())
  return { page, calls, props }
}

test('login labels identify stable, unique account and password fields in rendered HTML', async (t) => {
  const pages = await Promise.all([0, 1].map(() => createComponentHarness(loginFile, {
    props: { onLogin: inert }, dependencies: { './api.js': { api: { authProviders: async () => ({ items: [] }) } } },
  })))
  t.after(() => pages.forEach((page) => page.unmount()))
  const ids = []
  for (const page of pages) {
    page.render()
    await page.flush()
    const account = labelledControl(page, tx('账号'))
    const password = labelledControl(page, tx('密码'))
    ids.push(account.props.id, password.props.id)
    const accountInput = { value: 'admin' }
    page.act(() => account.props.onChange({ target: accountInput, currentTarget: accountInput }))
    assert.equal(labelledControl(page, tx('账号')).props.id, account.props.id)
    const html = renderToStaticMarkup(page.render())
    assert.ok(html.includes(`for="${account.props.id}"`))
    assert.ok(html.includes(`id="${password.props.id}"`))
  }
  assert.equal(new Set(ids).size, ids.length, 'multiple instances must not share field IDs')
})

test('new and existing user fields retain visible label associations through input and locale changes', async (t) => {
  const originalLocale = getLocale()
  t.after(() => setLocale(originalLocale))
  for (const user of [null, { id: 'u1', username: 'alice', displayName: 'Alice', orgId: 'engineering', roleId: 'member', isActive: true }]) {
    const { page, props } = await mountEditor(t, { user })
    const labelSources = ['账号', '姓名', user ? '重置密码（留空不改）' : '初始密码', '所属部门', '角色（权限）']
    const ids = labelSources.map((source) => labelledControl(page, tx(source)).props.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(labelledControl(page, tx('账号')).props.disabled, Boolean(user))
    page.act(() => labelledControl(page, tx('姓名')).props.onChange({ target: { value: '本地姓名' } }))
    setLocale('en-US')
    page.render(props)
    // Updating the locale does not replace the form instance or its field IDs.
    assert.deepEqual(labelSources.map((source) => labelledControl(page, tx(source)).props.id), ids)
    setLocale('zh-CN')
    page.render(props)
    page.act(() => labelledControl(page, tx('姓名')).props.onChange({ target: { value: 'Local name' } }))
  }
})

test('user choice groups expose keyboard buttons and persist the selected values through the existing save handler', async (t) => {
  const user = { id: 'u1', username: 'alice', displayName: 'Alice', orgId: 'engineering', roleId: 'member', isActive: true, positions: [], domains: [] }
  const { page, calls } = await mountEditor(t, { user })
  assertNamedGroups(page, 3)
  const choice = (label) => page.nodes((node) => textOf(node) === label && (node.props.className?.includes('poschip') || node.props.className?.split(' ').includes('s')))[0]
  for (const label of ['工程师', '支付', tx('停用')]) {
    const button = choice(label)
    assert.equal(button?.type, 'button', `${label} is keyboard reachable through a native button`)
    assert.equal(button.props.type, 'button')
    assert.equal(button.props['aria-pressed'], false)
    page.act(() => button.props.onClick())
    assert.equal(choice(label).props['aria-pressed'], true)
  }
  const enabled = choice(tx('启用'))
  assert.equal(enabled.props['aria-pressed'], false)
  const save = React.Children.toArray(page.render().props.foot.props.children).find((node) => textOf(node) === tx('保存'))
  await save.props.onClick()
  page.render()
  assert.deepEqual(calls, [['update', 'u1', { displayName: 'Alice', orgId: 'engineering', roleId: 'member', isActive: false, positions: ['engineer'], domains: ['payments'] }]])
})

test('editing a user profile cannot overwrite an existing personal allowance', async (t) => {
  const user = { id: 'u1', username: 'alice', displayName: 'Alice', orgId: 'engineering',
    roleId: 'member', isActive: true, tokenQuota: { mode: 'limited', limit: 12345 } }
  const { page, calls } = await mountEditor(t, { user })
  const save = () => React.Children.toArray(page.render().props.foot.props.children).find((node) => textOf(node) === tx('保存')).props.onClick()
  assert.equal(page.nodes(node => node.type === 'label' && textOf(node) === tx('Token 额度')).length, 0)
  page.act(() => labelledControl(page, tx('姓名')).props.onChange({ target: { value: 'New name' } }))
  await save(); page.render()
  assert.equal(calls[0][2].displayName, 'New name')
  assert.equal('tokenQuota' in calls[0][2], false)
  assert.deepEqual(user.tokenQuota, { mode: 'limited', limit: 12345 })
})

test('user creation leaves trial and quota assignment to the dedicated allowance policy', async (t) => {
  const { page, calls } = await mountEditor(t)
  page.act(() => labelledControl(page, tx('账号')).props.onChange({ target: { value: 'alice' } }))
  page.act(() => labelledControl(page, tx('初始密码')).props.onChange({ target: { value: 'fixture-password' } }))
  page.act(() => labelledControl(page, tx('所属部门')).props.onChange({ target: { value: 'engineering' } }))
  const save = () => React.Children.toArray(page.render().props.foot.props.children).find((node) => textOf(node) === tx('保存')).props.onClick()
  await save(); page.render()
  assert.equal(calls[0][0], 'create')
  assert.equal(calls[0][1].username, 'alice')
  assert.equal('tokenQuota' in calls[0][1], false)
})

test('domain manager names the add and rename inputs with stable label targets', async (t) => {
  const { page } = await mountEditor(t, { component: 'DomainManager' })
  const inputs = page.nodes((node) => node.type === 'input')
  assert.equal(inputs.length, 2)
  assert.equal(new Set(inputs.map((input) => input.props.id)).size, inputs.length)
  for (const input of inputs) {
    assert.ok(input.props.id)
    const labels = page.nodes((node) => node.type === 'label' && node.props.htmlFor === input.props.id)
    assert.equal(labels.length, 1, 'each domain input has one visible label')
    assert.ok(textOf(labels[0]).includes(tx('领域名称')))
  }
  page.act(() => inputs[1].props.onChange({ target: { value: '账单' } }))
  assert.deepEqual(page.nodes((node) => node.type === 'input').map((node) => node.props.id), inputs.map((node) => node.props.id))
})

test('SelectMenu places field ID and accessible naming metadata on its native trigger', async (t) => {
  const page = await createComponentHarness(uiFile, {
    exportName: 'SelectMenu', dependencies: { './api.js': { api: {} } },
    props: { id: 'department', 'aria-labelledby': 'department-label', 'aria-describedby': 'department-help', required: true,
      value: 'engineering', children: React.createElement('option', { value: 'engineering' }, '研发') },
  })
  t.after(() => page.unmount())
  const matches = page.nodes((node) => node.props.id === 'department')
  assert.equal(matches.length, 1, 'the field ID must exist exactly once')
  const trigger = matches[0]
  assert.equal(trigger.type, 'button', 'label activation must target the native focusable trigger')
  assert.equal(trigger.props.role, 'combobox', 'required fields use a role that supports aria-required')
  assert.equal(trigger.props['aria-labelledby'], 'department-label')
  assert.equal(trigger.props['aria-describedby'], 'department-help')
  assert.equal(trigger.props['aria-required'], true)
  const html = renderToStaticMarkup(page.render())
  assert.match(html, /<button[^>]*id="department"/)
  page.render({ value: 'engineering', children: React.createElement('option', { value: 'engineering' }, '研发') })
  const ordinaryTrigger = page.nodes((node) => node.props.className === 'select-menu-trigger')[0]
  assert.equal(ordinaryTrigger.props.role, undefined, 'existing menus retain button content naming')
  assert.equal(ordinaryTrigger.props['aria-required'], undefined)
})

async function mountKeyboardMenu(t, overrides = {}) {
  const listeners = new Map(), changes = []
  const document = { activeElement: null,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
  }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  const props = { value: 'two', 'aria-label': 'Department', required: true, onChange: (event) => changes.push(event.target.value),
    children: [['none', true], ['one', false], ['blocked', true], ['two', false], ['three', false]].map(([value, disabled]) =>
      React.createElement('option', { key: value, value, disabled }, value)), ...overrides }
  const page = await createComponentHarness(uiFile, { exportName: 'SelectMenu', dependencies: { './api.js': { api: {} } }, props })
  const element = (name) => ({ name, focus() { document.activeElement = this } })
  const trigger = element('trigger'), options = React.Children.toArray(props.children).map((child) => element(child.props.value))
  const root = { contains: (node) => node === trigger || options.includes(node), querySelectorAll: () => options }
  page.render().ref.current = root
  page.nodes((node) => node.props.className === 'select-menu-trigger')[0].ref.current = trigger
  trigger.focus()
  t.after(() => {
    page.unmount()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
  })
  function key(name, { index, ...extra } = {}) {
    const target = index === undefined ? trigger : options[index]
    const event = { key: name, target, currentTarget: target, defaultPrevented: false, stopped: false, ...extra,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
    page.act(() => {
      const node = index === undefined ? page.nodes((item) => item.props.className === 'select-menu-trigger')[0]
        : page.nodes((item) => item.props.role === 'option')[index]
      node?.props.onKeyDown?.(event)
      if (!event.stopped) { event.currentTarget = root; page.render().props.onKeyDown?.(event) }
      if (!event.stopped) for (const fn of listeners.get('keydown') || []) fn(event)
    })
    return event
  }
  return { page, document, trigger, options, changes, key,
    isOpen: () => page.nodes((node) => node.props.role === 'listbox').length === 1 }
}

test('SelectMenu arrow keys open at the current enabled option or the first enabled option', async (t) => {
  for (const value of ['two', 'missing', 'blocked']) {
    await t.test(value, async (caseTest) => {
      const menu = await mountKeyboardMenu(caseTest, { value })
      const event = menu.key(value === 'two' ? 'ArrowUp' : 'ArrowDown')
      assert.equal(menu.isOpen(), true)
      assert.equal(menu.document.activeElement, menu.options[value === 'two' ? 3 : 1])
      assert.equal(event.defaultPrevented, true, 'opening keys do not scroll the page')
    })
  }
})

test('SelectMenu arrow, Home and End navigation skip disabled options without changing the selection', async (t) => {
  const menu = await mountKeyboardMenu(t)
  menu.key('ArrowDown')
  for (const [name, index, expected] of [['ArrowDown', 3, 4], ['ArrowDown', 4, 1], ['ArrowUp', 1, 4], ['Home', 4, 1], ['End', 1, 4]]) {
    const event = menu.key(name, { index })
    assert.equal(menu.document.activeElement, menu.options[expected])
    assert.equal(event.defaultPrevented, true)
  }
  assert.deepEqual(menu.changes, [])
  assert.ok(menu.page.nodes((node) => node.props.role === 'option').every((node) => node.props.tabIndex === -1), 'options do not add tab stops')
})

test('SelectMenu consumes the first Escape, restores its trigger, and leaves the next Escape to the outer dialog', async (t) => {
  const menu = await mountKeyboardMenu(t)
  let closed = 0
  const release = registerDialogLayer({ ownerDocument: menu.document, onClose: () => closed++ })
  t.after(release)
  menu.page.act(() => menu.page.nodes((node) => node.props.className === 'select-menu-trigger')[0].props.onClick())
  menu.options[3].focus()
  const first = menu.key('Escape', { index: 3 })
  assert.equal(menu.isOpen(), false)
  assert.equal(first.defaultPrevented, true)
  assert.equal(first.stopped, true)
  assert.equal(menu.document.activeElement, menu.trigger)
  assert.equal(closed, 0)
  menu.key('Escape')
  assert.equal(closed, 1)
})

test('SelectMenu selection restores its trigger and Tab closes without suppressing native or modal navigation', async (t) => {
  const menu = await mountKeyboardMenu(t)
  menu.page.act(() => menu.page.nodes((node) => node.props.className === 'select-menu-trigger')[0].props.onClick())
  menu.options[4].focus()
  menu.page.act(() => menu.page.nodes((node) => node.props.role === 'option')[4].props.onClick())
  assert.deepEqual(menu.changes, ['three'])
  assert.equal(menu.isOpen(), false)
  assert.equal(menu.document.activeElement, menu.trigger)
  for (const shiftKey of [false, true]) {
    menu.key('ArrowDown')
    const event = menu.key('Tab', { index: 3, shiftKey })
    assert.equal(menu.isOpen(), false)
    assert.equal(event.defaultPrevented, false)
    assert.equal(event.stopped, false)
    assert.equal(menu.document.activeElement, menu.trigger, 'native Tab starts beside the field after the popup is removed')
  }
})
