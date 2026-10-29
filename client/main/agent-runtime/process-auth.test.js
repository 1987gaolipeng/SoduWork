'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostAuth, MAX_RESPONSE_BYTES } = require('./process-auth');

const hub = 'https://hub.example.invalid';
function token(uid = 'account-a', exp = 1900000000) {
  return Buffer.from(JSON.stringify({ typ: 'device', cid: 'device-a', uid, exp })).toString('base64url') + '.' + 'a'.repeat(64);
}
function fixture(options = {}) {
  let identity = { hub, clientId: 'device-a', secret: 'private-device-key', session: token() };
  const calls = [];
  const host = createHostAuth({ app: {}, identity,
    identityOf: async () => identity,
    deviceAuth: { ensureSession: async () => token('account-a', 1900000300) },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return options.fetch ? options.fetch(url, init, calls.length) : Response.json({ ok: true });
    }, ...options.host });
  return { host, calls, setIdentity(value) { identity = value; }, get identity() { return identity; } };
}
async function body(reply) { return new Response(reply.body).json(); }

test('public identity and renewed sessions never expose the device secret', async () => {
  const { host } = fixture();
  assert.deepEqual(Object.keys(host.publicIdentity()).sort(), ['clientId', 'hub', 'session']);
  const renewed = await host.ensureSession();
  assert.equal(renewed, token('account-a', 1900000300));
  assert.equal(host.publicIdentity().session, renewed);
  assert.equal(JSON.stringify(host.publicIdentity()).includes('private-device-key'), false);
});

test('host replaces supplied authentication and disables redirects and cookies', async () => {
  const { host, calls } = fixture();
  const response = await host.request(hub + '/api/v1/ai-proxy/config?agent=pi&model=model-a', {
    headers: { Authorization: 'Bearer attacker', 'X-Soduwork-Secret': 'attacker', 'X-Soduwork-Device': 'attacker',
      'X-Device-Key': 'attacker', Cookie: 'attacker', 'Proxy-Authorization': 'attacker', 'Content-Type': 'application/json' },
    redirect: 'follow', credentials: 'include' });
  assert.deepEqual(await body(response), { ok: true });
  const init = calls[0].init;
  assert.equal(init.headers.get('Authorization'), 'Device ' + token());
  for (const key of ['x-soduwork-secret', 'x-soduwork-device', 'x-device-key', 'cookie', 'proxy-authorization'])
    assert.equal(init.headers.has(key), false, key);
  assert.equal(init.headers.get('content-type'), 'application/json');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
});

test('401 forces a same-account short-session renewal once and never retries a 403', async () => {
  let rejectedSession;
  const { host, calls } = fixture({
    host: { deviceAuth: { ensureSession: async (_, id) => { rejectedSession = id.staleSession; return token('account-a', 1900000300); } } },
    fetch: (url, init, attempt) => Response.json({ ok: attempt > 1 }, { status: attempt === 1 ? 401 : 200 }) });
  assert.equal((await host.request(hub + '/api/v1/ai-proxy/config')).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(rejectedSession, token());
  assert.equal(calls[1].init.headers.get('authorization'), 'Device ' + token('account-a', 1900000300));
  assert.equal(calls[1].init.headers.has('x-soduwork-secret'), false);
  const denied = fixture({ fetch: () => new Response('denied', { status: 403 }) });
  assert.equal((await denied.host.request(hub + '/api/v1/ai-proxy/config')).status, 403);
  assert.equal(denied.calls.length, 1);
});

test('a cached old account cannot use a device rebound on Hub during 401 renewal', async () => {
  const { host, calls } = fixture({
    host: { deviceAuth: { ensureSession: async () => token('account-b') } },
    fetch: () => new Response('expired', { status: 401 }),
  });
  assert.equal((await host.request(hub + '/api/v1/ai-proxy/config')).status, 401);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.has('x-soduwork-secret'), false);
  assert.equal(host.publicIdentity().session, token());
});

test('expired initial token retains account provenance and can be renewed', async () => {
  const id = { hub, clientId: 'device-a', session: token('account-a', 1), secret: 'key' };
  const host = createHostAuth({ identity: id, identityOf: async () => ({ ...id, session: token() }),
    deviceAuth: { ensureSession: async () => token() } });
  assert.equal(await host.ensureSession(), token());
});

