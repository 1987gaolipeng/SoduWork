'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../main/conversation/local-delivery-sync');
const { scope } = require('../main/platform-connections/runtime.cjs');
function identity(user = 'alice', hub = 'http://localhost:9999', clientId = 'desktop') {
  const now = Math.floor(Date.now() / 1000);
  return { hub, clientId, session: Buffer.from(JSON.stringify({ typ: 'device', cid: clientId, uid: user, iat: now, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
}
for (const [label, next] of [
  ['account', identity('bob')], ['Hub address', identity('alice', 'http://localhost:9998')],
  ['device', identity('alice', 'http://localhost:9999', 'new-device')],
  ['Hub base path', identity('alice', 'http://localhost:9999/another-hub')],
]) test(`rebinding ${label} discards an obsolete local index without any upload`, async t => {
  let release; const calls = [];
  t.mock.method(global, 'fetch', async () => calls.push('network'));
  const handle = { snapshot: () => ({ status: 'idle' }) };
  const manager = create({ snapshotFiles: () => new Promise(resolve => { release = resolve; }) });
  manager.bind(handle, identity()); const captured = handle.captureDelivery();
  manager.bind(handle, next); release({ items: [{ artifactId: 'old-result', primary: true, changedInTurn: true }] }); await captured;
  assert.equal(handle.deliveryOwner, scope(next)); assert.deepEqual(handle.deliverySync.artifactIds, []);
  assert.equal(handle.deliverySync.state, 'local'); assert.deepEqual(calls, []);
});
test('token renewal on the same connection retains local file metadata, never inventing a save receipt', async () => {
  const handle = { snapshot: () => ({ status: 'idle' }) }, manager = create({ snapshotFiles: () => ({ items: [{ artifactId: 'result', primary: true, changedInTurn: true }] }) });
  const original = identity(); manager.bind(handle, original); await handle.captureDelivery();
  manager.bind(handle, { ...original, hub: original.hub + '/' });
  assert.deepEqual(handle.deliverySync.artifactIds, ['result']); assert.equal(handle.deliverySync.delivery, undefined);
});
