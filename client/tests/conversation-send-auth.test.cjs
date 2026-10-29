'use strict';

// Production identity, owner persistence, IPC send, and runtime adapters. Only
// Electron windows, Hub responses, Runner RPC, and the Pi inference engine are
// isolated fixtures; this does not claim paid-model or installed-CLI coverage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const memory = require('../main/conversation/session-memory');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { createRunnerRuntimeAdapter, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const { scope } = require('../main/platform-connections/runtime.cjs');

function loadIpc(bridge) {
  const file = require.resolve('../main/pi-session/ipc');
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  const requireFixture = name => {
    if (name === '../agent-runtime/pi-session-bridge') return bridge;
    if (name === 'electron') return { shell: {}, dialog: {} };
    return nativeRequire(name);
  };
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){\n' +
    fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
    requireFixture, module, module.exports, file, path.dirname(file));
  return module.exports;
}

function newAuth() {
  const file = require.resolve('../main/device-auth');
  delete require.cache[file];
  return require(file);
}

async function fixture(t, spec, legacySendIdentity = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-send-auth-'));
  const app = new EventEmitter();
  app.getPath = () => root;
  app.getVersion = () => '1.12.51-test';
  const handlers = new Map();
  const ipcMain = { handle: (name, callback) => handlers.set(name, callback), on() {} };
  const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: value => Buffer.from('fixture:' + value),
    decryptString: value => value.toString().replace(/^fixture:/, ''),
  };
  let auth = newAuth(), uid = 'fixture-account-a', enrollmentCount = 0, loggedOut = false;
  let failure = '', now = Date.now();
  const originalNow = Date.now, originalFetch = global.fetch;
  let bridge;
  t.after(async () => {
    try {
      app.emit('before-quit');
      await bridge?.dispose();
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      global.fetch = originalFetch;
      Date.now = originalNow;
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('soduwork-send-auth-'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  Date.now = () => now;
  function authResponse(body, account = uid) {
    const issued = Math.floor(Date.now() / 1000);
    const claims = { typ: 'device', uid: account, cid: body.device, iat: issued, exp: issued + 1800 };
    const session = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + '0'.repeat(64);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      authState: 'active', activationRequired: false, session, expiresIn: 1800, user: { id: account },
    }) };
  }
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/v1/clients/enroll')) {
      enrollmentCount++;
      await new Promise(resolve => setImmediate(resolve));
      if (failure) return { ok: false, status: 503,
        text: async () => JSON.stringify({ detail: failure }) };
      if (loggedOut) return { ok: true, status: 200, text: async () => JSON.stringify({
        authState: 'pending', activationRequired: true,
      }) };
      return authResponse(JSON.parse(options.body));
    }
    if (String(url).endsWith('/api/v1/client-auth/logout')) {
      loggedOut = true;
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    }
    if (String(url).endsWith('/api/v1/client-auth/login')) {
      const body = JSON.parse(options.body);
      uid = body.account;
      loggedOut = false;
      return authResponse(body);
    }
    // A real optional usage reporter may flush fixture completion counters.
    if (String(url).endsWith('/api/v1/usage/events')) return {
      ok: true, status: 200, text: async () => '{"ok":true}',
    };
    throw Error('Unexpected network request in isolated authentication fixture');
  };
  const installAuth = () => auth.install({ app, ipcMain, safeStorage });
  installAuth();
  const enrollment = await auth.enroll(app, { hub: 'http://127.0.0.1:9' });
  assert.equal(enrollment.ok, true);
  const identityOf = (...args) => auth.authenticatedIdentity(...args);
  const model = { id: 'fixture-model', key: 'fixture-only', baseUrl: 'http://model.invalid' };
  const turns = [], piHistory = new Map(), runnerHistory = new Map();
  let openedNumber = 0;

  const engine = {
    probe: () => ({ ok: true }),
    async open(options) {
      const sessionId = options.resumePath || 'fixture-pi-' + (++openedNumber);
      const messages = piHistory.get(sessionId) || [];
      piHistory.set(sessionId, messages);
      const listeners = new Set();
      const handle = {
        adapterId: 'pi', displayName: 'Pi',
        ref: options.ref, sessionId, cwd: root, ui: {},
        on: callback => { listeners.add(callback); return () => listeners.delete(callback); },
        status: () => 'idle', inFlight: () => false,
        snapshot: () => ({ status: 'idle', messages: messages.slice(), tools: [] }),
        historyRow: () => ({ id: sessionId, adapterId: 'pi', cwd: root }),
        submit(text) {
          turns.push({ adapter: 'pi', text });
          messages.push({ role: 'user', text });
          listeners.forEach(fn => fn({ kind: 'turn-dequeued' }));
          messages.push({ role: 'assistant', text: 'Fixture reply: ' + text, done: true });
          listeners.forEach(fn => fn({ kind: 'turn-finished' }));
          return { accepted: true, completion: Promise.resolve({ ok: true }) };
        },
        async close() {
          const dispose = handle.ui.memorySubscription;
          delete handle.ui.memorySubscription;
          if (dispose) await dispose();
          listeners.clear();
        },
      };
      return { ok: true, session: handle };
    },
  };
  const runtime = { async rpc(op, input) {
    if (op === 'runtime.detect') return { ok: true, data: { installed: true, state: 'ready' } };
    if (op === 'job.dispatch') {
      const ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + input.task.id + ':' + input.cli);
      turns.push({ adapter: input.cli, text: input.ctx.conversationUserText });
      runnerHistory.set(ref, [{ seq: 1, kind: 'say', text: 'Fixture first reply' }]);
      return { ok: true, data: { ref } };
    }
    if (op === 'job.comment') {
      turns.push({ adapter: spec.id, text: input.text });
      const rows = runnerHistory.get(input.ref) || [];
      rows.push({ seq: rows.length + 1, kind: 'say', text: 'Fixture reply: ' + input.text });
      runnerHistory.set(input.ref, rows);
      return { ok: true, data: { ok: true } };
    }
    if (op === 'job.session') {
      const items = runnerHistory.get(input.ref) || [];
      return { ok: true, data: { status: 'done', round: items.length, items } };
    }
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    throw Error('Unexpected isolated RPC: ' + op);
  } };
  bridge = createPiSessionBridge({ app, sessionModule: engine,
    runnerAdapters: catalog.runtimes().filter(row => row.transport === 'runner').map(row => createRunnerRuntimeAdapter({
      app, runtimeSpec: row, runnerRuntime: runtime,
      modelConfig: { fetchModel: async () => ({ ok: true, model }) },
    })),
  });
  const installed = loadIpc(bridge).install({ app, ipcMain, BrowserWindow, identityOf,
    // The explicit legacy shape is a negative control: the original production
    // callback returned a device key without the already-cached session.
    sendIdentityOf: legacySendIdentity ? (...args) => auth.identity(...args) : identityOf,
  });
  const memories = memory.install({ app, ipcMain: { handle() {} }, identityOf });
  let serial = 0;
  async function open(resume) {
    const identity = await identityOf(app);
    const result = await bridge.open({ app, identity, adapterId: spec.id, cwd: root,
      ref: 'fixture-' + spec.id + '-' + (++serial), ...(resume ? { resumePath: resume } : {}) });
    assert.equal(result.ok, true, result.reason);
    const handle = result.session;
    handle.usageIdentity = { hub: identity.hub, clientId: identity.clientId };
    await memories.attach(handle, identity, { ids: [], items: [], scopes: [] }, [],
      { resumed: Boolean(resume), workspaceExplicit: false });
    return handle;
  }
  async function send(handle, text) {
    // Call the installed production IPC handler; there is no alternate test send path.
    const result = await handlers.get('pi-session-send')(null, handle.ref, text, [], {});
    if (result.ok) {
      // IPC deliberately returns before inference completes. Wait for the real
      // adapter's terminal snapshot before opening/closing the next fixture turn.
      for (let i = 0; i < 200 && handle.inFlight?.(); i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(Boolean(handle.inFlight?.()), false, 'adapter must reach its terminal state');
      assert.equal(handle.snapshot().status, 'idle', 'adapter completion must succeed, not merely stop');
    }
    return result;
  }
  return { root, app, open, send, installed, bridge, turns, memories, handlers,
    identity: () => auth.authenticatedIdentity(app), localIdentity: () => auth.identity(app),
    sessionReady: () => Boolean(auth.session(app)), enrollments: () => enrollmentCount,
    expire: () => { now += 3600 * 1000; },
    fail: reason => { failure = reason; },
    switchAccount: () => { uid = 'fixture-account-b'; auth.clearSession(app); },
    restartAuth: () => { auth = newAuth(); installAuth(); },
    selectHub: hub => auth.selectHub(app, hub),
    sessionFor: hub => auth.session(app, hub),
    clear: () => auth.clearSession(app),
    logout: () => auth.logout(app),
    login: () => auth.login(app, { hub: auth.identity(app).hub,
      account: 'fixture-account-b', password: 'fixture-only' }),
  };
}

