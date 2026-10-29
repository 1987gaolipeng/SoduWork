'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const memory = require('../main/conversation/session-memory');
const local = require('../main/conversation/local-memory');
const { scope } = require('../main/platform-connections/runtime.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-memory-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = { getPath: () => directory };
  let auth = identity('one'), current = { status: 'idle', messages: [] }, receive;
  const service = memory.install({ app, ipcMain: { handle() {} }, identityOf: async () => auth });
  const session = { sessionId: 'review-session', ui: {}, snapshot: () => current,
    subscribe: fn => { receive = fn; return () => {}; } };
  const attach = (resumed = false) => service.attach(session, auth, { ids: [], items: [], scopes: [] }, [], { resumed });
  return { directory, app, service, session, attach,
    setAuth: value => { auth = identity(value); },
    snapshot: value => { current = value; },
    event: value => receive(value),
    flush: () => session.ui.memorySubscription(),
    prompt: user => local.context({ app, owner: scope(identity(user)) }).prompt,
  };
}
const oldMessages = () => [
  { role: 'user', text: 'Prior account private goal', sentAt: 100 },
  { role: 'assistant', blocks: [{ kind: 'text', text: 'Prior account private outcome' }], done: true },
];

test('new sessions stamp empty-selection ownership; another account cannot backfill their old messages', async t => {
  const f = fixture(t);
  await f.attach();
  f.snapshot({ status: 'idle', messages: oldMessages() });
  f.event({ type: 'turn.completed' });
  await f.flush();
  assert.match(f.prompt('one'), /Prior account private outcome/);
  assert.throws(() => f.service.assertOwner(identity('two'), f.session.sessionId), /另一个账号/);
  f.setAuth('two');
  await f.attach(true);
  await f.flush();
  assert.equal(f.prompt('two'), '');
  // Reopening foreign local history itself remains possible. New work belongs
  // only to the new user, and must not copy even the original goal or title.
  await f.attach(true);
  f.event({ type: 'turn.started' });
  f.snapshot({ status: 'idle', messages: [...oldMessages(),
    { role: 'user', text: 'New account current goal', sentAt: 200 },
    { role: 'assistant', blocks: [{ kind: 'text', text: 'New account current outcome' }], done: true },
  ] });
  f.event({ type: 'turn.completed' });
  await f.flush();
  assert.match(f.prompt('two'), /New account current goal/);
  assert.match(f.prompt('two'), /New account current outcome/);
  assert.doesNotMatch(f.prompt('two'), /Prior account/);
  assert.match(f.prompt('one'), /Prior account private outcome/);
});

test('unknown-owner archives do not get silently claimed; only newly sent visible work is learned', async t => {
  const f = fixture(t);
  f.snapshot({ status: 'idle', messages: oldMessages() });
  await f.attach(true);
  f.event({ type: 'turn.completed' }); // A late event from old work proves no new user turn.
  await f.flush();
  assert.equal(f.prompt('one'), '');
  assert.equal(fs.existsSync(path.join(f.directory, 'session-memory-bindings')), false);
  await f.attach(true);
  f.event({ kind: 'turn-dequeued' });
  f.snapshot({ status: 'idle', messages: [...oldMessages(),
    { role: 'user', text: 'Prior account private goal', sentAt: 201 }, // repeated text, new actual turn
    { role: 'assistant', content: 'Current independently completed work', done: true },
  ] });
  f.event({ kind: 'turn-finished' });
  await f.flush();
  assert.match(f.prompt('one'), /Current independently completed work/);
  assert.doesNotMatch(f.prompt('one'), /Prior account private outcome/);
});

test('verified same-account history remains eligible for completion backfill and does not need selected memories', async t => {
  const f = fixture(t);
  await f.attach();
  await f.flush();
  f.snapshot({ status: 'idle', messages: oldMessages() });
  await f.attach(true);
  await f.flush();
  assert.match(f.prompt('one'), /Prior account private outcome/);
});

