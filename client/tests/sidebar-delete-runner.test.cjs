'use strict';

/*
 * Verify permanent deletion of archived Runner conversations through adapter, RPC,
 * fallback lookup, and forgetRunner routing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRunnerRuntimeAdapter } = require('../main/agent-runtime/runner-adapter');
const runtimeCatalog = require('../main/agent-runtime/runtime-catalog');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');

function fakeRunnerRuntime(reply) {
  const calls = [];
  return {
    calls,
    async rpc(op, payload = {}) {
      calls.push({ op, payload });
      const value = await reply(op, payload);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function fakeRunnerAdapter(id, chats, options = {}) {
  const forget = options.forget || (async () => ({ ok: true }));
  const seen = [];
  return {
    id,
    displayName: id + ' display',
    version: '1',
    capabilities: [],
    seen,
    async detect() { return { ok: true }; },
    async createSession() { return {}; },
    async history() { return { ok: true, chats }; },
    async forgetSession(ref) {
      seen.push(ref);
      return forget(ref);
    },
  };
}

test('runner adapter forwards forget to the local control channel', async () => {
  const spec = runtimeCatalog.runtime('qwen');
  const runtime = fakeRunnerRuntime(async () => ({ ok: true, data: { ok: true, forgotten: true } }));
  const adapter = createRunnerRuntimeAdapter({ runnerRuntime: runtime, runtimeSpec: spec });
  const got = await adapter.forgetSession('ref-1');
  assert.deepEqual(got, { ok: true });
  assert.deepEqual(runtime.calls, [{ op: 'runtime.session.forget', payload: { ref: 'ref-1' } }]);

  const refused = fakeRunnerRuntime(async () => ({ ok: false, error: '它还在跑，先停止再删除' }));
  const adapter2 = createRunnerRuntimeAdapter({ runnerRuntime: refused, runtimeSpec: spec });
  const denied = await adapter2.forgetSession('ref-2');
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /停止/);

  const rejected = fakeRunnerRuntime(async () => ({ ok: true, data: { ok: false, error: '这个本地会话不在了' } }));
  const adapter3 = createRunnerRuntimeAdapter({ runnerRuntime: rejected, runtimeSpec: spec });
  const missing = await adapter3.forgetSession('ref-3');
  assert.equal(missing.ok, false);
  assert.equal(missing.notFound, true);
  assert.match(missing.reason, /不在了/);
});

test('runner delete invalidates the shared inventory immediately', async () => {
  const rows = [{ ref: 'ref-cache', taskId: 'chat-cache', cli: 'qwen', state: 'failed' }];
  const runtime = fakeRunnerRuntime(async (op) => {
    if (op === 'runtime.sessions') return { ok: true, data: { runs: rows.slice() } };
    if (op === 'runtime.session.forget') return { ok: true, data: { ok: true } };
    return { ok: false, error: 'unexpected op' };
  });
  const adapter = createRunnerRuntimeAdapter({
    runnerRuntime: runtime, runtimeSpec: runtimeCatalog.runtime('qwen'),
  });
  assert.equal((await adapter.history()).chats.length, 1);
  assert.deepEqual(await adapter.forgetSession('ref-cache'), { ok: true });
  assert.equal((await adapter.history()).chats.length, 0);
  assert.equal(runtime.calls.filter(call => call.op === 'runtime.sessions').length, 1);
});

test('bridge routes forgetRunner by adapter id and falls back for archivedConversation', async () => {
  const runnerRow = {
    id: 'ref-qwen-1', path: 'ref-qwen-1', adapterId: 'qwen', cwd: 'C:/w',
    title: 'Qwen 工作会话', at: 5, count: 3, state: 'idle',
  };
  const qwen = fakeRunnerAdapter('qwen', [runnerRow]);
  const dsh = fakeRunnerAdapter('dsh', []);
  const piEntry = { id: 'pi-archived', path: 'C:/arch.jsonl', title: 'Pi 会话' };
  const sessionModule = {
    open: async () => ({}),
    history: async () => ({ ok: true, chats: [] }),
    historyEntry: async (_app, id) => id === 'pi-archived'
      ? { ok: true, entry: piEntry }
      : { ok: false, notFound: true, reason: '这条会话已经不存在了' },
  };
  const bridge = createPiSessionBridge({
    sessionModule,
    adapter: { id: 'pi', displayName: 'Pi', version: '1', capabilities: [], detect: async () => ({ ok: true }), createSession: async () => ({}) },
    runnerAdapters: [qwen, dsh],
  });

  const row = await bridge.findRunnerRow('ref-qwen-1');
  assert.equal(row && row.adapterId, 'qwen');
  assert.equal(await bridge.findRunnerRow('ref-none'), null);

  const resumed = await bridge.archivedConversation({}, 'ref-qwen-1');
  assert.equal(resumed && resumed.id, 'ref-qwen-1');
  const archived = await bridge.archivedConversation({}, 'pi-archived');
  assert.equal(archived && archived.adapterId, 'pi');

  const forgot = await bridge.forgetRunner({}, 'ref-qwen-1');
  assert.deepEqual(forgot, { ok: true });
  assert.deepEqual(qwen.seen, ['ref-qwen-1']);
  assert.deepEqual(dsh.seen, []);

  const lost = await bridge.forgetRunner({}, 'ref-none');
  assert.equal(lost.ok, false);
  assert.equal(lost.notFound, true);
});


test('bridge reports Runner inventory failures instead of treating them as deletion', async () => {
  const broken = fakeRunnerAdapter('qwen', []);
  broken.history = async () => ({ ok: false, reason: 'Runner 已离线', chats: [] });
  const bridge = createPiSessionBridge({
    sessionModule: { open: async () => ({}), history: async () => ({ ok: true, chats: [] }) },
    adapter: {
      id: 'pi', displayName: 'Pi', version: '1', capabilities: [],
      detect: async () => ({ ok: true }), createSession: async () => ({}),
    },
    runnerAdapters: [broken],
  });
  await assert.rejects(bridge.findRunnerRow('ref-offline'), /Runner 已离线/);
});