test('production cloud handoff IPC rejects stale-account conversations before scanning or uploading', async t => {
  const f = await fixture(t, catalog.runtime('pi')), h = await f.open();
  const mainFrame = {}, sender = { mainFrame, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href };
  const event = { sender, senderFrame: mainFrame };
  assert.equal((await f.handlers.get('conversation-cloud-preview')({ ...event, senderFrame: {} }, h.ref)).ok, false);
  f.switchAccount();
  const preview = await f.handlers.get('conversation-cloud-preview')(event, h.ref);
  assert.equal(preview.ok, false); assert.match(preview.reason, /账号|归属/);
  const confirm = await f.handlers.get('conversation-cloud-confirm')(event, h.ref, { previewId: 'stale', instruction: 'Continue' });
  assert.equal(confirm.ok, false); assert.match(confirm.reason, /账号|归属/);
  assert.equal(fs.existsSync(path.join(f.root, 'conversation-handoffs')), false);
  assert.equal(f.turns.length, 0);
});

test('production IPC switches Pi -> OpenCode -> Qwen -> Pi and authenticates model selection', async t => {
  const f = await fixture(t, catalog.runtime('pi')), h = await f.open(), id = h.sessionId;
  const mainFrame = {}, sender = { mainFrame, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href };
  const event = { sender, senderFrame: mainFrame }, select = f.handlers.get('pi-session-select-agent');
  const models = f.handlers.get('pi-session-select-model');
  assert.equal((await f.handlers.get('pi-session-conversation-runtimes')(event, h.ref)).ok, true);
  await f.send(h, 'First turn');
  for (const agentId of ['opencode', 'qwen', 'pi']) {
    const result = await select(event, h.ref, agentId); assert.equal(result.ok, true, result.reason);
    assert.equal(h.sessionId, id); assert.equal(h.adapterId, agentId);
    if (agentId !== 'pi') { const modelResult = await models(event, h.ref, 'next-model'); assert.equal(modelResult.ok, true, modelResult.reason); }
    const sent = await f.send(h, 'Continue ' + agentId); assert.equal(sent.ok, true, sent.reason);
  }
  assert.equal(h.snapshot().messages.filter(row => row.role === 'user').length, 4);
  assert.equal((await select({ ...event, senderFrame: {} }, h.ref, 'qwen')).ok, false);
  f.switchAccount(); assert.equal((await select(event, h.ref, 'qwen')).ok, false);
  assert.equal((await models(event, h.ref, 'forbidden')).ok, false); assert.equal(h.adapterId, 'pi');
});

