'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../main/conversation/local-delivery-sync');
function identity(user = 'alice') {
  const now = Math.floor(Date.now() / 1000);
  return { hub: 'http://localhost:9999', clientId: 'desktop', session: Buffer.from(JSON.stringify({ typ: 'device', cid: 'desktop', uid: user, iat: now, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function until(test) { for (let i = 0; i < 80; i++) { if (test()) return; await tick(); } assert.fail('Timed out'); }
function fixture(options = {}) {
  let account = identity(), snapshot = { status: 'idle' }, inflight = false, uploads = 0;
  const handle = { ref: 'test', sessionId: 'test', detached: true, inFlight: () => inflight, snapshot: () => snapshot };
  const manager = create({ app: {}, identityOf: async () => account, snapshotFiles: () => ({ items: [{ artifactId: 'result', changedInTurn: true, primary: true }, { artifactId: 'evidence', changedInTurn: true, processEvidence: true }] }),
    prepare: async (_handle, ids) => { assert.deepEqual(ids, ['result']); return { manifest: { revision: 'v1' }, bytes: Buffer.from('result') }; },
    upload: async () => { uploads++; return { id: 'stored-result' }; }, ...options });
  manager.bind(handle, account);
  return { handle, manager, uploads: () => uploads, account: value => account = value, snapshot: value => snapshot = value, inflight: value => inflight = value };
}
test('detached session publishes once without renderer; duplicate settled is idempotent', async () => {
  const f = fixture(); f.manager.observe(f.handle, { kind: 'turn-finished' }, f.handle.snapshot());
  await until(() => f.handle.deliverySync.state === 'synced'); assert.equal(f.uploads(), 1);
  f.manager.observe(f.handle, { kind: 'settled' }, f.handle.snapshot()); await tick(); await tick();
  assert.equal(f.uploads(), 1);
});
test('early model settled waits for runtime completion; stopped and blocked work do not publish', async () => {
  const f = fixture(); f.inflight(true); f.manager.observe(f.handle, { kind: 'settled' }, f.handle.snapshot()); await tick();
  assert.equal(f.uploads(), 0); f.inflight(false); f.manager.observe(f.handle, { kind: 'turn-finished' }, f.handle.snapshot());
  await until(() => f.uploads() === 1);
  for (const snapshot of [{ status: 'incomplete' }, { status: 'idle', execution: { stopped: true } }, { status: 'idle', pendingUi: {} }, { status: 'idle', execution: { quality: { phase: 'blocked' } } }]) {
    const g = fixture(); g.snapshot(snapshot); g.manager.observe(g.handle, { kind: 'turn-finished' }, snapshot); await tick(); assert.equal(g.uploads(), 0);
  }
});
test('switching account during file preparation never uploads previous user files', async () => {
  let release, prepared = false;
  const f = fixture({ prepare: async () => { prepared = true; await new Promise(resolve => release = resolve); return { manifest: { revision: 'v1' } }; } });
  f.manager.observe(f.handle, { kind: 'turn-finished' }, f.handle.snapshot()); await until(() => prepared);
  f.account(identity('bob')); release(); await tick(); await tick(); assert.equal(f.uploads(), 0);
});

test('account rebind during capture terminates its obsolete packaging worker', async () => {
  let release,prepared=false,canceled=0;
  const f=fixture({prepare:async()=>{prepared=true;await new Promise(resolve=>release=resolve);return{manifest:{revision:'v1'},cancel:()=>canceled++}}});
  const captured=f.handle.captureDelivery();await until(()=>prepared);
  const other=identity('bob');f.account(other);f.manager.bind(f.handle,other);
  release();await captured;assert.equal(canceled,1);assert.equal(f.uploads(),0);
  assert.equal(f.handle.deliverySync.state,'local');
});
test('new turn while storage is slow is collected after prior upload, without losing completion', async () => {
  let release, uploads = 0, revision = 1;
  const f = fixture({ prepare: async () => ({ manifest: { revision: 'v' + revision } }), upload: async () => {
    uploads++; if (uploads === 1) await new Promise(resolve => release = resolve); return { id: 'result-' + uploads };
  } });
  f.manager.observe(f.handle, { kind: 'turn-finished' }, f.handle.snapshot()); await until(() => uploads === 1);
  revision++; f.manager.observe(f.handle, { kind: 'turn-finished' }, f.handle.snapshot()); release();
  await until(() => uploads === 2 && f.handle.deliverySync.state === 'synced'); assert.equal(f.handle.deliverySync.delivery.id, 'result-2');
});
test('upload failure keeps local delivery retryable and never throws into the session callback', async () => {
  const f = fixture({ upload: async () => { throw Error('fetch failed'); } });
  assert.doesNotThrow(() => f.manager.observe(f.handle, { kind: 'turn-finished' }, f.handle.snapshot()));
  await until(() => f.handle.deliverySync.state === 'failed'); assert.match(f.handle.deliverySync.error, /文件已保留/);
});

test('Runner settled before queue release is retried without requiring a renderer or Pi event', async () => {
  const f = fixture(); f.inflight(true); f.manager.observe(f.handle, { kind: 'settled' }, f.handle.snapshot());
  await tick(); await tick(); f.inflight(false);
  await until(() => f.handle.deliverySync.state === 'synced'); assert.equal(f.uploads(), 1);
});

test('shared turn queue freezes each final result before a subsequent turn overwrites it', async () => {
  const { createTurnQueue } = require('../main/pi-session/turn-queue');
  let current = '', release, uploaded = [];
  const f = fixture({ snapshotFiles: () => ({ items: [{ artifactId: current, changedInTurn: true, primary: true, at: current }] }),
    prepare: async (_handle, ids, options) => { assert.equal(options.completedTurn, true); await tick(); return {manifest:{revision:ids[0]},bytes:Buffer.from(current)}; },
    upload: async (_identity, payload) => { const text = payload.bytes.toString(); uploaded.push(text); if (uploaded.length === 1) await new Promise(resolve => release = resolve); return {id:text}; }
  });
  f.handle.deliveryCaptureAtTurnBoundary = true;
  const queue = createTurnQueue(undefined, () => f.handle.captureDelivery());
  for (const name of ['one', 'two']) {
    const turn = queue.add({text:name}); await queue.run(queue.take(), async () => { current = name; return {ok:true}; });
    assert.equal((await turn.completion).ok, true);
  }
  await until(() => uploaded.length === 1); assert.equal(current, 'two'); release();
  await until(() => uploaded.length === 2); assert.deepEqual(uploaded, ['one', 'two']);
});

test('expired account token never falls back to a device secret on upload', async t => {
  const { publish } = require('../main/conversation/local-delivery-sync');
  const calls = [], original = global.fetch; t.after(() => global.fetch = original);
  global.fetch = async (_url, options) => { calls.push(options.headers); return new Response('{}', {status:401}); };
  await assert.rejects(publish({...identity(),secret:'device-now-owned-by-bob'}, {manifest:{revision:'one'},bytes:Buffer.from('private'),filename:'report.txt'}));
  assert.equal(calls.length, 1); assert.equal(Object.keys(calls[0]).join(','), 'Authorization');
});

test('file capture does not wait for authentication renewal or network publication', async () => {
  let renew, checked = false;
  const account = identity(), handle = {sessionId:'offline',snapshot:()=>({status:'idle'})};
  const manager = create({app:{},identityOf:()=>{checked=true;return new Promise(resolve=>renew=resolve)},
    snapshotFiles:()=>({items:[{artifactId:'report',primary:true,changedInTurn:true}]}),
    prepare:async()=>({manifest:{revision:'one'},bytes:Buffer.from('original')}),upload:async()=>({id:'saved'})});
  manager.bind(handle,account);
  await handle.captureDelivery();
  await until(()=>checked);
  assert.equal(handle.deliverySync.state,'saving');
  renew(account); await until(()=>handle.deliverySync.state==='saving');
  // The post-upload account check uses the same renewal hook; let it complete.
  await tick(); renew(account); await until(()=>handle.deliverySync.state==='synced');
});
