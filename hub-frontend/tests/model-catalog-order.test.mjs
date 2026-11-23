import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createComponentHarness } from './helpers/react-harness.mjs'

const Runtime = () => null
const provider = (id, name, builtin, enabled = true) => ({ id, name, builtin, enabled, revision: 'fixture' })
const initial = [provider('builtin-a', 'A builtin', true), provider('custom-z', 'Z custom', false),
  provider('builtin-off', 'A disabled', true, false), provider('custom-a', 'A custom', false),
  provider('custom-off', 'Z disabled', false, false)]

async function mount(t, catalog, { api = {}, takeNav = () => null, ...options } = {}) {
  const page = await createComponentHarness(new URL('../src/screens/ModelCatalog.jsx', import.meta.url), {
    ...options,
    dependencies: {
      '../api.js': { api: { modelCatalog: async () => structuredClone(catalog), ...api } },
      '../ui.jsx': { takeNav, Modal: () => null, SelectMenu: () => null, Confirm: () => null,
        Icon: () => null, Loading: () => null, ErrorState: () => null, toast() {} },
      './ModelProviderDeletion.jsx': { __esModule: true, default: () => null },
      './LlmSettings.jsx': { __esModule: true, default: () => null }, './ModelRuntime.jsx': { __esModule: true, default: Runtime },
      './model-catalog-actions.css': {}, './model-capabilities.css': {},
      './ModelCapabilities.jsx': { CAPABILITY_LABELS: {}, CAPABILITY_STATES: {}, CapabilityBadges() {}, ModelCapabilityStatus() {} },
    },
  })
  t.after(() => page.unmount())
  page.render(); await page.flush()
  return page
}
const order = page => page.nodes(node => node.type === 'article').map(node => node.key)
const buttons = (page, area) => page.nodes(node => node.type === 'button', area)
const labelMatches = label => button => renderToStaticMarkup(button).includes(label)

test('first chat shortcuts open the requested action for the same administrator and current service', async t => {
  const target = { ...provider('service', 'Service', false), baseUrl: 'https://service.example/v1', keySet: true }
  for (const [action, account, enabled, expected] of [
    ['provider', 'owner', true, 'ProviderForm'], ['model', 'owner', true, 'ModelForm'],
    ['discover', 'owner', true, 'DiscoverForm'], ['model', 'other', true, null], ['model', 'owner', false, null],
  ]) {
    const catalog = { providers: [{ ...target, enabled }], models: [] }
    const page = await mount(t, catalog, { props: { me: { id: 'owner' } },
      takeNav: screen => screen === 'models' && { firstChat: action, accountId: account, providerId: target.id } })
    const forms = page.nodes(n => ['ProviderForm', 'ModelForm', 'DiscoverForm'].includes(n.type?.name))
    assert.equal(forms[0]?.type.name || null, expected)
    if (action === 'model' && expected) assert.equal(forms[0].props.providerId, target.id)
    if (action === 'discover') assert.equal(forms[0].props.provider.id, target.id)
  }
})

test('the provider form tests current draft credentials and discards results after edits', async t => {
  const requests = []
  const form = await mount(t, {}, {
    privateExports: ['ProviderForm'], exportName: 'ProviderForm',
    api: { testModelProviderConnection: body => new Promise(resolve => requests.push({ body, resolve })) },
  })
  const change = (matches, value) => form.act(() => form.nodes(matches)[0].props.onChange({ target: { value } }))
  const address = node => node.props.placeholder === 'https://gateway.example.com/v1'
  const testConnection = () => React.Children.toArray(form.render().props.foot.props.children)
    .find(button => button.props.children === '测试连接').props.onClick()
  const status = () => form.nodes(node => node.props.role === 'status')
  change(address, 'https://fixture.invalid/v1')
  change(node => node.props.type === 'password', 'draft-value')
  const stale = testConnection()
  assert.deepEqual(requests[0].body, { kind: 'openai-compat', baseUrl: 'https://fixture.invalid/v1', apiKey: 'draft-value' })
  change(address, 'https://next.invalid/v1')
  requests[0].resolve({ ok: true, models: ['stale'] })
  await stale
  assert.equal(status().length, 0)
  const current = testConnection()
  requests[1].resolve({ ok: true, models: ['fixture-a', 'fixture-b'] })
  await current
  const result = React.Children.toArray(status()[0].props.children.props.children).join('')
  assert.match(result, /2 个模型/)
  assert.match(result, /fixture-a, fixture-b/)
  assert.match(result, /确认额度/)
  change(node => node.type?.name === 'SelectMenu', 'anthropic')
  assert.equal(status().length, 0)
  assert.equal(form.nodes(node => node.props.placeholder === 'https://api.anthropic.com').length, 1)
  assert.equal(form.nodes(node => node.type === 'label' && node.props.children === 'Anthropic 服务根地址').length, 1)
})

