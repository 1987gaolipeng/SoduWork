'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { create } = require('../main/conversation/local-delivery-sync');
const { scope } = require('../main/platform-connections/runtime.cjs');

function identity(hub = 'http://localhost:9999', clientId = 'desktop', signature = 'a') {
  const now = Math.floor(Date.now() / 1000);
  const claims = { typ: 'device', cid: clientId, uid: 'same-user', iat: now, exp: now + 3600 };
  return { hub, clientId, session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + signature.repeat(64) };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('delivery did not settle');
}
const result = () => ({ manifest: { revision: 'original' }, bytes: Buffer.from('private original file'),
  contentType: 'text/plain', filename: 'report.txt' });
function fixture(initial, overrides = {}) {
  let current = initial;
  const calls = [];
  const handle = { sessionId: 'local-session', snapshot: () => ({ status: 'idle' }) };
  const manager = create({ app: {}, identityOf: async () => current,
    snapshotFiles: () => ({ items: [{ artifactId: 'report', primary: true, changedInTurn: true }] }),
    prepare: async () => result(), upload: async (account, payload) => {
      calls.push({ account, payload }); return { id: 'saved' };
    }, ...overrides });
  manager.bind(handle, initial);
  return { manager, handle, calls, account: next => { current = next; } };
}

for (const [label, next] of [
  ['Hub address', identity('http://localhost:9998')],
  ['device registration', identity('http://localhost:9999', 'new-device')],
  ['Hub base path on the same origin', identity('http://localhost:9999/another-hub')],
]) {
  test(`switching ${label} during capture cancels upload even with the same user id`, async () => {
    const gate = deferred(), started = deferred(); let cancelled = 0;
    const f = fixture(identity(), { prepare: async () => {
      started.resolve(); await gate.promise; return { ...result(), cancel: () => cancelled++ };
    } });
    const captured = f.handle.captureDelivery(); await started.promise;
    f.account(next); gate.resolve(); await captured;
    await until(() => f.handle.deliverySync.state === 'failed');
    assert.equal(f.calls.length, 0); assert.equal(cancelled, 1);
    assert.match(f.handle.deliverySync.error, /连接已切换.*文件已保留/);
    assert.equal(f.handle.deliveryOwner, scope(next), 'local account ownership remains portable');
  });
}

test('Hub switch during background packaging rechecks the destination before upload', async () => {
  const gate = deferred(); let checks = 0, current = identity();
  const f = fixture(current, {
    identityOf: async () => { checks++; return current; },
    prepare: async () => ({ manifest: result().manifest, payload: gate.promise }),
  });
  await f.handle.captureDelivery(); await until(() => checks === 1);
  current = identity('http://localhost:9998'); gate.resolve(result());
  await until(() => f.handle.deliverySync.state === 'failed');
  assert.equal(f.calls.length, 0); assert.equal(checks, 2);
});

test('rebinding the same account to another Hub discards an obsolete capture and cancels its worker', async () => {
  const gate = deferred(), started = deferred(); let cancelled = 0;
  const f = fixture(identity(), { prepare: async () => {
    started.resolve(); await gate.promise; return { ...result(), cancel: () => cancelled++ };
  } });
  const captured = f.handle.captureDelivery(); await started.promise;
  const next = identity('http://localhost:9998');
  f.account(next); f.manager.bind(f.handle, next);
  gate.resolve(); await captured;
  assert.equal(cancelled, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.handle.deliverySync.state, 'local');
});

test('token renewal on the original connection keeps pending work and uses the refreshed token', async () => {
  const gate = deferred(), started = deferred();
  const original = identity(), refreshed = identity(original.hub + '/', original.clientId, 'b');
  const f = fixture(original, { prepare: async () => { started.resolve(); await gate.promise; return result(); } });
  const captured = f.handle.captureDelivery(); await started.promise;
  f.account(refreshed); f.manager.bind(f.handle, refreshed);
  gate.resolve(); await captured;
  await until(() => f.handle.deliverySync.state === 'synced');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].account.session, refreshed.session);
});

test('a late upload receipt cannot mark the new connection as synced', async () => {
  const gate = deferred(), started = deferred();
  const f = fixture(identity(), { upload: async () => { started.resolve(); await gate.promise; return { id: 'old-hub' }; } });
  await f.handle.captureDelivery(); await started.promise;
  f.account(identity('http://localhost:9998')); gate.resolve();
  await until(() => f.handle.deliverySync.state === 'failed');
  assert.equal(f.handle.deliverySync.delivery, undefined);
});

async function endpoint(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ delivery: { id: 'stored' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, hub: `http://127.0.0.1:${server.address().port}` };
}

test('real uploader sends no original file to a switched Hub and can retry on the original connection', async t => {
  const first = await endpoint(t), second = await endpoint(t), original = identity(first.hub);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-delivery-connection-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'report.txt'); await fs.writeFile(file, result().bytes);
  const metadata = await fs.stat(file);
  const gate = deferred(), started = deferred(); let captures = 0;
  const f = fixture(original, { upload: undefined, prepare: async () => {
    if (++captures === 1) { started.resolve(); await gate.promise; }
    return { ...result(), fileVersions: [{ path: 'report.txt', ...metadata }] };
  } });
  f.handle.cwd = cwd;
  const captured = f.handle.captureDelivery(); await started.promise;
  f.account(identity(second.hub)); gate.resolve(); await captured;
  await until(() => f.handle.deliverySync.state === 'failed');
  assert.deepEqual(first.requests, []); assert.deepEqual(second.requests, []);
  f.account(original); await f.handle.captureDelivery();
  await until(() => f.handle.deliverySync.state === 'synced');
  assert.equal(first.requests.length, 1); assert.deepEqual(second.requests, []);
  assert.equal(first.requests[0].url, '/api/v1/deliveries');
  assert.match(first.requests[0].body, /private original file/);
  assert.equal(first.requests[0].auth, 'Device ' + original.session);
});
