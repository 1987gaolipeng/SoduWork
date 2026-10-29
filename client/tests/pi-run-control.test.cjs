'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runControl = require('../main/pi-session/run-control.js');

function context(overrides) {
  const value = {
    configured: true,
    visible: () => true,
    goalEnabled: () => true,
    status: () => 'streaming',
    limitRequest: () => null,
    qualityPhase: () => 'executing',
    qualityReason: () => '正在执行',
    qualityRounds: () => 1,
    inFlight: () => true,
    queueView: () => [],
    queueSize: () => 0,
    harnessView: () => ({ phase: 'execute' }),
    budgetMs: 60000,
    maxSteps: 12,
    toolGuard: { SOFT_NOTICE_MS: 1000, STALL_NOTICE_MS: 2000 },
  };
  return Object.assign(value, overrides || {});
}

test('run state observes tools once and exposes a provider-neutral execution view', () => {
  const run = runControl.createState();
  runControl.resetTurn(run, true);
  const policy = () => ({ kind: 'command', hardLimitMs: 90000, timeoutSeconds: 90 });
  runControl.observeEvent(run, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' }, policy);
  runControl.observeEvent(run, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' }, policy);
  assert.equal(run.toolSteps, 1);
  assert.equal(run.activeTools.size, 1);
  const view = runControl.execution(run, context());
  assert.equal(view.step, 1);
  assert.equal(view.tool.name, 'bash');
  assert.equal(view.running, true);
  runControl.observeEvent(run, { type: 'tool_execution_end', toolCallId: 't1' }, policy);
  assert.equal(run.activeTools.size, 0);
});

test('prompt lifecycle and recovery counters reset without leaking state', async () => {
  const run = runControl.createState();
  run.protocolRecoveryCount = 1;
  run.stallRecoveryCount = 1;
  const result = await runControl.promptComplete(run, async (prompt) => prompt.toUpperCase(), 'done', {});
  assert.equal(result, 'DONE');
  assert.equal(run.promptActive, false);
  assert.equal(run.promptReject, null);
  runControl.resetTurn(run, true);
  assert.equal(run.protocolRecoveryCount, 0);
  assert.equal(run.stallRecoveryCount, 0);
  assert.equal(run.stopReason, '');
  assert.equal(run.toolSteps, 0);
});

test('normal completion freezes once while cleanup is fenced and a new turn restarts the clock', () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    const run = runControl.createState();
    runControl.resetTurn(run, true);
    now += 4500;
    runControl.finishTurn(run);
    const completed = runControl.execution(run, context());
    assert.equal(completed.elapsedMs, 4500);
    assert.equal(completed.running, false);
    assert.equal(completed.finalizing, true);
    now += 60000;
    runControl.finishTurn(run);
    assert.equal(runControl.execution(run, context({ inFlight: () => false })).elapsedMs, 4500);
    runControl.resetTurn(run, true);
    now += 2000;
    assert.equal(runControl.execution(run, context()).elapsedMs, 2000);
    assert.equal(runControl.execution(run, context()).running, true);
  } finally { Date.now = originalNow; }
});

test('automatic recovery cleanup keeps its original elapsed budget until the resumed execution completes', () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    for (const pending of ['stallPending', 'protocolPending']) {
      const run = runControl.createState();
      runControl.resetTurn(run, true);
      now += 3000; run[pending] = {};
      runControl.finishTurn(run);
      assert.equal(run.terminalAt, 0);
      now += 2000; run[pending] = null;
      runControl.resetTurn(run, false, true);
      assert.equal(runControl.execution(run, context()).elapsedMs, 5000);
      now += 1000;
      runControl.finishTurn(run);
      now += 60000;
      assert.equal(runControl.execution(run, context({ inFlight: () => false })).elapsedMs, 6000);
    }
  } finally { Date.now = originalNow; }
});

