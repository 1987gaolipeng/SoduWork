'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const stale = error => error.code === 'STALE_TASK_SCOPE';
const plain = value => JSON.parse(JSON.stringify(value));
const reply = value => new Response(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const localRunner = { runnerId: 'desktop/source', scope: 'current-instance', online: true };
const localMachine = { runnerId: 'desktop/source', scope: 'current-instance',
  env: { node: 'v22', ok: true }, agents: [{ key: 'pi' }] };
const cloudRunner = { runnerId: 'cloud', scope: 'personal-cloud', online: true, isCurrentDevice: true };
const cloudMachine = { runnerId: 'cloud', scope: 'personal-cloud', env: { node: 'cloud-node' }, agents: [{ key: 'cloud-agent' }] };

async function fixture(runners = [cloudRunner, localRunner], data = { machines: [cloudMachine, localMachine],
  agents: cloudMachine.agents, env: cloudMachine.env, models: [{ name: 'fixture-model' }], modelCount: 1 }) {
  let user = 'alice';
  const values = new Map([['soduwork_work_hub_url', 'http://hub-a:8989']]);
  const h = { calls: [], now: Date.now(), data, runners };
  const bridge = {
    deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: user }, session: 'session-' + user, expiresIn: 1800 }),
    runnerStatus: async () => ({ connected: true, running: true }),
  };
  h.fetch = async url => new URL(url).pathname.endsWith('/runners') ? reply({ runners: h.runners }) : reply(h.data);
  const window = { __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true }, soduWorkAPI: bridge, dispatchEvent() {} };
  vm.runInNewContext(source, {
    window, User: { id: 'device-1', name: 'Fixture' }, navigator: { platform: 'fixture' },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key) },
    fetch: async (url, options) => { h.calls.push({ url, options }); return h.fetch(url, options); },
    Date: class extends Date { static now() { return h.now; } },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  });
  h.api = window.SoduWorkAPI;
  h.bridge = bridge;
  h.signIn = async next => { user = next; await h.api.registerClient(); };
  h.switch = async kind => kind === 'account' ? h.signIn('bob') : h.api.setHubEnvironment('development', 'http://hub-b:8989');
  await h.signIn('alice');
  h.calls.length = 0;
  return h;
}

test('local setup requests only the authenticated current Runner and removes older Hub compatibility data', async () => {
  const h = await fixture();
  const result = await h.api.localAgentSetup();
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), ['/api/v1/runners', '/api/v1/agent-setup']);
  assert.equal(new URL(h.calls[1].url).searchParams.get('runnerId'), localRunner.runnerId);
  assert.deepEqual(Array.from(result.machines, row => row.runnerId), [localRunner.runnerId]);
  assert.deepEqual(plain(result.agents), localMachine.agents);
  assert.deepEqual(plain(result.env), localMachine.env);
  assert.equal(result.machines[0].isCurrentDevice, true);
  assert.equal(result.modelCount, 1);
  assert.deepEqual(plain(result.models), [{ name: 'fixture-model' }]);
  assert.doesNotMatch(JSON.stringify(result), /cloud-agent|cloud-node/);
});

test('legacy exact identity may supplement missing machine scope without guessing from names', async () => {
  const runner = { ...localRunner, scope: undefined, isCurrentDevice: true };
  const machine = { ...localMachine, scope: undefined, isCurrentDevice: undefined };
  const h = await fixture([runner], { machines: [{ ...machine, runnerId: 'other', label: '我的电脑' }, machine] });
  const result = await h.api.localAgentSetup();
  assert.equal(result.machines.length, 1);
  assert.equal(result.machines[0].scope, 'current-instance');
  assert.equal(result.machines[0].isCurrentDevice, true);
  assert.equal(result.machines[0].runnerId, localRunner.runnerId);
  assert.equal(result.modelCount, null);
});

test('explicit current-instance identity takes precedence over a legacy current-device flag', async () => {
  const h = await fixture([{ ...localRunner, runnerId: 'legacy', scope: undefined, isCurrentDevice: true }, localRunner]);
  await h.api.localAgentSetup();
  assert.equal(new URL(h.calls[1].url).searchParams.get('runnerId'), localRunner.runnerId);
});

