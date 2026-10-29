import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale, translateText as tx } from '../src/i18n.js'

const source = new URL('../src/screens/RepositoryIssueSync.jsx', import.meta.url)
const row = { id: 'repo-a', provider: 'gitlab', displayName: 'Repository A', fullName: 'team/repo-a' }
const receipt = (extra = {}) => ({ enabled: false, startedLabel: '处理中', intervalSeconds: 60,
  importedCount: 0, lastCreatedCount: 0, lastError: '', mappedMembers: 0, totalMembers: 0,
  members: [], userOptions: [], ...extra })
const ui = { Modal: 'dialog', Loading: 'loading', SelectMenu: 'select', Icon: 'svg', toast() {} }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function walk(value, predicate) {
  if (Array.isArray(value)) return value.flatMap((item) => walk(item, predicate))
  if (!React.isValidElement(value)) return []
  return [...(predicate(value) ? [value] : []), ...walk(value.props.children, predicate)]
}
const byClass = (page, name) => page.nodes((node) => node.props.className?.split(/\s+/).includes(name))[0]
const button = (page, label) => [...page.nodes((node) => node.type === 'button'), ...walk(page.render().props.footer, (node) => node.type === 'button')].find((node) => node.props.children === label)
const checkbox = (page) => page.nodes((node) => node.type === 'input' && node.props.type === 'checkbox')[0]
const labelInput = (page) => page.nodes((node) => node.type === 'input' && node.props.className === 'f-in')[0]
async function host(t, methods = {}, props = {}) {
  setLocale('zh-CN')
  const changes = []
  const api = { repositoryIssueSync: async () => receipt(), ...methods }
  const page = await createComponentHarness(source, { props: { row, onClose() {}, onUpdated: (value) => changes.push(value), ...props },
    dependencies: { '../api.js': { api }, '../ui.jsx': ui, './repository-issue-sync.css': {} } })
  let mounted = true
  const unmount = () => { if (mounted) { page.unmount(); mounted = false } }
  t.after(unmount)
  page.render(); await page.flush()
  return { page, changes, unmount }
}

test('enabling waits for the authoritative save, preserves failure details and prevents duplicate saves', async (t) => {
  const requests = []
  const { page, changes } = await host(t, { saveRepositoryIssueSync(id, body) {
    const request = { id, body, ...deferred() }; requests.push(request); return request.promise
  } })
  page.act(() => checkbox(page).props.onChange({ target: { checked: true } }))
  page.act(() => labelInput(page).props.onChange({ target: { value: '  started  ' } }))
  const click = button(page, '保存设置').props.onClick
  const saving = click(); click(); page.render()
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].body, { enabled: true, startedLabel: 'started' })
  assert.equal(requests[0].id, row.id)
  assert.equal(button(page, '正在保存…').props.disabled, true)
  assert.deepEqual(changes, [], 'no optimistic enabled receipt')
  requests[0].reject(new Error('GitLab member permission denied'))
  await saving; page.render()
  assert.equal(byClass(page, 'rc-issue-error').props.children, 'GitLab member permission denied')
  assert.equal(checkbox(page).props.checked, true, 'failed save retains editable draft')
  assert.equal(button(page, '立即同步 Issue').props.disabled, true, 'failed enable cannot run')
  assert.deepEqual(changes, [])
  const retry = button(page, '保存设置').props.onClick()
  requests[1].resolve(receipt({ enabled: true, startedLabel: 'started' }))
  await retry; page.render()
  assert.equal(changes.length, 1)
  assert.equal(changes[0].enabled, true)
  assert.equal(changes[0].members, undefined, 'catalog receipt excludes full member records')
  assert.equal(button(page, '保存设置').props.disabled, true)
  assert.equal(button(page, '立即同步 Issue').props.disabled, false)
})

test('manual sync only runs saved enabled configuration and reports server counts', async (t) => {
  const calls = []
  const { page, changes } = await host(t, {
    repositoryIssueSync: async () => receipt({ enabled: true }),
    runRepositoryIssueSync: async (id) => { calls.push(id); return { ok: true, created: 3, skippedConfidential: 1, issueSync: receipt({ enabled: true, importedCount: 8, lastCreatedCount: 3 }) } },
  })
  page.act(() => labelInput(page).props.onChange({ target: { value: 'unsaved' } }))
  assert.equal(button(page, '立即同步 Issue').props.disabled, true)
  await button(page, '立即同步 Issue').props.onClick()
  assert.deepEqual(calls, [])
  page.act(() => labelInput(page).props.onChange({ target: { value: '处理中' } }))
  await button(page, '立即同步 Issue').props.onClick(); page.render()
  assert.deepEqual(calls, [row.id])
  assert.equal(changes[0].importedCount, 8)
  assert.equal(byClass(page, 'rc-issue-notice').props.children, '本次已同步 3 条新需求。')
})

