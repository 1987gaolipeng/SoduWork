'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CAPABILITIES,
  RuntimeContractError,
  AgentRuntimeRegistry,
  RuntimeEventJournal,
  createEventFactory,
  createPiRuntimeAdapter,
  createCordisRuntimePlugin,
  startCordisHost,
} = require('./index');

function fakeSession(id) {
  return {
    id,
    send() { return { accepted: true }; },
    subscribe() { return () => {}; },
    snapshot() { return { status: 'idle' }; },
    dispose() {},
  };
}

test('chat, goal and task acquire the exact same adapter instance', () => {
  const registry = new AgentRuntimeRegistry();
  const adapter = {
    id: 'test-runtime', displayName: 'Test Runtime', version: '1', capabilities: [],
    async detect() { return { ok: true }; },
    async createSession(request) { return fakeSession('session-' + request.consumer); },
  };
  registry.register(adapter);
  assert.equal(registry.acquire('test-runtime', 'chat').adapter, adapter);
  assert.equal(registry.acquire('test-runtime', 'goal').adapter, adapter);
  assert.equal(registry.acquire('test-runtime', 'task').adapter, adapter);
});

test('registration is unique and its disposer is reversible', () => {
  const registry = new AgentRuntimeRegistry();
  const adapter = {
    id: 'unique', displayName: 'Unique', capabilities: [],
    detect() {}, createSession() { return fakeSession('one'); },
  };
  const dispose = registry.register(adapter);
  assert.throws(() => registry.register(adapter), (error) =>
    error instanceof RuntimeContractError && error.code === 'DUPLICATE_ADAPTER');
  assert.equal(dispose(), true);
  assert.equal(dispose(), false);
  assert.equal(registry.get('unique'), null);
});

test('a claimed capability must have its normalized implementation', async () => {
  const registry = new AgentRuntimeRegistry();
  registry.register({
    id: 'invalid-session', displayName: 'Invalid Session',
    capabilities: [CAPABILITIES.TURN_CANCEL],
    detect() {}, createSession() { return fakeSession('missing-cancel'); },
  });
  await assert.rejects(
    registry.createSession({ adapterId: 'invalid-session', consumer: 'chat' }),
    (error) => error instanceof RuntimeContractError && error.code === 'MISSING_METHOD');
});

test('runtime event journal rejects replay and out-of-order delivery', () => {
  const factory = createEventFactory({
    adapterId: 'pi', sessionId: 's1',
    clock: () => new Date('2026-08-23T00:00:00.000Z'),
  });
  const first = factory('turn.started', { text: 'one' });
  const second = factory('turn.completed', { text: 'two' }, {
    native: { namespace: 'pi', type: 'turn-finished', payload: { kept: true } },
  });
  const journal = new RuntimeEventJournal();
  assert.equal(journal.append(first), first);
  assert.equal(journal.append(second), second);
  assert.deepEqual(second.native.payload, { kept: true });
  assert.equal(journal.cursor('pi', 's1'), 2);
  assert.throws(() => journal.append(second), (error) => error.code === 'DUPLICATE_EVENT');
  assert.throws(() => new RuntimeEventJournal().append({ ...second, sequence: 0 }),
    (error) => error.code === 'INVALID_EVENT_SEQUENCE');
  assert.throws(() => new RuntimeEventJournal().append({ ...second, id: 'gap', sequence: 2 }),
    (error) => error.code === 'EVENT_GAP');
});

