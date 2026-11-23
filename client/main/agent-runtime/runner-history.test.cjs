'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunnerHistoryProvider } = require('./runner-history.cjs');
const { createRunnerRuntimeAdapter } = require('./runner-adapter');
const catalog = require('./runtime-catalog');

function fixture() {
  let runs = [], failure = null, forgetReply = { ok: true, data: { ok: true } };
  const calls = [];
  const runtime = { async rpc(method, params) {
    calls.push({ method, params });
    if (method === 'runtime.sessions') {
      if (failure) throw failure;
      return { ok: true, data: { runs } };
    }
    assert.equal(method, 'runtime.session.forget');
    if (forgetReply?.data?.ok === true) runs = runs.filter(row => row.ref !== params.ref);
    return forgetReply;
  } };
  return { runtime, calls, rows: value => { runs = value; }, fail: value => { failure = value; },
    forget: value => { forgetReply = value; },
    provider: id => createRunnerHistoryProvider({ adapterId: id, runnerRuntime: runtime }) };
}
const row = (id, cli, extra = {}) => ({ ref: id, cli, taskId: 'chat-' + id,
  state: 'done', title: 'Saved chat', workDir: 'fixture', started: 11, ended: 22, seq: 4, ...extra });

test('retired history providers cannot create, resume, detect, or enable an arbitrary runtime', () => {
  const f = fixture();
  for (const id of ['claude', 'harness2']) {
    const provider = f.provider(id);
    assert.equal(provider.id, id);
    assert.deepEqual(Object.keys(provider).sort(), ['forgetSession', 'history', 'historyEntry', 'id']);
  }
  for (const id of ['pi', 'qwen', 'unregistered', '__proto__', undefined])
    assert.throws(() => f.provider(id), /Unsupported retired/);
});

test('active and retired providers share inventory while retaining only eligible chat metadata', async () => {
  const f = fixture();
  f.rows([row('old-claude', 'claude', { apiKey: 'fixture-secret', environment: { token: 'fixture-token' } }),
    row('old-planner', 'harness2'), row('current', 'qwen'), row('task', 'claude', { taskId: 'work-task' }),
    row('unknown', 'unknown'), { cli: 'claude', taskId: 'chat-malformed' }]);
  const active = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('qwen'), runnerRuntime: f.runtime });
  const [claude, planner, current] = await Promise.all([
    f.provider('claude').history(50, { metadataOnly: true }),
    f.provider('harness2').history(50, { metadataOnly: true }),
    active.history(50, { metadataOnly: true }),
  ]);
  assert.equal(f.calls.length, 1);
  assert.equal(claude.ok, true);
  assert.deepEqual(claude.chats, [{ id: 'old-claude', path: 'old-claude', adapterId: 'claude', runtimeRetired: true,
    cwd: 'fixture', title: 'Saved chat', createdAt: 11000, at: 22000, count: 4, state: 'idle' }]);
  assert.deepEqual(planner.chats.map(row => row.id), ['old-planner']);
  assert.deepEqual(current.chats.map(row => row.id), ['current']);
  assert.doesNotMatch(JSON.stringify(claude), /fixture-secret|fixture-token|apiKey|environment/);
});

test('exact lookup hydrates only the requested journal and keeps historical provenance', async t => {
  const f = fixture(), reads = [];
  t.mock.method(require('../conversation/task-output-journal'), 'usedHarnesses', async (_app, ref) => {
    reads.push(ref); return ['pi'];
  });
  f.rows(Array.from({ length: 2000 }, (_, i) => row('old-' + i, 'claude')));
  const provider = f.provider('claude');
  assert.deepEqual((await provider.historyEntry('old-1999')).chats[0].usedHarnesses, ['claude', 'pi']);
  assert.deepEqual(reads, ['old-1999']);
  assert.deepEqual((await provider.historyEntry('missing')).chats, []);
  assert.deepEqual(reads, ['old-1999']);
});

test('strict lookup bypasses cached absence and reports inventory failures', async () => {
  const f = fixture(), provider = f.provider('harness2');
  assert.deepEqual((await provider.historyEntry('old')).chats, []);
  f.rows([row('old', 'harness2')]);
  assert.deepEqual((await provider.historyEntry('old')).chats, []);
  assert.equal((await provider.historyEntry('old', { strict: true })).chats[0].id, 'old');
  f.fail(Error('Fresh inventory unavailable'));
  assert.deepEqual(await provider.history(50, { strict: true }),
    { ok: false, chats: [], reason: 'Fresh inventory unavailable' });
  assert.equal((await provider.historyEntry('missing', { strict: true })).ok, false);
});

test('malformed inventories fail and malformed records cannot become retired sessions', async () => {
  const malformed = createRunnerHistoryProvider({ adapterId: 'claude',
    runnerRuntime: { rpc: async () => ({ ok: true, data: {} }) } });
  assert.equal((await malformed.history()).ok, false);
  const f = fixture();
  f.rows([null, {}, { ref: 'wrong-task', cli: 'claude', taskId: 1 }, { cli: 'claude', taskId: 'chat-missing-id' }]);
  assert.deepEqual(await f.provider('claude').history(), { ok: true, chats: [] });
});

test('forget rejects another runtime, non-chat records, active sessions, and unavailable inventory', async () => {
  const f = fixture(), provider = f.provider('claude');
  f.rows([row('other', 'qwen'), row('task', 'claude', { taskId: 'task-1' }),
    row('running', 'claude', { state: 'running' }), row('stopping', 'claude', { stopping: true })]);
  for (const id of ['other', 'task', 'running', 'stopping']) {
    const result = await provider.forgetSession(id);
    assert.equal(result.ok, false);
    assert.notEqual(result.notFound, true);
  }
  f.fail(Error('Offline'));
  assert.match((await provider.forgetSession('missing')).reason, /Offline/);
  assert.ok(f.calls.every(call => call.method === 'runtime.sessions'));
});

test('confirmed forget invalidates shared inventory and malformed replies cannot claim success', async () => {
  const f = fixture(), first = f.provider('harness2'), second = f.provider('harness2');
  f.rows([row('old', 'harness2')]);
  assert.equal((await second.history()).chats.length, 1);
  f.forget({ ok: true });
  assert.equal((await first.forgetSession('old')).ok, false);
  assert.equal((await second.history()).chats.length, 1);
  f.forget({ ok: true, data: { ok: true } });
  assert.deepEqual(await first.forgetSession('old'), { ok: true });
  const count = f.calls.length;
  assert.deepEqual((await second.history()).chats, []);
  assert.equal(f.calls.length, count);
});
