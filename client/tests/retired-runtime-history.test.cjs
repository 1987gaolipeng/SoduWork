'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { create } = require('../main/conversation/local-history-view.cjs');

function fixture(t) {
  const bridge = createPiSessionBridge({ runnerAdapters: [], sessionModule: {
    open: async () => assert.fail('retired histories must never create a Pi runtime'),
    probe: async () => ({ ok: true }), history: async () => ({ ok: true, chats: [] }),
  } });
  t.after(() => bridge.dispose());
  return bridge;
}

for (const adapterId of ['claude', 'harness2']) {
  test(`${adapterId} archives open as passive history without model or execution access`, async t => {
    const bridge = fixture(t), calls = [];
    bridge.setReplicaHistory({ open: async id => {
      calls.push(id);
      return create({ row: { id, adapterId, title: 'Historical reply' }, read: async () => ({
        format: 'messages', items: [{ id: '1', role: 'user', text: 'Original question' },
          { id: '2', role: 'assistant', text: 'Preserved answer' }], nextCursor: null,
      }) });
    } });
    const opened = await bridge.open({ adapterId, resumePath: 'old-run' });
    assert.equal(opened.ok, true, opened.reason);
    assert.deepEqual(calls, ['old-run']);
    assert.equal(opened.session.adapterId, adapterId);
    assert.equal(opened.session.localReplica, true);
    assert.deepEqual(opened.session.snapshot().messages.map(item => item.text), ['Original question', 'Preserved answer']);
    assert.equal((await opened.session.send('Do not execute')).accepted, false);
    assert.equal(bridge.registry.list().some(row => row.id === adapterId), false);
    assert.equal(await opened.session.close(), true);
    assert.equal(bridge.findBySessionId('old-run'), null);
  });

  test(`${adapterId} cannot start a new conversation or bypass an unreadable archive`, async t => {
    const bridge = fixture(t); let reads = 0;
    bridge.setReplicaHistory({ open: async () => { reads++; throw Error('Account changed'); } });
    const fresh = await bridge.open({ adapterId });
    assert.equal(fresh.ok, false);
    assert.equal(fresh.runtimeError, 'ADAPTER_NOT_FOUND');
    assert.equal(reads, 0);
    const stale = await bridge.open({ adapterId, resumePath: 'old-run' });
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /Account changed/);
    assert.equal(reads, 1);
    assert.equal(bridge.list().length, 0);
  });
}

test('retired providers retain inventory and exact archive lookup without adding selectable runtimes', async t => {
  const { createRunnerHistoryProvider } = require('../main/agent-runtime/runner-history.cjs');
  const calls = [];
  const runnerRuntime = { rpc: async (operation) => {
    calls.push(operation);
    assert.equal(operation, 'runtime.sessions');
    return { ok: true, data: { runs: ['claude', 'harness2'].map(cli => ({
      cli, ref: cli + '-old-run', taskId: 'chat-' + cli, state: 'done', title: 'Saved ' + cli,
    })) } };
  } };
  const bridge = createPiSessionBridge({ runnerAdapters: [],
    historyAdapters: ['claude', 'harness2'].map(adapterId => createRunnerHistoryProvider({ adapterId, runnerRuntime })),
    sessionModule: { open: async () => assert.fail('must not execute'), probe: async () => ({ ok: true }),
      history: async () => ({ ok: true, chats: [] }), historyEntry: async () => ({ ok: false, notFound: true }) },
  });
  t.after(() => bridge.dispose());
  const history = await bridge.history();
  assert.equal(history.ok, true, history.reason);
  assert.deepEqual(history.chats.map(row => row.adapterId).sort(), ['claude', 'harness2']);
  for (const adapterId of ['claude', 'harness2']) {
    assert.equal((await bridge.archivedConversation(null, adapterId + '-old-run')).adapterId, adapterId);
    assert.equal(bridge.runtimes().some(row => row.id === adapterId), false);
    assert.equal((await bridge.probe(null, adapterId)).ok, false);
  }
  assert.deepEqual(calls, ['runtime.sessions'], 'archive providers share the existing inventory cache');
});