test('the catalog offers service onboarding first and keeps organization defaults under legacy settings', async t => {
  const page = await mount(t, { providers: [], models: [] })
  const { catalogActions, catalogSummary } = page.nodes(node => node.type === Runtime)[0].props
  assert.ok(buttons(page, catalogActions).some(labelMatches('接一个服务')))
  assert.ok(!buttons(page, catalogActions).some(labelMatches('组织默认调用')))
  const legacy = buttons(page, catalogSummary).find(labelMatches('组织默认调用（旧版兼容）'))
  assert.ok(legacy)
  page.act(() => legacy.props.onClick())
  assert.equal(page.nodes(node => node.props.title === '组织默认调用（旧版兼容）').length, 1)
})

test('custom services stay first within enabled groups on initial load and remount, without changing server order', async t => {
  const catalog = { providers: structuredClone(initial), models: [] }
  const expected = ['custom-a', 'custom-z', 'builtin-a', 'custom-off', 'builtin-off']
  assert.deepEqual(order(await mount(t, catalog)), expected)
  catalog.providers.reverse()
  assert.deepEqual(order(await mount(t, catalog)), expected)
  assert.deepEqual(catalog.providers, initial.toReversed())
})

test('new service is revealed immediately and remains ahead of built-ins after reopening', async t => {
  const catalog = { providers: structuredClone(initial), models: [] }
  const page = await mount(t, catalog)
  const { catalogActions } = page.nodes(node => node.type === Runtime)[0].props
  const add = buttons(page, catalogActions).find(labelMatches('接一个服务'))
  page.act(() => add.props.onClick())
  catalog.providers.push(provider('custom-new', 'ZZ new service', false))
  const form = page.nodes(node => node.type?.name === 'ProviderForm')[0]
  page.act(() => form.props.onSaved('custom-new'))
  await page.flush()
  assert.equal(order(page)[0], 'custom-new')
  const reopened = order(await mount(t, catalog))
  assert.ok(reopened.indexOf('custom-new') < reopened.indexOf('builtin-a'))
  assert.deepEqual(reopened, ['custom-a', 'custom-z', 'custom-new', 'builtin-a', 'custom-off', 'builtin-off'])
})

test('service cards distinguish credentials from enabled chat models and open the first model form', async t => {
  const base = { ...provider('empty', 'Service', false), baseUrl: 'https://example.invalid', keySet: true }
  const providers = [base, { ...base, id: 'mixed' }, { ...base, id: 'no-chat', kind: 'anthropic' },
    { ...base, id: 'agent', kind: 'anthropic' },
    { ...base, id: 'no-key', keySet: false }, { ...base, id: 'off', enabled: false }, { ...base, id: 'no-url', baseUrl: '' }]
  const model = (providerId, modality, enabled = true) => ({ id: providerId + '-' + modality,
    name: 'fixture', providerId, modality, enabled })
  const models = [model('mixed', 'chat'), model('mixed', undefined), model('mixed', 'video'),
    model('no-chat', 'image'), model('no-chat', 'chat', false), model('off', 'chat'), model('no-key', 'chat'),
    model('no-url', 'chat'), model('agent', 'chat')]
  const page = await mount(t, { providers, models })
  const cards = page.nodes(node => node.type === 'article')
  const badges = page.nodes(node => node.props.className?.startsWith('model-state '))
  assert.deepEqual(Object.fromEntries(cards.map((card, i) => [card.key, badges[i].props.children.at(-1)])), {
    empty: '已配置但无模型', mixed: '可对话（2）', 'no-chat': '无已启用的对话模型',
    'no-key': '缺密钥', off: '已停用', 'no-url': '缺地址', agent: '需兼容 Agent（1）',
  })
  const agentBadge = badges[cards.findIndex(card => card.key === 'agent')]
  assert.match(agentBadge.props.className, /warn/)
  assert.equal(agentBadge.props.title, '1 个已启用的对话模型需要使用支持此协议的 Agent。')
  const add = page.nodes(node => node.type === 'button' && node.props.children?.at?.(-1) === '加第一个模型')
  assert.equal(add.length, 1)
  page.act(() => add[0].props.onClick())
  assert.equal(page.nodes(node => node.type?.name === 'ModelForm')[0].props.providerId, 'empty')
})