test('idle presentation is insufficient: paused, incomplete, stopped, error and pending handoff never become completed work', () => {
  const messages = [{ role: 'user', text: 'Task' },
    { role: 'assistant', blocks: [{ kind: 'text', text: 'Only a partial attempt' }], done: true }];
  for (const patch of [
    { execution: { paused: true } }, { execution: { stopped: true } },
    { execution: { running: true } },
    { execution: { limitRequest: { kind: 'budget' } } },
    { execution: { quality: { phase: 'blocked' } } },
    { execution: { harness: { state: 'paused' } } },
    { completion: { incomplete: true } }, { completion: { incompleteReason: 'action-handoff' } },
    { completion: { reason: 'length' } }, { completion: { reason: 'toolUse' } },
    { completion: { error: 'provider error' } }, { completion: { protocolIssue: { code: 'missing-answer' } } },
  ]) assert.equal(memory.digestSnapshot({ status: 'idle', messages, ...patch }, 'partial').completed, false, JSON.stringify(patch));
  for (const patch of [{ done: false }, { stopReason: 'aborted' }, { stopReason: 'error' }, { errorMessage: 'failure' }]) {
    const rows = [messages[0], { ...messages[1], ...patch }];
    assert.equal(memory.digestSnapshot({ status: 'idle', messages: rows }, 'partial').completed, false);
  }
  assert.equal(memory.digestSnapshot({ status: 'idle', messages, completion: { reason: 'stop' },
    execution: { quality: { phase: 'reviewed' } } }, 'complete').completed, true);
});

test('late asynchronous archive loading without an actual new turn is never mistaken for new work', async t => {
  const f = fixture(t);
  await f.attach(true); // Runner resume begins before its historical messages arrive.
  f.snapshot({ status: 'idle', messages: oldMessages() });
  f.event({ kind: 'settled' });
  await f.flush();
  assert.equal(f.prompt('one'), '');
});

const { createRunnerRuntimeAdapter, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const catalog = require('../main/agent-runtime/runtime-catalog');
async function actualRunner(t, spec, mode = 'complete') {
  const f = fixture(t), alias = 'actual-memory-' + spec.id;
  const ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':' + spec.id);
  let round = 0;
  const runtime = { async rpc(op) {
    if (op === 'runtime.detect') return { ok: true, data: { installed: true, state: 'ready' } };
    if (op === 'job.dispatch') { round++; return { ok: true, data: { ref } }; }
    if (op === 'job.comment') { round++; return { ok: true, data: { ok: true } }; }
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    if (op === 'job.session') {
      return { ok: true, data: { status: mode === 'paused' ? 'running' : mode === 'failed' ? 'failed' : 'done', round,
        ...(mode === 'failed' ? { error: 'isolated provider failure' } : {}),
        items: [{ seq: round, kind: 'say', text: 'Actual ' + spec.id + ' outcome ' + round }] } };
    }
    throw Error('Unexpected isolated RPC: ' + op);
  } };
  const adapter = createRunnerRuntimeAdapter({ app: f.app, runtimeSpec: spec, runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'isolated', key: 'fixture-only', baseUrl: 'http://model.invalid' } }) } });
  const bridge = createPiSessionBridge({ app: f.app,
    sessionModule: { probe() { return { ok: false }; }, open() { throw Error('Pi is outside this isolated runner fixture'); } }, runnerAdapters: [adapter] });
  const opened = await bridge.open({ app: f.app, identity: identity('one'), adapterId: spec.id, cwd: f.directory, ref: alias,
    ...(mode === 'paused' ? { intent: 'goal', goal: 'Paused isolated work' } : {}) });
  assert.equal(opened.ok, true, opened.reason);
  const handle = opened.session, events = [];
  assert.equal(typeof handle.on, 'function');
  assert.equal(typeof handle.subscribe, 'undefined');
  handle.on(event => events.push(event.kind));
  await f.service.attach(handle, identity('one'), { ids: [], items: [], scopes: [] }, [], {});
  t.after(async () => { await handle.ui.memorySubscription?.(); await bridge.dispose(); });
  return { ...f, handle, events };
}