test('cloud, backend, foreign, unverified, empty-ID and offline Runners never trigger Agent RPC', async () => {
  const candidates = [cloudRunner, { ...localRunner, scope: 'backend', isCurrentDevice: true },
    { ...localRunner, scope: 'bound-runner', isCurrentDevice: true },
    { ...localRunner, scope: undefined, label: '我的电脑', host: 'same-host', isCurrentDevice: undefined },
    { ...localRunner, runnerId: '  ' }, { ...localRunner, online: false }, { ...localRunner, online: undefined },
    { ...localRunner, execution: 'backend' }, { ...localRunner, scope: 0, isCurrentDevice: true }];
  for (const candidate of candidates) {
    const h = await fixture([candidate]);
    const result = await h.api.localAgentSetup();
    assert.equal(h.calls.length, 1, JSON.stringify(candidate));
    assert.deepEqual(plain(result.machines), []);
    assert.deepEqual(plain(result.agents), []);
    assert.deepEqual(plain(result.models), []);
    assert.equal(result.modelCount, null);
    assert.equal(result.env.why, '当前客户端的 Runner 尚未连接，连接后会显示本机底座。');
  }
});

test('an unavailable local Runner reports native status without fabricating missing models', async () => {
  const h = await fixture([cloudRunner]);
  h.bridge.runnerStatus = async () => ({ connected: false, running: true, error: 'fixture local Runner reconnecting' });
  const result = await h.api.localAgentSetup();
  assert.equal(result.env.why, 'fixture local Runner reconnecting');
  assert.equal(result.modelCount, null);
  assert.equal(h.calls.length, 1);
});

test('matching machine ID cannot override explicit foreign or backend scope', async () => {
  for (const invalid of [{ scope: 'personal-cloud', isCurrentDevice: true }, { scope: 'backend' },
    { scope: 'bound-runner' }, { scope: undefined, isCurrentDevice: false },
    { scope: undefined, isCurrentDevice: 'true' }, { execution: 'backend' }, { online: false }]) {
    const h = await fixture([localRunner], { machines: [{ ...localMachine, ...invalid }],
      agents: cloudMachine.agents, env: cloudMachine.env, modelCount: 0 });
    const result = await h.api.localAgentSetup();
    assert.equal(result.machines.length, 0, JSON.stringify(invalid));
    assert.equal(result.agents.length, 0);
    assert.equal(result.modelCount, null);
    assert.equal(h.calls.length, 2);
  }
});

test('a legacy top-level Agent list without an identified machine is never a local fallback', async () => {
  const h = await fixture([localRunner], { agents: [{ key: 'pi' }], env: { ok: true }, models: [], modelCount: 0 });
  const result = await h.api.localAgentSetup();
  assert.equal(result.machines.length, 0);
  assert.equal(result.agents.length, 0);
  assert.equal(result.modelCount, null);
});

test('exact Runner failure is propagated without retrying the cloud or full inventory', async () => {
  const h = await fixture();
  h.fetch = async url => new URL(url).pathname.endsWith('/runners') ? reply({ runners: h.runners }) :
    new Response('{"detail":"Runner disconnected"}', { status: 503 });
  await assert.rejects(h.api.localAgentSetup(), error => error.status === 503);
  assert.equal(h.calls.length, 2);
  assert.ok(new URL(h.calls[1].url).searchParams.has('runnerId'));
});

for (const kind of ['account', 'hub']) for (const stage of ['runners', 'setup', 'reason']) {
  test(`local setup discards a stale ${stage} result after a ${kind} switch`, async () => {
    const h = await fixture(stage === 'reason' ? [] : undefined), wait = deferred();
    h.fetch = async url => {
      const listing = new URL(url).pathname.endsWith('/runners');
      if (stage === 'runners' && listing || stage === 'setup' && !listing) return wait.promise;
      return reply(listing ? { runners: h.runners } : h.data);
    };
    if (stage === 'reason') h.bridge.runnerStatus = () => wait.promise;
    const pending = h.api.localAgentSetup();
    await tick();
    await h.switch(kind);
    wait.resolve(stage === 'reason' ? { connected: false, running: false } :
      reply(stage === 'runners' ? { runners: h.runners } : h.data));
    await assert.rejects(pending, stale);
    assert.equal(h.calls.length, stage === 'setup' ? 2 : 1);
    assert.ok(h.calls.every(call => call.options.headers.Authorization === 'Device session-alice'));
  });
}

test('authentication refresh between listing and setup cannot send the old Runner ID as another account', async () => {
  const h = await fixture();
  h.bridge.deviceAuthBootstrap = async () => ({ ok: true, stored: true, clientId: 'device-1',
    user: { id: 'bob' }, session: 'session-bob', expiresIn: 1800 });
  h.fetch = async () => ({ ok: true, status: 200, text: async () => {
    h.now += 31 * 60 * 1000;
    return JSON.stringify({ runners: h.runners });
  } });
  await assert.rejects(h.api.localAgentSetup(), stale);
  assert.equal(h.calls.length, 1);
});

