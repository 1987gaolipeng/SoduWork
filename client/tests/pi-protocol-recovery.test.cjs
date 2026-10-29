'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runControl = require('../main/pi-session/run-control');
const stream = require('../main/pi-session/event-stream');
const protocolGuard = require('../main/agent-runtime/protocol-guard');

const request = {
  goalMode: false,
  request: 'Inspect the existing report, keep the completed export, and finish the remaining summary.',
  pluginIds: ['plugin-report', 'plugin-office'],
  projectId: 'project-report',
};
const narration = Array(8).fill('Let me read README now.').join('\n');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ goal = false, complete = true } = {}) {
  const state = runControl.createState();
  const acc = stream.create();
  const sent = [], emitted = [], checkpoints = [];
  let closed = false, inFlight = false, enabled = goal, limit = null;
  let quality = '', failed = true, providerAborts = 0, toolStarts = 0;
  function push(event) {
    if (event.type === 'tool_execution_start') toolStarts += 1;
    return acc.push(event);
  }
  function answer(text) {
    push({ type: 'message_start', message: { role: 'assistant' } });
    push({ type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0, content: text,
    } });
    push({ type: 'message_end', message: { role: 'assistant',
      stopReason: 'stop', usage: { input: 20, output: 8, totalTokens: 28 } } });
    push({ type: 'agent_settled' });
  }
  const ctx = {
    protocolGuard, acc, goalIntent: goal ? 'goal' : 'chat',
    goal: { goal: request.request, acceptance: 'The summary is complete.' },
    limitRequest: () => limit,
    setLimitRequest: value => { limit = value; },
    goalEnabled: () => enabled,
    setGoalEnabled: value => { enabled = value; },
    setQuality: (phase, reason) => { quality = reason; },
    qualityReason: () => quality,
    checkpoint: (kind, data) => checkpoints.push({ kind, data }),
    closed: () => closed,
    inFlight: () => inFlight,
    setFailedLastTurn: value => { failed = value; },
    endGoalTurn: () => acc.endGoalTurn(),
    emit: event => emitted.push(event),
    piSession: { isIdle: true, abort: async () => { providerAborts += 1; } },
    goalPluginIds: () => ['goal-plugin'],
    goalPluginProjectId: () => 'goal-project',
    send: async (prompt, attachments, options) => {
      sent.push({ prompt, attachments, options });
      // Use the real projection for the internal control prompt and response.
      // No model or executor is called; completed native tools remain evidence.
      push({ type: 'message_end', message: { role: 'user', content: prompt } });
      push({ type: 'agent_start' });
      if (complete) answer('The remaining summary is complete; the existing export was retained.');
    },
  };
  push({ type: 'message_end', message: { role: 'user', content: request.request } });
  push({ type: 'agent_start' });
  push({ type: 'tool_execution_start', toolCallId: 'export-completed', toolName: 'write',
    args: { path: 'report.md', content: 'Previously completed export' } });
  push({ type: 'tool_execution_end', toolCallId: 'export-completed', toolName: 'write',
    isError: false, result: { content: [{ type: 'text', text: 'Export saved once.' }] } });
  function fail() {
    push({ type: 'message_start', message: { role: 'assistant' } });
    const touched = push({ type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0, content: narration,
    } });
    assert.equal(touched.kind, 'protocol-leak');
    assert.equal(acc.state.protocolIssue.code, protocolGuard.DEGENERATE_OUTPUT_CODE);
    runControl.stopProtocolIssue(state, acc.state.protocolIssue, ctx);
  }
  fail();
  return {
    state, acc, ctx, sent, emitted, checkpoints, fail,
    close: () => { closed = true; },
    setInFlight: value => { inFlight = value; },
    get enabled() { return enabled; },
    get failed() { return failed; },
    get providerAborts() { return providerAborts; },
    get toolStarts() { return toolStarts; },
  };
}

