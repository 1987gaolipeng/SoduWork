'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const capabilities = require('../main/conversation/capabilities');

async function fixture(t, handler) {
  const sockets = new Set();
  let closing = false;
  const server = http.createServer((req, res) => {
    res.setHeader('Connection', 'close');
    handler(req, res);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closing) socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    // Drain aborted bodies and late connections before another fixture starts.
    closing = true;
    if (process.platform === 'win32') await new Promise(resolve => setTimeout(resolve, 100));
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await closed;
    capabilities._policyCache.clear();
    capabilities._policyPending.clear();
  });
  return { hub: `http://127.0.0.1:${server.address().port}`, clientId: 'fixture-device', session: 'fixture-session' };
}

test('a cold catalog beyond the old 4.5s deadline succeeds within the shared default budget', { timeout: 15000 }, async t => {
  const identity = await fixture(t, (req, res) => {
    assert.equal(req.url, '/api/v1/skills');
    assert.equal(req.headers.authorization, 'Device fixture-session');
    const timer = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ skills: [{ name: 'fixture-skill' }], enabled: ['fixture-skill'] }));
    }, 4800);
    res.on('close', () => clearTimeout(timer));
  });
  const [old, current] = await Promise.all([
    capabilities.fetchPolicy(identity, 4500, (...args) => fetch(...args)),
    capabilities.fetchPolicy(identity, undefined, undefined, true),
  ]);
  assert.equal(old.ok, false);
  assert.match(old.reason, /策略超时/);
  assert.equal(current.ok, true);
  assert.deepEqual(current.enabled, ['fixture-skill']);
});

test('a stalled response body times out, fails closed, and permits a fresh retry', async t => {
  let stalled = true;
  const identity = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (stalled) { res.write('{'); return; }
    res.end(JSON.stringify({ skills: [], enabled: [], revoked: ['fixture-skill'] }));
  });
  const result = await capabilities.fetchPolicy(identity, 250, undefined, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /策略超时/);
  assert.deepEqual(result.skills, []);
  assert.equal(capabilities._policyPending.size, 0);
  assert.equal(capabilities._policyCache.size, 0);
  stalled = false;
  const retried = await capabilities.fetchPolicy(identity, 1000, undefined, true);
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.revoked, ['fixture-skill']);
});

test('same-account renewal and the retried policy request share one total deadline', async t => {
  let requests = 0;
  const auth = require('../main/device-auth-request'), { sessions } = require('./helpers/platform-session-fixture.cjs');
  const tokens = sessions();
  const identity = await fixture(t, (req, res) => {
    requests++;
    if (req.headers.authorization === 'Device ' + tokens.expired) {
      const timer = setTimeout(() => { res.writeHead(401); res.end('{}'); }, 100);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    assert.equal(req.headers.authorization, 'Device ' + tokens.renewed);
    assert.equal(req.headers['x-soduwork-secret'], undefined);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
  });
  identity.clientId = 'device'; identity.session = tokens.expired;
  auth.setIdentityRefresher(async () => ({ ...identity, session: tokens.renewed }));
  t.after(() => auth.setIdentityRefresher(null));
  const began = Date.now();
  const result = await capabilities.fetchPolicy({ ...identity, secret: 'fixture-secret' }, 400, undefined, true);
  assert.equal(requests, 2);
  assert.equal(result.ok, false);
  assert.match(result.reason, /策略超时/);
  assert(Date.now() - began < 1000, 'renewal must not reset the request deadline');
});
