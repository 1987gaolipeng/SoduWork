import * as catalogSearch from '../src/screens/repository-catalog-search.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

const source = new URL('../src/screens/Repositories.jsx', import.meta.url)
const button = (page, label) => page.nodes((node) => node.type === 'button' && node.props.children === label)[0]
const username = (page) => page.nodes((node) => node.type === 'input' && node.props.type !== 'password')[0]
const secret = (page) => page.nodes((node) => node.type === 'input' && node.props.type === 'password')[0]
async function host(t, methods = {}, account = {}, expand = true) {
  setLocale('zh-CN')
  const notices = [], probes = [], saves = []
  let reloads = 0
  const page = await createComponentHarness(source, { exportName: 'SourceCard', privateExports: ['SourceCard'],
    props: { source: { id: 'source', type: 'gitlab', pullAccountUser: 'saved-user', pullAccountKind: 'password', pullAccountSet: true, ...account },
      onSaved: async () => { reloads++ }, onSync() {} },
    dependencies: { '../api.js': { can: () => true, api: {
      testPullAccount: async (id, body) => { probes.push({ id, body }); return { ok: true, detail: 'Verified' } },
      savePullAccount: async (id, body) => { saves.push({ id, body }); return { ok: true } }, ...methods,
    } }, '../FilterControls.jsx': { FilterInput: 'input' }, '../ui.jsx': { Icon: 'svg', Loading: 'loading', Modal: 'dialog', SelectMenu: 'select', toast: (value) => notices.push(value) },
    './repository-catalog-search.js': catalogSearch, './project-governance.css': {}, './repositories.css': {}, './RepositoryIssueSync.jsx': { default: 'issue-dialog', RepositoryIssueSyncStatus: 'issue-status' } },
  })
  t.after(() => page.unmount())
  page.render()
  if (expand && !username(page)) page.act(() => page.nodes((node) => node.type === 'button' && node.props.className?.startsWith('rc-acct'))[0].props.onClick())
  return { page, notices, probes, saves, reloads: () => reloads }
}

test('a source without an account offers its editable credentials on arrival', async (t) => {
  const { page } = await host(t, {}, { pullAccountSet: false }, false)
  assert.ok(secret(page))
  const toggle = () => page.nodes((node) => node.props.className?.startsWith('rc-acct'))[0]
  assert.equal(toggle().props['aria-expanded'], true)
  page.act(() => toggle().props.onClick())
  assert.equal(toggle().props['aria-expanded'], false)
  assert.equal(secret(page), undefined)
})

test('renaming with a retained secret tests and saves the same account draft', async (t) => {
  const { page, probes, saves } = await host(t)
  page.act(() => username(page).props.onChange({ target: { value: ' new-user ' } }))
  page.act(() => page.nodes((node) => node.type === 'select')[0].props.onChange({ target: { value: '' } }))
  await button(page, '测一下').props.onClick(); page.render()
  const expected = { id: 'source', body: { user: 'new-user', secret: null, kind: '' } }
  assert.deepEqual(probes[0], expected)
  await button(page, '保存').props.onClick(); page.render()
  assert.deepEqual(saves[0], expected)
  assert.deepEqual(probes[1].body, {}, 'after saving, verify the authoritative stored account')
})

test('first account and blank usernames are rejected before a stale saved account can be tested', async (t) => {
  const first = await host(t, {}, { pullAccountSet: false })
  await button(first.page, '测一下').props.onClick()
  assert.deepEqual(first.probes, [])
  assert.match(first.notices[0], /第一次配置/)
  const existing = await host(t)
  existing.page.act(() => username(existing.page).props.onChange({ target: { value: '' } }))
  await button(existing.page, '测一下').props.onClick()
  assert.deepEqual(existing.probes, [])
  assert.equal(existing.notices[0], '请填用户名')
})

test('editing the draft clears an obsolete success and token mode reaches the API', async (t) => {
  const { page, probes } = await host(t)
  await button(page, '测一下').props.onClick(); page.render()
  assert.equal(page.nodes((node) => node.props.className === 'rc-probe ok').length, 1)
  page.act(() => secret(page).props.onChange({ target: { value: 'temporary-token' } }))
  page.act(() => page.nodes((node) => node.type === 'select')[0].props.onChange({ target: { value: 'token' } }))
  assert.equal(page.nodes((node) => node.props.className === 'rc-probe ok').length, 0)
  await button(page, '测一下').props.onClick()
  assert.deepEqual(probes.at(-1).body, { user: 'saved-user', secret: 'temporary-token', kind: 'token' })
})

