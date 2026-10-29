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
    fetch: async (url, options) => { h.calls.push({ url, options }); return new Response(JSON.stringify(await h.result)); },
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
