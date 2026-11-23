import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import http from 'node:http'
import { once } from 'node:events'
import { getLocale, serverMessage, setLocale } from '../src/i18n.js'
import { transform } from 'esbuild'

async function fixture(t) {
  const requests = [], events = []
  const storage = new Map([['soduwork_hub_admin_token', 'synthetic-release-token'],
    ['soduwork_hub_admin_user', JSON.stringify({ id: 'fixture-publisher' })]])
  let reply = { status: 200, body: { notes: [{ version: '2.0.0', channel: 'stable', locales: {} }] } }
  let hold = false
  const held = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body })
      if (hold) { held.push(res); return }
      res.writeHead(reply.status, { 'Content-Type': 'application/json', 'X-Request-ID': 'fixture-release-notes', ...reply.headers })
      res.end(JSON.stringify(reply.body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const origin = 'http://127.0.0.1:' + server.address().port
  // Execute the actual API exports. Only browser globals and relative URL
  // resolution are supplied; requests use real fetch against loopback HTTP.
  const source = await fs.readFile(new URL('../src/api.js', import.meta.url), 'utf8')
  const { code } = await transform(source, { format: 'cjs', loader: 'js' })
  const module = { exports: {} }
  const browser = { setTimeout, clearTimeout, dispatchEvent: event => events.push(event.type) }
  const localStorage = { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  new Function('require', 'module', 'exports', 'window', 'localStorage', 'fetch', code)(
    () => ({ translateText: text => text, serverMessage }), module, module.exports, browser, localStorage,
    (url, options) => fetch(new URL(url, origin), options))
  return { api: module.exports.api, exports: module.exports, storage, requests, events,
    respond: (status, body, headers = {}) => { reply = { status, body, headers } },
    hold: () => { hold = true },
    waitHeld: async () => {
      for (let i = 0; i < 100; i++) {
        if (held.length) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw Error('HTTP request did not reach the fixture')
    },
    release: (status, body) => {
      hold = false
      for (const res of held.splice(0)) {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
    } }
}

const authenticatedOperations = {
  json: api => api.orgs(),
  upload: api => api.importPlugin(new Blob(['synthetic package'])),
  form: api => api.uploadClientRelease(new Blob(['synthetic bundle']), new Blob(['synthetic installer'])),
  download: api => api.downloadClientRelease('synthetic-release', 'fixture.bin'),
}

for (const [kind, operation] of Object.entries(authenticatedOperations)) {
  test(`${kind}: a previous session's 401 preserves the new session`, async t => {
    const f = await fixture(t)
    f.hold()
    const pending = operation(f.api)
    const rejection = assert.rejects(pending, error => error.code === 'AUTH_CONTEXT_CHANGED')
    await f.waitHeld()
    f.exports.setToken('new-synthetic-session')
    f.exports.setUser({ id: 'new-account' })
    f.release(401, { detail: 'old session expired' })
    await rejection
    assert.equal(f.exports.getToken(), 'new-synthetic-session')
    assert.deepEqual(f.exports.getUser(), { id: 'new-account' })
    assert.deepEqual(f.events, [])
  })

  test(`${kind}: a current-session 401 still clears authentication`, async t => {
    const f = await fixture(t)
    f.respond(401, { detail: 'current session expired' })
    await assert.rejects(operation(f.api))
    assert.equal(f.exports.getToken(), '')
    assert.equal(f.exports.getUser(), null)
    assert.deepEqual(f.events, ['soduwork-hub-unauth'])
  })

  test(`${kind}: a previous session's success is discarded`, async t => {
    const f = await fixture(t)
    f.hold()
    const rejection = assert.rejects(operation(f.api), error => error.code === 'AUTH_CONTEXT_CHANGED')
    await f.waitHeld()
    f.exports.setToken('new-synthetic-session')
    f.exports.setUser({ id: 'new-account' })
    f.release(200, { privateOldAccountData: 'must not reach the new view' })
    await rejection
    assert.equal(f.exports.getToken(), 'new-synthetic-session')
    assert.deepEqual(f.events, [])
  })
}

test('sign-out and re-sign-in fence requests even when the token string is reused', async t => {
  const f = await fixture(t)
  f.hold()
  const rejection = assert.rejects(f.api.me(), error => error.code === 'AUTH_CONTEXT_CHANGED')
  await f.waitHeld()
  f.exports.setToken('')
  f.exports.setToken('synthetic-release-token')
  f.exports.setUser({ id: 'renewed-account' })
  f.release(401, {})
  await rejection
  assert.equal(f.exports.getToken(), 'synthetic-release-token')
  assert.deepEqual(f.events, [])
})

test('real release-notes API export sends an authenticated read-only HTTP request', async t => {
  const { api, requests } = await fixture(t)
  assert.equal(typeof api.clientReleaseNotes, 'function', 'the release screen requires this real API export')
  const response = await api.clientReleaseNotes()
  assert.deepEqual(response, { notes: [{ version: '2.0.0', channel: 'stable', locales: {} }] })
  assert.deepEqual(requests, [{ method: 'GET', path: '/api/v1/admin/client-release-notes',
    authorization: 'Bearer synthetic-release-token', body: '' }])
})

test('release-note HTTP errors retain status and expiry clears authentication', async t => {
  const { api, respond, requests, storage, events } = await fixture(t)
  for (const status of [404, 403, 503]) {
    respond(status, { detail: 'fixture failure ' + status })
    await assert.rejects(api.clientReleaseNotes(), error =>
      error.status === status && error.requestId === 'fixture-release-notes'
      && error.message === 'fixture failure ' + status)
    assert.equal(storage.get('soduwork_hub_admin_token'), 'synthetic-release-token')
  }
  respond(401, { detail: 'expired fixture session' })
  await assert.rejects(api.clientReleaseNotes(), error => Boolean(error.message))
  assert.equal(storage.has('soduwork_hub_admin_token'), false)
  assert.equal(storage.has('soduwork_hub_admin_user'), false)
  assert.deepEqual(events, ['soduwork-hub-unauth'])
  assert.equal(requests.length, 4)
  assert.ok(requests.every(row => row.method === 'GET' && row.path === '/api/v1/admin/client-release-notes'))
})

test('quota reads preserve pagination, search encoding and member identity over real HTTP', async t => {
  const { api, requests } = await fixture(t)
  await api.quotaPlans()
  await api.quotaMembers({ q: 'fixture +/&?', limit: 50, offset: 0 })
  await api.quotaMember('fixture member+?')
  assert.equal(requests[0].path, '/api/v1/admin/quotas')
  const members = new URL(requests[1].path, 'http://fixture.invalid')
  assert.equal(members.pathname, '/api/v1/admin/quotas/members')
  assert.deepEqual(Object.fromEntries(members.searchParams), { q: 'fixture +/&?', limit: '50', offset: '0' })
  assert.equal(requests[2].path, '/api/v1/admin/quotas/members/fixture%20member%2B%3F')
  assert.ok(requests.every(row => row.method === 'GET' && row.body === ''
    && row.authorization === 'Bearer synthetic-release-token'))
})

test('quota writes retain revision, zero and unlimited values without changing the payload', async t => {
  const { api, requests } = await fixture(t)
  const config = { revision: 7, defaultLimit: null, plans: [
    { id: 'standard', name: 'Fixture plan', totalLimit: 0, models: [], restrictModels: false },
  ] }
  const assignment = { revision: 2, mode: 'custom', custom: { totalLimit: 0, models: [], restrictModels: false } }
  await api.saveQuotaPlans(config)
  await api.assignQuota('fixture member+?', assignment)
  assert.deepEqual(requests.map(row => [row.method, row.path, JSON.parse(row.body)]), [
    ['PUT', '/api/v1/admin/quotas', config],
    ['PUT', '/api/v1/admin/quotas/members/fixture%20member%2B%3F', assignment],
  ])
  assert.ok(requests.every(row => row.authorization === 'Bearer synthetic-release-token'))
})

test('quota revision conflicts reach the editor with their actual HTTP status', async t => {
  const { api, respond } = await fixture(t)
  respond(409, { detail: 'fixture quota revision conflict' })
  await assert.rejects(api.assignQuota('fixture-member', { revision: 1, mode: 'inherit' }),
    error => error.status === 409 && error.message === 'fixture quota revision conflict')
})

test('department and role deletion errors use the selected locale and preserve unknown diagnostics', async t => {
  const f = await fixture(t)
  const previous = getLocale()
  t.after(() => setLocale(previous))
  const cases = [
    [f.api.deleteOrg, 'org.delete.has_children', '该部门下还有子部门', 'This department still has subdepartments.'],
    [f.api.deleteRole, 'role.delete.in_use', '仍有用户在用该角色', 'This role is still assigned to users.'],
  ]
  for (const [remove, code, detail, english] of cases) {
    f.respond(400, { detail }, { 'X-Error-Code': code })
    for (const [locale, expected] of [['zh-CN', detail], ['en-US', english]]) {
      setLocale(locale)
      await assert.rejects(remove('fixture'), error =>
        error.status === 400 && error.code === code && error.message === expected)
    }
  }
  f.respond(400, { detail: 'Diagnostic from a newer Hub' }, { 'X-Error-Code': 'future.unknown' })
  await assert.rejects(f.api.deleteOrg('fixture'), { message: 'Diagnostic from a newer Hub' })
})

test('Hub input errors use each selected language and preserve unknown validation details', async t => {
  const f = await fixture(t)
  const previous = getLocale()
  t.after(() => setLocale(previous))
  for (const [locale, hostname, minimum] of [
    ['zh-CN', '主机名必须是字符串', 'days 不能小于 1'],
    ['en-US', 'The hostname must be text.', 'days must be at least 1.'],
    ['ja-JP', 'ホスト名を文字列で指定してください。', 'days には 1 以上の値を指定してください。'],
    ['ko-KR', '호스트 이름은 문자열이어야 합니다.', 'days 값은 1 이상이어야 합니다.'],
  ]) {
    setLocale(locale)
    f.respond(422, { detail: 'fixture' }, { 'X-Error-Code': 'hub.input.host_type' })
    await assert.rejects(f.api.me(), { message: hostname })
    f.respond(422, { detail: [
      { type: 'greater_than_equal', loc: ['query', 'days'], ctx: { ge: 1 }, msg: 'out of range' },
      { type: 'other', msg: 'original diagnostic' },
    ] })
    await assert.rejects(f.api.me(), { message: minimum + '；original diagnostic' })
  }
})