test('manual sync failure reads server health without claiming success', async (t) => {
  let reads = 0
  const { page, changes } = await host(t, {
    repositoryIssueSync: async () => receipt({ enabled: true, lastError: reads++ ? 'GitLab unavailable' : '' }),
    runRepositoryIssueSync: async () => { throw new Error('HTTP 502') },
  })
  await button(page, '立即同步 Issue').props.onClick(); page.render()
  assert.equal(changes[0].lastError, 'GitLab unavailable')
  assert.equal(byClass(page, 'rc-issue-notice'), undefined)
  assert.equal(byClass(page, 'rc-issue-error').props.children, 'HTTP 502')
  assert.equal(button(page, '立即同步 Issue').props.disabled, false)
})

test('successful manual sync refreshes repository members from detail after the summary receipt', async (t) => {
  let reads = 0
  const first = { externalUserId: '42', username: 'existing', active: true, userId: '' }
  const discovered = { externalUserId: '43', username: 'new-member', active: true, userId: 'user-43' }
  const { page, changes } = await host(t, {
    repositoryIssueSync: async () => receipt({ enabled: true, members: ++reads === 1 ? [first] : [first, discovered],
      totalMembers: reads === 1 ? 1 : 2, mappedMembers: reads === 1 ? 0 : 1 }),
    runRepositoryIssueSync: async () => ({ ok: true, created: 0, issueSync: { enabled: true, totalMembers: 2, mappedMembers: 1 } }),
  })
  assert.equal(page.nodes((node) => node.props.className === 'rc-issue-member').length, 1)
  await button(page, '立即同步 Issue').props.onClick(); page.render()
  assert.equal(reads, 2, 'a successful scan must reload the authoritative member detail')
  assert.equal(page.nodes((node) => node.props.className === 'rc-issue-member').length, 2)
  assert.equal(page.nodes((node) => node.type === 'select')[1].props.value, 'user-43')
  assert.equal(changes.at(-1).totalMembers, 2)
})

test('failed detail refresh after successful sync retains its receipt and reports a separate refresh error', async (t) => {
  let reads = 0, runs = 0
  const { page, changes } = await host(t, {
    repositoryIssueSync: async () => { if (++reads > 1) throw new Error('detail temporarily unavailable'); return receipt({ enabled: true }) },
    runRepositoryIssueSync: async () => { runs++; return { ok: true, created: 2, issueSync: { enabled: true, importedCount: 2 } } },
  })
  await button(page, '立即同步 Issue').props.onClick(); page.render()
  assert.equal(runs, 1)
  assert.equal(reads, 2)
  assert.equal(changes.at(-1).importedCount, 2)
  assert.equal(byClass(page, 'rc-issue-notice').props.children, '本次已同步 2 条新需求。')
  assert.match(byClass(page, 'rc-issue-error').props.children, /成员列表刷新失败.*detail temporarily unavailable/)
  assert.equal(button(page, '立即同步 Issue').props.disabled, false)
})

test('member mappings start unselected, require explicit save, and can be removed', async (t) => {
  const mappings = []
  let userId = ''
  const { page } = await host(t, {
    repositoryIssueSync: async () => receipt({ enabled: true, totalMembers: 1, mappedMembers: userId ? 1 : 0,
      members: [{ externalUserId: '42', username: 'same-name', displayName: 'Same name', active: true, userId }],
      userOptions: [{ id: 'soduwork-42', name: 'Same name', username: 'same-name' }] }),
    mapRepositoryIssueMember: async (id, externalUserId, body) => { mappings.push({ id, externalUserId, body }); userId = body.userId || '' },
  })
  const select = () => page.nodes((node) => node.type === 'select')[0]
  assert.equal(select().props.value, '', 'matching display names do not map identities')
  page.act(() => select().props.onChange({ target: { value: 'soduwork-42' } }))
  assert.deepEqual(mappings, [], 'choosing an account is a draft')
  await button(page, '保存关联').props.onClick(); page.render()
  assert.deepEqual(mappings[0], { id: row.id, externalUserId: '42', body: { userId: 'soduwork-42' } })
  assert.equal(select().props.value, 'soduwork-42')
  assert.equal(button(page, '保存关联').props.disabled, true)
  page.act(() => select().props.onChange({ target: { value: '' } }))
  await button(page, '保存关联').props.onClick(); page.render()
  assert.equal(mappings[1].body.userId, null)
  assert.equal(select().props.value, '')
})

