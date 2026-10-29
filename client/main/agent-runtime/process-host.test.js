'use strict';

// Real RPC codec and asynchronous transport; the fake child and injected tree
// guard cannot start, signal or inspect any operating-system process.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path'), os = require('node:os');
const { createRpcPeer } = require('./process-rpc');
const { createProcessHost, environment } = require('./process-host');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
async function until(check, label, timeout = 1500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await wait(2); }
  throw Error('Host fixture timed out: ' + label);
}
class RemoteSession { constructor(ref) { this.ref = ref; } }

function fixture(t, options = {}) {
  const child = new EventEmitter(); child.pid = options.spawnPidPending ? undefined : 410009;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const wire = [], receivedIdentities = [], auths = [], errors = [], operations = [], projections = new Map();
  const app = { isPackaged: false, getPath: name => path.join(os.tmpdir(), 'soduwork-host-fixture', name),
    getAppPath: () => path.resolve(__dirname, '../..'), getVersion: () => '1.12.94' };
  let spawns = 0, treeStarts = 0, treeStops = 0, kills = 0, spawnOptions;
  let currentIdentity = { hub: 'https://isolated-hub.example', clientId: 'isolated-device',
    secret: 'host-private-device-secret', session: 'session-0' };
  function projection(ref, revision) {
    const next = revision || (projections.get(ref) || 0) + 1; projections.set(ref, next);
    return { ref, revision: next,
      data: { properties: { ref, sessionId: 'native-' + ref, adapterId: 'pi', cwd: '/isolated/workspace' },
        model: { id: 'fixture-model' }, status: 'idle', inFlight: false,
        state: { status: 'idle', execution: { running: false, queue: [] } },
        history: { id: 'native-' + ref, title: 'Isolated conversation', count: 1 }, goal: {}, resumePath: '' },
      messages: { length: 1, changed: [[0, { role: 'user', blocks: [{ kind: 'text', text: 'Original requirement' }] }]] },
      tools: { length: 0, changed: [] }, event: null };
  }
  let remote;
  remote = createRpcPeer({ timeoutMs: 1000, callbackTimeoutMs: 0,
    send(packet) { const copy = structuredClone(packet); wire.push({ direction: 'worker-host', packet: copy });
      setImmediate(() => child.emit('message', copy)); },
    encodeSpecial: value => value instanceof RemoteSession
      ? { tag: 'soduwork.session', data: { ref: value.ref, projection: projection(value.ref) } } : undefined,
    decodeSpecial(tag, data) {
      if (tag === 'soduwork.app') return data;
      if (tag === 'soduwork.identity') { receivedIdentities.push(data); return data; }
      if (tag === 'soduwork.session') return new RemoteSession(data.ref);
      throw Error('Unsupported fixture capability');
    },
    onError: error => errors.push(error),
    handlers: {
      initialize: () => { operations.push('initialize');
        return options.initializeGate ? options.initializeGate.promise : { pid: child.pid, node: process.versions.node }; },
      shutdown: () => { operations.push('shutdown'); return true; },
      echo: value => value,
      inspectIdentity: value => ({ ...value }),
      async renew(identity) { return remote.call('ensureSession', [identity.id]); },
      open: opts => ({ ok: true, session: new RemoteSession(opts.ref || 'fixture-session') }),
      session: (_ref, method) => { operations.push(method); return { ok: true }; },
      property: () => { operations.push('property'); return true; },
      ...options.handlers,
    } });
  child.postMessage = packet => {
    const copy = structuredClone(packet); wire.push({ direction: 'host-worker', packet: copy });
    setImmediate(() => remote.receive(copy));
  };
  child.kill = () => { kills++; return true; };
  const host = createProcessHost(app, {
    spawn: async (_entry, config) => { spawns++; spawnOptions = config;
      if (options.spawnGate) await options.spawnGate.promise; return child; },
    treeFactory: ({ pid }) => {
      assert.equal(pid, 410009, 'fixture must never receive a real operating-system PID');
      return { start: async () => { treeStarts++;
        return options.treeStartGate ? options.treeStartGate.promise : { rootFound: true, tracked: 1 }; },
        stop: async () => { treeStops++; if (options.cleanup) return options.cleanup(treeStops);
          if (options.cleanupGate) return options.cleanupGate.promise; return { terminated: [] }; } };
    },
    authFactory: ({ identity }) => {
      const entry = { identity: { ...identity }, closed: 0,
        publicIdentity: () => ({ hub: identity.hub, clientId: identity.clientId, session: currentIdentity.session }),
        ensureSession: async () => currentIdentity.session,
        request: async () => ({ status: 200, statusText: 'OK', headers: [], body: new Uint8Array() }),
        close() { entry.closed++; } };
      auths.push(entry); return entry;
    }, onError: error => errors.push(error), stallTimeoutMs: options.stallTimeoutMs || 45000,
    ...(options.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
  });
  t.after(async () => {
    options.spawnGate?.resolve(); options.treeStartGate?.resolve({ rootFound: true, tracked: 1 });
    options.initializeGate?.resolve({ pid: child.pid, node: process.versions.node });
    options.cleanupGate?.resolve({ terminated: [] });
    await host.stop().catch(() => {});
    remote.close(); child.removeAllListeners();
  });
  return { host, remote, child, wire, operations, receivedIdentities, auths, errors, projection,
    get spawns() { return spawns; }, get treeStarts() { return treeStarts; }, get treeStops() { return treeStops; },
    get kills() { return kills; }, get spawnOptions() { return spawnOptions; },
    get identity() { return currentIdentity; }, set identity(value) { currentIdentity = value; } };
}

test('runtime retains Windows program directories for shell discovery without forwarding similarly named secrets', t => {
  const values = { ProgramFiles: 'C:\\runtime-fixture\\program64',
    'ProgramFiles(x86)': 'C:\\runtime-fixture\\program32', ProgramFiles_SECRET: 'private-fixture-secret' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const env = environment();
  const envValue = name => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())];
  assert.equal(envValue('ProgramFiles'), values.ProgramFiles);
  assert.equal(envValue('ProgramFiles(x86)'), values['ProgramFiles(x86)']);
  assert.equal(env.ProgramFiles_SECRET, undefined);
  const candidates = require('../pi-session/shell-runtime').candidates({ env, platform: 'win32', resourceRoot: '' });
  assert.ok(candidates.some(row => row.source === 'system-git' && row.shellPath === path.join(values.ProgramFiles, 'Git', 'bin', 'bash.exe')));
  assert.ok(candidates.some(row => row.source === 'system-git' && row.shellPath === path.join(values['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe')));
});

test('trusted identities use the flat capability codec and never send long-lived secrets or private environment', async t => {
  const previous = process.env.SODUWORK_TEST_PRIVATE;
  process.env.SODUWORK_TEST_PRIVATE = 'private-process-env-fixture';
  t.after(() => { if (previous === undefined) delete process.env.SODUWORK_TEST_PRIVATE;
    else process.env.SODUWORK_TEST_PRIVATE = previous; });
  const f = fixture(t);
  const restored = await f.host.call('inspectIdentity', [{ ...f.identity }]);
  const decoded = f.receivedIdentities[0];
  assert.deepEqual(Object.keys(decoded).sort(), ['clientId', 'hub', 'id', 'session']);
  assert.equal(decoded.hub, f.identity.hub); assert.equal(decoded.clientId, f.identity.clientId);
  assert.equal(decoded.session, 'session-0'); assert.equal(restored.hub, f.identity.hub);
  assert.equal(decoded.identity, undefined, 'nested identity envelopes would hide the trusted provenance fields');
  assert.equal(JSON.stringify(f.wire).includes('host-private-device-secret'), false);
  assert.equal(f.spawnOptions.env.SODUWORK_TEST_PRIVATE, undefined);
  assert.equal(JSON.stringify(f.spawnOptions.env).includes('private-process-env-fixture'), false);
  assert.equal(f.spawnOptions.env.NODE_OPTIONS, undefined);
  assert.equal(f.spawnOptions.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(f.spawns, 1); assert.equal(f.treeStarts, 1);
});

test('renewed identity objects for the same Hub and device reuse their trusted auth capability', async t => {
  const f = fixture(t);
  for (let index = 0; index < 60; index++) {
    f.identity = { ...f.identity, session: 'renewed-session-' + index };
    assert.equal(await f.host.call('renew', [{ ...f.identity }]), f.identity.session);
  }
  assert.equal(f.auths.length, 1); assert.equal(f.host.diagnostics().auths, 1);
  assert.equal(new Set(f.receivedIdentities.map(value => value.id)).size, 1);
  assert.equal(f.host.diagnostics().rpc.exported, 0);
});

test('aborting a command forwards cancellation once without replaying it or replacing the runtime', async t => {
  let executions = 0, aborts = 0;
  const f = fixture(t, { handlers: { operate() {
    executions++;
    return new Promise((_, reject) => this.signal.addEventListener('abort', () => {
      aborts++; reject(this.signal.reason);
    }, { once: true }));
  } } });
  const controller = new AbortController();
  const pending = f.host.call('operate', [], { signal: controller.signal, timeoutMs: 1000 });
  await until(() => executions === 1, 'operation accepted');
  controller.abort(); await assert.rejects(pending, { code: 'RPC_ABORTED' });
  await until(() => aborts === 1, 'remote cancellation');
  assert.equal(executions, 1); assert.equal(f.spawns, 1); assert.equal(f.host.isDead(), false);
  assert.equal(f.treeStops, 0);
});

test('a timed-out admission stops the runtime instead of automatically resubmitting an uncertain operation', async t => {
  let executions = 0;
  const f = fixture(t, { handlers: { operate() { executions++; return new Promise(() => {}); } } });
  await assert.rejects(f.host.call('operate', [], { timeoutMs: 20 }), { code: 'RPC_TIMEOUT' });
  assert.equal(executions, 1); assert.equal(f.host.isDead(), true); assert.equal(f.treeStops, 1);
  await assert.rejects(f.host.call('operate'), { code: 'RUNTIME_PROCESS_GONE' });
  assert.equal(executions, 1); assert.equal(f.spawns, 1);
});

test('an out-of-order projection freezes the accepted handle and immediately shuts down its host', async t => {
  const gate = deferred(), f = fixture(t, { cleanupGate: gate });
  const opened = await f.host.call('open', [{ ref: 'ordered-session' }]);
  assert.equal(opened.session.snapshot().messages[0].blocks[0].text, 'Original requirement');
  const bad = f.projection('ordered-session', 3); bad.messages.changed[0][1].blocks[0].text = 'Unaccepted rewrite';
  f.remote.notify('projection', [bad]);
  await until(() => f.host.isDead(), 'projection failure closes host');
  const snapshot = opened.session.snapshot();
  assert.equal(snapshot.runtimeUnavailable, true);
  assert.equal(snapshot.messages[0].blocks[0].text, 'Original requirement');
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleaning');
  gate.resolve(); await f.host.stop(); assert.deepEqual(f.host.maintenanceWorkloads(), []);
});

test('a crashed host remains a maintenance blocker until observed process cleanup actually settles', async t => {
  const gate = deferred(), f = fixture(t, { cleanupGate: gate }); await f.host.start();
  f.child.emit('exit', 1, null);
  assert.equal(f.host.isDead(), true);
  let blockers = f.host.maintenanceWorkloads(); assert.equal(blockers.length, 1);
  assert.equal(blockers[0].status, 'cleaning'); assert.equal(blockers[0].canStop, false);
  assert.equal(blockers[0].ref, 'runtime-cleanup:' + f.host.diagnostics().generation);
  await turn(); assert.equal(f.treeStops, 1);
  assert.equal(f.host.maintenanceWorkloads().length, 1);
  gate.resolve(); await f.host.stop(); blockers = f.host.maintenanceWorkloads();
  assert.deepEqual(blockers, []); assert.equal(f.treeStops, 1);
});

test('failed process cleanup remains visible and cannot be converted into successful disposal', async t => {
  const gate = deferred(), f = fixture(t, { cleanupGate: gate }); await f.host.start();
  f.child.emit('exit', 1, null); gate.reject(Error('Isolated cleanup could not be confirmed'));
  await assert.rejects(f.host.stop(), /could not be confirmed/);
  const blocker = f.host.maintenanceWorkloads()[0];
  assert.equal(blocker.status, 'cleanup-failed'); assert.equal(blocker.canStop, false);
  await assert.rejects(f.host.stop(), /could not be confirmed/);
  assert.equal(f.treeStops, 2, 'retry must verify again rather than reuse a failed promise');
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleanup-failed');
  assert.ok(f.errors.length > 0);
});

test('an accepted host callback still finishing after worker loss keeps maintenance blocked without replay', async t => {
  const completion = deferred(); let executions = 0;
  const f = fixture(t, { handlers: { begin: callback => ({ accepted: true, completion: callback() }) } });
  const accepted = await f.host.call('begin', [async () => { executions++; return completion.promise; }]);
  const outcome = accepted.completion.then(value => ({ value }), error => ({ error }));
  try {
    await until(() => executions === 1, 'host callback started');
    f.child.emit('exit', 1, null); await f.host.stop();
    assert.ok((await outcome).error);
    const blocker = f.host.maintenanceWorkloads()[0];
    assert.equal(blocker.status, 'cleaning'); assert.match(blocker.reason, /收尾/);
    assert.equal(f.treeStops, 1); assert.equal(executions, 1);
    completion.resolve({ ok: true, receipt: 'confirmed-after-disconnect' });
    await until(() => f.host.maintenanceWorkloads().length === 0, 'actual callback settlement');
    assert.equal(executions, 1, 'settling cleanup never replays a host side effect');
  } finally { completion.resolve({ ok: true }); }
});

test('completed turn callback capabilities return to their baseline over many turns', async t => {
  let effects = 0;
  const f = fixture(t, { handlers: { turn: async value => {
    await value.beforeTurn(); return { accepted: true, completion: Promise.resolve({ ok: true }) };
  } } });
  for (let index = 0; index < 80; index++) {
    const accepted = await f.host.call('turn', [{ beforeTurn: () => { effects++; } }]);
    assert.deepEqual(await accepted.completion, { ok: true });
    await until(() => f.host.diagnostics().capabilities === 0 && f.host.diagnostics().rpc.exported === 0 &&
      f.remote.stats().functions === 0, 'turn capabilities released');
  }
  assert.equal(effects, 80); assert.equal(f.spawns, 1);
});

test('session close and property replacement release session-owned callback capabilities', async t => {
  const f = fixture(t);
  const opened = await f.host.call('open', [{ ref: 'capability-session', resolveSkills: async () => ({ items: [] }) }]);
  assert.equal(f.host.diagnostics().capabilities, 1);
  for (let index = 0; index < 12; index++) {
    opened.session.captureDelivery = async () => ({ index });
    await until(() => f.operations.filter(value => value === 'property').length === index + 1 &&
      f.host.diagnostics().capabilities === 2, 'property replacement acknowledged');
  }
  await opened.session.close();
  await until(() => f.host.diagnostics().capabilities === 0 && f.host.diagnostics().rpc.exported === 0 &&
    f.remote.stats().functions === 0, 'closed session capabilities released');
  assert.equal(f.host.handles.size, 0);
});

test('permanently pending cleanup rejects bounded disposal while continuing to block maintenance', async t => {
  const gate = deferred(), f = fixture(t, { cleanupGate: gate, cleanupTimeoutMs: 20 });
  await f.host.start();
  const stopped = f.host.stop().then(value => ({ value }), error => ({ error }));
  let timer;
  const outcome = await Promise.race([stopped, new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), 500);
  })]).finally(() => clearTimeout(timer));
  assert.equal(outcome.timedOut, undefined, 'a never-settling tree guard cannot hold application disposal indefinitely');
  assert.equal(outcome.error?.code, 'RUNTIME_CLEANUP_TIMEOUT');
  assert.equal(f.host.isDead(), true); assert.equal(f.treeStops, 1);
  const blocker = f.host.maintenanceWorkloads()[0];
  assert.equal(blocker.status, 'cleanup-failed'); assert.equal(blocker.canStop, false);
  await wait(30);
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleanup-failed', 'a timeout is not confirmation of process exit');
  await assert.rejects(f.host.stop(), { code: 'RUNTIME_CLEANUP_TIMEOUT' });
  await assert.rejects(f.host.call('echo', ['never replay']), { code: 'RUNTIME_PROCESS_GONE' });
  assert.equal(f.treeStops, 1); assert.equal(f.spawns, 1);
  // The fixture teardown releases its gate; while the assertion ran, no
  // process-exit acknowledgement existed and maintenance stayed blocked.
});

