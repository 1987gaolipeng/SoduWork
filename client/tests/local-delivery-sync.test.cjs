'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../main/conversation/local-delivery-sync');
const { scope } = require('../main/platform-connections/runtime.cjs');
function identity(user = 'alice', hub = 'http://localhost:9999', clientId = 'desktop') {
  const now = Math.floor(Date.now() / 1000);
  return { hub, clientId, session: Buffer.from(JSON.stringify({ typ: 'device', cid: clientId, uid: user, iat: now, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function until(predicate) { for (let i = 0; i < 80; i++) { if (predicate()) return; await tick(); } assert.fail('Timed out'); }
function fixture(options = {}) {
  let snapshot = { status: 'idle' }, inflight = false, reads = 0;
  const handle = { ref: 'test', sessionId: 'test', detached: true, inFlight: () => inflight, snapshot: () => snapshot };
  const manager = create({ snapshotFiles: () => { reads++; return { items: [
    { artifactId: 'result', changedInTurn: true, primary: true, at: 10, size: 20 },
    { artifactId: 'evidence', changedInTurn: true, processEvidence: true }] }; }, ...options });
  manager.bind(handle, identity());
  return { handle, manager, reads: () => reads, snapshot: value => snapshot = value, inflight: value => inflight = value };
}
test('completed detached conversations remain local and never package, authenticate or upload', async t => {
  const calls = [];
  t.mock.method(global, 'fetch', async () => { calls.push('network'); throw Error('unexpected network'); });
  const f = fixture({ identityOf: () => calls.push('auth'), prepare: () => calls.push('package'), upload: () => calls.push('upload') });
  f.manager.observe(f.handle, { kind: 'turn-finished' }, f.handle.snapshot());
  await until(() => f.handle.deliverySync.artifactIds.length);
  assert.deepEqual(f.handle.deliverySync.artifactIds, ['result']);
  assert.equal(f.handle.deliverySync.state, 'local');
  assert.equal(f.handle.deliverySync.delivery, undefined);
  assert.equal(f.handle.deliveryOwner, scope(identity()));
  f.manager.observe(f.handle, { kind: 'settled' }, f.handle.snapshot()); await tick();
  assert.deepEqual(calls, []);
});
test('early settlement waits for completion and excludes incomplete work', async () => {
  const f = fixture(); f.inflight(true); f.manager.observe(f.handle, { kind: 'settled' }, f.handle.snapshot()); await tick();
  assert.equal(f.reads(), 0); f.inflight(false); await until(() => f.reads() > 0);
  for (const snapshot of [{ status: 'incomplete' }, { status: 'idle', execution: { stopped: true } }, { status: 'idle', pendingUi: {} }, { status: 'idle', execution: { quality: { phase: 'blocked' } } }]) {
    const g = fixture(); g.snapshot(snapshot); g.manager.observe(g.handle, { kind: 'turn-finished' }, snapshot); await tick(); assert.equal(g.reads(), 0);
  }
});
test('a new file version remains unsaved and a text-only follow-up does not claim a new result', async () => {
  let at = 10;
  const f = fixture({ snapshotFiles: () => ({ items: [{ artifactId: 'result', primary: true, changedInTurn: true, at, size: 20 }] }) });
  await f.handle.captureDelivery(); assert.equal(f.handle.deliverySync.currentTurn, true);
  await f.handle.captureDelivery(); assert.equal(f.handle.deliverySync.currentTurn, false);
  at++; await f.handle.captureDelivery();
  assert.equal(f.handle.deliverySync.currentTurn, true); assert.equal(f.handle.deliverySync.state, 'local');
  assert.deepEqual(f.handle.deliverySync.artifactVersions, [{ id: 'result', at: 11, size: 20 }]);
});
test('shared turn queue indexes each result without storing it or delaying the next turn for network', async () => {
  const { createTurnQueue } = require('../main/pi-session/turn-queue');
  let current = '', indexed = [];
  const f = fixture({ snapshotFiles: () => ({ items: [{ artifactId: current, changedInTurn: true, primary: true }] }),
    notify: handle => indexed.push(handle.deliverySync.artifactIds) });
  f.handle.deliveryCaptureAtTurnBoundary = true;
  const queue = createTurnQueue(undefined, () => f.handle.captureDelivery());
  for (const name of ['one', 'two']) {
    const turn = queue.add({ text: name }); await queue.run(queue.take(), async () => { current = name; return { ok: true }; });
    assert.equal((await turn.completion).ok, true);
  }
  assert.deepEqual(indexed, [['one'], ['two']]); assert.equal(f.handle.deliverySync.state, 'local');
});
test('index failure and passive cloud views never trigger saving or fail the turn', async () => {
  const f = fixture({ snapshotFiles: async () => { throw Error('unavailable'); } });
  await assert.doesNotReject(f.handle.captureDelivery()); assert.equal(f.handle.deliverySync.state, 'local');
  const g = fixture(); g.handle.passiveCloudView = true; await g.handle.captureDelivery(); assert.equal(g.reads(), 0);
});
test('supporting-only edits invalidate the previous saved UI revision', async () => {
  let at = 10;
  const f = fixture({ snapshotFiles: () => ({ delivery: { source: 'manifest' }, items: [
    { artifactId: 'entry', primary: true, at: 1, size: 20 },
    { artifactId: 'style', primary: false, role: 'supporting', at, size: 10 }] }) });
  await f.handle.captureDelivery(); const original = f.handle.deliverySync.revision;
  at++; await f.handle.captureDelivery();
  assert.notEqual(f.handle.deliverySync.revision, original); assert.equal(f.handle.deliverySync.currentTurn, true);
  assert.equal(f.handle.deliverySync.state, 'local'); assert.deepEqual(f.handle.deliverySync.artifactIds, ['entry']);
});

test('a later result does not carry previously confirmed inferred files into its collection', async () => {
  let items = [{artifactId:'markdown',primary:true,changedInTurn:true,at:10,size:20}];
  const f = fixture({snapshotFiles:()=>({delivery:{source:'inferred',items},items})});
  await f.handle.captureDelivery();
  assert.deepEqual(f.handle.deliverySync.artifactIds, ['markdown']);
  items = [{...items[0],changedInTurn:false}, {artifactId:'word',primary:true,changedInTurn:true,at:11,size:40}];
  await f.handle.captureDelivery();
  assert.deepEqual(f.handle.deliverySync.artifactIds, ['word']);
});

test('a delayed index from the previous turn cannot replace the new turn state', async () => {
  let release;
  const f = fixture({ snapshotFiles: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.handle.captureDelivery();
  f.manager.observe(f.handle, {}, { status: 'streaming' });
  release({ items: [{ artifactId: 'old-result', primary: true, changedInTurn: true }] }); await pending;
  assert.deepEqual(f.handle.deliverySync.artifactIds, []);
  const next = f.handle.captureDelivery();
  release({ items: [{ artifactId: 'new-result', primary: true, changedInTurn: true }] }); await next;
  assert.deepEqual(f.handle.deliverySync.artifactIds, ['new-result']);
  assert.equal(f.handle.deliverySync.state, 'local');
});
