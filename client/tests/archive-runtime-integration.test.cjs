'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const sessions = require('../main/pi-session/session');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { createRunnerRuntimeAdapter } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');

test('live provenance aggregation revisits only appended and active rows through completion', () => {
  const harnesses = require('../main/conversation/used-harnesses');
  let reads = 0;
  const old = { role: 'assistant', done: true, get sourceAgent() { reads++; return { agentId: 'qwen' }; } };
  const pending = { role: 'assistant', done: false, taskId: 'late-source', blocks: [] };
  const state = { messages: [old, pending], tools: [] };
  assert.deepEqual(harnesses.fromSnapshot(state, 'pi'), ['qwen']);
  const initialReads = reads;
  pending.blocks.push({ kind: 'text', text: 'stream delta' });
  assert.deepEqual(harnesses.fromSnapshot(state, 'pi'), ['qwen']);
  assert.equal(reads, initialReads, 'each token must not reread completed historical provenance');
  pending.sourceAgent = { agentId: 'opencode' }; pending.done = true;
  assert.deepEqual(harnesses.fromSnapshot(state, 'pi'), ['qwen', 'opencode']);
  state.tools.push({ id: 'real-tool', state: 'running', sourceAgent: { agentId: 'codex' } });
  assert.deepEqual(harnesses.fromSnapshot(state, 'pi'), ['qwen', 'opencode', 'codex']);
  state.messages.splice(0, 2, { role: 'assistant', done: true, sourceAgent: { agentId: 'harness2' } });
  state.tools.length = 0;
  assert.deepEqual(harnesses.fromSnapshot(state, 'pi'), ['harness2'], 'a replaced or shortened transcript cannot retain prior usage');
});

test('legacy completed output with unknown provenance is not rescanned on each streamed token', () => {
  const harnesses = require('../main/conversation/used-harnesses');
  let reads = 0;
  const messages = Array.from({ length: 10000 }, (_, index) => ({ role: 'assistant', done: true,
    taskId: 'legacy-' + index, get sourceAgent() { reads++; return undefined; } }));
  const tools = Array.from({ length: 10000 }, (_, index) => ({ id: 'task:legacy-tool-' + index, state: 'done',
    get sourceAgent() { reads++; return undefined; } }));
  const active = { role: 'assistant', done: false, taskId: 'live-task', blocks: [] };
  messages.push(active);
  const state = { messages, tools };
  assert.deepEqual(harnesses.fromSnapshot(state, 'pi'), []);
  const initialReads = reads;
  for (let index = 0; index < 20; index++) {
    active.blocks = [{ kind: 'text', text: 'delta-' + index }];
    assert.deepEqual(harnesses.fromSnapshot(state, 'pi'), []);
  }
  assert.equal(reads, initialReads, 'terminal legacy rows keep immutable provenance even when unknown');
  active.sourceAgent = { agentId: 'qwen' }; active.done = true;
  assert.deepEqual(harnesses.fromSnapshot(state, 'pi'), ['qwen'], 'the terminal update is observed once');
});

test('cold Runner history includes persisted task sources and refreshes after journal append', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-harness-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, ref = 'runner-source-fixture';
  const journal = await require('../main/conversation/task-output-journal').create(app, ref);
  journal.append(1, { kind: 'message', role: 'assistant', text: 'Task result', taskId: 'task', sourceAgent: { agentId: 'pi' } });
  journal.append(2, { kind: 'tool', event: { type: 'tool_execution_end', sourceAgent: { agentId: 'codex' } } });
  journal.append(3, { kind: 'message', role: 'user', text: 'User request', sourceAgent: { agentId: 'opencode' } });
  const runtime = { rpc: async () => ({ ok: true, data: { runs: [{ ref, cli: 'qwen', taskId: 'chat-sources', state: 'done' }] } }) };
  const adapter = createRunnerRuntimeAdapter({ app, runtimeSpec: catalog.runtime('qwen'), runnerRuntime: runtime });
  assert.deepEqual((await adapter.history()).chats[0].usedHarnesses, ['qwen', 'pi', 'codex']);
  journal.append(4, { kind: 'message', role: 'assistant', text: 'More work', sourceAgent: { agentId: 'harness2' } });
  assert.deepEqual((await adapter.history()).chats[0].usedHarnesses, ['qwen', 'pi', 'codex', 'harness2']);
});