test('the existing explicit Agent setup API still supports cloud consumers', async () => {
  const h = await fixture();
  const result = await h.api.agentSetup('cloud');
  assert.equal(h.calls.length, 1);
  assert.equal(new URL(h.calls[0].url).searchParams.get('runnerId'), 'cloud');
  assert.equal(result.machines[0].scope, 'personal-cloud');
});

const scopedOperations = [
  ['agentSetup', api => api.agentSetup('cloud'), '/agent-setup?runnerId=cloud', 'GET'],
  ['agentInstall', api => api.agentInstall('codex-harness', 'install', 'cloud'), '/agent-setup/install', 'POST',
    { key: 'codex-harness', action: 'install', runnerId: 'cloud' }],
  ['cancel Codex login', api => api.agentInstall('codex', 'login-cancel', 'cloud', { jobId: 'cloud|job-1' }), '/agent-setup/install', 'POST',
    { key: 'codex', action: 'login-cancel', runnerId: 'cloud', jobId: 'cloud|job-1' }],
  ['agentProbe', api => api.agentProbe('opencode', 'fixture-model', 'cloud'), '/agent-setup/probe', 'POST',
    { key: 'opencode', model: 'fixture-model', runnerId: 'cloud' }],
  ['agentJob', api => api.agentJob('cloud|job-1'), '/agent-setup/job/cloud%7Cjob-1', 'GET'],
  ['setAgentModel', api => api.setAgentModel('pi', 'fixture-model'), '/agent-setup/model', 'PUT',
    { key: 'pi', model: 'fixture-model' }],
  ['cloudEnvironments', api => api.cloudEnvironments(), '/cloud-environments', 'GET'],
  ['updateCloudEnvironment', api => api.updateCloudEnvironment('cloud', { mode: 'draining' }), '/cloud-environments/cloud', 'PATCH',
    { mode: 'draining' }],
  ['removeCloudEnvironment', api => api.removeCloudEnvironment('cloud'), '/cloud-environments/cloud', 'DELETE'],
];

for (const [name, invoke, route, method, body] of scopedOperations) {
  test(`${name} sends no request when expired authentication restores another account`, async () => {
    const h = await fixture();
    let refreshes = 0;
    h.now += 31 * 60 * 1000;
    h.bridge.deviceAuthBootstrap = async () => {
      refreshes++;
      return { ok: true, stored: true, clientId: 'device-1', user: { id: 'bob' },
        session: 'session-bob', expiresIn: 1800 };
    };
    await assert.rejects(invoke(h.api), stale);
    assert.equal(refreshes, 1);
    assert.equal(h.calls.length, 0);
  });

  test(`${name} keeps its target and payload when authentication refreshes the same account`, async () => {
    const h = await fixture();
    let refreshes = 0;
    h.now += 31 * 60 * 1000;
    h.bridge.deviceAuthBootstrap = async () => {
      refreshes++;
      return { ok: true, stored: true, clientId: 'device-1', user: { id: 'alice' },
        session: 'renewed-alice', expiresIn: 1800 };
    };
    const result = await invoke(h.api);
    assert.deepEqual(plain(result), h.data);
    assert.equal(refreshes, 1);
    assert.equal(h.calls.length, 1);
    const request = h.calls[0], url = new URL(request.url);
    assert.equal(url.pathname + url.search, '/api/v1' + route);
    assert.equal(request.options.method || 'GET', method);
    assert.equal(request.options.headers.Authorization, 'Device renewed-alice');
    assert.equal(Object.hasOwn(request.options, 'taskScope'), false);
    assert.deepEqual(request.options.body ? JSON.parse(request.options.body) : undefined, body);
  });

  test(`${name} never replays an unauthorized request as another account`, async () => {
    const h = await fixture();
    h.fetch = async () => new Response('{"detail":"expired"}', { status: 401 });
    h.bridge.deviceAuthBootstrap = async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: 'bob' }, session: 'session-bob', expiresIn: 1800 });
    await assert.rejects(invoke(h.api), stale);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.headers.Authorization, 'Device session-alice');
  });
}

test('explicit Agent setup discards native fallback diagnostics after an account switch', async () => {
  const h = await fixture([], { machines: [], agents: [], env: {} }), wait = deferred();
  h.bridge.runnerStatus = () => wait.promise;
  const pending = h.api.agentSetup('cloud');
  await tick();
  await h.signIn('bob');
  wait.resolve({ connected: false, running: false, error: 'old account diagnostic' });
  await assert.rejects(pending, stale);
  assert.equal(h.calls.length, 1);
});
