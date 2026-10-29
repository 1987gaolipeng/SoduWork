'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const control = require('../main/pi-session/run-control');
const recovery = require('../main/pi-session/stall-recovery');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const state = control.createState(), sent = [], notices = [], emitted = [];
  let closed = false, waiting = false, aborts = 0;
  const ctx = { acc: { abort() {}, recoverRuntime() {}, appendNotice: message => notices.push(message), snapshot: () => ({}) },
    goalIntent: 'chat', goalEnabled: () => false, setGoalEnabled() {}, setFailedLastTurn() {},
    closed: () => closed, inFlight: () => false, endGoalTurn() {}, drainTurns() {},
    status: () => waiting ? 'waiting-user' : 'streaming', waitingPermission: () => waiting,
    budgetMs: 0, emit: event => emitted.push(event),
    piSession: { isIdle: true, async abort() { aborts++; } },
    send: async (...args) => { sent.push(args); return { ok: true }; },
  };
  return { state, ctx, sent, notices, emitted, close: () => { closed = true; },
    wait: value => { waiting = value; }, get aborts() { return aborts; } };
}
test('silent provider recovery never starts before the old native run actually exits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.ctx.piSession.isIdle = false;
  f.state.abortPromise = new Promise(() => {});
  f.state.stalledIncident = { reason: 'silent', idleMs: recovery.HARD_IDLE_MS };
  assert.equal(control.scheduleStall(f.state, { request: 'finish' }, f.ctx).recovering, true);
  const receipt = f.state.recoveryReceipt;
  await flush(); t.mock.timers.tick(recovery.ABORT_SETTLE_MS); await flush();
  const result = await receipt.promise;
  assert.equal(f.sent.length, 0, 'a timed-out abort is not proof of native termination');
  assert.equal(result.ok, false);
});
test('internal recovery keeps the original explicit time, tool and no-progress budgets', () => {
  const state = control.createState(); control.resetTurn(state, true);
  state.startedAt = 1234; state.toolSteps = 9; state.toolProgress.noProgress = 7;
  state.toolIds.add('completed-write');
  control.resetTurn(state, false, true);
  assert.equal(state.startedAt, 1234); assert.equal(state.toolSteps, 9);
  assert.equal(state.toolProgress.noProgress, 7); assert.ok(state.toolIds.has('completed-write'));
});
test('watchdog activity, permission waits and native recovery obey their bounded lifecycle', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000000 });
  const f = fixture(); control.resetTurn(f.state, true); f.state.promptActive = true;
  control.startMonitor(f.state, f.ctx); t.after(() => control.dispose(f.state));
  t.mock.timers.tick(recovery.HARD_IDLE_MS - 10000);
  assert.equal(f.aborts, 0);
  control.observeEvent(f.state, { type: 'message_update' }, () => ({}));
  t.mock.timers.tick(20000); assert.equal(f.aborts, 0, 'new activity resets the silence clock');
  f.wait(true); t.mock.timers.tick(recovery.HARD_IDLE_MS); assert.equal(f.aborts, 0);
  f.wait(false); t.mock.timers.tick(10000); assert.equal(f.aborts, 1);
  f.state.promptActive = false;
  assert.equal(control.scheduleStall(f.state, { request: 'finish' }, f.ctx).recovering, true);
  await f.state.recoveryReceipt.promise;
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][2].runtimeRecovery, true);
  f.state.stalledIncident = { reason: 'silent again', idleMs: recovery.HARD_IDLE_MS };
  assert.equal(control.scheduleStall(f.state, {}, f.ctx).recovering, false);
  assert.equal(f.sent.length, 1, 'one silent-stream recovery per submitted turn');
});
for (const action of ['cancel', 'close']) test(action + ' prevents deferred automatic restart', async () => {
  const f = fixture(); f.state.stalledIncident = { reason: 'silent', idleMs: recovery.HARD_IDLE_MS };
  control.scheduleStall(f.state, { request: 'finish' }, f.ctx);
  if (action === 'cancel') control.cancelPending(f.state); else f.close();
  await f.state.recoveryReceipt.promise; await flush();
  assert.equal(f.sent.length, 0);
});
