import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

const file = new URL('../src/screens/FirstChatChecklist.jsx', import.meta.url)
const api = { firstChatReadiness() {}, modelCatalog() {} }
const ready = { providerReady: true, chatModelReady: false, runtimeReady: false, modelReady: null }
const provider = { id: 'team', name: 'Team', enabled: true, baseUrl: 'https://example.test/v1', keySet: true }
const click = (page, label) => page.act(() => page.nodes(n => n.type === 'button' && n.props.children === label)[0].props.onClick())

async function steps(t, data = ready) {
  setLocale('zh-CN')
  const requests = [], destinations = []
  const sources = new Map([
    [api.firstChatReadiness, { data, reload: () => requests.push('readiness') }],
    [api.modelCatalog, { data: { providers: [
      { ...provider, id: 'off', enabled: false }, { ...provider, id: 'missing', keySet: false },
      { ...provider, id: 'builtin', builtin: true }, provider,
    ] }, reload: () => requests.push('catalog') }],
  ])
  const page = await createComponentHarness(file, { exportName: 'Steps', privateExports: ['Steps'], props: { accountId: 'alice' },
    dependencies: { '../api.js': { api }, '../ui.jsx': { navTo: (...args) => destinations.push(args), useAsync: fn => sources.get(fn) } } })
  t.after(() => { page.unmount(); setLocale('zh-CN') })
  return { page, sources, destinations, requests }
}

test('four steps use reported readiness, a real editable service and fixed desktop settings', async t => {
  const { page, destinations, requests } = await steps(t)
  const items = page.nodes(n => n.type === 'li')
  assert.equal(items.length, 4)
  assert.equal(items[1].props['aria-current'], 'step')
  assert.equal(page.nodes(n => n.type === 'progress')[0].props.value, 1)
  assert.match(renderToStaticMarkup(items[3]), /等待本账号桌面端报告/)
  assert.deepEqual(page.nodes(n => n.type === 'option').map(n => n.props.value), ['team', 'builtin'])
  click(page, '连接模型服务')
  click(page, '添加对话模型')
  page.act(() => page.nodes(n => n.type === 'select')[0].props.onChange({ target: { value: 'builtin' } }))
  click(page, '发现模型')
  assert.deepEqual(destinations.map(([screen, p]) => [screen, p.accountId, p.firstChat, p.providerId]), [
    ['models', 'alice', 'provider', undefined], ['models', 'alice', 'model', 'team'], ['models', 'alice', 'discover', 'builtin'],
  ])
  assert.deepEqual(page.nodes(n => n.type === 'a').map(n => n.props.href), ['soduwork://first-chat/runtime', 'soduwork://first-chat/model'])
  click(page, '重新检测')
  assert.deepEqual(requests, ['readiness', 'catalog'])
})

test('errors do not show stale progress and unavailable catalog actions cannot open an old service', async t => {
  const { page, sources } = await steps(t)
  sources.get(api.firstChatReadiness).error = new Error('offline')
  sources.get(api.modelCatalog).error = new Error('offline')
  assert.equal(page.nodes(n => n.type === 'progress').length, 0)
  assert.equal(page.nodes(n => n.type === 'select').length, 0)
  assert.equal(page.nodes(n => n.props.role === 'alert').length, 2)
  delete sources.get(api.firstChatReadiness).error
  delete sources.get(api.modelCatalog).error
  sources.get(api.firstChatReadiness).data = { ...ready, chatModelReady: true, runtimeReady: true, modelReady: true }
  sources.get(api.modelCatalog).data = { providers: [] }
  page.render({ accountId: 'alice' })
  assert.equal(page.nodes(n => n.type === 'progress')[0].props.value, 4)
  assert.equal(page.nodes(n => n.props['aria-current'] === 'step').length, 0)
  assert.match(renderToStaticMarkup(page.render()), /请先连接可用的组织模型服务/)
})

test('skip and revisit are stored separately for each account', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const stored = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key),
  } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage })
  const view = async accountId => createComponentHarness(file, { props: { accountId }, dependencies: { '../api.js': { api }, '../ui.jsx': {} } })
  const first = await view('alice')
  first.act(() => first.render().props.onSkip()); first.unmount()
  const bob = await view('bob')
  assert.equal(bob.render().type.name, 'Steps')
  bob.unmount()
  const again = await view('alice')
  assert.equal(again.render().type, 'button')
  again.act(() => again.render().props.onClick())
  assert.equal(again.render().type.name, 'Steps')
  assert.equal(stored.size, 0)
  again.unmount()
})

test('the checklist and its unknown desktop state use all four languages', async t => {
  const { page } = await steps(t)
  for (const [locale, title, unknown] of [
    ['zh-CN', '首次对话清单', '等待本账号桌面端报告'],
    ['en-US', 'First chat checklist', 'Waiting for this account’s desktop to report'],
    ['ja-JP', '初回チャットのチェックリスト', 'このアカウントのデスクトップからの報告待ち'],
    ['ko-KR', '첫 대화 체크리스트', '이 계정의 데스크톱 보고 대기 중'],
  ]) {
    setLocale(locale)
    const markup = renderToStaticMarkup(page.render({ accountId: 'alice' }))
    assert.ok(markup.includes(title) && markup.includes(unknown), locale)
  }
})
