'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const workloads = require('../main/update-workloads');

test('stop uses the runtime cancellation path and remains unsafe until execution acknowledges', async () => {
  let active = true, calls = 0;
  const handle = { ref: 'live', inFlight: () => active, cancel() { calls++; } };
  const sessions = { list: () => [handle], get: ref => ref === 'live' ? handle : null };
  assert.equal((await workloads.stop(sessions, 'live')).stopping, true);
  assert.equal(calls, 1);
  assert.equal(workloads.snapshot(sessions).safe, false);
  active = false;
  assert.equal(workloads.snapshot(sessions).safe, true);
  assert.equal((await workloads.stop(sessions, 'gone')).alreadyStopped, true);
});


test('maintenance gate rejects new local work without touching active work', () => {
  workloads.setDraining(false);
  assert.equal(workloads.guard().ok, true);
  workloads.setDraining(true);
  const denied = workloads.guard();
  assert.equal(denied.ok, false);
  assert.equal(denied.maintenance, true);
  assert.match(denied.reason, /安全升级/);
  workloads.setDraining(false);
});


test('snapshot reports only conversations that still have work in flight', () => {
  const sessions = {
    list: () => [{
      ref: 'chat-running', sessionId: 'session-running',
      inFlight: () => true,
      historyRow: () => ({ title: '生成经营分析', state: 'running' }),
    }, {
      ref: 'chat-idle', sessionId: 'session-idle',
      inFlight: () => false,
      historyRow: () => ({ title: '已经完成', state: 'done' }),
    }],
  };
  const state = workloads.snapshot(sessions);
  assert.equal(state.safe, false);
  assert.equal(state.activeCount, 1);
  assert.equal(state.blockers[0].id, 'session-running');
  assert.equal(state.blockers[0].title, '生成经营分析');
  assert.equal(state.blockers[0].resumable, false);
});


test('snapshot fails closed when a session cannot report its state', () => {
  const state = workloads.snapshot({
    list: () => [{ ref: 'chat-unknown', inFlight: () => { throw new Error('lost'); } }],
  });
  assert.equal(state.safe, false);
  assert.equal(state.blockers.length, 1);
});

test('an idle interrupted conversation stays unsafe until its runtime resources are confirmed reclaimed', () => {
  let pending = [{ ref: 'runtime-cleanup:isolated-generation', kind: 'runtime-cleanup',
    status: 'cleaning', reason: '正在回收该执行服务创建的工具进程', canStop: false }];
  const sessions = { list: () => [{ ref: 'crashed-chat', inFlight: () => false }], maintenanceWorkloads: () => pending };
  let state = workloads.snapshot(sessions);
  assert.equal(state.safe, false); assert.equal(state.activeCount, 1);
  assert.equal(state.blockers[0].ref, 'runtime-cleanup:isolated-generation');
  assert.equal(state.blockers[0].kind, 'runtime-cleanup'); assert.equal(state.blockers[0].status, 'cleaning');
  assert.equal(state.blockers[0].canStop, false); assert.equal(state.blockers[0].resumable, false);
  assert.equal(state.blockers[0].reason, pending[0].reason);
  pending = [{ ...pending[0], status: 'cleanup-failed', reason: '尚未确认工具进程退出' }];
  state = workloads.snapshot(sessions);
  assert.equal(state.safe, false); assert.equal(state.blockers[0].status, 'cleanup-failed');
  assert.equal(state.blockers[0].reason, '尚未确认工具进程退出');
  pending = [];
  assert.equal(workloads.snapshot(sessions).safe, true, 'only confirmed cleanup removes the maintenance blocker');
});

test('cleanup blockers cannot be cancelled or mistaken for an already stopped conversation', async () => {
  let status = 'cleaning', lookups = 0;
  const sessions = { list: () => [], get() { lookups++; return null; }, maintenanceWorkloads: () => [{
    ref: 'runtime-cleanup:isolated-generation', kind: 'runtime-cleanup', status,
    reason: '执行服务资源仍在回收', canStop: false }] };
  await assert.rejects(workloads.stop(sessions, 'runtime-cleanup:isolated-generation'), error =>
    error.code === 'RUNTIME_CLEANUP_PENDING' && error.canStop === false && /仍在回收/.test(error.message));
  status = 'cleanup-failed';
  await assert.rejects(workloads.stop(sessions, 'runtime-cleanup:isolated-generation'), error =>
    error.code === 'RUNTIME_CLEANUP_FAILED' && error.canStop === false);
  assert.equal(lookups, 0, 'resource cleanup must not pass through session cancellation');
  assert.equal(workloads.snapshot(sessions).safe, false);
});

test('ordinary execution and cleanup remain independent blockers until each is acknowledged', async () => {
  let active = true, cancelled = 0, pending = true;
  const handle = { ref: 'live', sessionId: 'native-live', inFlight: () => active,
    cancel() { cancelled++; }, historyRow: () => ({ title: '仍在执行的会话', state: 'running' }) };
  const sessions = { list: () => [handle], get: ref => ref === 'live' ? handle : null,
    maintenanceWorkloads: () => pending ? [{ kind: 'runtime-cleanup', ref: 'runtime-cleanup:older-generation',
      status: 'cleanup-failed', reason: '之前的执行服务尚未确认退出', canStop: false }] : [] };
  let state = workloads.snapshot(sessions);
  assert.equal(state.activeCount, 2); assert.deepEqual(state.blockers.map(row => row.kind), ['conversation', 'runtime-cleanup']);
  assert.equal((await workloads.stop(sessions, 'live')).stopping, true); assert.equal(cancelled, 1);
  assert.equal(workloads.snapshot(sessions).activeCount, 2, 'a cancellation request is not a completion acknowledgement');
  active = false;
  state = workloads.snapshot(sessions); assert.equal(state.safe, false); assert.equal(state.activeCount, 1);
  pending = false; assert.equal(workloads.snapshot(sessions).safe, true);
  assert.equal((await workloads.stop(sessions, 'runtime-cleanup:older-generation')).alreadyStopped, true);
});

test('unavailable or malformed cleanup evidence fails closed without hiding ordinary work', async () => {
  const handle = { ref: 'live', inFlight: () => true, cancel() {} };
  const sessions = { list: () => [handle], get: ref => ref === 'live' ? handle : null,
    maintenanceWorkloads: () => { throw Error('snapshot unavailable'); } };
  let state = workloads.snapshot(sessions);
  assert.equal(state.safe, false); assert.equal(state.activeCount, 2);
  assert.equal(state.blockers[1].status, 'cleanup-failed'); assert.equal(state.blockers[1].canStop, false);
  assert.equal((await workloads.stop(sessions, 'live')).stopping, true);
  await assert.rejects(workloads.stop(sessions, 'runtime-cleanup:unknown-generation'), error =>
    error.code === 'RUNTIME_CLEANUP_FAILED');
  sessions.maintenanceWorkloads = () => ({ cleanup: 'unknown' });
  state = workloads.snapshot(sessions); assert.equal(state.safe, false); assert.equal(state.activeCount, 2);
  sessions.maintenanceWorkloads = () => [];
  assert.equal(workloads.snapshot(sessions).activeCount, 1, 'ordinary execution is still independently active');
});
