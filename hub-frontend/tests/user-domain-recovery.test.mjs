import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { getLocale, setLocale, translateText as tx } from '../src/i18n.js'

const source = new URL('../src/screens/Users.jsx', import.meta.url)
const retained = { id: 'retained-domain', name: 'Retained responsibility' }
const removed = 'removed-legacy-domain'
const hint = '部分已选领域已不存在，请点击对应项移除后再保存。'
const removedLabel = '已不存在的领域：{0}'
const user = { id: 'legacy-user', username: 'legacy-user', displayName: 'Original name',
  orgId: 'team', roleId: 'member', isActive: true, positions: [], domains: [retained.id, removed] }
const textOf = node => React.Children.toArray(node?.props?.children)
  .map(child => React.isValidElement(child) ? textOf(child) : String(child)).join('')

async function editor(t, { saved = user, domains = async () => [retained], update, onClose } = {}) {
  const calls = [], notices = []
  let completed = 0
  const api = {
    positions: async () => [], domains,
    updateUser: async (id, body) => {
      calls.push({ id, body: structuredClone(body) })
      return update?.(id, body)
    },
    createUser: async body => calls.push({ body: structuredClone(body) }),
  }
  const props = { user: saved, orgs: [{ id: 'team', name: 'Synthetic team' }],
    roles: [{ id: 'member', name: 'Synthetic member' }],
    onClose: onClose || (() => {}), onDone: () => completed++ }
  const page = await createComponentHarness(source, {
    exportName: 'UserEditor', privateExports: ['UserEditor'], props,
    dependencies: {
      '../api.js': { api }, '../FilterControls.jsx': {}, '../viewport-height.js': {},
      '../ui.jsx': { Modal: 'Modal', Confirm: 'Confirm', SelectMenu: 'SelectMenu', Icon: 'Icon',
        toast: value => notices.push(value) }, './admin-access-pages.css': {},
    },
  })
  page.render()
  await page.flush()
  t.after(() => page.unmount())
  return { page, calls, notices, props, completed: () => completed,
    async save() {
      const button = React.Children.toArray(page.render().props.foot.props.children)
        .find(node => node.type === 'button' && textOf(node) === tx('保存'))
      assert.ok(button)
      await button.props.onClick()
      await page.flush()
    } }
}

function selectedButton(page, label) {
  const button = page.nodes(node => node.type === 'button' && textOf(node) === label)[0]
  assert.ok(button, 'the selected domain has a visible removal control: ' + label)
  assert.equal(button.props.type, 'button')
  assert.equal(button.props['aria-pressed'], true)
  return button
}

test('a user saved before domain deletion can explicitly remove the obsolete reference and save valid assignments', async t => {
  const f = await editor(t, { update: async (_id, body) => {
    if (body.domains.includes(removed)) throw Error('Selected domain no longer exists')
  } })
  assert.ok(f.page.nodes(node => textOf(node) === tx(hint)).length)
  selectedButton(f.page, retained.name)
  const obsolete = selectedButton(f.page, tx(removedLabel, [removed]))
  await f.save()
  assert.equal(f.completed(), 0, 'the existing validator still rejects a stale reference')
  assert.deepEqual(f.calls[0].body.domains, user.domains, 'loading the catalog never cleans saved data silently')
  f.page.act(() => obsolete.props.onClick())
  assert.equal(f.page.nodes(node => node.type === 'button' && textOf(node) === tx(removedLabel, [removed])).length, 0)
  selectedButton(f.page, retained.name)
  await f.save()
  assert.equal(f.completed(), 1)
  assert.equal(f.calls[1].id, user.id)
  assert.deepEqual(f.calls[1].body.domains, [retained.id])
  assert.equal(f.calls[1].body.displayName, user.displayName)
  assert.equal(f.calls[1].body.roleId, user.roleId)
})

test('missing-domain guidance and controls translate in all shipped locales while preserving the saved identifier', async t => {
  const original = getLocale()
  t.after(() => setLocale(original))
  const copy = {
    'zh-CN': ['部分已选领域已不存在，请点击对应项移除后再保存。', '已不存在的领域：removed-legacy-domain'],
    'en-US': ['Some selected domains no longer exist. Click their entries to remove them before saving.', 'Missing domain: removed-legacy-domain'],
    'ja-JP': ['選択した領域の一部は存在しません。該当する項目をクリックして削除してから保存してください。', '存在しない領域：removed-legacy-domain'],
    'ko-KR': ['선택한 영역 중 일부가 더 이상 존재하지 않습니다. 해당 항목을 클릭하여 제거한 후 저장하세요.', '존재하지 않는 영역: removed-legacy-domain'],
  }
  const f = await editor(t)
  for (const [locale, [message, label]] of Object.entries(copy)) {
    setLocale(locale)
    f.page.render(f.props)
    assert.equal(tx(hint), message)
    assert.equal(tx(removedLabel, [removed]), label)
    assert.ok(f.page.nodes(node => textOf(node) === message).length)
    selectedButton(f.page, label)
    selectedButton(f.page, retained.name)
  }
  await f.save()
  assert.deepEqual(f.calls[0].body.domains, user.domains, 'language changes do not edit selected values')
})

