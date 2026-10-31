import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

const ui = { Modal: () => null, Confirm: () => null, Icon: () => null, Loading: () => null, LiveDot: () => null, toast() {} }
const viewport = { useViewportHeight: () => undefined }
const source = new URL('../src/screens/Integrations.jsx', import.meta.url)

function host(exportName, props, api = {}) {
  return createComponentHarness(source, {
    exportName, privateExports: [exportName], props,
    dependencies: { '../api.js': { api }, '../ui.jsx': ui, '../viewport-height.js': viewport },
  })
}

test('new integration form offers GitLab and omits Gerrit', async (t) => {
  const page = await host('IntForm', { onClose() {}, onSaved() {} })
  t.after(() => page.unmount())
  const labels = page.nodes(node => node.type === 'b').map(node => node.props.children).flat()
  assert.ok(labels.includes('GitLab'))
  assert.ok(!labels.includes('Gerrit'))
})

test('historical Gerrit cards stay visible with reenable, edit and token rotation disabled', async (t) => {
  const page = await host('IntCard', { i: { id: 'old', name: 'Old repository', type: 'gerrit', enabled: false } })
  t.after(() => page.unmount())
  const buttons = page.nodes(node => node.type === 'button')
  assert.equal(buttons.find(node => node.props.className?.startsWith('toggle')).props.disabled, true)
  for (const label of ['编辑', '轮换令牌']) {
    assert.equal(buttons.find(node => node.props.children === label).props.disabled, true)
  }
  assert.ok(buttons.find(node => node.props.children === '删除'))
})

test('GitLab integration can still be enabled normally', async (t) => {
  const calls = []
  const page = await host('IntCard', {
    i: { id: 'gitlab', name: 'GitLab', type: 'gitlab', enabled: false }, onChanged() {},
  }, { toggleIntegration: async (...args) => calls.push(args) })
  t.after(() => page.unmount())
  const toggle = page.nodes(node => node.type === 'button' && node.props.className?.startsWith('toggle'))[0]
  assert.equal(Boolean(toggle.props.disabled), false)
  await toggle.props.onClick()
  assert.deepEqual(calls, [['gitlab', true]])
})


test('GitHub creation configures the API base and routes Issue imports through repository catalog', async (t) => {
  const calls = [];
  const form = await host('IntForm', {onClose() {}, onSaved() {}}, {createIntegration: async body => {calls.push(body); return {}}});
  t.after(() => form.unmount());
  const github = form.nodes(node => node.props.className === 'typecard').find(node => node.props.children[0].props.children[0] === 'GitHub');
  assert.ok(github);
  form.act(() => github.props.onClick());
  const fields = form.nodes(node => node.type === 'input');
  form.act(() => fields[0].props.onChange({target: {value: 'Engineering GitHub'}}));
  form.act(() => fields[1].props.onChange({target: {value: 'https://api.github.com'}}));
  await form.render().props.foot.props.children[1].props.onClick();
  assert.deepEqual(calls, [{name: 'Engineering GitHub', type: 'github', config: {base_url: 'https://api.github.com'}}]);
  const card = await host('IntCard', {i: {id: 'github', type: 'github', enabled: true}, onChanged() {}});
  t.after(() => card.unmount());
  assert.equal(card.nodes(node => node.type === 'button' && node.props.children === '立即拉取').length, 0);
  assert.match(JSON.stringify(card.render()), /在「仓库目录」配置固定拉取账号，再按仓库开启 Issue 同步/);
  assert.doesNotMatch(JSON.stringify(card.render()), /\/api\/v4/);
});