test('only explicit execution routes and methods are allowed', async () => {
  const { host, calls } = fixture();
  const routes = [
    ['GET', '/api/v1/ai-proxy/media/config'], ['POST', '/api/v1/ai-proxy/vision/analyze'],
    ['POST', '/api/v1/conversations/chat-a/images'], ['GET', '/api/v1/conversations/chat-a/media'],
    ['POST', '/api/v1/attachments/file-a/access'], ['GET', '/api/v1/tasks/task-a'],
    ['GET', '/api/v1/tasks/task-a/attachments'], ['POST', '/api/v1/tasks/task-a/conversation-turn'],
    ['POST', '/api/v1/tasks/task-a/conversation-delivery'], ['GET', '/api/v1/tasks/task-a/acceptance-context'],
    ['POST', '/api/v1/tasks/task-a/auto-review'], ['POST', '/api/v1/tasks/task-a/ai-dispatch'],
    ['POST', '/api/v1/tasks/task-a/plugin-runs'], ['GET', '/api/v1/tasks/task-a/ai-session?ref=r%3Aa&since=2'],
    ['GET', '/api/v1/plugin-runs/run-a'], ['POST', '/api/v1/plugin-runs/run-a/cancel'], ['GET', '/api/v1/repos'],
  ];
  for (const [method, path] of routes) assert.equal((await host.request(hub + path, { method })).status, 200, path);
  assert.equal(calls.length, routes.length);
});

test('origin, route, query and parser bypasses never reach fetch', async () => {
  const { host, calls } = fixture();
  const denied = [
    'https://other.example/api/v1/ai-proxy/config', 'http://hub.example.invalid/api/v1/ai-proxy/config',
    'https://user:password@hub.example.invalid/api/v1/ai-proxy/config', hub + '/api/v1/ai-proxy/config#fragment',
    hub + '/api/v1/clients/enroll', hub + '/api/v1/tasks', hub + '/api/v1/tasks/task-a/status',
    hub + '/api/v1/ai-proxy/v1/chat/completions', hub + '/api/v1/a/../ai-proxy/config',
    hub + '/api/v1/%61i-proxy/config', hub + '/api/v1/ai-proxy%2fconfig',
    hub + '/api/v1/ai-proxy/config/..', hub + '\\api\\v1\\ai-proxy\\config',
    hub + '/api/v1/ai-proxy/config?url=https://other.example',
    hub + '/api/v1/ai-proxy/config?agent=pi&agent=other', hub + '/api/v1/ai-proxy/config\n',
    '/api/v1/ai-proxy/config',
  ];
  for (const url of denied) await assert.rejects(host.request(url), { code: 'RUNTIME_AUTH_ROUTE_DENIED' }, url);
  await assert.rejects(host.request(hub + '/api/v1/ai-proxy/config', { method: 'POST' }), { code: 'RUNTIME_AUTH_ROUTE_DENIED' });
  assert.equal(calls.length, 0);
});

test('account, Hub, device, key changes and logout invalidate the host', async () => {
  for (const change of [id => null, id => ({ ...id, hub: 'https://other.example' }),
    id => ({ ...id, clientId: 'device-b' }), id => ({ ...id, secret: 'another-key' }),
    id => ({ ...id, session: token('account-b') })]) {
    const f = fixture(); f.setIdentity(change(f.identity));
    await assert.rejects(f.host.request(hub + '/api/v1/ai-proxy/config'), { code: 'RUNTIME_IDENTITY_CHANGED' });
    assert.equal(f.calls.length, 0);
  }
});

test('identity change while fetch is pending rejects its response and secret fallback', async () => {
  let resolve;
  const f = fixture({ fetch: () => new Promise(done => { resolve = done; }) });
  const pending = f.host.request(hub + '/api/v1/ai-proxy/config');
  while (!resolve) await new Promise(done => setImmediate(done));
  f.setIdentity({ ...f.identity, session: token('account-b') });
  resolve(new Response('expired', { status: 401 }));
  await assert.rejects(pending, { code: 'RUNTIME_IDENTITY_CHANGED' });
  assert.equal(f.calls.length, 1);
});

test('identity change during body streaming rejects the late body', async () => {
  let finish;
  const f = fixture({ fetch: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"ok":true}'));
    finish = () => controller.close();
  } })) });
  const pending = f.host.request(hub + '/api/v1/ai-proxy/config');
  while (!finish) await new Promise(done => setImmediate(done));
  f.setIdentity(null); finish();
  await assert.rejects(pending, { code: 'RUNTIME_IDENTITY_CHANGED' });
});