test('writeback errors identify each Issue, distinguish manual handling, and show retry details', async (t) => {
  const retryAt = '2026-10-23T08:00:00Z'
  const { page } = await host(t, {
    repositoryIssueSync: async () => receipt({ enabled: true, pendingWritebacks: 1, manualWritebacks: 1, writebacks: [
      { issueIid: 12, issueUrl: 'https://gitlab.example.test/team/repo/-/issues/12', state: 'error', lastError: 'GitLab returned HTTP 503', attempts: 2, nextRetryAt: retryAt },
      { issueIid: 13, issueUrl: 'http://gitlab.internal/team/repo/-/issues/13', state: 'manual', lastError: 'Cannot verify label after execution', attempts: 3, nextRetryAt: retryAt },
    ] }),
  })
  const rows = page.nodes((node) => node.props.className === 'rc-issue-writeback')
  assert.equal(rows.length, 2)
  const links = page.nodes((node) => node.type === 'a')
  assert.deepEqual(links.map((link) => link.props.children), ['Issue #12', 'Issue #13'])
  assert.equal(links[0].props.href, 'https://gitlab.example.test/team/repo/-/issues/12')
  assert.ok(links.every((link) => link.props.target === '_blank' && link.props.rel === 'noopener noreferrer'))
  const labels = page.nodes((node) => node.props.className === 'rc-issue-writeback-state').map((node) => node.props.children)
  assert.deepEqual(labels, ['等待自动重试', '需人工核对'])
  const retries = page.nodes((node) => node.props.className === 'rc-issue-writeback-retry')
  assert.equal(retries.length, 1, 'manual handling must not promise another automatic retry')
  assert.ok(retries[0].props.children.includes(new Date(retryAt).toLocaleString('zh-CN')))
  assert.equal(page.nodes((node) => node.props.className === 'rc-issue-writeback-error')[0].props.children, 'GitLab returned HTTP 503')
})

test('writeback source links reject executable schemes and render server errors as text', async (t) => {
  const error = '<img src=x onerror=alert(1)>'
  const { page } = await host(t, {
    repositoryIssueSync: async () => receipt({ writebacks: [
      { issueIid: 91, issueUrl: 'javascript:alert(1)', state: 'manual', lastError: error, attempts: 1 },
      { issueIid: 92, issueUrl: 'data:text/html,<script>alert(1)</script>', state: 'error', attempts: 1 },
      { issueIid: 93, issueUrl: 'file:///C:/secret.txt', state: 'manual', attempts: 1 },
    ] }),
  })
  assert.equal(page.nodes((node) => node.type === 'a').length, 0)
  assert.equal(page.nodes((node) => node.props.className === 'rc-issue-writeback').length, 3)
  assert.equal(page.nodes((node) => node.props.className === 'rc-issue-writeback-error')[0].props.children, error)
  assert.equal(page.nodes((node) => node.props.dangerouslySetInnerHTML).length, 0)
})

test('closing during reads or saves ignores late responses and does not update the catalog', async (t) => {
  const pendingRead = deferred()
  const reading = await host(t, { repositoryIssueSync: () => pendingRead.promise })
  reading.unmount(); pendingRead.resolve(receipt({ enabled: true })); await pendingRead.promise
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(reading.changes, [])
  const pendingSave = deferred()
  const saving = await host(t, { saveRepositoryIssueSync: () => pendingSave.promise })
  saving.page.act(() => checkbox(saving.page).props.onChange({ target: { checked: true } }))
  const result = button(saving.page, '保存设置').props.onClick()
  saving.unmount(); pendingSave.resolve(receipt({ enabled: true })); await result
  assert.deepEqual(saving.changes, [])
})