test('Pi recovers narration once with the original normal request, plugins and project', async () => {
  const f = fixture();
  assert.equal(f.providerAborts, 1);
  assert.equal(f.acc.status(), 'unreachable');
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true);
  assert.equal(f.sent.length, 0, 'recovery must wait for the current stack to settle');
  await flush();
  assert.equal(f.sent.length, 1);
  const turn = f.sent[0];
  assert.equal(protocolGuard.isRecoveryPrompt(turn.prompt), true);
  assert.ok(turn.prompt.includes(request.request));
  assert.match(turn.prompt, /native runtime tool calls/);
  assert.doesNotMatch(turn.prompt, /Let me read README now/);
  assert.deepEqual(turn.options, {
    internal: true, runtimeRecovery: true, continuing: false, goalMode: false,
    pluginIds: request.pluginIds, projectId: request.projectId,
  });
  assert.notEqual(turn.options.pluginIds, request.pluginIds);
  assert.deepEqual(turn.attachments, []);
  assert.equal(f.state.protocolRecoveryCount, 1);
  assert.equal(f.state.stopReason, '');
  assert.equal(f.failed, false);
  assert.equal(f.enabled, false);
  assert.deepEqual(f.checkpoints, [], 'ordinary chat must not become a goal run');
  const snap = f.acc.snapshot();
  assert.equal(snap.completion.protocolIssue, null);
  assert.equal(snap.status, 'idle');
  assert.deepEqual(snap.messages.filter(row => row.role === 'user').map(row => row.text), [request.request]);
  const assistants = snap.messages.filter(row => row.role === 'assistant');
  assert.ok(assistants.every(row => row.scope === stream.SCOPES.NORMAL));
  const replies = assistants.filter(row => row.blocks.some(block => block.text.trim()));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].scope, stream.SCOPES.NORMAL);
  assert.match(replies[0].blocks.map(block => block.text).join('\n'), /remaining summary is complete/);
  assert.doesNotMatch(JSON.stringify(snap.messages), /soduwork-internal-protocol-recovery|Let me read README/);
  assert.equal(f.toolStarts, 1, 'recovery must not replay the completed tool event');
  assert.equal(snap.tools.length, 1);
  assert.equal(snap.tools[0].id, 'export-completed');
  assert.equal(snap.tools[0].state, 'done');
  assert.equal(snap.tools[0].result, 'Export saved once.');
});

test('Pi stops after the same protocol error returns in the single recovery attempt', async () => {
  const f = fixture({ complete: false });
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true);
  await flush();
  f.fail();
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), false);
  await flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.state.protocolRecoveryCount, 1);
  assert.equal(f.providerAborts, 2);
  assert.ok(f.state.stopReason);
  assert.equal(f.acc.status(), 'unreachable');
  assert.equal(f.acc.snapshot().completion.protocolIssue.code, protocolGuard.DEGENERATE_OUTPUT_CODE);
  assert.equal(f.toolStarts, 1);
  assert.equal(f.acc.snapshot().tools[0].result, 'Export saved once.');
  assert.equal(f.emitted.filter(event => event.kind === 'protocol-recovering').length, 1);
});

test('a user stop cancels pending protocol recovery before it can send', async () => {
  const f = fixture();
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true);
  runControl.cancelPending(f.state);
  f.acc.abort();
  await flush();
  assert.equal(f.sent.length, 0, 'user cancellation must invalidate the queued recovery');
  assert.equal(f.emitted.some(event => event.kind === 'protocol-recovering'), false);
  assert.equal(f.state.protocolRecoveryCount, 1, 'cancelling cannot grant another automatic attempt');
  assert.equal(f.toolStarts, 1);
});

test('protocol recovery waits for asynchronous turn cleanup without settling the original receipt', { timeout: 2000 }, async () => {
  const f = fixture(); let release, settled = false;
  const cleanup = new Promise(resolve => { release = resolve; });
  f.setInFlight(true);
  const oldTurn = (async () => {
    try { assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true); }
    finally { await cleanup; f.setInFlight(false); }
  })();
  const receipt = f.state.recoveryReceipt;
  receipt.promise.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.sent.length, 0);
  assert.equal(settled, false, 'journal cleanup must not cancel the original queue item');
  assert.ok(f.state.protocolPending);
  release(); await oldTurn; await receipt.promise;
  assert.equal(f.sent.length, 1);
  assert.equal(f.state.protocolPending, null);
  assert.equal(f.acc.status(), 'idle');
});

for (const action of ['stop', 'close', 'new-turn']) {
  test(action + ' while cleanup is pending prevents the deferred protocol retry', { timeout: 2000 }, async () => {
    const f = fixture(); f.setInFlight(true);
    assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true);
    const receipt = f.state.recoveryReceipt;
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.ok(f.state.protocolPending);
    if (action === 'stop') runControl.cancelPending(f.state);
    else if (action === 'close') f.close();
    else runControl.resetTurn(f.state, true);
    f.setInFlight(false);
    assert.equal((await receipt.promise).cancelled, true);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.sent.length, 0);
    assert.equal(f.emitted.some(event => event.kind === 'protocol-recovering'), false);
  });
}

test('an internal protocol retry retains a copy of the selected skill names', async () => {
  const f = fixture(), selected = ['report-skill'];
  assert.equal(runControl.scheduleProtocol(f.state, { ...request, skills: selected }, f.ctx), true);
  await flush();
  assert.deepEqual(f.sent[0].options.skills, selected);
  assert.notEqual(f.sent[0].options.skills, selected);
});

