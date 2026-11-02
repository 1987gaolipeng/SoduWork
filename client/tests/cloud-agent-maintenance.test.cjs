'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/cloud-environments.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  let owner = 'first-account';
  const calls = [], auth = deferred();
  const api = {
    taskStorageKey: () => owner,
    agentInstall: async (...args) => { calls.push(['install', ...args]); return { jobId: 'installation' }; },
    agentProbe: async (...args) => { calls.push(['probe', ...args]); return { jobId: 'probe' }; },
    agentJob: async id => { calls.push(['job', id]); return { state: 'done', ok: true }; },
  };
  const context = {
    SoduWorkAPI: api, addEventListener() {},
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    CodexAuthDialog: { open: options => { calls.push(['login', options]); return auth.promise; } },
  };
  context.window = context;
  vm.runInNewContext(source.replace('global.CloudEnvironments = {',
    'global.testCloud = { installAgent, harnessView, rowView, environmentRemoved, scopeChanged, jobs: agentJobs, setData: value => { data = value; owner = ownerScope(); } }; global.CloudEnvironments = {'), context);
  const agents = [
    { id: 'codex', name: 'Codex', installed: true, ready: false, reason: '需要登录' },
    { id: 'opencode', name: 'OpenCode', installed: true, ready: true, version: '1.18.18' },
    { id: 'pi', name: 'Pi', installed: true, ready: true },
  ];
  const row = { id: 'cloud-runner', name: 'Cloud computer', host: 'linux-host', os: 'Linux', online: true,
    canManage: true, availableAgents: agents };
  const data = { environments: [row] };
  const cloud = context.testCloud;
  cloud.setData(data);
  return { api, auth, calls, cloud, context, data, row, agents,
    switchOwner(value) { owner = value; cloud.scopeChanged(); },
  };
}

test('cloud cards offer Codex authorization and real probes without uninstalling Pi', () => {
  const f = fixture();
  const codex = f.cloud.harnessView(f.row, f.agents[0]);
  assert.match(codex, /data-ce-agent-action="login"/);
  assert.match(codex, /连接 Codex/);
  for (const agent of f.agents.slice(1)) {
    const html = f.cloud.harnessView(f.row, agent);
    assert.match(html, /data-ce-agent-action="probe"/);
    assert.doesNotMatch(html, /uninstall|卸载/);
  }
  assert.match(f.cloud.harnessView(f.row, { ...f.agents[0], installed: false }), /data-ce-agent-action="install"/);
  assert.doesNotMatch(f.cloud.harnessView(f.row, f.agents[0], true), /data-ce-install-agent/);
});

test('cloud probe keeps the chosen Runner and uses the existing effective model policy', async () => {
  const f = fixture();
  await f.cloud.installAgent(f.row.id, 'opencode', 'probe');
  assert.deepEqual(f.calls, [['probe', 'opencode', '', 'cloud-runner'], ['job', 'probe']]);
  assert.equal(f.cloud.jobs['cloud-runner:opencode'].ok, true);
  assert.match(f.cloud.harnessView(f.row, f.agents[1]), /测通了/);
});

test('missing cloud Agent preparation uses the selected Runner Pi install action', async () => {
  const f = fixture();
  Object.assign(f.row, { status: 'missing_agent', action: 'install_agent' });
  Object.assign(f.agents[2], { installed: false, ready: false });
  const header = row => f.cloud.rowView(row).split('ce-server-content')[0];
  assert.match(header(f.row), /data-ce-install-agent="cloud-runner" data-ce-agent-key="pi" data-ce-agent-action="install">准备 Agent/);
  await f.cloud.installAgent(f.row.id, 'pi', 'install');
  assert.deepEqual(f.calls[0], ['install', 'pi', 'install', 'cloud-runner']);
  for (const change of [{ status: 'auth_required' }, { online: false }, { eligible: false },
    { deploymentRestricted: true }, { canManage: false }, { availableAgents: [] },
    { availableAgents: [{ id: 'pi', installable: false }] },
    { availableAgents: [{ id: 'pi', installed: true }] }]) {
    assert.doesNotMatch(header({ ...f.row, ...change }), /准备 Agent/);
  }
});

test('cloud actions reject missing, unrelated, offline and administratively blocked targets', async () => {
  const f = fixture();
  for (const id of ['', 'local-runner', 'unknown-cloud']) await f.cloud.installAgent(id, 'opencode', 'probe');
  for (const change of [{ online: false }, { eligible: false }, { deploymentRestricted: true }, { canManage: false }]) {
    const row = { ...f.row, ...change };
    f.cloud.setData({ environments: [row] });
    await f.cloud.installAgent(row.id, 'opencode', 'probe');
    assert.match(f.cloud.harnessView(row, f.agents[1]), / disabled/);
  }
  f.cloud.setData(f.data);
  await f.cloud.installAgent(f.row.id, 'pi', 'uninstall');
  await f.cloud.installAgent(f.row.id, 'codex', 'uninstall');
  await f.cloud.installAgent(f.row.id, 'unknown-agent', 'install');
  assert.deepEqual(f.calls, []);
});

