'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stream = require('../main/pi-session/event-stream');
const seed = require('../main/pi-session/history-seed');
const history = require('../main/pi-session/history-state');
const outcome = require('../main/pi-session/turn-outcome');
const summary = require('../components/panels/chat-turn-summary');
const user = (at = 1000) => ({ type: 'message', message: { role: 'user', content: 'Request', sentAt: at } });
const reply = (stopReason, at = 2000) => ({ type: 'message', message: { role: 'assistant',
  content: [{ type: 'text', text: 'Partial answer' }], stopReason, completedAt: at } });
function restore(entries, options) {
  const acc = stream.create();
  seed.seed(acc, { state: { messages: [] }, sessionManager: { getEntries: () => entries } }, options);
  return acc;
}
function context(acc, entries = []) {
  const noop = () => {};
  const ctx = { acc, shared: { _presenceState: history.presenceState, _messageTitle: history.messageTitle },
    ref: 'fixture', displayTitle: 'Synthetic chat', taskBinding: { taskIds: [], taskBindings: [] }, goal: {},
    opts: {}, prep: { model: {} }, inFlight: false, turnQueue: { size: () => 0, active: () => null, stopActive: noop, clear: noop, resume: noop },
    resourceActivation: { cancel: noop }, immediate: { cancel: noop }, liveAccess: { cancel: noop },
    modelRecovery: { clear: noop }, _cancelPendingStallRecovery: noop, _emit: noop,
    piSession: { sessionId: 'fixture', sessionManager: { appendCustomEntry: (customType, data) =>
      entries.push({ type: 'custom', customType, data }) } }, _snapshot: () => acc.snapshot() };
  ctx.handle = require('../main/pi-session/session-handle').create(ctx);
  return ctx;
}

test('cold archive → real handle → merged history retains interruption across reopening', () => {
  for (const tail of [[], [reply('toolUse')], [reply('toolUse'),
    { type: 'message', message: { role: 'toolResult', toolCallId: 't', content: [] } }]]) {
    const entries = [user(), ...tail], acc = restore(entries), ctx = context(acc);
    const disk = { id: 'fixture', state: history.archivedTurnState(entries) };
    assert.equal(disk.state, 'interrupted');
    assert.equal(history.mergeHistory([disk], [ctx.handle], 10)[0].state, 'interrupted');
    assert.equal(context(restore(entries)).handle.historyRow().state, 'interrupted');
    assert.equal(acc.status(), 'idle', 'opening history never starts execution or blocks ordinary sending');
    const turns = summary.project(acc.snapshot(), new Set([1]));
    assert.equal(turns[0].outcome, 'interrupted');
    assert.equal(turns[0].elapsedMs, null, 'exit time is not inferred from reopen time');
  }
});

test('real JSONL index retains terminal state without keeping message bodies in binding metadata', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-outcome-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentRoot = path.join(root, 'pi-agent');
  const dir = path.join(agentRoot, 'sessions', 'fixture-workspace'); fs.mkdirSync(dir, { recursive: true });
  const variants = [
    ['interrupted', [user(), reply('toolUse')]],
    ['aborted', [user(), reply('toolUse'), { type: 'custom', customType: outcome.ENTRY_TYPE,
      data: { kind: 'stopped', sentAt: 1000, at: 20000 } }, reply('toolUse')]],
    ['idle', [user(), reply('stop')]],
    ['unreachable', [user(), reply('error')]],
  ];
  for (const [id, entries] of variants) fs.writeFileSync(path.join(dir, id + '.jsonl'),
    [{ type: 'session', id, cwd: root, timestamp: '2026-01-01T00:00:00Z' }, ...entries].map(JSON.stringify).join('\n'));
  const index = require('../main/pi-session/archive-history').createArchiveHistory({ root: agentRoot, project(row, bindings) {
    assert.equal(bindings.length, 0, 'Index never retains full message entries'); return row;
  } });
  const rows = await index.list();
  assert.equal(rows.length, variants.length);
  for (const [id] of variants) assert.equal(rows.find(row => row.id === id).archivedTurnState, id);
  const cold = await require('../main/pi-session/session').history({ getPath: () => root }, 20);
  assert.equal(cold.ok, true);
  for (const [id, state] of Object.entries({ interrupted: 'interrupted', aborted: 'stopped', unreachable: 'failed' })) {
    assert.equal(cold.chats.find(row => row.id === id).state, state);
  }
  assert.equal(cold.chats.find(row => row.id === 'idle').state, undefined, 'A metadata refresh does not erase retained failures');
});

test('cancel records an explicit immutable receipt; later completion cannot replace it', async () => {
  const entries = [user()], acc = stream.create();
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'message_end', message: entries[0].message, replay: true });
  acc.push({ type: 'message_start', message: { role: 'assistant' } });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Partial' } });
  const ctx = context(acc, entries); ctx.inFlight = true;
  const realNow = Date.now; Date.now = () => 20000;
  try { await ctx.handle.cancel({ userInitiated: true }); await ctx.handle.cancel({ userInitiated: true }); } finally { Date.now = realNow; }
  assert.equal(entries.filter(entry => entry.customType === outcome.ENTRY_TYPE).length, 1);
  const terminal = reply('aborted', 23000); entries.push(terminal);
  acc.push({ type: 'message_end', message: terminal.message, replay: true });
  acc.push({ type: 'agent_settled' }); ctx.inFlight = false;
  assert.equal(ctx.handle.historyRow().state, 'stopped');
  const metric = acc.snapshot().turnMetrics[0];
  assert.equal(metric.elapsedMs, 19000);
  assert.equal(history.archivedTurnState(entries), 'aborted');
  assert.equal(restore(entries).snapshot().turnMetrics[0].elapsedMs, 19000);
  entries.push(user(30000), reply('stop', 32000));
  const reopened = restore(entries), snap = reopened.snapshot();
  assert.equal(context(reopened).handle.historyRow().state, 'completed');
  assert.equal(snap.turnMetrics[0].outcome, 'stopped');
  assert.equal(snap.turnMetrics[1].outcome, undefined);
  const turns = summary.project(snap, new Set([1, 3]));
  assert.equal(turns.find(turn => turn.outcome).elapsedMs, 19000);
  const html = summary.create({ esc: String }).html(turns.find(turn => turn.outcome));
  assert.match(html, /你在 19 秒后停止了/);
  assert.doesNotMatch(html, /button|data-thinking|正常开启|恢复/);
});

