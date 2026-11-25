'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-runtime.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fullCatalog = ['pi', 'codex-harness', 'opencode', 'qwen', 'dsh', 'codex'].map(id => ({ id }));
function clock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
function fixture(first, options = {}) {
  const handlers = new Map(), timers = new Map(), elements = new Map(); let calls = 0, refreshes = 0;
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
    setTimeout(fn) { const id = {}; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  if (options.clock) Object.assign(ctx, { setTimeout: options.clock.setTimeout, clearTimeout: options.clock.clearTimeout });
  ctx.window = ctx;
  vm.runInNewContext(source, ctx);
  const bind = () => ctx.ComposeRuntime.bind(root, { api: () => api, refresh: () => { refreshes++; } }); bind();
  return { api, context: ctx, runtime: ctx.ComposeRuntime, calls: () => calls, refreshes: () => refreshes,
    bind, click: () => handlers.get('#cpRuntime:click')(),
    more: () => handlers.get('#cpRuntimeMore:click')({stopPropagation() {}}),
    owner(value, event = true) { owner = value; if (event) listeners.get('soduwork-data-scope-changed')?.(); },
    goalButton: () => element('#cpIntentMenu'),
    select: id => { const row = element(id); row.dataset.runtime = id;
      return handlers.get('#cpRuntimePop:click')({ target: { closest: () => row } }); },
    expire: () => { for (const fn of [...timers.values()]) fn(); } };
}

test('a pending manual switch fences submissions and a superseded selection cannot commit a prepared model', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog }));
  await f.runtime.ready();
  const first = deferred(), commits = [];
  f.context.ComposeModelPicker = { prepareRuntimeSwitch: async row => {
    if (row.id === 'qwen') await first.promise;
    return { preservesModel: true, apply: () => commits.push(row.id) };
  } };
  const qwen = f.select('qwen'); await flush();
  const waiting = f.runtime.pendingSelection();
  assert.ok(waiting);
  await f.select('opencode'); first.resolve(); await qwen;
  assert.equal(await waiting, false);
  assert.deepEqual(commits, ['opencode']);
  assert.equal(f.runtime.value(), 'opencode');
  assert.equal(f.runtime.pendingSelection(), null);
});

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

for (const failure of ['disconnect', 'unknown-auth']) test('Codex retries ' + failure + ' but accepts a definitive missing result', async () => {
  const { createRunnerRuntimeAdapter } = require('../main/agent-runtime/runner-adapter');
  const runtimeSpec = require('../main/agent-runtime/runtime-catalog').runtime('codex');
  let calls = 0;
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec, runnerRuntime: { async rpc() {
    if (++calls === 1) {
      if (failure === 'disconnect') throw Error('Runner is not running');
      return { ok: true, data: { installed: true, state: 'unauthed', authStatus: 'unknown' } };
    }
    return { ok: true, data: { installed: calls === 2, state: calls === 2 ? 'ready' : 'missing' } };
  } } });
  assert.equal((await adapter.detect()).ok, true);
  assert.equal((await adapter.detect()).state, 'missing');
  assert.equal(calls, 3);
});

