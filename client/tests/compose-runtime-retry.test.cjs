'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-runtime.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fullCatalog = ['pi', 'codex-harness', 'opencode', 'qwen', 'dsh', 'codex'].map(id => ({ id }));
function fixture(first, options = {}) {
  const handlers = new Map(), timers = new Map(), elements = new Map(); let calls = 0;
  let owner = 'hub-a/device/user-a';
  const listeners = new Map();
  const healthProject = reply => {
    if (!reply || !reply.ok || Array.isArray(reply.availableRuntimes)) return reply;
    const rows = Array.isArray(reply.runtimes) ? reply.runtimes : [];
    return { ...reply, availableRuntimes: rows, missing: [] };
  };
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener: (event, handler) => handlers.set(selector + ':' + event, handler),
    setAttribute() {}, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
    return elements.get(selector);
  };
  const root = { querySelector: element, querySelectorAll: () => [] };
  const api = { runtimes: async () => {
    const reply = await (++calls === 1 ? first() : { ok: true, runtimes: fullCatalog });
    return options.project === false ? reply : healthProject(reply);
  },
    probe: async () => ({ ok: true, accessControl: { supported: true, schema: 'soduwork.access-policy/v1' } }) };
  const ctx = { window: null, document: root, WorkComposer: { contextButton: () => '' },
    SoduWorkAPI: { taskStorageKey: () => owner }, addEventListener: (event, listener) => listeners.set(event, listener),
    setTimeout(fn) { const id = {}; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } }; ctx.window = ctx;
  vm.runInNewContext(source, ctx);
  const bind = () => ctx.ComposeRuntime.bind(root, { api: () => api }); bind();
  return { api, context: ctx, runtime: ctx.ComposeRuntime, calls: () => calls, bind, click: () => handlers.get('#cpRuntime:click')(),
    more: () => handlers.get('#cpRuntimeMore:click')({stopPropagation() {}}),
    owner(value, event = true) { owner = value; if (event) listeners.get('soduwork-data-scope-changed')?.(); },
    goalButton: () => element('#cpIntentMenu'),
    select: id => { const row = element(id); row.dataset.runtime = id;
      return handlers.get('#cpRuntimePop:click')({ target: { closest: () => row } }); },
    expire: () => { for (const fn of [...timers.values()]) fn(); } };
}

test('runtime maintenance follows the selected location and never falls back from cloud to local', () => {
  const f = fixture(() => ({ok:true,runtimes:fullCatalog})), calls = [];
  f.context.openAgentsEntry = () => calls.push('agents');
  f.context.WorkspaceHost = {open: page => calls.push(page)};
  f.more();
  f.runtime.setLocation('cloud'); f.more();
  delete f.context.WorkspaceHost;
  f.context.openCloudEnvironmentsPanel = () => calls.push('cloud-fallback');
  f.more();
  delete f.context.openCloudEnvironmentsPanel; f.more();
  f.runtime.setLocation('local'); f.more();
  assert.deepEqual(calls, ['agents','cloud','cloud-fallback','agents']);
});

test('a legacy declaration-only response never exposes unverified non-Pi runtimes', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog }), { project: false });
  await f.runtime.ready();
  assert.deepEqual(f.runtime.catalog().map(row => row.id), ['pi']);
  assert.doesNotMatch(f.runtime.controls(''), /data-runtime='opencode'/);
});

test('an incomplete health projection cannot remove the resident Pi entry', async () => {
  const f = fixture(() => ({ ok: true,
    runtimes: [{ id: 'pi', displayName: 'Pi' }, { id: 'opencode', displayName: 'OpenCode' }],
    availableRuntimes: [{ id: 'opencode', displayName: 'OpenCode' }],
    missing: [] }));
  await f.runtime.ready();
  assert.equal(Array.from(f.runtime.catalog(), row => row.id).join(','), 'pi,opencode');
});

for (const failed of ['rejection', 'invalid', 'empty']) {
  test(`failed ${failed} catalog is retried on reopen, coalesces concurrent loads and rediscovers on later opens`, async () => {
    const f = fixture(() => { if (failed === 'rejection') throw Error('startup IPC failed');
      return failed === 'invalid' ? { ok: false, runtimes: fullCatalog } : { ok: true, runtimes: [] }; });
    await f.runtime.ready(); assert.equal(f.runtime.catalog().length, 1);
    f.click(); f.click(); f.bind(); await f.runtime.ready(); await flush();
    assert.equal(f.calls(), 2); assert.equal(f.runtime.catalog().length, 6);
    f.click(); f.bind(); await f.runtime.ready(); assert.equal(f.calls(), 3, 'reopening discovers external installations');
  });
}

