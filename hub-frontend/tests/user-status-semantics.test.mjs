import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { translateText as tx } from '../src/i18n.js'

const source = new URL('../src/screens/Users.jsx', import.meta.url)
const textOf = node => React.Children.toArray(node?.props?.children)
  .map(child => React.isValidElement(child) ? textOf(child) : String(child)).join('')

const orgs = [{ id: 'team', name: 'Synthetic team' }]
const roles = [{ id: 'member', name: 'Synthetic member' }]
const fixture = [
  { id: 'u-active', username: 'alice', displayName: 'Alice', orgId: 'team', roleId: 'member',
    isActive: true, lastLogin: '2026-11-01T08:00:00Z' },
  { id: 'u-inactive', username: 'testorg', displayName: 'Test Org', orgId: 'team', roleId: 'member',
    isActive: false, lastLogin: null },
  { id: 'u-disabled', username: 'bob', displayName: 'Bob', orgId: 'team', roleId: 'member',
    isActive: false, lastLogin: '2026-10-01T08:00:00Z' },
  { id: 'u-qa', username: 'qatest001', displayName: 'QA runner', orgId: 'team', roleId: 'member',
    isActive: true, lastLogin: '2026-11-02T08:00:00Z' },
]

const accounts = page => page.nodes(node => node.type === 'td' && node.props.className === 'mono').map(textOf)

const statusDot = page => page.nodes(node => node.type === 'span' && node.props.className?.startsWith('status-dot'))

async function mount(t, { list = fixture, batchUpdateUsers = async () => ({ updated: 0 }) } = {}) {
  const history = { state: {}, replaceState(next) { this.state = next } }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { history } })
  t.after(() => previousWindow ? Object.defineProperty(globalThis, 'window', previousWindow) : delete globalThis.window)
  const api = { users: () => list, orgs: () => orgs, roles: () => roles, batchUpdateUsers }
  const page = await createComponentHarness(source, {
    dependencies: {
      '../api.js': { api, getUser: () => ({ id: 'actor', username: 'admin' }) },
      './admin-access-pages.css': {},
      '../FilterControls.jsx': { FilterInput: 'FilterInput', FilterSelect: 'FilterSelect' },
      '../ui.jsx': { useAsync: fn => ({ data: fn(), reload: async () => true }), Icon: 'Icon',
        Loading: 'Loading', Modal: 'Modal', Confirm: 'Confirm', SelectMenu: 'SelectMenu', toast() {} },
    },
  })
  page.render()
  t.after(() => page.unmount())
  return page
}

const byLabel = (page, label) => page.nodes(node => node.props['aria-label'] === label)[0]
const button = (page, key) => page.nodes(node => node.type === 'button' && textOf(node) === tx(key))[0]
const confirm = page => page.nodes(node => node.type === 'Confirm')[0]
const setValue = (page, key, value) => page.act(() => byLabel(page, tx(key)).props.onChange({ target: { value } }))
const check = (page, label, checked) => page.act(() => byLabel(page, label).props.onChange({ target: { checked } }))
const selectAll = page => check(page, tx('全选筛选结果'), true)
const toggleTests = page => page.act(() => page.nodes(node => node.type === 'label' && textOf(node) === tx('测试及疑似账号'))[0].props.children[0].props.onChange({ target: { checked: true } }))

test('account availability and login history produce three disjoint statuses and matching totals', async t => {
  const page = await mount(t)
  const dots = statusDot(page)
  assert.deepEqual(dots.map(textOf), [tx('启用'), tx('未激活'), tx('已停用'), tx('启用')])
  assert.deepEqual(dots.map(node => node.props.title), [undefined, tx('停用且无登录记录'), tx('停用且有登录记录'), undefined])
  const cards = page.nodes(node => node.props.className === 'stat')
  assert.deepEqual(cards.map(textOf), ['4' + tx('用户总数'), '2' + tx('启用中'), '1' + tx('未激活'), '1' + tx('已停用')])
  setValue(page, '状态', 'inactive')
  assert.deepEqual(accounts(page), ['testorg' + tx('疑似测试账号')])
  setValue(page, '状态', 'disabled')
  assert.deepEqual(accounts(page), ['bob'])
})

test('explicit account markers take precedence over conservative legacy name hints', async t => {
  const list = [
    { ...fixture[0], username: 'contest' },
    { ...fixture[1], isTestAccount: false },
    { ...fixture[2], isTestAccount: true },
    fixture[3],
  ]
  const page = await mount(t, { list })
  assert.deepEqual(accounts(page), ['contest', 'testorg', 'bob' + tx('测试账号'), 'qatest001' + tx('疑似测试账号')])
  toggleTests(page)
  assert.deepEqual(accounts(page), ['bob' + tx('测试账号'), 'qatest001' + tx('疑似测试账号')])
  assert.equal(button(page, '批量停用'), undefined, 'filtering test candidates selects nobody')
})