test('a slow last ACP runtime cannot discard the ready OpenCode projection after the composer deadline', async () => {
  const { createRuntimeCatalog } = require('../main/agent-runtime/runtime-catalog');
  const { createRunnerRuntimeAdapter } = require('../main/agent-runtime/runner-adapter');
  const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
  const document = require('../../hub-backend/app/agent_catalog.json');
  const extension = { ...structuredClone(document.agents.find(row => row.id === 'dsh')),
    id: 'atelier', displayName: 'Atelier', order: 95,
    runner: { adapter: 'acp', bins: ['atelier'], args: ['acp'] },
    install: { installer: 'manual', pkg: 'atelier', source: 'local build' } };
  const catalog = createRuntimeCatalog({ ...document, agents: [...document.agents, extension] });
  const time = clock(), calls = [];
  const runtime = { rpc(op, payload, timeout) {
    assert.equal(op, 'runtime.detect'); calls.push(payload.key);
    if (payload.key === 'atelier') return new Promise((_, reject) => {
      time.setTimeout(() => reject(Error('Runner request timed out')), timeout);
    });
    return Promise.resolve({ ok: true, data: {
      installed: payload.key === 'opencode', state: payload.key === 'opencode' ? 'ready' : 'missing',
    } });
  } };
  const bridge = createPiSessionBridge({ catalog,
    runnerAdapters: catalog.runnerRuntimes().map(runtimeSpec => createRunnerRuntimeAdapter({ runtimeSpec, runnerRuntime: runtime })),
    sessionModule: { probe: async () => ({ ok: true }), open: async () => { throw Error('No model is used'); } } });
  let projection;
  try {
    const f = fixture(async () => {
      // Cross-process dispatch starts the host deadline after the renderer deadline.
      await new Promise(resolve => time.setTimeout(resolve, 1));
      projection = await bridge.availableRuntimes(null, { force: true });
      return projection;
    }, { clock: time });
    await flush(); await time.advance(1);
    assert.equal(calls.at(-1), 'atelier');
    assert.ok(calls.indexOf('opencode') < calls.indexOf('atelier'));
    await time.advance(14999);
    assert.equal(projection, undefined);
    assert.equal(await f.runtime.ready(), true, 'Pi remains usable while the inventory is late');
    const refreshes = f.refreshes();
    await time.advance(1);
    assert.deepEqual(projection.availableRuntimes.map(row => row.id), ['pi', 'opencode']);
    assert.equal(projection.missing.find(row => row.id === 'atelier').availability.ok, false);
    assert.deepEqual(Array.from(f.runtime.catalog(), row => row.id), ['pi', 'opencode']);
    assert.ok(f.refreshes() > refreshes, 'the late inventory repaints the composer');
    assert.match(f.runtime.controls(''), /data-runtime='opencode'/);
    assert.doesNotMatch(f.runtime.controls(''), /data-runtime='atelier'/);
  } finally { await bridge.dispose(); }
});

test('a timed-out inventory cannot fill a newer pending retry with its stale success', async () => {
  const old = deferred(), fresh = deferred(), f = fixture(() => old.promise);
  await flush(); f.expire(); await f.runtime.ready();
  f.api.runtimes = () => fresh.promise;
  f.bind(); await flush();
  old.resolve({ ok: true, runtimes: [{ id: 'obsolete' }] }); await flush();
  assert.deepEqual(Array.from(f.runtime.catalog(), row => row.id), ['pi']);
  fresh.resolve({ ok: true, runtimes: fullCatalog, availableRuntimes: fullCatalog, missing: [] });
  await f.runtime.ready();
  assert.equal(f.runtime.catalog().length, fullCatalog.length);
});

for (const failure of ['unavailable', 'rejection']) {
  test(`a timed-out catalog ${failure} cannot demote a successful retry`, async () => {
    const old = deferred(), f = fixture(() => old.promise);
    await flush(); f.expire(); await f.runtime.ready();
    f.click(); await f.runtime.ready(); await flush();
    assert.equal(f.runtime.catalog().length, fullCatalog.length);
    if (failure === 'rejection') old.reject(Error('The old inventory failed'));
    else old.resolve({ ok: false, runtimes: [], availableRuntimes: [] });
    await flush();
    assert.equal(f.runtime.catalog().length, fullCatalog.length);
    assert.match(f.runtime.controls(''), /data-runtime='opencode'/);
  });
}