test('Codex authorization keeps its Runner, tracks its job and probes only after explicit confirmation', async () => {
  const f = fixture();
  const login = f.cloud.installAgent(f.row.id, 'codex', 'login');
  const options = f.calls[0][1];
  assert.equal(options.runnerId, 'cloud-runner');
  assert.equal(options.machine, 'Cloud computer · linux-host · Linux');
  options.onStart('auth-job');
  assert.equal(f.cloud.jobs['cloud-runner:codex'].jobId, 'auth-job');
  await f.cloud.installAgent(f.row.id, 'codex', 'probe');
  assert.equal(f.calls.length, 1);
  options.onDone(true);
  assert.equal(f.calls.length, 1);
  await options.onProbe();
  f.auth.resolve(true);
  await login;
  assert.deepEqual(f.calls.slice(1), [['probe', 'codex', '', 'cloud-runner'], ['job', 'probe']]);
  assert.equal(f.cloud.jobs['cloud-runner:codex'].action, 'probe');
  assert.equal(f.cloud.jobs['cloud-runner:codex'].ok, true);
});

test('cancelling Codex authorization never starts a probe or leaves the card busy', async () => {
  const f = fixture();
  const login = f.cloud.installAgent(f.row.id, 'codex', 'login');
  f.calls[0][1].onStart('auth-job');
  f.auth.resolve(false);
  await login;
  assert.equal(f.calls.length, 1);
  assert.equal(f.cloud.jobs['cloud-runner:codex'], undefined);
});

test('Codex authorization callbacks cannot escape an account switch or resurrect an earlier scope', async () => {
  const f = fixture();
  const login = f.cloud.installAgent(f.row.id, 'codex', 'login');
  const options = f.calls[0][1];
  f.switchOwner('second-account');
  f.switchOwner('first-account');
  f.cloud.setData(f.data);
  options.onStart('stale-auth-job');
  options.onDone(true);
  await options.onProbe();
  f.auth.resolve(true);
  await login;
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.cloud.jobs), []);
});

test('late probe receipts cannot update another account or a removed cloud computer', async () => {
  for (const transition of ['owner', 'remove']) {
    const f = fixture(), pending = deferred();
    f.api.agentJob = async id => { f.calls.push(['job', id]); return pending.promise; };
    const running = f.cloud.installAgent(f.row.id, 'opencode', 'probe');
    await tick();
    if (transition === 'owner') f.switchOwner('second-account');
    else f.cloud.environmentRemoved(f.row.id);
    pending.resolve({ state: 'done', ok: true });
    await running;
    assert.deepEqual(Object.keys(f.cloud.jobs), []);
  }
});

test('failed probes retain their action and retry a probe instead of reinstalling', async () => {
  const f = fixture();
  f.api.agentJob = async () => ({ state: 'done', ok: false, detail: 'Fixture probe failed <unsafe>' });
  await f.cloud.installAgent(f.row.id, 'opencode', 'probe');
  const html = f.cloud.harnessView(f.row, f.agents[1]);
  assert.match(html, /测了没通/);
  assert.match(html, /data-ce-agent-action="probe"/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.doesNotMatch(html, /安装失败/);
  f.api.agentProbe = async () => { throw Error('Probe transport unavailable'); };
  await f.cloud.installAgent(f.row.id, 'opencode', 'probe');
  assert.equal(f.cloud.jobs['cloud-runner:opencode'].action, 'probe');
});

test('current availability and runtime version supersede completed cloud probe results', async () => {
  for (const ok of [true, false]) {
    const f = fixture();
    f.api.agentJob = async () => ({ state: 'done', ok, detail: 'Previous probe result' });
    await f.cloud.installAgent(f.row.id, 'opencode', 'probe');
    assert.match(f.cloud.harnessView(f.row, f.agents[1]), ok ? /测通了/ : /测了没通/);
    for (const [nodeChange, agentChange, expected] of [
      [{ online: false }, {}, '等待连接'],
      [{ eligible: false }, {}, '等待连接'],
      [{ deploymentRestricted: true }, {}, '等待连接'],
      [{ canManage: false }, {}, '等待连接'],
      [{}, { ready: false }, '已安装，等待云端确认'],
      [{}, { installed: false, ready: false }, '未安装'],
      [{}, { installed: false, ready: true }, '未安装'],
      [{}, { version: '1.18.19' }, '已就绪'],
    ]) {
      const html = f.cloud.harnessView({ ...f.row, ...nodeChange }, { ...f.agents[1], ...agentChange });
      assert.ok(html.includes(expected), JSON.stringify({ ok, nodeChange, agentChange }));
      assert.doesNotMatch(html, /测通了|测了没通|Previous probe result/);
    }
  }
});

test('existing install, check and update actions remain targeted cloud jobs', async () => {
  const f = fixture();
  for (const action of ['install', 'check', 'update']) {
    await f.cloud.installAgent(f.row.id, 'opencode', action);
  }
  assert.deepEqual(f.calls.filter(call => call[0] === 'install'), [
    ['install', 'opencode', 'install', 'cloud-runner'],
    ['install', 'opencode', 'check', 'cloud-runner'],
    ['install', 'opencode', 'update', 'cloud-runner'],
  ]);
});


test('completed cloud installation publishes the common catalog invalidation without changing its target', async () => {
  const f = fixture(), notifications = [];
  f.context.soduWorkAPI = { broadcast: kind => notifications.push(kind) };
  await f.cloud.installAgent(f.row.id, 'opencode', 'update');
  assert.deepEqual(notifications, ['agent-runtimes-changed']);
  assert.deepEqual(f.calls[0], ['install', 'opencode', 'update', f.row.id]);
});