test('all filters intersect and a change clears both visible and hidden selections', async t => {
  const list = [...fixture,
    { ...fixture[3], id: 'department-miss', orgId: 'other' },
    { ...fixture[3], id: 'role-miss', roleId: 'other' },
    { ...fixture[3], id: 'status-miss', isActive: false },
    { ...fixture[3], id: 'query-miss', username: 'testuser9', displayName: 'Other member' },
    { ...fixture[3], id: 'kind-miss', isTestAccount: false }]
  const page = await mount(t, { list })
  setValue(page, '搜索姓名或账号', 'qa')
  setValue(page, '所属部门', 'team')
  setValue(page, '角色', 'member')
  setValue(page, '状态', 'active')
  toggleTests(page)
  assert.deepEqual(accounts(page), ['qatest001' + tx('疑似测试账号')])
  selectAll(page)
  assert.ok(button(page, '批量停用'))
  setValue(page, '角色', 'other')
  assert.equal(button(page, '批量停用'), undefined)
  setValue(page, '角色', 'member')
  assert.equal(byLabel(page, tx('选择账号 {0}', ['qatest001'])).props.checked, false)
})

test('selection, cancellation, confirmation and failure preserve the exact batch request', async t => {
  const calls = []
  let rejected = true
  const page = await mount(t, { batchUpdateUsers: async body => {
    calls.push(body)
    if (rejected) throw Error('Synthetic validation failure')
    return { updated: 1 }
  } })
  check(page, tx('选择账号 {0}', ['testorg']), true)
  check(page, tx('选择账号 {0}', ['bob']), true)
  page.act(() => button(page, '批量启用').props.onClick())
  const prompt = textOf(confirm(page).props.text)
  assert.ok(prompt.includes(tx('已选 {0} 个账号', [2])) && prompt.includes('testorg') && prompt.includes('bob'))
  page.act(() => confirm(page).props.onClose())
  assert.deepEqual(calls, [])
  page.act(() => button(page, '批量停用').props.onClick())
  assert.equal(confirm(page).props.danger, true)
  await confirm(page).props.onConfirm()
  assert.deepEqual(calls[0], { ids: ['u-inactive', 'u-disabled'], isActive: false })
  assert.ok(textOf(page.nodes(node => node.props.role === 'alert')[0]).includes('Synthetic validation failure'))
  assert.ok(byLabel(page, tx('选择账号 {0}', ['testorg'])).props.checked)
  rejected = false
  setValue(page, '目标部门', 'team')
  page.act(() => button(page, '批量更改部门').props.onClick())
  assert.ok(textOf(confirm(page).props.text).includes(orgs[0].name))
  await confirm(page).props.onConfirm()
  assert.deepEqual(calls[1], { ids: ['u-inactive', 'u-disabled'], orgId: 'team' })
  assert.equal(button(page, '批量启用'), undefined)
  assert.equal(textOf(page.nodes(node => node.props.role === 'status')[0]), tx('已更新 {0} 个账号', [1]))
})

test('the current account and a super administrator cannot be bulk-disabled', async t => {
  const page = await mount(t, { list: [
    { ...fixture[0], id: 'actor' },
    { ...fixture[1], isSuper: true },
    fixture[2],
  ] })
  for (const username of ['alice', 'testorg']) {
    check(page, tx('选择账号 {0}', [username]), true)
    assert.equal(button(page, '批量停用').props.disabled, true)
    assert.equal(button(page, '批量启用').props.disabled, false)
    check(page, tx('选择账号 {0}', [username]), false)
  }
  check(page, tx('选择账号 {0}', ['bob']), true)
  assert.equal(button(page, '批量停用').props.disabled, false)
})

test('select-all keeps the entire match set and visibly blocks a batch above 200', async t => {
  const list = Array.from({ length: 201 }, (_, i) => ({ ...fixture[0], id: 'account-' + i, username: 'member' + i }))
  const page = await mount(t, { list })
  selectAll(page)
  assert.equal(byLabel(page, tx('全选筛选结果')).props.checked, true)
  assert.equal(button(page, '批量启用').props.disabled, true)
  assert.ok(textOf(page.nodes(node => node.props.role === 'status')[0]).includes('200'))
  check(page, tx('选择账号 {0}', ['member200']), false)
  assert.equal(button(page, '批量启用').props.disabled, false)
})