test('real running/waiting state wins, followup starts normally and keeps the old marker', () => {
  const acc = restore([user(), reply('toolUse')]), ctx = context(acc);
  ctx.inFlight = true;
  assert.equal(ctx.handle.historyRow().state, 'running');
  assert.equal(summary.project({ ...acc.snapshot(), execution: { running: true } }, new Set())[0].outcome, 'interrupted');
  acc.state.pendingUi = { method: 'input' };
  assert.equal(ctx.handle.historyRow().state, 'waiting');
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'message_end', message: user(4000).message, replay: true });
  assert.equal(acc.status(), 'streaming');
  assert.equal(acc.snapshot().turnMetrics[0].outcome, 'interrupted');
  assert.equal(acc.snapshot().turnMetrics[1].outcome, undefined);
  acc.push({ type: 'message_end', message: reply('stop', 6000).message, replay: true });
  acc.push({ type: 'agent_settled' }); ctx.inFlight = false;
  assert.equal(ctx.handle.historyRow().state, 'completed');
});

test('legacy abort has no evidence of user intent; errors and normal replies stay distinct', () => {
  const view = summary.create({ esc: String });
  for (const reason of ['stop', 'error', 'length', 'aborted']) {
    const acc = restore([user(), reply(reason)]), snap = acc.snapshot();
    const row = context(acc).handle.historyRow();
    assert.equal(row.state, { stop: 'completed', error: 'failed', length: 'failed', aborted: 'interrupted' }[reason]);
    if (reason === 'aborted') assert.match(view.html(summary.project(snap, new Set())[0]), /本轮已中断/);
    else assert.equal(snap.turnMetrics[0].outcome, undefined);
  }
  const acc = stream.create(); acc.push({ type: 'message_end', message: user(0).message, replay: true });
  outcome.record(acc.state, { kind: 'stopped', at: 20000 });
  assert.match(view.html(summary.project(acc.snapshot(), new Set())[0]), /你已停止/);
});

test('internal cancellation does not attribute the interruption to the user', async () => {
  const acc = stream.create();
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'message_end', message: user().message, replay: true });
  const entries = [], ctx = context(acc, entries); ctx.inFlight = true;
  await ctx.handle.cancel();
  assert.equal(entries.length, 0);
  assert.equal(acc.snapshot().turnMetrics[0].outcome, undefined);
});

test('both stop IPC channels identify user intent without changing the stop receipt', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../main/pi-session/ipc'), 'utf8');
  const start = source.indexOf('  const cancelSession = async (ref) => {');
  const end = source.indexOf("  require('./artifact-ipc')", start);
  const handlers = new Map(), calls = [];
  const handle = { cancel: options => { calls.push(options.userInitiated); return { ok: true, stopped: true }; },
    snapshot: () => ({ status: 'aborted' }) };
  vm.runInNewContext(source.slice(start, end), { session: { get: () => handle },
    _cloudHandoff: { guard: () => false }, _contextSnapshot: (_, snap) => snap,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) } });
  const result = await handlers.get('pi-session-cancel-request')({}, 'fixture');
  assert.equal(result.stopped, true);
  handlers.get('pi-session-cancel')({}, 'fixture');
  assert.deepEqual(calls, [true, true]);
});

test('bounded history retains outcome ownership and ignores a receipt for another submission', () => {
  const entries = [user(), reply('toolUse'), { type: 'custom', customType: outcome.ENTRY_TYPE,
    data: { kind: 'stopped', at: 20000, submissionId: 'different' } }];
  const acc = restore(entries), snap = acc.uiSnapshot({ messageLimit: 1 });
  assert.equal(snap.messages.length, 1);
  assert.equal(summary.project(snap, new Set())[0].outcome, 'interrupted');
  assert.equal(history.archivedTurnState(entries), 'interrupted');
  const ctx = context(acc); ctx.inFlight = true;
  ctx.turnQueue.active = () => ({ options: { submissionId: 'next-pending' } });
  outcome.userStopped(ctx);
  assert.equal(acc.snapshot().turnMetrics[0].outcome, 'interrupted');
  const long = [user(), ...Array.from({ length: 8 }, () => reply('toolUse'))];
  const clipped = restore(long, { maxMessages: 2 });
  assert.equal(clipped.snapshot().messages.length, 2);
  assert.equal(context(clipped).handle.historyRow().state, 'interrupted');
  long.splice(1, 0, { type: 'custom', customType: outcome.ENTRY_TYPE,
    data: { kind: 'stopped', sentAt: 1000, at: 20000 } });
  assert.equal(restore(long, { maxMessages: 2 }).snapshot().turnMetrics[0].elapsedMs, 19000);
});
