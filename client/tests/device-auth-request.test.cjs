'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../main/device-auth-request');
const { fetchWithDeviceAuthRetry } = auth;
const { identity: accountIdentity, sessions } = require('./helpers/platform-session-fixture.cjs');

test('the established Pi path shares the canonical auth object and patch points', () => {
  const legacy = require('../main/pi-session/device-auth-request');
  assert.equal(legacy, auth);
  const original = auth.fetchWithDeviceAuthRetry;
  const patched = () => {};
  try {
    legacy.fetchWithDeviceAuthRetry = patched;
    assert.equal(auth.fetchWithDeviceAuthRetry, patched);
  } finally {
    auth.fetchWithDeviceAuthRetry = original;
  }
});

test('expired account sessions renew once with the same account and preserve request headers', async t => {
  const calls = [];
  const identity = { ...accountIdentity('expired'), secret: 'k'.repeat(40) };
  const renewed = { ...identity, session: sessions().renewed };
  auth.setIdentityRefresher(async before => { assert.equal(before.session, identity.session); return renewed; });
  t.after(() => auth.setIdentityRefresher(null));
  const response = await fetchWithDeviceAuthRetry(identity, 'https://hub.test/route', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }, async (_url, options) => {
    calls.push(options);
    return calls.length === 1 ? { status: 401, ok: false } : { status: 200, ok: true };
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, 'Device ' + identity.session);
  assert.equal(calls[1].headers['X-Soduwork-Secret'], undefined);
  assert.equal(calls[1].headers.Authorization, 'Device ' + renewed.session);
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
});

for (const [boundary, patch] of [
  ['account', () => ({ session: sessions().two })], ['Hub', () => ({ hub: 'https://other.invalid' })],
  ['device', () => ({ clientId: 'device-two', session: sessions().otherDevice })],
  ['missing account proof', () => ({ session: sessions().missingUid })], ['missing session', () => ({ session: '' })],
]) test('a rejected old session cannot retry after a change in ' + boundary, async t => {
  const identity = { ...accountIdentity('expired'), secret: 'fixture-secret' }, calls = [];
  auth.setIdentityRefresher(async () => ({ ...identity, session: sessions().renewed, ...patch() }));
  t.after(() => auth.setIdentityRefresher(null));
  const rejected = { status: 401, ok: false };
  const result = await fetchWithDeviceAuthRetry(identity, identity.hub + '/api/v1/tasks', {}, async (_, options) => {
    calls.push(options); return calls.length === 1 ? rejected : { status: 200, ok: true, account: 'wrong-account' };
  });
  assert.equal(result, rejected); assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['X-Soduwork-Secret'], undefined);
});

test('401 without a trusted refresher or original account proof never downgrades to a device key', async t => {
  let refreshes = 0, requests = 0;
  auth.setIdentityRefresher(async () => { refreshes++; return accountIdentity(); });
  t.after(() => auth.setIdentityRefresher(null));
  const identity = { hub: 'https://fixture.invalid', clientId: 'device', session: 'opaque-old-token', secret: 'fixture-key' };
  const fetch = async (_, options) => { requests++; assert.equal(options.headers['X-Soduwork-Secret'], undefined); return { status: 401 }; };
  assert.equal((await fetchWithDeviceAuthRetry(identity, identity.hub, {}, fetch)).status, 401);
  assert.equal(refreshes, 0);
  auth.setIdentityRefresher(null);
  assert.equal((await fetchWithDeviceAuthRetry(accountIdentity(), identity.hub, {}, fetch)).status, 401);
  assert.equal(requests, 2);
});

test('a device without an account token keeps its initial bootstrap credential and does not retry', async () => {
  const calls = [], identity = { clientId: 'device', secret: 'fixture-key' };
  const result = await fetchWithDeviceAuthRetry(identity, 'https://fixture.invalid/api/v1/clients/enroll', {}, async (_, options) => {
    calls.push(options); return { status: 401 };
  });
  assert.equal(result.status, 401); assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['X-Soduwork-Secret'], identity.secret);
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('identity renewal shares the original request cancellation and never sends a late retry', async t => {
  let resolveRenewal, calls = 0;
  auth.setIdentityRefresher(() => new Promise(resolve => { resolveRenewal = resolve; }));
  t.after(() => auth.setIdentityRefresher(null));
  const controller = new AbortController();
  const pending = fetchWithDeviceAuthRetry(accountIdentity('expired'), 'https://fixture.invalid/api/v1/tasks',
    { signal: controller.signal }, async () => { calls++; return { status: 401 }; });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(Error('fixture deadline'));
  await assert.rejects(pending, /fixture deadline/);
  resolveRenewal(accountIdentity()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});