for (const spec of catalog.runtimes()) {
  test(spec.id + ': cached authenticated IPC first-send, expired renewal, history resume and uid isolation', async t => {
    const f = await fixture(t, spec);
    const handle = await f.open();
    assert.equal(Object.hasOwn(f.localIdentity(), 'session'), false, 'keep the production device-only identity shape');
    assert.equal(f.sessionReady(), true);
    assert.deepEqual(f.memories.assertOwner(await f.identity(), handle.sessionId), []);
    const files = fs.readdirSync(path.join(f.root, 'session-memory-bindings'));
    assert.equal(files.length, 1, 'new conversation persists an owner even without selected memories');
    const binding = JSON.parse(fs.readFileSync(path.join(f.root, 'session-memory-bindings', files[0]), 'utf8'));
    assert.deepEqual(binding.ids, []);
    assert.equal(binding.owner, scope(await f.identity()));

    assert.equal((await f.send(handle, 'First message')).ok, true);
    assert.equal(f.turns.length, 1, 'the actual selected adapter received the turn');
    assert.equal(f.enrollments(), 1, 'valid cached identity adds no enrollment request');
    f.expire();
    assert.equal(f.sessionReady(), false);
    assert.equal((await f.send(handle, 'After expiry')).ok, true);
    assert.equal(f.enrollments(), 2, 'expired cache renews exactly once');
    assert.equal(f.turns.length, 2);

    const sessionId = handle.sessionId;
    await handle.close();
    assert.equal(f.bridge.get(handle.ref), null);
    const resumed = await f.open(sessionId);
    assert.equal(resumed.sessionId, sessionId);
    assert.equal((await f.send(resumed, 'Continue prior conversation')).ok, true);
    assert.equal(f.turns.length, 3);
    assert.equal(f.enrollments(), 2);

    const device = f.localIdentity().clientId;
    f.switchAccount();
    assert.equal(f.localIdentity().clientId, device, 'account changes on the same device');
    const rejected = await f.send(resumed, 'Must not enter account A conversation');
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /另一个账号/);
    assert.equal(f.turns.length, 3, 'account mismatch never reaches a model or Runner');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'session-memory-bindings', files[0]), 'utf8')).owner,
      binding.owner, 'rejected send cannot relabel prior ownership');
  });
}

