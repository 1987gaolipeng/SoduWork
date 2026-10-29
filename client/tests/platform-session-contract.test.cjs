'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../main/platform-connections/runtime.cjs');
const { sessions, identity, backendSessions, backendAvailable } = require('./helpers/platform-session-fixture.cjs');

test('real Hub device session scopes all platform connections; renewal keeps the same account', t => {
  if (!backendAvailable()) { t.skip('Backend venv required; set SODUWORK_TEST_PYTHON for real issuer contract.'); return; }
  const f = backendSessions(), current = { ...identity(), session: f.one };
  assert.equal(f.one.split('.').length, 2);
  assert.notEqual(f.one, f.renewed);
  assert.match(runtime.scope(current), /^[a-f0-9]{32}$/);
  assert.equal(runtime.scope(current), runtime.scope({ ...current, session: f.renewed }));
  assert.notEqual(runtime.scope(current), runtime.scope({ ...current, session: f.two }));
  const otherDevice = { ...current, clientId: 'device-two', session: f.otherDevice };
  const otherHub = { ...current, hub: 'https://other.invalid' };
  assert.equal(runtime.scope(current), runtime.scope(otherDevice));
  assert.equal(runtime.scope(current), runtime.scope(otherHub));
  assert.equal(runtime.connectionScope(current), runtime.connectionScope({ ...current, session: f.renewed }));
  assert.notEqual(runtime.connectionScope(current), runtime.connectionScope(otherDevice));
  assert.notEqual(runtime.connectionScope(current), runtime.connectionScope(otherHub));
});

test('platform ownership rejects expired, future, non-device, unbound and malformed sessions', () => {
  const f = sessions(), current = identity();
  const payload = f.one.split('.')[0];
  for (const session of [f.expired, f.future, f.wrongType, f.missingUid, f.otherDevice,
    'fixture.' + payload + '.fixture', payload, payload + '.', '!!!.' + 'a'.repeat(64),
    Buffer.from('null').toString('base64url') + '.' + 'a'.repeat(64)]) {
    assert.throws(() => runtime.scope({ ...current, session }), /会话/);
  }
  assert.throws(() => runtime.scope({ ...current, session: '' }), /登录/);
});