test('redirect responses, including redirected successful fixtures, fail closed', async () => {
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://other.example' } }),
    Object.defineProperty(new Response('ok'), 'redirected', { value: true })]) {
    const f = fixture({ fetch: () => response });
    await assert.rejects(f.host.request(hub + '/api/v1/ai-proxy/config'), { code: 'RUNTIME_AUTH_REDIRECT_DENIED' });
  }
});

test('response body and reflected response headers cannot return the long-lived key', async () => {
  const f = fixture({ fetch: () => Response.json({ detail: 'private-device-key / private-device-key' }, {
    headers: { 'set-cookie': 'token=private', 'x-diagnostic': 'private-device-key', 'x-soduwork-secret': 'private-device-key',
      'content-length': '70', 'content-encoding': 'gzip' } }) });
  const reply = await f.host.request(hub + '/api/v1/ai-proxy/config');
  assert.deepEqual(await body(reply), { detail: '[hidden] / [hidden]' });
  const headers = new Headers(reply.headers);
  assert.equal(headers.get('x-diagnostic'), '[hidden]');
  for (const key of ['set-cookie', 'x-soduwork-secret', 'content-length', 'content-encoding']) assert.equal(headers.has(key), false);
  assert.equal(JSON.stringify(reply).includes('private-device-key'), false);
});

test('content-length and streamed bodies enforce the response limit', async () => {
  let cancelled = 0;
  const oversizedLength = fixture({ fetch: () => new Response(new ReadableStream({ cancel() { cancelled++; } }), {
    headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }) });
  await assert.rejects(oversizedLength.host.request(hub + '/api/v1/ai-proxy/config'), { code: 'RUNTIME_AUTH_RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, 1);
  const oversizedStream = fixture({ fetch: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES)); controller.enqueue(new Uint8Array(1));
  }, cancel() { cancelled++; } })) });
  await assert.rejects(oversizedStream.host.request(hub + '/api/v1/ai-proxy/config'), { code: 'RUNTIME_AUTH_RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, 2);
});

test('close aborts active work and refuses reuse', async () => {
  let started;
  const f = fixture({ fetch: (url, init) => new Promise((resolve, reject) => {
    started = init.signal;
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }) });
  const pending = f.host.request(hub + '/api/v1/ai-proxy/config');
  while (!started) await new Promise(done => setImmediate(done));
  f.host.close(); f.host.close();
  await assert.rejects(pending, { code: 'RUNTIME_IDENTITY_CHANGED' });
  assert.equal(started.aborted, true);
  assert.throws(() => f.host.publicIdentity(), { code: 'RUNTIME_IDENTITY_CHANGED' });
  await assert.rejects(f.host.ensureSession(), { code: 'RUNTIME_IDENTITY_CHANGED' });
});

test('request preserves cancellation and multipart bodies without inspecting their contents', async () => {
  const f = fixture();
  const data = new FormData(); data.append('files', new Blob(['artifact']), 'output.txt');
  const controller = new AbortController();
  await f.host.request(hub + '/api/v1/tasks/task-a/conversation-delivery', {
    method: 'POST', body: data, signal: controller.signal });
  assert.equal(f.calls[0].init.body, data);
  controller.abort();
  const second = new AbortController(); second.abort();
  await assert.rejects(f.host.request(hub + '/api/v1/ai-proxy/config', { signal: second.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 1);
});

test('worker authentication delegates to the host capability without local fetch or secret fallback', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const calls = [], exported = { exports: {} };
  const identity = { hub, clientId: 'device-a', session: token() };
  const response = Response.json({ ok: true });
  const context = { authFetch: async (...args) => { calls.push(args); return response; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../device-auth-request.js'), 'utf8'), {
    module: exported, global: { fetch: () => { throw Error('worker must not fetch with local credentials'); } },
    require: name => { assert.equal(name, './agent-runtime/process-context'); return { current: () => context }; },
  });
  const init = { method: 'GET' };
  assert.equal(await exported.exports.fetchWithDeviceAuthRetry(identity, hub + '/api/v1/ai-proxy/config', init), response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], identity);
  assert.equal(calls[0][2], init);
});