function fakePiHandle() {
  const listeners = new Set();
  const calls = [];
  const handle = {
    sessionId: 'pi-session-1',
    calls,
    submit(text, attachments, options) {
      calls.push(['submit', text, attachments, options]);
      return { accepted: true, queued: true, queueId: 'q1', position: 1,
        completion: Promise.resolve({ ok: true }) };
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(touched, snapshot) { listeners.forEach((listener) => listener(touched, snapshot)); },
    snapshot() {
      return { status: 'idle', messages: [], tools: [], execution: { queued: 0 } };
    },
    inFlight() { return false; },
    cancel() { calls.push(['cancel']); return { ok: true }; },
    outputs() { return { files: [{ name: 'report.docx' }] }; },
    answerUi(value) { calls.push(['answerUi', value]); return { ok: true }; },
    continueGoal() { calls.push(['continueGoal']); return { ok: true }; },
    pauseGoal() { calls.push(['pauseGoal']); return { ok: true }; },
    disableGoal() { calls.push(['disableGoal']); return { ok: true }; },
    cancelQueued(id) { calls.push(['cancelQueued', id]); return { ok: true }; },
    goalView() { return { mode: 'goal' }; },
    historyRow() { return { id: 'pi-session-1' }; },
    status() { return 'idle'; },
    close() { calls.push(['close']); },
  };
  return handle;
}

test('Pi adapter preserves native controls while exposing the common contract', async () => {
  const opened = [];
  const handle = fakePiHandle();
  const module = {
    probe(app) { return { ok: true, app }; },
    async open(options) { opened.push(options); return { ok: true, session: handle }; },
  };
  const adapter = createPiRuntimeAdapter({ sessionModule: module, app: 'electron-app' });
  const session = await adapter.createSession({
    runtimeId: 'desktop-1', mode: 'goal', consumer: 'goal',
    workspace: { path: 'C:/work' },
    goal: { objective: '完成产品', acceptance: ['可运行', '有验证'] },
    native: { pi: { openOptions: { thinkingLevel: 'high', piOnly: true } } },
  });
  assert.equal(opened[0].app, 'electron-app');
  assert.equal(opened[0].cwd, 'C:/work');
  assert.equal(opened[0].goal, '完成产品');
  assert.equal(opened[0].acceptance, '可运行\n有验证');
  assert.equal(opened[0].piOnly, true);
  assert.equal(session.native.namespace, 'pi');
  assert(session.native.operations.includes('continueGoal'));

  const events = [];
  session.subscribe((event) => events.push(event));
  handle.emit({ kind: 'turn-queued', queueId: 'q1', piOnlyFact: 7 }, {
    status: 'idle', messages: [], tools: [],
    execution: {
      configured: true, visible: true, active: false, paused: true,
      limitRequest: { kind: 'steps', reason: 'step limit', used: 30, limit: 30 },
      quality: { required: true, phase: 'paused', reason: 'step limit', rounds: 2 },
      harness: {
        runId: 'goal-runtime-1', node: 'verify', phase: 'verify', state: 'paused',
        revision: 9, iteration: 3,
        phases: [{ key: 'verify', label: 'Verify', state: 'paused' }],
        tasks: [{ key: 'tests', label: 'Run tests', status: 'failed', attempts: 2 }],
        progress: [{ id: 'p1', type: 'verification.failed', summary: 'one gap' }],
      },
    },
  });
  assert.equal(events[0].type, 'turn.queued');
  assert.equal(events[0].turnId, 'q1');
  assert.equal(events[0].native.namespace, 'pi');
  assert.equal(events[0].native.payload.piOnlyFact, 7);
  const normalized = events[0].payload.snapshot.execution;
  assert.equal(normalized.configured, true);
  assert.equal(normalized.limitRequest.kind, 'steps');
  assert.equal(normalized.quality.rounds, 2);
  assert.equal(normalized.harness.runId, 'goal-runtime-1');
  assert.equal(normalized.harness.revision, 9);
  assert.equal(normalized.harness.phases[0].state, 'paused');
  assert.equal(normalized.harness.tasks[0].id, 'tests');
  assert.equal(normalized.harness.progress[0].summary, 'one gap');
  handle.emit({ kind: 'turn-finished' }, {
    status: 'unreachable', messages: [], tools: [], execution: {},
  });
  assert.equal(events[1].type, 'turn.failed');

  const sent = session.send({ text: '继续', attachments: [{ name: 'a.png' }] });
  assert.equal(sent.accepted, true);
  assert.equal(sent.queued, true);
  assert.equal(sent.queueId, 'q1');
  assert.deepEqual(await sent.completion, { ok: true });
  assert.deepEqual(session.artifacts(), { files: [{ name: 'report.docx' }] });
  assert.deepEqual(session.controlGoal('continue'), { ok: true });
  assert.deepEqual(session.invokeNative('cancelQueued', 'q1'), { ok: true });
  await session.dispose();
  assert(handle.calls.some((item) => item[0] === 'close'));
});

test('Pi resume requires explicit durable state', async () => {
  const module = {
    probe() { return { ok: true }; },
    async open() { return { ok: true, session: fakePiHandle() }; },
  };
  const adapter = createPiRuntimeAdapter({ sessionModule: module });
  await assert.rejects(adapter.resumeSession({}),
    (error) => error.code === 'RESUME_STATE_REQUIRED');
});

test('Pi adapter waits for remote admission without waiting for execution completion', async () => {
  let admit, complete;
  const admission = new Promise(resolve => { admit = resolve; });
  const completion = new Promise(resolve => { complete = resolve; });
  const handle = fakePiHandle(); handle.submit = () => admission;
  const adapter = createPiRuntimeAdapter({ sessionModule: {
    probe: () => ({ ok: true }), open: async () => ({ ok: true, session: handle }),
  } });
  const session = await adapter.createSession({});
  const pending = session.send('remote turn'); let admitted = false;
  pending.then(() => { admitted = true; });
  await Promise.resolve(); assert.equal(admitted, false);
  admit({ accepted: true, queued: true, queueId: 'remote-queue', position: 2, completion });
  const result = await pending;
  assert.equal(result.accepted, true); assert.equal(result.queued, true);
  assert.equal(result.queueId, 'remote-queue'); assert.equal(result.position, 2);
  let finished = false; result.completion.then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  complete({ ok: true }); assert.deepEqual(await result.completion, { ok: true });
  handle.submit = async () => ({ accepted: false, result: { ok: false, reason: 'remote queue refused' } });
  const rejected = await session.send('rejected');
  assert.equal(rejected.accepted, false); assert.equal(rejected.result.reason, 'remote queue refused');
  await session.dispose();
});

test('Pi tool-permission changes expose requested and resolved approval events', async () => {
  const handle = fakePiHandle();
  const adapter = createPiRuntimeAdapter({ sessionModule: { probe: () => ({ ok: true }),
    open: async () => ({ ok: true, session: handle }) } });
  const session = await adapter.createSession({}), events = [];
  session.subscribe(event => events.push(event));
  handle.emit({ kind: 'permission' }, { status: 'waiting-user', pendingUi: { requestId: 'permission-one' },
    pendingPermissions: [{ requestId: 'permission-one' }], execution: {} });
  handle.emit({ kind: 'permission' }, { status: 'streaming', pendingPermissions: [], execution: {} });
  assert.deepEqual(events.map(event => event.type), ['approval.requested', 'approval.resolved']);
  assert.equal(events[0].payload.snapshot.status, 'waiting');
  await session.dispose();
});

test('Cordis plugin owns only assembly and unwinds its service', () => {
  const registry = new AgentRuntimeRegistry();
  const plugin = createCordisRuntimePlugin(registry);
  const context = {};
  const dispose = plugin.apply(context);
  assert.equal(plugin.provide[0], 'soduWorkAgentRuntime');
  assert.equal(context.soduWorkAgentRuntime, registry);
  dispose();
  assert.equal('soduWorkAgentRuntime' in context, false);
});

test('Cordis host can be loaded behind the stable runtime contract', async () => {
  class FakeContext {
    plugin(plugin) {
      const cleanup = plugin.apply(this);
      return {
        then(resolve) { return Promise.resolve().then(() => resolve()); },
        async dispose() { cleanup(); },
      };
    }
  }
  const host = await startCordisHost({ loadCordis: async () => ({ Context: FakeContext }) });
  assert.equal(host.context.soduWorkAgentRuntime, host.registry);
  assert.equal(await host.dispose(), true);
  assert.equal(await host.dispose(), false);
});