test('switching repositories ignores the previous request and resets unsaved state', async (t) => {
  const old = deferred()
  const { page } = await host(t, { repositoryIssueSync: (id) => id === row.id ? old.promise : Promise.resolve(receipt({ startedLabel: 'second-label' })) })
  page.render({ row: { ...row, id: 'repo-b' }, onClose() {} }); await page.flush()
  old.resolve(receipt({ enabled: true, startedLabel: 'old-label' })); await page.flush()
  assert.equal(labelInput(page).props.value, 'second-label')
  assert.equal(checkbox(page).props.checked, false)
})

async function catalogHost(t, manage, methods) {
  const page = await createComponentHarness(new URL('../src/screens/Repositories.jsx', import.meta.url), {
    dependencies: { '../api.js': { api: methods, can: (permission) => permission === 'integration.manage' && manage },
      '../ui.jsx': ui, '../FilterControls.jsx': { FilterInput: 'filter-input' },
      './project-governance.css': {}, './repositories.css': {},
      './RepositoryIssueSync.jsx': { __esModule: true, default: 'issue-dialog', RepositoryIssueSyncStatus: 'issue-status' } },
  })
  t.after(() => page.unmount())
  page.render(); await page.flush()
  return page
}

test('members can read the catalog without integration.manage and cannot configure sync', async (t) => {
  const calls = []
  const page = await catalogHost(t, false, {
    repositoryCatalog: async (...args) => { calls.push(args); return { items: [{ ...row, issueSync: receipt({ enabled: true }) }] } },
    integrations: async () => { throw new Error('members must not request admin integrations') },
  })
  assert.deepEqual(calls, [[]])
  assert.equal(page.nodes((node) => node.type === 'issue-status')[0].props.value.enabled, true)
  assert.equal(button(page, '配置 Issue 同步'), undefined)
  assert.equal(page.nodes((node) => node.type === 'filter-input')[0].props.disabled, false)
  assert.ok(page.nodes((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined).every((node) => node.props.disabled === false))
  assert.ok(page.nodes((node) => node.props.className?.includes('rc-toolbar')).every((node) => !node.props.className.split(/\s+/).includes('is-empty')))
})

test('catalog settings update only the selected repository without reloading the list', async (t) => {
  let loads = 0
  const page = await catalogHost(t, true, {
    integrations: async () => [],
    repositoryCatalog: async () => { loads++; return { items: [row, { ...row, id: 'repo-b' }] } },
  })
  page.act(() => button(page, '配置 Issue 同步').props.onClick())
  const dialog = page.nodes((node) => node.type === 'issue-dialog')[0]
  page.act(() => dialog.props.onUpdated(receipt({ enabled: true })))
  const states = page.nodes((node) => node.type === 'issue-status').map((node) => node.props.value?.enabled)
  assert.deepEqual(states, [true, undefined])
  assert.equal(loads, 1)
})

test('one failed code source keeps healthy repository catalogs visible and reports the failure', async (t) => {
  const page = await catalogHost(t, true, {
    integrations: async () => [{ id: 'gitlab-source', type: 'gitlab' }, { id: 'github-source', type: 'github' }],
    repositoryCatalog: async (id) => {
      if (id === 'github-source') throw new Error('source-unavailable')
      return { items: [row] }
    },
  })
  assert.equal(page.nodes((node) => node.type === 'issue-status').length, 1)
  const errors = JSON.stringify(page.nodes((node) => node.props.role === 'alert'))
  assert.ok(errors.includes('github-source') && errors.includes('source-unavailable'))
})

test('failed catalog reads keep source account controls available for recovery', async (t) => {
  const page = await catalogHost(t, true, {
    integrations: async () => [{ id: 'gitlab-source', type: 'gitlab' }],
    repositoryCatalog: async () => { throw new Error('source-unavailable') },
  })
  assert.equal(page.nodes((node) => node.props.source?.id === 'gitlab-source').length, 1)
})

test('repository Issue wording is translated while label values stay user-authored', async (t) => {
  const { page } = await host(t)
  setLocale('en-US')
  // The harness does not subscribe to locale events, so render with fresh props.
  page.render({ row, onClose() {} })
  assert.equal(button(page, 'Sync Issues now').props.disabled, true)
  assert.equal(labelInput(page).props.value, '处理中')
  assert.equal(tx('配置 Issue 同步'), 'Configure Issue sync')
  setLocale('zh-CN')
})

test('repository Issue API wrappers preserve IDs and send the correct mutation bodies', async (t) => {
  const previousStorage = globalThis.localStorage, previousWindow = globalThis.window
  globalThis.localStorage = { getItem() { return null }, setItem() {}, removeItem() {} }
  globalThis.window = { setTimeout, clearTimeout }
  t.after(() => { globalThis.localStorage = previousStorage; globalThis.window = previousWindow })
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) })
    return { ok: true, status: 200, text: async () => '{"enabled":true}' }
  })
  const { api } = await import('../src/api.js?repository-issue-sync-test')
  await api.repositoryIssueSync('repo / one')
  await api.saveRepositoryIssueSync('repo / one', { enabled: true, startedLabel: '开始' })
  await api.runRepositoryIssueSync('repo / one')
  await api.mapRepositoryIssueMember('repo / one', 'member / 2', { userId: null })
  const base = '/api/v1/admin/repository-catalog/repo%20%2F%20one/issue-sync'
  assert.deepEqual(calls, [
    { url: base, method: 'GET', body: undefined },
    { url: base, method: 'PUT', body: { enabled: true, startedLabel: '开始' } },
    { url: base + '/run', method: 'POST', body: {} },
    { url: base + '/members/member%20%2F%202', method: 'PUT', body: { userId: null } },
  ])
})


