'use strict';

// Regression coverage for authentication changes and conversation status recovery.
// Real projection, RPC, host lifecycle, archive, SQLite and sidebar code run
// against synthetic data. OS child/cleanup, policy/model IO and DOM painting are isolated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRpcPeer } = require('../main/agent-runtime/process-rpc');
const { createProcessHost } = require('../main/agent-runtime/process-host');
const { createProcessSession } = require('../main/agent-runtime/process-session');
const { createPublisher } = require('../main/agent-runtime/process-projection');
const { create: createHistory } = require('../main/conversation/shared-history.cjs');
const { create: createStore } = require('../main/conversation/replica-store.cjs');
const engine = require('../main/pi-session/session');
const stream = require('../main/pi-session/event-stream');
const { seed } = require('../main/pi-session/history-seed');
const { presenceState } = require('../main/pi-session/history-state');
const tokens = require('./helpers/platform-session-fixture.cjs');
const clientRoot = path.resolve(__dirname, '..');

function rendererHistory() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(clientRoot,
    'components/workspace/workspace-chat-history.js'), 'utf8'), { window });
  return window.WorkspaceChatHistory;
}
const { chatState } = rendererHistory();

function archivedMessages(id) {
  return [
    { type: 'message', id: id + '-user', timestamp: '2026-11-10T00:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Analyze synthetic image ' + id }], timestamp: 1794268800000 } },
    { type: 'message', id: id + '-answer', timestamp: '2026-11-10T00:00:01Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic analysis completed.' }],
        stopReason: 'stop', timestamp: 1794268801000, usage: { input: 10, output: 5, totalTokens: 15 } } },
  ];
}

function nativeSession(row, status = 'idle') {
  const acc = stream.create();
  seed(acc, { state: { messages: archivedMessages(row.id).map(entry => entry.message) },
    sessionManager: { getEntries: () => archivedMessages(row.id) } });
  const snapshot = { ...acc.snapshot(), status,
    execution: { running: status === 'streaming', queue: [], turnQueue: { active: null, paused: false } } };
  return { ref: 'ref-' + row.id, sessionId: row.id, adapterId: 'pi', cwd: row.cwd,
    model: { id: 'synthetic-model' }, snapshot: () => snapshot, status: () => snapshot.status,
    inFlight: () => snapshot.execution.running,
    historyRow: () => ({ ...row, state: presenceState(snapshot.status), status: snapshot.status, live: true }),
    goalView: () => ({ mode: 'chat' }), resumeLocation: () => row.path };
}

function isolatedHost(app, rows, initialStatus) {
  // No fake PID reaches a real process guard, job object or signal operation.
  const child = new EventEmitter(); child.pid = 410009;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
  class RemoteSession { constructor(ref) { this.ref = ref; } }
  const natives = new Map();
  const remote = createRpcPeer({ timeoutMs: 1000,
    send: packet => setImmediate(() => child.emit('message', structuredClone(packet))),
    encodeSpecial: value => value instanceof RemoteSession ? { tag: 'soduwork.session',
      data: { ref: value.ref, projection: natives.get(value.ref).capture() } } : undefined,
    decodeSpecial: (_tag, data) => data,
    handlers: {
      initialize: () => ({ pid: child.pid, node: process.versions.node }),
      health: () => true, shutdown: () => true,
      open: options => {
        const native = nativeSession(rows.find(row => row.id === options.chatId), initialStatus);
        natives.set(native.ref, createPublisher(native, () => {}));
        return { ok: true, session: new RemoteSession(native.ref) };
      },
      // The diagnostic exercises prewarm routing, not a real model provider.
      module: () => ({ ok: true }), session: () => ({ ok: true }),
    } });
  child.postMessage = packet => setImmediate(() => remote.receive(structuredClone(packet)));
  const host = createProcessHost(app, {
    spawn: async () => child, jobFactory: async () => null,
    treeFactory: ({ pid }) => {
      assert.equal(pid, 410009);
      return { start: async () => ({ rootFound: true }), stop: async () => ({ terminated: [] }) };
    },
    authFactory: ({ identity }) => ({ publicIdentity: () => ({ hub: identity.hub,
      clientId: identity.clientId, session: identity.session || '' }), close() {} }),
  });
  return { host, remote, child };
}