test('a stop on the recovery announcement cannot leak another model request', async () => {
  const f = fixture();
  const emit = f.ctx.emit;
  f.ctx.emit = event => {
    emit(event);
    if (event.kind === 'protocol-recovering') runControl.cancelPending(f.state);
  };
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true);
  await flush();
  assert.equal(f.sent.length, 0);
  const result = await runControl.finishRecovery(f.state, { ok: true, recovering: true });
  assert.equal(result.cancelled, true);
});

test('closing the session suppresses its pending protocol recovery', async () => {
  const f = fixture();
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true);
  f.close();
  await flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.emitted.some(event => event.kind === 'protocol-recovering'), false);
});

test('goal protocol recovery retains its goal-specific capability selection', async () => {
  const f = fixture({ goal: true, complete: false });
  assert.equal(runControl.scheduleProtocol(f.state, { ...request, goalMode: true }, f.ctx), true);
  await flush();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].options, {
    internal: true, runtimeRecovery: true, continuing: true, goalMode: true,
    pluginIds: ['goal-plugin'], projectId: 'goal-project',
  });
  assert.equal(f.ctx.limitRequest(), null);
  assert.equal(f.enabled, true);
  assert.equal(f.acc.state.currentScope, stream.SCOPES.GOAL_EXECUTION);
  assert.ok(f.checkpoints.some(event => event.kind === 'run.resumed' && event.data.automatic));
});


test('a fresh user turn invalidates the old queued recovery without cancelling its own recovery', async () => {
  const f = fixture();
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true);
  runControl.resetTurn(f.state, true);
  f.acc.recoverProtocol();
  f.fail();
  const fresh = { ...request, request: 'Finish the new summary for the current user turn.' };
  assert.equal(runControl.scheduleProtocol(f.state, fresh, f.ctx), true);
  await flush();
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].prompt.includes(fresh.request));
  assert.ok(!f.sent[0].prompt.includes(request.request), 'the stale turn must never be relaunched');
  assert.equal(f.state.protocolRecoveryCount, 1);
});

test('disposing the run invalidates its queued protocol recovery', async () => {
  const f = fixture();
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true);
  runControl.dispose(f.state);
  await flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.emitted.some(event => event.kind === 'protocol-recovering'), false);
});

test('an accumulator without a protocol issue does not schedule a recovery', async () => {
  const f = fixture();
  f.acc.recoverProtocol();
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), false);
  await flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.protocolRecoveryCount, 0);
});

test('protocol interruption retains active tools and tracks native abort completion', async () => {
  const f = fixture(); const priorAbort = f.state.abortPromise;
  f.state.activeTools.set('still-running', { id: 'still-running' });
  f.state.stopReason = '';
  runControl.stopProtocolIssue(f.state, f.acc.state.protocolIssue, f.ctx);
  assert.equal(f.state.activeTools.has('still-running'), true, 'requesting abort cannot fabricate a tool end');
  assert.notEqual(f.state.abortPromise, priorAbort);
  await f.state.abortPromise;
});

test('protocol recovery cannot send before native exit and leaves a bounded failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.ctx.piSession.isIdle = false;
  f.state.abortPromise = new Promise(() => {});
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true);
  const receipt = f.state.recoveryReceipt;
  await flush();
  assert.equal(f.sent.length, 0);
  t.mock.timers.tick(require('../main/pi-session/stall-recovery').ABORT_SETTLE_MS);
  await flush();
  assert.equal((await receipt.promise).ok, false);
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.protocolPending, null);
});

test('protocol cleanup polling is owned and cleared when recovery is cancelled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.setInFlight(true);
  assert.equal(runControl.scheduleProtocol(f.state, request, f.ctx), true);
  await flush();
  assert.ok(f.state.recoveryTimer, 'pending cleanup must retain its cancellable timer');
  runControl.cancelPending(f.state);
  assert.equal(f.state.recoveryTimer, null);
  f.setInFlight(false); t.mock.timers.tick(10000); await flush();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.state.recoveryReceipt.promise).cancelled, true);
});

test('cancelling protocol native-exit wait settles and clears its timeout immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.ctx.piSession.isIdle = false;
  f.state.abortPromise = new Promise(() => {});
  runControl.scheduleProtocol(f.state, request, f.ctx);
  await flush();
  assert.equal(typeof f.state.recoveryWaitCancel, 'function');
  runControl.cancelPending(f.state); await flush();
  assert.equal(f.state.recoveryWaitCancel, null);
  assert.equal((await f.state.recoveryReceipt.promise).cancelled, true);
  t.mock.timers.tick(10000); await flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.emitted.some(event => event.kind === 'protocol-recovery-failed'), false);
});