test('a late inventory from the previous account cannot replace the current account catalog', async () => {
  const old = deferred(), f = fixture(() => old.promise);
  await flush(); f.expire(); await f.runtime.ready();
  f.owner('hub-b/device/user-b'); await f.runtime.ready(); await flush();
  assert.equal(f.runtime.catalog().length, fullCatalog.length);
  old.resolve({ ok: true, runtimes: [{ id: 'previous-account' }] }); await flush();
  assert.equal(f.runtime.catalog().length, fullCatalog.length);
  assert.ok(!f.runtime.catalog().some(row => row.id === 'previous-account'));
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

for (const [label, latest, ready, state] of [
  ['unavailable probe', { ok: false, state: 'missing', reason: 'The newer probe found no runtime' }, false, 'unavailable'],
  ['unsupported access policy', { ok: true,
    accessControl: { supported: false, schema: 'soduwork.access-policy/v1' } }, true, 'unsupported'],
]) {
  test(`late inventory preserves a newer ${label}`, async () => {
    const old = deferred(), time = clock();
    const f = fixture(() => old.promise, { project: false, clock: time });
    f.api.probe = async () => latest;
    await flush(); await time.advance(15000);
    assert.equal(await f.runtime.ready(), ready);
    assert.equal(f.runtime.accessState(), state);
    assert.equal(f.runtime.accessSupported(), false);

    // The catalog captured its health before the explicit probe completed.
    const staleHealth = { ok: true, state: 'ready',
      accessControl: { supported: true, schema: 'soduwork.access-policy/v1' } };
    const rows = ['pi', 'opencode'].map(id => ({ id, availability: staleHealth }));
    old.resolve({ ok: true, runtimes: rows, availableRuntimes: rows, missing: [] });
    await flush();

    assert.deepEqual(Array.from(f.runtime.catalog(), row => row.id), ['pi', 'opencode'],
      'the late inventory still restores healthy choices');
    assert.equal(await f.runtime.ready(), ready, 'older health must not change admission after a newer probe');
    assert.equal(f.runtime.accessState(), state);
    assert.equal(f.runtime.accessSupported(), false, 'older inventory cannot restore revoked permission support');
    if (latest.reason) assert.equal(f.runtime.availability().reason, latest.reason);
  });
}

test('directory runtime restoration requires an installed available Agent and never substitutes Pi', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog })); await f.runtime.ready();
  assert.equal(await f.runtime.restoreSelection('qwen'), true);
  assert.equal(f.runtime.value(), 'qwen');
  assert.equal(await f.runtime.restoreSelection('uninstalled-agent'), false);
  assert.equal(f.runtime.value(), 'qwen');
  f.api.probe = async () => ({ ok: false, reason: 'Fixture authentication unavailable' });
  assert.equal(await f.runtime.restoreSelection('codex'), false);
  assert.equal(f.runtime.value(), 'qwen');
});

test('a delayed directory runtime restore cannot overwrite an explicit newer Agent selection', async () => {
  const f = fixture(() => ({ ok: true, runtimes: fullCatalog })), old = deferred(); await f.runtime.ready();
  f.api.probe = async id => id === 'qwen' ? old.promise : { ok: true };
  const restoring = f.runtime.restoreSelection('qwen'); await flush();
  await f.select('codex'); assert.equal(f.runtime.value(), 'codex');
  old.resolve({ ok: true }); assert.equal(await restoring, false);
  assert.equal(f.runtime.value(), 'codex');
});

test('directory runtime restore checks its caller scope again after asynchronous health checks', async () => {
  for (const changed of ['directory', 'owner', 'location']) {
    const f = fixture(() => ({ ok: true, runtimes: fullCatalog })), old = deferred(); await f.runtime.ready();
    let current = true; f.api.probe = async () => old.promise;
    const restoring = f.runtime.restoreSelection('qwen', () => current); await flush();
    if (changed === 'directory') current = false;
    if (changed === 'owner') f.owner('hub-b/device/user-b');
    if (changed === 'location') f.runtime.setLocation('cloud');
    old.resolve({ ok: true }); assert.equal(await restoring, false, changed);
    assert.notEqual(f.runtime.value(), 'qwen', changed);
  }
});