test('negative control reproduces original failure despite a valid cached session', async t => {
  const f = await fixture(t, catalog.runtime('codex-harness'), true);
  const handle = await f.open();
  assert.equal(f.sessionReady(), true);
  const result = await f.send(handle, 'Legacy callback shape');
  assert.equal(result.ok, false);
  assert.equal(result.reason, '请先登录 SoduWork');
  assert.equal(f.turns.length, 0);
});

test('a fresh auth module restores the stored device and deduplicates missing-session renewal', async t => {
  const f = await fixture(t, catalog.runtime('pi'));
  const original = f.localIdentity();
  f.restartAuth();
  assert.equal(f.sessionReady(), false);
  assert.equal(f.localIdentity().clientId, original.clientId);
  const results = await Promise.all(Array.from({ length: 7 }, () => f.identity()));
  assert.equal(f.enrollments(), 2);
  assert.equal(new Set(results.map(row => row.session)).size, 1);
  assert.ok(results.every(row => scope(row) === scope(results[0])));
});

test('renewal outage preserves the service error and never enters an adapter', async t => {
  const f = await fixture(t, catalog.runtime('codex-harness'));
  const handle = await f.open();
  f.expire();
  f.fail('Isolated Hub unavailable');
  const result = await f.send(handle, 'Must remain unsent');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Isolated Hub unavailable');
  assert.equal(f.turns.length, 0);
});

function holdNextResponse(suffix = '/clients/enroll') {
  const original = global.fetch;
  let reached, release, consumed = false;
  const entered = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  global.fetch = async (...args) => {
    const response = await original(...args);
    if (!consumed && String(args[0]).endsWith(suffix)) {
      consumed = true;
      reached();
      await gate; // The server has issued this response, but the client has not received it.
    }
    return response;
  };
  return { entered, release };
}