test('an in-flight probe blocks concurrent saves and freezes the credential draft', async (t) => {
  let complete, calls = 0
  const { page, saves } = await host(t, { testPullAccount: () => { calls++; return new Promise((resolve) => { complete = resolve }) } })
  const probe = button(page, '测一下').props.onClick
  const save = button(page, '保存').props.onClick
  const running = probe()
  probe(); save(); page.render()
  assert.equal(calls, 1)
  assert.deepEqual(saves, [])
  assert.equal(button(page, '保存').props.disabled, true)
  assert.equal(username(page).props.disabled, true)
  complete({ ok: true }); await running; page.render()
  assert.equal(button(page, '保存').props.disabled, false)
})

test('successful save followed by a failed probe still refreshes saved account state', async (t) => {
  const { page, notices, reloads } = await host(t, { testPullAccount: async () => { throw new Error('timeout') } })
  await button(page, '保存').props.onClick(); page.render()
  assert.deepEqual(notices, ['拉取账号已保存'])
  assert.equal(reloads(), 1)
  const message = page.nodes((node) => node.props.className === 'rc-probe bad')[0].props.children[1]
  assert.equal(message, '账号已保存，但连接验证失败：timeout')
})


test('GitHub uses only PAT authentication and preserves the saved secret during verification', async (t) => {
  const {page, probes, saves} = await host(t, {}, {type: 'github', pullAccountKind: 'password', pullAccountUser: 'octocat'});
  const choices = page.nodes(node => node.type === 'option').map(node => node.props.value);
  assert.deepEqual(choices, ['token']);
  assert.equal(page.nodes(node => node.type === 'select')[0].props.value, 'token');
  await button(page, '测一下').props.onClick(); page.render();
  await button(page, '保存').props.onClick(); page.render();
  assert.deepEqual(probes[0].body, {user: 'octocat', secret: null, kind: 'token'});
  assert.deepEqual(saves[0].body, probes[0].body);
  assert.doesNotMatch(JSON.stringify(page.render()), /LDAP|登录密码/);
});

test('a probe response after unmount does not update the account form', async (t) => {
  let complete
  const { page, notices, saves, reloads } = await host(t, {
    testPullAccount: () => new Promise((resolve) => { complete = resolve }),
  })
  const pending = button(page, '测一下').props.onClick()
  page.unmount()
  complete({ ok: true, detail: 'Verified' })
  await pending
  assert.deepEqual(notices, [])
  assert.deepEqual(saves, [])
  assert.equal(reloads(), 0)
})

test('a save response after unmount cannot probe or refresh a different account screen', async (t) => {
  let complete
  const { page, notices, probes, reloads } = await host(t, {
    savePullAccount: () => new Promise((resolve) => { complete = resolve }),
  })
  const pending = button(page, '保存').props.onClick()
  page.unmount()
  complete({ ok: true })
  await pending
  assert.deepEqual(notices, [])
  assert.deepEqual(probes, [])
  assert.equal(reloads(), 0)
})

test('the sync action describes scope and duration and distinguishes an empty successful scan', async (t) => {
  const { page } = await host(t, {}, { repositorySyncAt: 1700000000000, repositorySyncOk: true, repositorySyncCount: 0 })
  const action = page.nodes(node => node.type === 'button' && node.props.children?.includes?.('立即同步'))[0]
  assert.match(action.props.title, /此代码源.*几分钟.*项目映射/)
  assert.equal(page.nodes(node => node.props.id === action.props['aria-describedby'])[0].props.children, action.props.title)
  assert.match(JSON.stringify(page.render()), /未发现仓库/)
  page.render({ source: { id: 'source', type: 'gitlab', repositorySyncAt: 1700000000000, repositorySyncOk: true, repositorySyncCount: 2 },
    syncError: 'request timed out' })
  assert.match(JSON.stringify(page.render()), /同步成功/)
  assert.equal(page.nodes(node => node.props.role === 'status')[0].props.children, '本次同步请求：request timed out')
  assert.equal(page.nodes(node => node.props.role === 'alert').length, 0)
})

test('catalog progress names the reported stage and shows elapsed time apart from announcements', async (t) => {
  setLocale('zh-CN')
  const page = await createComponentHarness(source, { exportName: 'SyncProgress', privateExports: ['SyncProgress'],
    dependencies: { '../api.js': {}, '../FilterControls.jsx': {}, '../ui.jsx': {},
      './repository-catalog-search.js': catalogSearch, './project-governance.css': {}, './repositories.css': {}, './RepositoryIssueSync.jsx': {} } })
  t.after(() => page.unmount())
  assert.equal(page.nodes(node => node.props.role === 'status')[0].props.children, '等待同步结果')
  page.render({ stage: 'listing' })
  assert.equal(page.nodes(node => node.props.role === 'status')[0].props.children, '正在读取仓库列表')
  assert.match(page.nodes(node => node.props.role === 'timer')[0].props.children, /已用 \d+ 秒/)
})