test('pending and failed domain catalog reads retain selected IDs without declaring them deleted', async t => {
  let reject
  const f = await editor(t, { domains: () => new Promise((_resolve, fail) => { reject = fail }) })
  assert.equal(f.page.nodes(node => node.type === 'button' && textOf(node) === tx(removedLabel, [removed])).length, 0)
  await f.save()
  assert.deepEqual(f.calls[0].body.domains, user.domains)
  reject(Error('Synthetic catalog unavailable'))
  await f.page.flush()
  assert.equal(f.page.nodes(node => textOf(node) === tx(hint)).length, 0)
  await f.save()
  assert.deepEqual(f.calls[1].body.domains, user.domains, 'a failed read must not erase valid assignments')
})

test('a successful empty catalog lets an existing user remove its final obsolete domain', async t => {
  const f = await editor(t, { saved: { ...user, domains: [removed] }, domains: async () => [] })
  const obsolete = selectedButton(f.page, tx(removedLabel, [removed]))
  f.page.act(() => obsolete.props.onClick())
  await f.save()
  assert.deepEqual(f.calls[0].body.domains, [])
  assert.equal(f.completed(), 1)
})

test('retrying a failed catalog read exposes obsolete selections after a successful response', async t => {
  let unavailable = true
  const f = await editor(t, { domains: async () => {
    if (unavailable) throw Error('Synthetic catalog unavailable')
    return [retained]
  } })
  assert.ok(f.page.nodes(node => node.props.role === 'status' && textOf(node).includes(tx('领域列表加载失败，请重试。'))).length)
  const retry = f.page.nodes(node => node.type === 'button' && textOf(node) === tx('重试'))[0]
  assert.ok(retry)
  unavailable = false
  await retry.props.onClick()
  await f.page.flush()
  selectedButton(f.page, tx(removedLabel, [removed]))
  selectedButton(f.page, retained.name)
  await f.save()
  assert.deepEqual(f.calls[0].body.domains, user.domains)
})

test('an invalid catalog response cannot classify or remove saved assignments', async t => {
  for (const response of [null, {}, [{ name: 'Missing identity' }], [{ id: null }]]) {
    const f = await editor(t, { domains: async () => response })
    assert.equal(f.page.nodes(node => textOf(node) === tx(hint)).length, 0)
    assert.ok(f.page.nodes(node => node.props.role === 'status' && textOf(node).includes(tx('领域列表加载失败，请重试。'))).length)
    await f.save()
    assert.deepEqual(f.calls[0].body.domains, user.domains)
  }
})

test('a refreshed domain catalog exposes newly unavailable selections and a failed refresh preserves them', async t => {
  let catalog = [retained, { id: removed, name: 'Previously available responsibility' }]
  const f = await editor(t, { domains: async () => {
    if (catalog instanceof Error) throw catalog
    return catalog
  } })
  assert.equal(f.page.nodes(node => textOf(node) === tx(hint)).length, 0)
  const manage = f.page.nodes(node => node.type === 'button' && textOf(node) === tx('管理领域'))[0]
  f.page.act(() => manage.props.onClick())
  const manager = () => f.page.nodes(node => node.type?.name === 'DomainManager')[0]
  catalog = [retained]
  await manager().props.onChanged()
  await f.page.flush()
  selectedButton(f.page, tx(removedLabel, [removed]))
  catalog = Error('Synthetic refresh unavailable')
  await manager().props.onChanged()
  await f.page.flush()
  assert.equal(f.page.nodes(node => textOf(node) === tx(hint)).length, 0)
  await f.save()
  assert.deepEqual(f.calls[0].body.domains, user.domains)
  catalog = [retained]
  await manager().props.onChanged()
  await f.page.flush()
  selectedButton(f.page, tx(removedLabel, [removed]))
})

test('cancelled cleanup leaves the saved user unchanged and reopening restores the obsolete selection', async t => {
  let closed = 0
  const f = await editor(t, { onClose: () => closed++ })
  f.page.act(() => selectedButton(f.page, tx(removedLabel, [removed])).props.onClick())
  const cancel = React.Children.toArray(f.page.render().props.foot.props.children)
    .find(node => textOf(node) === tx('取消'))
  cancel.props.onClick()
  assert.equal(closed, 1)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(user.domains, [retained.id, removed])
  const reopened = await editor(t)
  selectedButton(reopened.page, tx(removedLabel, [removed]))
})

test('valid, absent and null legacy selections save through the existing user flow', async t => {
  for (const domains of [[retained.id], [], null, undefined]) {
    const f = await editor(t, { saved: { ...user, domains } })
    assert.equal(f.page.nodes(node => textOf(node) === tx(hint)).length, 0)
    await f.save()
    assert.deepEqual(f.calls[0].body.domains, domains || [])
    assert.equal(f.completed(), 1)
  }
})

test('duplicate obsolete references have one removal control and identifiers render as escaped text', async t => {
  const id = '<img src=x onerror=alert(1)>'
  const f = await editor(t, { saved: { ...user, domains: [retained.id, id, id] } })
  const buttons = f.page.nodes(node => node.type === 'button' && textOf(node) === tx(removedLabel, [id]))
  assert.equal(buttons.length, 1)
  const html = renderToStaticMarkup(buttons[0])
  assert.ok(html.includes('&lt;img'))
  assert.ok(!html.includes('<img'))
  f.page.act(() => buttons[0].props.onClick())
  await f.save()
  assert.deepEqual(f.calls[0].body.domains, [retained.id])
})