test('cloud selection checks remote capacity and does not require a local CLI; switching back restores local checks', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog }));
  await f.runtime.ready(); let probes = 0, cloudProbes = 0;
  f.api.probe = async () => { probes++; return { ok: false, reason: 'not installed' }; };
  f.api.cloud = { targets: async () => { cloudProbes++; return { ok: true, targets: [{ id: 'remote' }] }; } };
  f.runtime.setLocation('cloud'); assert.equal(await f.runtime.ready(), true);
  await f.select('codex'); assert.equal(f.runtime.value(), 'codex');
  assert.equal(probes, 0); assert.ok(cloudProbes >= 2); assert.equal(f.runtime.accessSupported(), false);
  f.runtime.setLocation('local'); await f.runtime.ready(); assert.equal(probes, 1);
  f.api.cloud.targets = async () => ({ ok: true, targets: [] });
  f.runtime.setLocation('cloud'); assert.equal(await f.runtime.ready(), false);
});

test('a failed local probe blocks the first turn instead of opening a dead chat', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog }));
  await f.runtime.ready();
  f.api.probe = async () => ({ ok: false, reason: 'not installed' });
  await f.runtime.refreshAccess();
  assert.equal(await f.runtime.ready(), false);
  assert.equal(f.runtime.accessState(), 'unavailable');
});

test('a cloud Agent probe cannot change the local Agent after the execution location changes', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog })), slow = deferred();
  await f.runtime.ready();
  f.api.cloud = { targets: async id => id === 'codex' ? slow.promise : { ok: true, targets: [{ id: 'cloud-pi' }] } };
  f.runtime.setLocation('cloud'); await f.runtime.ready();
  const selecting = f.select('codex');
  f.runtime.setLocation('local'); await f.runtime.ready();
  slow.resolve({ ok: true, targets: [{ id: 'cloud-codex' }] }); await selecting;
  assert.equal(f.runtime.value(), 'pi');
  assert.equal(f.runtime.location(), 'local');
});

test('the latest Agent click wins even if an earlier probe completes later', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog })), slow = deferred();
  await f.runtime.ready();
  f.api.probe = async id => id === 'codex' ? slow.promise : { ok: true };
  const older = f.select('codex'); await f.select('qwen');
  slow.resolve({ ok: true }); await older;
  assert.equal(f.runtime.value(), 'qwen');
});

test('a manual cloud Harness choice cannot be overwritten by automatic fallback', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog })), preferred = deferred(), chosen = deferred();
  await f.runtime.ready();
  f.api.cloud = { targets: async id => id === 'pi' ? preferred.promise : chosen.promise };
  f.runtime.setLocation('cloud');
  const waiting = f.runtime.ready();
  await flush();
  const selecting = f.select('codex');
  chosen.resolve({ ok: true, targets: [{ id: 'cloud-codex' }] });
  await selecting;
  preferred.resolve({ ok: false, reason: 'Pi 未安装' });
  assert.equal(await waiting, true);
  assert.equal(f.runtime.value(), 'codex');
  assert.equal(f.runtime.availability().ok, true);
});

test('rapidly leaving and returning to cloud starts a fresh Harness probe', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog })), old = deferred(), fresh = deferred();
  await f.runtime.ready();
  let calls = 0;
  f.api.cloud = { targets: async () => ++calls === 1 ? old.promise : fresh.promise };
  f.runtime.setLocation('cloud');
  const oldReady = f.runtime.ready();
  await flush();
  assert.equal(calls, 1);
  f.runtime.setLocation('local');
  await f.runtime.ready();
  f.runtime.setLocation('cloud');
  const freshReady = f.runtime.ready();
  await flush();
  assert.equal(calls, 2);
  fresh.resolve({ ok: true, targets: [{ id: 'fresh-cloud' }] });
  assert.equal(await freshReady, true);
  old.resolve({ ok: false, reason: '旧账号结果' });
  await oldReady;
  assert.equal(f.runtime.location(), 'cloud');
  assert.equal(f.runtime.availability().ok, true);
});

test('cloud capacity probes follow account changes and discard old approvals without waiting for the old account', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog })), old = deferred(), next = deferred();
  await f.runtime.ready(); let calls = 0;
  let account = 'old';
  f.api.cloud = { targets: () => { calls++; return account === 'old' ? old.promise : next.promise; } };
  f.runtime.setLocation('cloud'); let ready = null;
  const pendingReady = f.runtime.ready().then(value => { ready = value; });
  account = 'next'; f.owner('hub-b/device/user-b');
  await flush(); assert.ok(calls >= 1);
  next.resolve({ ok: false, reason: '此账号没有可用的执行机' }); await flush();
  assert.equal(ready, false);
  old.resolve({ ok: true, targets: [{ id: 'old-private-runner' }] }); await pendingReady; await flush();
  assert.equal(f.runtime.availability().ok, false);
  assert.match(f.runtime.availability().reason, /此账号/);
});