test('switching Hub during renewal rejects the pending IPC send and cannot refill the old cache', async t => {
  const f = await fixture(t, catalog.runtime('codex-harness'));
  const handle = await f.open(), originalHub = f.localIdentity().hub;
  f.expire();
  const held = holdNextResponse(), sent = f.send(handle, 'Do not cross environments');
  try {
    await held.entered;
    assert.equal(f.selectHub('http://127.0.0.1:19').ok, true);
    assert.equal(f.localIdentity(), null);
  } finally { held.release(); }
  const rejected = await sent;
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /账号或服务已变化/);
  assert.equal(f.sessionFor(originalHub), '');
  assert.equal(f.turns.length, 0);
});

test('switching away and back starts a new coalesced renewal; old finally cannot delete the newer request', async t => {
  const f = await fixture(t, catalog.runtime('pi')), originalHub = f.localIdentity().hub;
  f.expire();
  const old = holdNextResponse(), oldIdentity = f.identity().then(() => null, error => error);
  await old.entered;
  f.selectHub('http://127.0.0.1:19'); f.selectHub(originalHub);
  const next = holdNextResponse(), fresh = Array.from({ length: 7 }, () => f.identity());
  try {
    await next.entered;
    old.release();
    assert.match((await oldIdentity).message, /账号或服务已变化/);
    const late = f.identity();
    assert.equal(f.enrollments(), 3, 'old request plus exactly one new request after initial enrollment');
    next.release();
    const identities = await Promise.all([...fresh, late]);
    assert.equal(f.enrollments(), 3);
    assert.equal(new Set(identities.map(row => row.session)).size, 1);
    assert.equal(f.sessionReady(), true);
  } finally { old.release(); next.release(); }
});

test('successful logout invalidates an already-issued renewal before it can resume a send', async t => {
  const f = await fixture(t, catalog.runtime('codex-harness')), handle = await f.open();
  f.expire();
  const held = holdNextResponse(), sent = f.send(handle, 'Do not send after logout');
  try {
    await held.entered;
    assert.equal((await f.logout()).ok, true);
    assert.equal(f.sessionReady(), false);
  } finally { held.release(); }
  const rejected = await sent;
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /账号或服务已变化/);
  assert.equal(f.sessionReady(), false, 'late enrollment cannot restore the logged-out session');
  assert.equal(f.turns.length, 0);
});

test('same-device login cannot be overwritten by the previous account renewal', async t => {
  const f = await fixture(t, catalog.runtime('codex-harness')), handle = await f.open();
  const previousOwner = scope(await f.identity());
  f.expire();
  const held = holdNextResponse(), sent = f.send(handle, 'Do not send from previous account');
  let ownerAfterLogin;
  try {
    await held.entered;
    assert.equal((await f.login()).ok, true);
    ownerAfterLogin = scope(await f.identity());
    assert.notEqual(ownerAfterLogin, previousOwner);
  } finally { held.release(); }
  assert.equal((await sent).ok, false);
  assert.equal(scope(await f.identity()), ownerAfterLogin, 'late old response cannot replace the new account');
  assert.equal((await f.send(handle, 'Wrong historical owner')).ok, false);
  assert.equal(f.turns.length, 0);
  assert.equal((await f.send(await f.open(), 'New account own conversation')).ok, true);
});

for (const action of ['login', 'logout']) test(action + ' in flight blocks cached sends until its account transition settles', async t => {
  const f = await fixture(t, catalog.runtime('pi')), handle = await f.open();
  const held = holdNextResponse('/client-auth/' + action), changed = f[action]();
  try {
    await held.entered;
    assert.equal(f.sessionReady(), false, 'an intermediate pre-login enrollment is not cached');
    const rejected = await f.send(handle, 'Must wait for account transition');
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /账号或服务已变化/);
    assert.equal(f.turns.length, 0);
  } finally { held.release(); }
  assert.equal((await changed).ok, true);
});

test('clearing a session also invalidates the cached-identity microtask without an enrollment request', async t => {
  const f = await fixture(t, catalog.runtime('pi'));
  const pending = f.identity();
  f.clear();
  await assert.rejects(pending, /账号或服务已变化/);
  assert.equal(f.enrollments(), 1);
  assert.equal(f.sessionReady(), false);
});