for (const kind of ['stall', 'protocol']) {
  for (const ending of ['budget', 'cancel', 'announcement']) {
    test(kind + ' recovery stopped by ' + ending + ' freezes without starting another model turn', async () => {
      const originalNow = Date.now;
      let now = 100000, inFlight = true, limit = null, phase = 'executing', sends = 0;
      Date.now = () => now;
      const run = runControl.createState();
      const ctx = context({
        goalIntent: 'goal', budgetMs: ending === 'budget' ? 1000 : 60000,
        closed: () => false, inFlight: () => inFlight, status: () => 'idle',
        limitRequest: () => limit, setLimitRequest: value => { limit = value; },
        qualityPhase: () => phase, setQuality: value => { phase = value; },
        setGoalEnabled() {}, setFailedLastTurn() {}, checkpoint() {}, drainTurns() {},
        emit(event) {
          if (ending === 'announcement' && event.kind.endsWith('-recovering')) runControl.cancelPending(run);
        },
        goalPluginIds: () => [], goalPluginProjectId: () => '',
        goalQuality: { continuationPrompt: () => 'Continue' },
        piSession: { isIdle: true, abort: async () => {} },
        acc: { state: { protocolIssue: { code: 'invalid-test-output' } }, abort() {},
          recoverRuntime() {}, appendNotice() {}, snapshot: () => ({}) },
        protocolGuard: { reason: () => 'Invalid test output' },
        send: async () => { sends++; },
      });
      try {
        runControl.resetTurn(run, true);
        now += 2000;
        if (kind === 'stall') {
          run.stalledIncident = { reason: 'Stalled test stream', idleMs: 2000 };
          assert.equal(runControl.scheduleStall(run, { goalMode: true }, ctx).recovering, true);
        } else assert.equal(runControl.scheduleProtocol(run, { goalMode: true }, ctx), true);
        runControl.finishTurn(run); // Original send cleanup leaves its recovery pending.
        assert.equal(run.terminalAt, 0);
        inFlight = false;
        now += 1000;
        if (ending === 'cancel') runControl.cancelPending(run);
        const result = await run.recoveryReceipt.promise;
        assert.equal(result[ending === 'budget' ? 'paused' : 'cancelled'], true);
        assert.equal(sends, 0);
        const stopped = runControl.execution(run, ctx);
        assert.equal(stopped.running, false);
        now += 60000;
        assert.equal(runControl.execution(run, ctx).elapsedMs, stopped.elapsedMs);
        assert.equal(stopped.elapsedMs, 3000);
      } finally { runControl.dispose(run); Date.now = originalNow; }
    });
  }
}

test('a terminal agent stall stops the public clock while turn cleanup is still in flight', () => {
  const run = runControl.createState();
  runControl.resetTurn(run, true);
  run.stallRecoveryCount = 1;
  run.stalledIncident = {
    reason: '模型流已停滞。',
    idleMs: 307000,
    at: Date.now(),
  };
  const notices = [];
  const events = [];
  const ctx = context({
    // The session keeps this true while finishTurnJournal performs its file
    // scan. A terminal stall must already be idle from the user's point of view.
    inFlight: () => true,
    acc: { appendNotice: (value, level) => notices.push({ value, level }) },
    emit: (event) => events.push(event),
  });

  const result = runControl.scheduleStall(run, { request: 'continue' }, ctx);

  assert.equal(result.handled, true);
  assert.equal(result.recovering, false);
  assert.equal(run.stopKind, 'agent-stall');
  assert.ok(run.terminalAt > 0);
  assert.equal(runControl.execution(run, ctx).running, false);
  assert.equal(runControl.execution(run, ctx).stopped, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, 'error');
  assert.deepEqual(events.map((event) => event.kind), ['agent-stall-failed']);

  run.startedAt = run.terminalAt - 1250;
  assert.equal(runControl.execution(run, ctx).elapsedMs, 1250);
  runControl.resetTurn(run, true);
  assert.equal(run.terminalAt, 0);
  assert.equal(runControl.execution(run, ctx).running, true);
});

test('normal conversations stop a runaway tool burst without creating a hidden goal pause', () => {
  const run = runControl.createState();
  runControl.resetTurn(run, true);
  let aborted = 0;
  const notices = [];
  const ctx = context({
    goalEnabled: () => false,
    maxSteps: 0,
    maxToolSteps: 2,
    acc: {
      abort: () => { aborted += 1; },
      appendNotice: (value, level) => notices.push({ value, level }),
    },
    emit: () => {},
  });
  runControl.stopForLimit(run, 'steps', 'tool burst', ctx);
  assert.equal(aborted, 1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, 'error');
  assert.equal(ctx.limitRequest(), null);
  assert.equal(ctx.qualityPhase(), 'executing');
});