test('cloud selection exposes the actual paused/offline diagnosis and an absent desktop bridge is actionable', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog })); await f.runtime.ready();
  f.api.cloud = { targets: async () => ({ ok: true, targets: [], diagnostics: {
    summary: '执行机暂不可用', nodes: [
      { code: 'current_device', message: '当前电脑' },
      { code: 'paused', message: '执行机已暂停接单，请管理员恢复接单' },
    ],
  } }) };
  f.runtime.setLocation('cloud'); assert.equal(await f.runtime.ready(), false);
  assert.match(f.runtime.availability().reason, /暂停接单/);
  f.api.cloud = {}; await f.runtime.refreshAccess();
  assert.match(f.runtime.availability().reason, /重启客户端/);
  f.api.cloud = { targets: async () => { throw Error("Error invoking remote method 'conversation-cloud-targets': Error: No handler registered for 'conversation-cloud-targets'"); } };
  await f.runtime.refreshAccess();
  assert.equal(f.runtime.availability().ok, false);
  assert.match(f.runtime.availability().reason, /完全退出并重启客户端/);
  assert.doesNotMatch(f.runtime.availability().reason, /Error invoking|No handler/);
});
test('a timed-out catalog releases its pending slot and a late result cannot replace the recovered catalog', async () => {
  const old = deferred(), f = fixture(() => old.promise); await flush(); f.expire(); await f.runtime.ready();
  assert.equal(f.runtime.catalog().length, 1); f.click(); await flush();
  assert.equal(f.calls(), 2); assert.equal(f.runtime.catalog().length, 6);
  old.resolve({ ok: true, runtimes: [{ id: 'obsolete' }] }); await flush();
  assert.equal(f.runtime.catalog().length, 6); assert.ok(!f.runtime.catalog().some(row => row.id === 'obsolete'));
});

test('selecting a chat-only Agent disables the goal entry and returning to Pi restores it', async () => {
  const f = fixture(() => ({ ok: true, runtimes: [
    { id: 'pi', goalMode: 'native' }, { id: 'chat-only-acp', goalMode: 'none' },
  ] }));
  await f.runtime.ready();
  assert.equal(f.runtime.goalSupported(), true);
  await f.select('chat-only-acp');
  assert.equal(f.runtime.goalSupported(), false);
  assert.equal(f.goalButton().disabled, true);
  assert.match(f.goalButton().title, /不支持目标/);
  await f.select('pi');
  assert.equal(f.goalButton().disabled, false);
  assert.equal(f.runtime.goalSupported(), true);
});

test('new declared runtimes render without a built-in name or icon and keep labels as text', async () => {
  const f = fixture(() => ({ ok: true, runtimes: [{ id: 'sample-acp', displayName: '<Sample ACP>',
    summary: 'Read & write', modelMode: 'account' }] }));
  await f.runtime.ready();
  const html = f.runtime.controls('');
  assert.match(html, /data-runtime='sample-acp'/);
  assert.match(html, /&lt;Sample ACP&gt;/);
  assert.match(html, /Read &amp; write/);
  assert.doesNotMatch(html, /<Sample ACP>/);
});

test('runtime hover labels preserve quotes without creating HTML attributes', async () => {
  const f = fixture(() => ({ ok: true, runtimes: [{ id: 'custom-quotes', displayName: `Team's "Agent" <Local>` }] }));
  await f.runtime.ready();
  assert.match(f.runtime.controls(''), /title="Team's &quot;Agent&quot; &lt;Local&gt;"/);
});

test('runtime-added events refresh the catalog once, preserve the selected Agent and discard stale requests', async () => {
  const old = deferred(), f = fixture(() => old.promise), listeners = new Set();
  f.api.onRuntimesChanged = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  f.bind(); f.bind(); assert.equal(listeners.size, 1);
  const next = [...fullCatalog, { id: 'custom-new', displayName: 'New ACP Agent' }];
  f.api.runtimes = async () => ({ ok: true, runtimes: next, availableRuntimes: next, missing: [] });
  for (const listener of listeners) listener(); await flush();
  assert.equal(f.runtime.catalog().length, 7); assert.equal(f.runtime.value(), 'pi');
  old.resolve({ ok: true, runtimes: [{ id: 'obsolete' }] }); await flush();
  assert.equal(f.runtime.catalog().length, 7);
  await f.select('custom-new'); assert.equal(f.runtime.value(), 'custom-new');
  for (const listener of listeners) listener(); await flush();
  assert.equal(f.runtime.value(), 'custom-new');
});
