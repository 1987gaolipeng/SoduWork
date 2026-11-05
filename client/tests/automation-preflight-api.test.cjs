'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const copy = v => JSON.parse(JSON.stringify(v));
function harness() {
  const values = new Map([['soduwork_work_hub_url', 'http://hub-a:8989']]);
  const h = { user: 'alice', calls: [], native: [],
    result: { state: 'waiting', executionReady: true, deviceDependencies: { ownerClientId: 'device-1', plugin: { key: 'method', versionPolicy: 'latest' } } } };
  h.bridge = { deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
    user: { id: h.user }, session: 'test-session-' + h.user, expiresIn: 1800 }),
    automationPreflight: async payload => { h.native.push(payload); return { ...payload.server, state: 'ready' }; } };
  const window = { __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true }, soduWorkAPI: h.bridge, dispatchEvent() {} };
  const context = { window, User: { id: 'device-1', name: 'Test' }, navigator: { platform: 'test' },
    localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) },
    fetch: async (url, options) => { h.calls.push({ url, options }); return new Response(JSON.stringify(await h.result), { status: h.status || 200 }); },
    URL, URLSearchParams, FormData, Response, AbortController, CustomEvent: class {}, console: { log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0 };
  vm.runInNewContext(source, context, { filename: 'api.js' });
  h.api = window.SoduWorkAPI; h.login = () => h.api.registerClient();
  return h;
}
test('preflight merges native checks only after authenticated Hub runtime policy response', async () => {
  const h = harness(); await h.login();
  const result = await h.api.preflightSchedule({ personalPluginKey: 'method' }, { force: true });
  assert.equal(result.state, 'ready'); assert.equal(h.native.length, 1);
  assert.equal(h.native[0].force, true); assert.equal(h.native[0].hub, 'http://hub-a:8989');
  assert.deepEqual(copy(h.native[0].server), h.result);
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /schedules\/preflight$/);
  assert.equal(h.calls[0].options.headers.Authorization, 'Device test-session-alice');
});
test('older native bridge preserves backend waiting; direct schedule does not trigger local checks', async () => {
  const h = harness(); await h.login(); delete h.bridge.automationPreflight;
  assert.equal((await h.api.preflightSchedule({})).state, 'waiting');
  h.result = { state: 'ready', mode: 'direct' };
  h.bridge.automationPreflight = async () => { throw Error('unexpected'); };
  assert.equal((await h.api.preflightSchedule({})).state, 'ready');
});
for (const phase of ['hub', 'native']) for (const identity of ['account', 'hub']) {
  test('discard stale ' + phase + ' response after ' + identity + ' switch', async () => {
    const h = harness(), wait = deferred(); await h.login();
    const original = h.result;
    if (phase === 'hub') h.result = wait.promise;
    else h.bridge.automationPreflight = () => wait.promise;
    const work = h.api.preflightSchedule({ personalPluginKey: 'method' });
    await tick();
    if (identity === 'account') { h.user = 'bob'; await h.login(); }
    else h.api.setHubEnvironment('development', 'http://hub-b:8989');
    wait.resolve(original);
    await assert.rejects(work, error => error.code === 'STALE_TASK_SCOPE');
    if (phase === 'hub') assert.equal(h.native.length, 0);
  });
}

test('manual run wakes the native inbox only after the Hub accepts it, without waiting for the wake', async () => {
  const h = harness(), response = deferred(), wake = deferred(), wakes = [];
  await h.login();
  h.result = response.promise;
  h.bridge.automationConversationsWake = payload => { wakes.push(payload); return wake.promise; };
  const run = h.api.runSchedule('schedule/1', { instanceId: 'ui-owner' });
  await tick();
  assert.equal(wakes.length, 0);
  const accepted = { ok: true, runId: 'run-1', conversationInput: { text: 'work' } };
  response.resolve(accepted);
  assert.deepEqual(copy(await run), accepted);
  assert.deepEqual(copy(wakes), [{ hub: 'http://hub-a:8989' }]);
  assert.equal(h.calls.length, 1, 'waking must not create a second run request');
  assert.match(h.calls[0].url, /schedules\/schedule%2F1\/run$/);
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { instanceId: 'ui-owner' });
  wake.resolve({ ok: true });
});

for (const bridge of ['missing', 'throws', 'rejects']) {
  test('accepted manual run is preserved when native wake ' + bridge, async () => {
    const h = harness(); await h.login();
    h.result = { ok: true, runId: 'run-1' };
    if (bridge === 'throws') h.bridge.automationConversationsWake = () => { throw Error('unavailable'); };
    if (bridge === 'rejects') h.bridge.automationConversationsWake = async () => { throw Error('unavailable'); };
    assert.deepEqual(copy(await h.api.runSchedule('schedule-1')), h.result);
    await tick();
    assert.equal(h.calls.length, 1);
  });
}

for (const identity of ['account', 'hub']) {
  test('manual run response cannot wake a different ' + identity, async () => {
    const h = harness(), response = deferred(), wakes = [];
    await h.login();
    h.result = response.promise;
    h.bridge.automationConversationsWake = payload => { wakes.push(payload); return Promise.resolve({ ok: true }); };
    const run = h.api.runSchedule('schedule-1');
    await tick();
    if (identity === 'account') { h.user = 'bob'; await h.login(); }
    else h.api.setHubEnvironment('development', 'http://hub-b:8989');
    response.resolve({ ok: true, runId: 'run-1' });
    await assert.rejects(run, error => error.code === 'STALE_TASK_SCOPE');
    assert.equal(wakes.length, 0);
    assert.equal(h.calls.length, 1);
  });
}

test('failed manual run does not wake the native inbox', async () => {
  const h = harness(), wakes = []; await h.login();
  h.bridge.automationConversationsWake = payload => { wakes.push(payload); return { ok: true }; };
  h.result = { detail: 'service temporarily unavailable' }; h.status = 503;
  await assert.rejects(h.api.runSchedule('schedule-1'), error => error.status === 503);
  assert.equal(wakes.length, 0);
  h.status = 200; h.result = { ok: false, reason: 'run not created' };
  assert.deepEqual(copy(await h.api.runSchedule('schedule-1')), h.result);
  assert.equal(wakes.length, 0);
});