async function fixture(t, status = 'idle') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-login-status-'));
  const app = { getPath: () => root, getAppPath: () => clientRoot };
  const actor = { ...tokens.identity(), secret: 'synthetic-device-key' };
  let current = actor, history, store;
  const hosts = [], handles = [];
  const runtime = createProcessSession({ identityOf: () => current, hostFactory: () => {
    const transport = isolatedHost(app, rows, status); hosts.push(transport); return transport.host;
  } });
  t.after(async () => {
    try { await runtime.dispose(); await history?.close(); }
    finally {
      for (const transport of hosts) { transport.remote.close(); transport.child.removeAllListeners(); }
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('soduwork-login-status-'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const folder = path.join(root, 'pi-agent', 'sessions', 'synthetic');
  fs.mkdirSync(folder, { recursive: true });
  for (const id of ['first', 'second']) fs.writeFileSync(path.join(folder, id + '.jsonl'), [
    { type: 'session', id, cwd: root, timestamp: '2026-11-10T00:00:00Z' }, ...archivedMessages(id),
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const archive = await engine.history(app, 50);
  assert.equal(archive.ok, true); assert.equal(archive.chats.length, 2);
  const rows = archive.chats;
  const connectHistory = () => {
    store = createStore(path.join(root, 'history.sqlite'));
    history = createHistory({ app, session: runtime, store, identityOf: () => current });
  };
  connectHistory();
  for (const row of rows) {
    const opened = await runtime.open({ app, identity: actor, chatId: row.id });
    assert.equal(opened.ok, true); handles.push(opened.session);
  }
  const capture = async () => { for (const handle of handles) await history.capture(handle, actor); };
  return { root, app, actor, rows, runtime, hosts, handles,
    get history() { return history; }, get store() { return store; }, capture,
    signOut() { current = null; },
    setIdentity(value) { current = value; },
    signIn() { current = { ...actor, session: tokens.sessions().renewed }; return current; },
    async reload() { await history.close(); connectHistory(); },
    async states() { return (await history.page()).chats.map(row => [row.id, chatState(row)]).sort(); },
  };
}

test('control: completed native history survives signout and same-account cold reload without process loss', async t => {
  const f = await fixture(t); await f.capture();
  assert.deepEqual(await f.states(), [['first', 'completed'], ['second', 'completed']]);
  f.signOut(); assert.deepEqual(await f.states(), []);
  f.signIn(); await f.reload();
  assert.deepEqual(await f.states(), [['first', 'completed'], ['second', 'completed']]);
});

test('completed chats retain their execution result when their idle worker is stopped', async t => {
  const f = await fixture(t);
  assert.ok(f.handles.every(handle => chatState(handle.historyRow()) === 'completed'));
  await f.hosts[0].host.stop();
  assert.ok(f.handles.every(handle => handle.snapshot().runtimeUnavailable === true));
  assert.deepEqual(f.handles.map(handle => chatState(handle.historyRow())), ['completed', 'completed'],
    'worker lifetime ending must not retroactively fail successful turns');
});

test('control: losing a worker during active execution still reports interrupted work', async t => {
  const f = await fixture(t, 'streaming');
  assert.ok(f.handles.every(handle => handle.inFlight()));
  await f.hosts[0].host.stop();
  assert.ok(f.handles.every(handle => !handle.inFlight() && handle.snapshot().runtimeUnavailable));
  assert.deepEqual(f.handles.map(handle => chatState(handle.historyRow())), ['failed', 'failed']);
});

test('control: a real provider failure remains failed after worker shutdown', async t => {
  const f = await fixture(t, 'unreachable');
  assert.ok(f.handles.every(handle => chatState(handle.historyRow()) === 'failed'));
  await f.hosts[0].host.stop(); await f.capture();
  assert.deepEqual(await f.states(), [['first', 'failed'], ['second', 'failed']]);
});

test('control: same-account token renewal reuses the worker and preserves completed status', async t => {
  const f = await fixture(t);
  await f.runtime.prewarm(f.app, f.signIn(), 'synthetic-model');
  assert.equal(f.hosts.length, 1); assert.equal(f.hosts[0].host.isDead(), false);
  assert.deepEqual(f.handles.map(handle => chatState(handle.historyRow())), ['completed', 'completed']);
});

test('capability warmup without an account session cannot poison completed chats owned by the previous worker', async t => {
  const f = await fixture(t);
  f.signOut();
  // Mirrors _sessionIdentity's enrollment-only fallback after ensureSession fails.
  const { session, ...enrollmentOnly } = f.actor;
  const handlers = new Map();
  // Policy networking is unrelated to host retirement. Keep the real IPC warmup path.
  t.mock.method(require('../main/conversation/capabilities'), 'inspect', async () => ({
    policyOk: false, policyReason: 'Signed out synthetic account', items: [], businessSkills: [],
  }));
  require('../main/pi-session/environment-ipc').install({
    app: f.app, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    session: f.runtime, identityOf: async () => enrollmentOnly,
    _skillDirs: () => [], workDir: () => f.root, _conf: () => ({}),
  });
  const result = await handlers.get('conversation-capabilities')({}, {
    adapterId: 'pi', executionLocation: 'local', modelName: 'synthetic-model',
  });
  assert.equal(typeof result?.ok, 'boolean', 'the real IPC handler must return a structured result');
  if (!result.ok) assert.match(result.reason, /登录|身份|account|session/i);
  f.signIn();
  assert.deepEqual(f.handles.map(handle => chatState(handle.historyRow())), ['completed', 'completed'],
    'an unauthenticated warmup must be rejected/deferred or preserve successful historical results');
});

test('cold index refresh recovers a completed archive from a lifecycle-only failure projection', async t => {
  const f = await fixture(t); await f.capture();
  const before = f.rows.map(row => fs.readFileSync(row.path, 'utf8'));
  await f.hosts[0].host.stop(); await f.capture();
  f.signOut(); f.signIn(); await f.reload();
  const archive = await engine.history(f.app, 50);
  assert.equal(archive.ok, true);
  assert.ok(archive.chats.every(row => !Object.hasOwn(row, 'state') && !Object.hasOwn(row, 'status')));
  await f.history.projectRows(archive.chats);
  assert.deepEqual(f.rows.map(row => fs.readFileSync(row.path, 'utf8')), before);
  assert.deepEqual(await f.states(), [['first', 'completed'], ['second', 'completed']],
    'metadata-only archive refresh must not retain a false execution failure from process disposal');
});

test('control: replaying one completed archive replaces only that row in a previously failed index', async t => {
  const f = await fixture(t);
  await f.history.register(f.rows.map(row => ({ ...row, state: 'failed', status: 'failed',
    creator: { account: 'one', hub: f.actor.hub } })));
  await f.history.capture(nativeSession(f.rows.find(row => row.id === 'first')), f.actor);
  assert.deepEqual(await f.states(), [['first', 'completed'], ['second', 'failed']]);
});

test('attributed lifecycle corruption recovers its saved terminal outcome without changing the archive', async t => {
  const f = await fixture(t);
  await f.history.register(f.rows.map(row => ({ ...row, state: 'failed', status: 'failed',
    creator: { account: 'one', hub: f.actor.hub }, runtimeUnavailable: true,
    runtimeFailure: { code: 'RUNTIME_PROCESS_GONE', interrupted: false },
    executionOutcome: { version: 1, source: 'runtime', owner: 'one', hub: f.actor.hub,
      state: 'completed', status: 'idle' } })));
  await f.history.projectRows(f.rows);
  assert.deepEqual(await f.states(), [['first', 'completed'], ['second', 'completed']]);
});

test('unmarked legacy failures and genuine preflight failures survive metadata-only archive refresh', async t => {
  const f = await fixture(t);
  await f.history.register(f.rows.map(row => ({ ...row, state: 'failed', status: 'failed',
    creator: { account: 'one', hub: f.actor.hub } })));
  await f.history.projectRows(f.rows);
  assert.deepEqual(await f.states(), [['first', 'failed'], ['second', 'failed']]);
  await f.history.capture(nativeSession(f.rows.find(row => row.id === 'first'), 'unreachable'), f.actor);
  await f.history.projectRows(f.rows);
  assert.deepEqual(await f.states(), [['first', 'failed'], ['second', 'failed']]);
});

test('initial replay preserves genuine idle-loss failure and only a new successful execution replaces it', async t => {
  const f = await fixture(t), row = f.rows[0];
  const failed = nativeSession(row, 'unreachable');
  await f.history.capture(failed, f.actor);
  const before = f.store.get(row.id);
  await f.history.capture(nativeSession(row), f.actor, { initialReplay: true });
  assert.equal(f.store.get(row.id).state, 'failed');
  assert.equal(f.store.get(row.id).status, before.status);
  await f.history.capture(nativeSession(row), f.actor);
  assert.equal(f.store.get(row.id).state, 'completed');
  assert.equal(f.store.get(row.id).runtimeFailure, null);
});

test('an observed replay cannot turn a retained genuine failure into a recoverable idle loss', async t => {
  const f = await fixture(t), row = f.rows[0], handle = f.handles[0];
  await f.history.capture(nativeSession(row, 'unreachable'), f.actor);
  f.history.observe(handle, f.actor);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.get(row.id).state, 'failed');
  await f.hosts[0].host.stop();
  await handle.close();
  assert.equal(f.store.get(row.id).state, 'failed');
  await f.history.projectRows(f.rows);
  assert.equal(f.store.get(row.id).state, 'failed');
  assert.equal(f.store.get(row.id).status, 'unreachable');
});

test('terminal outcome recovery requires the current readable account and matching provenance', async t => {
  const f = await fixture(t), row = f.rows[0];
  await f.history.register([{ ...row, state: 'failed', status: 'failed',
    creator: { account: 'one', hub: f.actor.hub }, runtimeUnavailable: true,
    runtimeFailure: { code: 'RUNTIME_PROCESS_GONE', interrupted: false },
    executionOutcome: { version: 1, source: 'runtime', owner: 'one', hub: f.actor.hub,
      state: 'completed', status: 'idle' } }]);
  f.setIdentity(tokens.identity('two'));
  await f.history.projectRows(f.rows);
  assert.deepEqual(await f.states(), []);
  assert.equal(f.store.get(row.id).state, 'failed');
  f.setIdentity(f.actor);
  await f.history.projectRows(f.rows);
  assert.equal(f.store.get(row.id).state, 'completed');
});

test('a concurrent genuine failure wins over an older lifecycle repair', async t => {
  const f = await fixture(t), target = f.rows[0];
  await f.history.register([{ ...target, state: 'failed', status: 'failed',
    creator: { account: 'one', hub: f.actor.hub }, runtimeUnavailable: true,
    runtimeFailure: { code: 'RUNTIME_PROCESS_GONE', interrupted: false },
    executionOutcome: { version: 1, source: 'runtime', owner: 'one', hub: f.actor.hub,
      state: 'completed', status: 'idle' } }]);
  const register = f.store.register.bind(f.store);
  let inject = true;
  f.store.register = async (rows, options) => {
    const result = register(rows, options);
    if (inject && !options) {
      inject = false;
      await f.history.capture(nativeSession(target, 'unreachable'), f.actor);
    }
    return result;
  };
  await f.history.projectRows(f.rows);
  assert.equal(f.store.get(target.id).state, 'failed');
  assert.equal(f.store.get(target.id).status, 'unreachable');
  assert.equal(f.store.get(target.id).runtimeFailure, null);
});

test('a late previous-account warmup cannot retire the current account worker', async t => {
  const f = await fixture(t), next = { ...tokens.identity('two'), secret: f.actor.secret };
  f.setIdentity(next);
  const opened = await f.runtime.open({ app: f.app, identity: next, chatId: f.rows[0].id });
  assert.equal(opened.ok, true);
  await assert.rejects(f.runtime.prewarm(f.app, f.actor), { code: 'RUNTIME_IDENTITY_CHANGED' });
  assert.equal(f.hosts.length, 2); assert.equal(f.hosts[1].host.isDead(), false);
  assert.equal(chatState(opened.session.historyRow()), 'completed');
});

function sidebarFixture(local = false) {
  let finish;
  const window = { URL, addEventListener() {},
    SoduWorkAPI: { hubBase: () => 'https://fixture.invalid',
      clientAuthSnapshot: () => ({ user: { id: 'one' }, clientId: 'device' }) },
    soduWorkAPI: { conversationSession: { localHistorySupported: local,
      history: options => options?.source === 'account' ? Promise.resolve({ ok: true, chats: [] })
        : new Promise(resolve => { finish = resolve; }) } } };
  const context = vm.createContext({ window, URL });
  for (const name of ['workspace-chat-history', 'workspace-sidebar-state', 'workspace-chat-list']) {
    let source = fs.readFileSync(path.join(clientRoot, 'components/workspace', name + '.js'), 'utf8');
    if (name === 'workspace-chat-list') {
      const start = source.indexOf('function renderChats() {'), end = source.indexOf('function subscribeConversationPresence()', start);
      assert.ok(start > 0 && end > start);
      // Omit DOM painting only; retain real request sequencing, presence and reconciliation.
      source = source.slice(0, start) + 'function renderChats() {}\n' + source.slice(end);
    }
    vm.runInContext(source, context);
  }
  const ctx = { ...window.WorkspaceChatHistory, root: {}, chatItems: [], chatNames: new Map(),
    activeChatId: '', renderChats() {} };
  const api = window.WorkspaceChatList.create(ctx);
  Object.assign(ctx, api);
  return { ctx, api, finish: value => finish(value) };
}

test('a history request started before a completed presence cannot overwrite that newer state', async () => {
  const { ctx, api, finish } = sidebarFixture();
  const old = { id: 'first', title: 'Synthetic history', state: 'failed', status: 'failed', at: 1 };
  api.setChats([old]);
  const loading = api.refreshConversationHistory();
  await Promise.resolve();
  api.updateChatState({ sessionId: old.id, presence: { ...old, state: 'completed', status: 'idle', live: true } });
  assert.equal(chatState(ctx.chatItems[0]), 'completed');
  finish({ ok: true, chats: [old] }); await loading;
  assert.equal(chatState(ctx.chatItems[0]), 'completed',
    'a stale same-account history response must not undo a newer completed presence');
});

test('a confirmed canonical alias retains presence newer than the local history request', async () => {
  const { ctx, api, finish } = sidebarFixture(true);
  const old = { id: 'child', title: 'Synthetic history', state: 'failed', status: 'failed', at: 1 };
  api.setChats([old]);
  const loading = api.refreshLocalHistory(); await Promise.resolve();
  api.updateChatState({ sessionId: old.id, presence: { ...old, state: 'completed', status: 'idle', live: true } });
  finish({ ok: true, chats: [{ ...old, id: 'parent', historyAliasIds: ['child'] }], next: null,
    localCatalog: { workspace: 'fixture:one', revision: 1,
      items: [{ id: 'parent', archived: false, deleted: false, historyAliasIds: ['child'] }] } });
  await loading;
  assert.equal(ctx.chatItems[0].id, 'parent');
  assert.equal(chatState(ctx.chatItems[0]), 'completed');
});