test('GitHub Issues use shared settings without repository member mapping or misleading counts', async (t) => {
  const calls = [], github = {...row, id: 'github-repo', provider: 'github'};
  const snapshot = receipt({totalMembers: 1, members: [{externalUserId: '17', username: 'octocat', active: true}],
    userOptions: [{id: 'member-17', name: 'Repository member'}], manualWritebacks: 1,
    writebacks: [{issueIid: 42, issueUrl: 'https://github.com/team/repo/issues/42', state: 'manual'}]});
  const {page} = await host(t, {
    repositoryIssueSync: async () => snapshot,
    saveRepositoryIssueSync: async (id, body) => {calls.push({id, body}); return {...snapshot, ...body}},
    mapRepositoryIssueMember: async () => {throw new Error('GitHub must not map repository members')},
  }, {row: github});
  const text = JSON.stringify(page.render());
  assert.match(text, /自动进入收集箱，当前团队成员认领后移到待开始/);
  assert.match(text, /对当前团队全员可见，团队成员均可认领/);
  assert.doesNotMatch(text, /待关联|已关联|暂无仓库成员|仓库和成员读取权限/);
  assert.equal(page.nodes(node => node.type === 'select').length, 0);
  assert.equal(button(page, '保存关联'), undefined);
  assert.doesNotMatch(text, /GitLab/);
  assert.equal(page.nodes(node => node.type === 'a')[0].props['aria-label'], '在 GitHub 打开 Issue #42');
  assert.match(text, /请在 GitHub 核对标签/);
  page.act(() => checkbox(page).props.onChange({target: {checked: true}}));
  await button(page, '保存设置').props.onClick(); page.render();
  assert.deepEqual(calls[0], {id: github.id, body: {enabled: true, startedLabel: '处理中'}});
  assert.equal(calls.length, 1);
  setLocale('en-US'); page.render({row: github, onClose() {}});
  assert.equal(page.nodes(node => node.type === 'a')[0].props['aria-label'], 'Open Issue #42 in GitHub');
  assert.match(JSON.stringify(page.render()), /Any current team member can claim them and move them to Ready/);
  setLocale('zh-CN');
});

test('both repository providers expose sync status and configuration while unsupported providers do not', async (t) => {
  const catalogRequests = [];
  const page = await catalogHost(t, true, {
    integrations: async () => [{id: 'github-source', type: 'github', enabled: true}, {id: 'gitlab-source', type: 'gitlab', enabled: true},
      {id: 'disabled', type: 'github', enabled: false}, {id: 'other', type: 'generic', enabled: true}],
    repositoryCatalog: async (...args) => { catalogRequests.push(args); return {items: [row, {...row, id: 'github', provider: 'github'}, {...row, id: 'other', provider: 'generic'}]}; },
  });
  assert.deepEqual(catalogRequests, [['github-source'], ['gitlab-source'], ['disabled']]);
  assert.equal(page.nodes(node => node.type === 'issue-status').length, 2);
  const controls = page.nodes(node => node.type === 'button' && node.props.children === '配置 Issue 同步');
  assert.equal(controls.length, 2);
  assert.deepEqual(page.nodes(node => node.props.source).map(node => node.props.source.id), ['github-source', 'gitlab-source']);
  page.act(() => controls[1].props.onClick());
  assert.equal(page.nodes(node => node.type === 'issue-dialog')[0].props.row.provider, 'github');
});