test('late verified cleanup clears a prior timeout blocker without retrying termination or execution', async t => {
  const gate = deferred(), f = fixture(t, { cleanupGate: gate, cleanupTimeoutMs: 20 });
  await f.host.start(); f.child.emit('exit', 1, null);
  let timer;
  const outcome = await Promise.race([
    f.host.stop().then(value => ({ value }), error => ({ error })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 500); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(outcome.error?.code, 'RUNTIME_CLEANUP_TIMEOUT');
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleanup-failed');
  gate.resolve({ terminated: [410009], remaining: [] });
  await until(() => f.host.maintenanceWorkloads().length === 0, 'late confirmed resource cleanup');
  assert.equal(f.treeStops, 1); assert.equal(f.spawns, 1);
  assert.equal(f.host.isDead(), true, 'verified cleanup cannot resurrect the old runtime');
});

test('late cleanup failure preserves the timeout maintenance blocker', async t => {
  const gate = deferred(), f = fixture(t, { cleanupGate: gate, cleanupTimeoutMs: 20 });
  await f.host.start();
  let timer;
  const outcome = await Promise.race([
    f.host.stop().then(value => ({ value }), error => ({ error })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 500); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(outcome.error?.code, 'RUNTIME_CLEANUP_TIMEOUT');
  gate.reject(Error('Late process exit verification failed'));
  await turn();
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleanup-failed');
  assert.equal(f.treeStops, 1);
});

test('settled cleanup failure can be retried without spawning or overlapping recovery', async t => {
  const retryGate = deferred();
  const f = fixture(t, { cleanup: attempt => {
    if (attempt === 1) throw Error('Temporary process snapshot unavailable');
    return retryGate.promise;
  } });
  await f.host.start();
  await assert.rejects(f.host.stop(), /Temporary process snapshot/);
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleanup-failed');
  const retries = [f.host.stop(), f.host.stop(), f.host.stop()];
  await until(() => f.treeStops === 2, 'fresh cleanup verification');
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleaning');
  await assert.rejects(f.host.start(), { code: 'RUNTIME_PROCESS_GONE' });
  retryGate.resolve({ terminated: [410009], remaining: [] });
  await Promise.all(retries);
  assert.equal(f.treeStops, 2); assert.equal(f.spawns, 1);
  assert.deepEqual(f.host.maintenanceWorkloads(), []);
  await f.host.stop(); assert.equal(f.treeStops, 2);
});

test('explicit cleanup retry refreshes failed evidence and shares one in-flight attempt', async t => {
  const gate = deferred(), options = { cleanupGate: gate }, f = fixture(t, options);
  await f.host.start(); f.child.emit('exit', 1, null);
  gate.reject(Error('temporary process snapshot failure'));
  await assert.rejects(f.host.stop(), /temporary process snapshot failure/);
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleanup-failed');
  const recovered = deferred(); options.cleanupGate = recovered;
  const retries = [f.host.retryCleanup(), f.host.retryCleanup()];
  await turn();
  assert.equal(f.treeStops, 2);
  assert.equal(f.host.maintenanceWorkloads().length, 1);
  recovered.resolve({ terminated: [] }); await Promise.all(retries);
  assert.deepEqual(f.host.maintenanceWorkloads(), []);
  assert.equal(f.host.isDead(), true);
  assert.equal(f.spawns, 1, 'cleanup cannot replay execution or revive the old host');
});

test('cleanup retry cannot overlap an operation still running after its deadline', async t => {
  const gate = deferred(), f = fixture(t, { cleanupGate: gate, cleanupTimeoutMs: 20 });
  await f.host.start(); f.child.emit('exit', 1, null);
  await assert.rejects(f.host.stop(), { code: 'RUNTIME_CLEANUP_TIMEOUT' });
  await assert.rejects(f.host.retryCleanup(), { code: 'RUNTIME_CLEANUP_TIMEOUT' });
  assert.equal(f.treeStops, 1);
  assert.equal(f.host.maintenanceWorkloads().length, 1);
  gate.resolve(); await until(() => !f.host.maintenanceWorkloads().length, 'verified late cleanup');
});

test('stop during spawn waits for the late owned child and never initializes it', async t => {
  const spawnGate = deferred(), cleanupGate = deferred(), f = fixture(t, { spawnGate, cleanupGate });
  const opening = f.host.start().then(value => ({ value }), error => ({ error }));
  await until(() => f.spawns === 1, 'spawn request accepted');
  let stopped = false;
  const closing = f.host.stop().then(() => { stopped = true; });
  await turn();
  assert.equal(stopped, false); assert.equal(f.treeStops, 0);
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleaning');
  spawnGate.resolve();
  assert.equal((await opening).error?.code, 'RUNTIME_PROCESS_GONE');
  await until(() => f.treeStops === 1, 'late child identity cleanup');
  assert.equal(stopped, false); assert.equal(f.operations.includes('initialize'), false);
  assert.equal(f.host.diagnostics().initialized, false);
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleaning');
  cleanupGate.resolve({ terminated: [410009] }); await closing;
  assert.deepEqual(f.host.maintenanceWorkloads(), []);
  assert.equal(f.treeStarts, 1); assert.equal(f.treeStops, 1); assert.equal(f.kills, 0);
});

test('stop during the first identity snapshot waits for ownership and skips initialization', async t => {
  const treeStartGate = deferred(), f = fixture(t, { treeStartGate });
  const opening = f.host.start().then(value => ({ value }), error => ({ error }));
  await until(() => f.treeStarts === 1, 'first identity snapshot pending');
  const closing = f.host.stop(); await turn();
  assert.equal(f.treeStops, 0); assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleaning');
  treeStartGate.resolve({ rootFound: true, tracked: 1 });
  assert.equal((await opening).error?.code, 'RUNTIME_PROCESS_GONE'); await closing;
  assert.equal(f.treeStops, 1); assert.equal(f.operations.includes('initialize'), false);
  assert.equal(f.host.diagnostics().initialized, false); assert.equal(f.kills, 0);
});

test('stop while waiting for the utility spawn event reclaims the later published PID', async t => {
  const f = fixture(t, { spawnPidPending: true });
  const opening = f.host.start().then(value => ({ value }), error => ({ error }));
  await until(() => f.child.listenerCount('spawn') > 0, 'utility PID awaited');
  const closing = f.host.stop(); await turn();
  assert.equal(f.treeStarts, 0); assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleaning');
  f.child.pid = 410009; f.child.emit('spawn');
  assert.equal((await opening).error?.code, 'RUNTIME_PROCESS_GONE'); await closing;
  assert.equal(f.treeStarts, 1); assert.equal(f.treeStops, 1);
  assert.equal(f.operations.includes('initialize'), false); assert.equal(f.kills, 0);
});

test('a late initialize response cannot revive an already stopped host', async t => {
  const initializeGate = deferred(), cleanupGate = deferred(), f = fixture(t, { initializeGate, cleanupGate });
  const opening = f.host.start().then(value => ({ value }), error => ({ error }));
  await until(() => f.operations.includes('initialize'), 'initialize request accepted');
  const closing = f.host.stop();
  assert.equal((await opening).error?.code, 'RUNTIME_PROCESS_GONE');
  await until(() => f.treeStops === 1, 'started runtime cleanup');
  assert.equal(f.host.diagnostics().initialized, false); assert.equal(f.host.diagnostics().rpc.closed, true);
  initializeGate.resolve({ pid: 410009 }); await turn(); await turn();
  assert.equal(f.host.diagnostics().initialized, false); assert.equal(f.host.isDead(), true);
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleaning');
  cleanupGate.resolve(); await closing;
  await assert.rejects(f.host.start(), { code: 'RUNTIME_PROCESS_GONE' });
  assert.equal(f.spawns, 1); assert.equal(f.treeStops, 1);
});

test('spawn cleanup timeout remains blocked until a late child is actually registered and reclaimed', async t => {
  const spawnGate = deferred(), f = fixture(t, { spawnGate, cleanupTimeoutMs: 20 });
  const opening = f.host.start().then(value => ({ value }), error => ({ error }));
  await until(() => f.spawns === 1, 'delayed spawn');
  await assert.rejects(f.host.stop(), { code: 'RUNTIME_CLEANUP_TIMEOUT' });
  assert.equal(f.treeStarts, 0); assert.equal(f.treeStops, 0);
  assert.equal(f.host.maintenanceWorkloads()[0].status, 'cleanup-failed');
  spawnGate.resolve(); assert.equal((await opening).error?.code, 'RUNTIME_PROCESS_GONE');
  await until(() => f.treeStops === 1 && f.host.maintenanceWorkloads().length === 0, 'late child reclaimed');
  assert.equal(f.operations.includes('initialize'), false); assert.equal(f.kills, 0);
});

test('startup identity failure uses supervised cleanup rather than an unverified direct kill', async t => {
  const treeStartGate = deferred(), f = fixture(t, { treeStartGate });
  const opening = f.host.start();
  await until(() => f.treeStarts === 1, 'identity probe accepted');
  treeStartGate.reject(Error('Isolated identity snapshot failed'));
  await assert.rejects(opening, /identity snapshot failed/);
  await f.host.stop();
  assert.equal(f.treeStops, 1); assert.equal(f.kills, 0); assert.equal(f.operations.includes('initialize'), false);
});

test('an unobserved runtime identity cannot initialize execution or certify a startup', async t => {
  const treeStartGate = deferred(), f = fixture(t, { treeStartGate });
  const opening = f.host.start();
  await until(() => f.treeStarts === 1, 'initial identity probe');
  treeStartGate.resolve({ rootFound: false, tracked: 0 });
  await assert.rejects(opening, { code: 'RUNTIME_PROCESS_IDENTITY_UNAVAILABLE' });
  await f.host.stop();
  assert.equal(f.operations.includes('initialize'), false);
  assert.equal(f.kills, 0, 'unverified PIDs must not receive an unsupervised signal');
});

test('stopping an unused host prevents any future spawn', async t => {
  const f = fixture(t); await f.host.stop();
  await assert.rejects(f.host.start(), { code: 'RUNTIME_PROCESS_GONE' });
  assert.equal(f.spawns, 0); assert.equal(f.treeStarts, 0); assert.equal(f.treeStops, 0);
});

test('shutdown has a bounded acknowledgement wait and concurrent disposal attempts share one cleanup', { timeout: 7000 }, async t => {
  let shutdowns = 0;
  const f = fixture(t, { handlers: { shutdown() { shutdowns++; return new Promise(() => {}); } } });
  await f.host.start(); const started = Date.now();
  await Promise.all([f.host.stop(), f.host.stop(), f.host.stop()]);
  assert.ok(Date.now() - started < 5000, 'unresponsive shutdown cannot hold desktop disposal indefinitely');
  assert.equal(shutdowns, 1); assert.equal(f.treeStops, 1); assert.equal(f.host.isDead(), true);
  assert.equal(f.host.diagnostics().rpc.pending, 0); assert.deepEqual(f.host.maintenanceWorkloads(), []);
  await assert.rejects(f.host.call('echo', ['after disposal']), { code: 'RUNTIME_PROCESS_GONE' });
  assert.equal(f.spawns, 1);
});