for (const spec of catalog.runnerRuntimes()) test(spec.id + ': actual bridge native handle saves settled output across queued turns and immediate close', async t => {
  const f = await actualRunner(t, spec);
  const first = f.handle.submit('First actual task', [], {});
  const next = f.handle.submit('Next queued actual task', [], {});
  assert.equal(next.queued, true);
  assert.equal((await first.completion).ok, true);
  assert.equal((await next.completion).ok, true);
  const disposeMemory = f.handle.ui.memorySubscription;
  await f.handle.close();
  assert.equal(f.handle.ui.memorySubscription, undefined);
  await disposeMemory();
  assert.ok(f.events.includes('started'));
  assert.equal(f.events.filter(kind => kind === 'settled').length, 2);
  assert.match(f.prompt('one'), new RegExp('Actual ' + spec.id + ' outcome 2'));
  assert.doesNotMatch(f.prompt('one'), new RegExp('Actual ' + spec.id + ' outcome 1'));
});

test('actual native Runner failure cannot promote partial assistant output', async t => {
  const f = await actualRunner(t, catalog.runtime('qwen'), 'failed');
  const sent = f.handle.submit('An attempted task', [], {});
  assert.equal((await sent.completion).ok, false);
  await f.handle.ui.memorySubscription();
  assert.equal(f.prompt('one'), '');
});

test('actual native Runner paused goal presents idle but never promotes its partial output', async t => {
  const f = await actualRunner(t, catalog.runtime('dsh'), 'paused');
  const sent = f.handle.submit('Attempt only', [], {});
  for (let count = 0; count < 100 && !f.handle.snapshot().messages.some(row => row.role === 'assistant'); count++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.handle.snapshot().messages.some(row => row.role === 'assistant'));
  assert.equal((await f.handle.pauseGoal()).ok, true);
  assert.equal((await sent.completion).paused, true);
  assert.equal(f.handle.snapshot().status, 'idle');
  assert.equal(f.handle.snapshot().execution.paused, true);
  await f.handle.ui.memorySubscription();
  assert.equal(f.prompt('one'), '');
});

test('thought/tool-only blocks cannot leak through raw text fallback or resurrect an earlier assistant answer', () => {
  for (const final of [
    { blocks: [{ kind: 'thinking', text: 'Hidden reasoning' }], text: 'Hidden reasoning fallback' },
    { content: [{ type: 'thinking', text: 'Hidden reasoning' }], text: 'Hidden reasoning fallback' },
    { blocks: [{ kind: 'tool', text: 'Hidden command' }], text: 'Hidden command fallback' },
  ]) {
    const digest = memory.digestSnapshot({ status: 'idle', messages: [
      { role: 'user', text: 'Task' }, { role: 'assistant', text: 'Interim plan' },
      { role: 'assistant', done: true, ...final },
    ] }, 'thoughts');
    assert.equal(digest.completed, false);
    assert.equal(digest.fields.outcomes, '');
    assert.doesNotMatch(JSON.stringify(digest), /Hidden/);
  }
});

test('paused snapshot on verified history reopen cannot overwrite its incomplete source marker as completed', async t => {
  const f = fixture(t);
  await f.attach();
  f.snapshot({ status: 'idle', messages: oldMessages(), execution: { paused: true }, completion: { incompleteReason: 'length' } });
  f.event({ kind: 'goal-paused' });
  await f.flush();
  await f.attach(true);
  await f.flush();
  assert.equal(f.prompt('one'), '');
});

test('optional corrupt local evidence cannot block opening a conversation even with an explicit selection', async t => {
  const f = fixture(t);
  const root = local.userMemoryRoot(f.app, scope(identity('one')));
  fs.writeFileSync(path.join(root, '.personal-learning.json'), '{invalid');
  fs.writeFileSync(path.join(root, 'sessions'), 'Not a directory');
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    const context = await f.service.context(identity('one'), { memoryIds: ['unavailable-source'] });
    assert.equal(context.prompt, '');
    assert.match(context.warning, /已跳过/);
  } finally { global.fetch = original; }
});

test('account switching during asynchronous context lookup cannot return the previous account context', async t => {
  const f = fixture(t), original = global.fetch;
  let finish;
  global.fetch = () => new Promise(resolve => { finish = resolve; });
  try {
    const pending = f.service.context(identity('one'), {});
    f.setAuth('two');
    finish({ ok: true, json: async () => ({ ok: true, prompt: 'Old account organization context' }) });
    await assert.rejects(pending, /账号或服务已变化/);
  } finally { global.fetch = original; }
});