test('unreadable optional task-source metadata does not hide authoritative Runner history', async t => {
  t.mock.method(require('../main/conversation/task-output-journal'), 'usedHarnesses', async () => {
    throw Object.assign(new Error('isolated unreadable journal'), { code: 'EACCES' });
  });
  const runtime = { rpc: async () => ({ ok: true, data: { runs: [{ ref: 'read-denied', cli: 'qwen', taskId: 'chat-denied', state: 'done' }] } }) };
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('qwen'), runnerRuntime: runtime });
  const result = await adapter.history();
  assert.equal(result.ok, true);
  assert.deepEqual(result.chats.map(row => [row.id, row.usedHarnesses]), [['read-denied', ['qwen']]]);
});

for (const spec of catalog.runnerRuntimes()) test(spec.id + ' archives persist, restore and delete without affecting live runs or other chats', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-archive-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  let offline = false, rejectDelete = false;
  const runs = [{ ref: 'finished', cli: spec.id, taskId: 'chat-complete', title: 'Finished', state: 'done' },
    { ref: 'active', cli: spec.id, taskId: 'chat-active', title: 'Active', state: 'running' }];
  const runtime = { async rpc(op, input) {
    if (offline) return { ok: false, error: 'offline' };
    if (op === 'runtime.sessions') return { ok: true, data: { runs } };
    if (op === 'runtime.session.forget') {
      if (rejectDelete) return { ok: false, error: 'delete refused' };
      const index = runs.findIndex(row => row.ref === input.ref);
      if (index >= 0) runs.splice(index, 1);
    }
    return { ok: true, data: {} };
  } };
  function bridge() { return createPiSessionBridge({ app, sessionModule: sessions,
    runnerAdapters: [createRunnerRuntimeAdapter({ app, runtimeSpec: spec, runnerRuntime: { rpc: (...args) => runtime.rpc(...args) } })] }); }
  let current = bridge(); t.after(() => current.dispose());
  assert.equal((await current.archiveHistory(app, 'active')).ok, false, 'a run remains active even without an open client handle');
  assert.equal(sessions.isArchived(app, 'active'), false);
  assert.equal((await current.archiveHistory(app, 'finished')).ok, true);
  assert.equal((await current.history(app, 50)).chats.some(row => row.id === 'finished'), false);
  assert.deepEqual((await current.history(app, 1)).chats.map(row => row.id), ['active'],
    'archived recent rows do not consume the sidebar limit and hide older visible chats');
  await current.dispose(); current = bridge();
  assert.equal((await current.archivedHistory(app)).chats[0].id, 'finished', 'fresh bridge reads durable archive state');
  assert.equal((await current.restoreHistory(app, 'finished')).ok, true);
  assert.equal((await current.history(app, 50)).chats.some(row => row.id === 'finished'), true);
  assert.equal((await current.permanentlyDeleteHistory(app, 'finished')).ok, false, 'unarchived chats cannot be permanently deleted');
  await current.archiveHistory(app, 'finished');
  rejectDelete = true;
  assert.equal((await current.permanentlyDeleteHistory(app, 'finished')).ok, false);
  assert.equal(sessions.isArchived(app, 'finished'), true, 'a failed deletion preserves the archive marker');
  rejectDelete = false;
  assert.equal((await current.permanentlyDeleteHistory(app, 'finished')).ok, true);
  assert.equal(sessions.isArchived(app, 'finished'), false);
  assert.deepEqual(runs.map(row => row.ref), ['active']);
  sessions.setArchived(app, 'active', true);
  assert.equal((await current.permanentlyDeleteHistory(app, 'active')).ok, false);
  assert.equal(sessions.isArchived(app, 'active'), true);
  offline = true;
  await current.dispose(); current = bridge();
  await assert.rejects(() => current.permanentlyDeleteHistory(app, 'active'), /offline/);
  assert.equal(sessions.isArchived(app, 'active'), true, 'an offline runtime never clears a saved archive marker');
});