test('the label input switches between GitLab and GitHub length limits', async (t) => {
  const {page} = await host(t);
  assert.equal(labelInput(page).props.maxLength, 120);
  page.render({row: {...row, id: 'github', provider: 'github'}, onClose() {}});
  await page.flush();
  assert.equal(labelInput(page).props.maxLength, 50);
});

test('administrators retain per-source catalog capacity when multiple sources exceed the combined limit', async (t) => {
  const catalogs = {
    lab: Array.from({ length: 600 }, (_, i) => ({ ...row, id: 'lab-' + i })),
    hub: Array.from({ length: 600 }, (_, i) => ({ ...row, id: 'hub-' + i, provider: 'github' })),
  }
  const calls = []
  const page = await catalogHost(t, true, {
    integrations: async () => [{ id: 'lab', type: 'gitlab' }, { id: 'hub', type: 'github' }],
    repositoryCatalog: async (id) => {
      calls.push(id)
      return { items: id ? catalogs[id] : Object.values(catalogs).flat().slice(0, 1000) }
    },
  })
  assert.equal(page.nodes(node => node.type === 'issue-status').length, 1200)
  assert.deepEqual(calls.sort(), ['hub', 'lab'])
})

test('members with an empty catalog see an explanation without requesting integrations', async (t) => {
  const page = await catalogHost(t, false, {
    repositoryCatalog: async () => ({ items: [] }),
    integrations: async () => { throw new Error('must not request integrations') },
  })
  const empty = page.nodes(node => node.props.title === '目录里还没有仓库')[0]
  assert.ok(empty)
  assert.equal(empty.props.text, '请联系管理员同步仓库目录。')
})


test('one failed source does not hide a successful catalog and reports its name and error', async (t) => {
  const page = await catalogHost(t, true, {
    integrations: async () => [{ id: 'lab', type: 'gitlab', name: 'Healthy source' }, { id: 'hub', type: 'github', name: 'Failed source' }],
    repositoryCatalog: async (id) => {
      if (id === 'hub') throw new Error('temporary catalog timeout')
      return { items: [{ ...row, id: 'healthy-repo' }] }
    },
  })
  assert.equal(page.nodes(node => node.type === 'issue-status').length, 1)
  const alerts = page.nodes(node => node.props.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.match(JSON.stringify(alerts[0]), /Failed source/)
  assert.match(JSON.stringify(alerts[0]), /temporary catalog timeout/)
  assert.ok(button(page, '重新加载'))
})

test('all failed catalog reads preserve previous rows and a successful retry clears failures', async (t) => {
  let fail = false
  const page = await catalogHost(t, true, {
    integrations: async () => [{ id: 'lab', type: 'gitlab', name: 'GitLab source' }, { id: 'hub', type: 'github', name: 'GitHub source' }],
    repositoryCatalog: async (id) => {
      if (fail) throw new Error(id + ' unavailable')
      return { items: [{ ...row, id: id + '-repo' }] }
    },
  })
  const rows = () => page.nodes(node => node.props.className === 'rc-row').map(node => node.key)
  assert.deepEqual(rows(), ['lab-repo', 'hub-repo'])
  fail = true
  await page.nodes(node => typeof node.props.onSaved === 'function')[0].props.onSaved(); page.render()
  assert.deepEqual(rows(), ['lab-repo', 'hub-repo'], 'a failed refresh cannot erase previously loaded repositories')
  const alert = page.nodes(node => node.props.role === 'alert')[0]
  assert.ok(alert)
  for (const value of ['GitLab source', 'GitHub source', 'lab unavailable', 'hub unavailable', '保留已有目录']) assert.ok(JSON.stringify(alert).includes(value), value)
  fail = false
  await button(page, '重新加载').props.onClick(); page.render()
  assert.equal(page.nodes(node => node.props.role === 'alert').length, 0)
  assert.deepEqual(rows(), ['lab-repo', 'hub-repo'])
})
