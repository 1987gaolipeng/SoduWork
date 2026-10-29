'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const segments = require('../main/conversation/runtime-segments');
const runtime = require('../main/platform-connections/runtime.cjs');
const deviceAuth = require('../main/device-auth');
const { identity, sessions } = require('./helpers/platform-session-fixture.cjs');

const app = { getPath() { throw Error('Owner checks must not access real user storage'); } };
const record = () => Object.freeze({ id: 'fixture-chat', owner: runtime.scope(identity('one')) });
function noProfiles(t) {
  return t.mock.method(deviceAuth, 'profiles', () => []);
}
test('runtime owner: missing login is actionable and does not masquerade as account mismatch', t => {
  const profiles = noProfiles(t), row = record();
  for (const auth of [null, {}, { hub: 'https://fixture.invalid', clientId: 'device' }]) {
    assert.throws(() => segments.assertOwner(app, row, auth), error => {
      assert.match(error.message, /请先登录/);
      assert.doesNotMatch(error.message, /另一个账号/);
      return true;
    });
  }
  assert.equal(profiles.mock.callCount(), 0, 'invalid login must fail before loading profile candidates');
});
test('runtime owner: expired session reports relogin before ownership comparison', t => {
  const profiles = noProfiles(t), row = record();
  assert.throws(() => segments.assertOwner(app, row, { ...identity('one'), session: sessions().expired }),
    /当前账号会话已失效，请重新登录/);
  assert.equal(profiles.mock.callCount(), 0);
});
test('runtime owner: malformed and device-mismatched sessions retain authentication diagnostics', t => {
  const profiles = noProfiles(t), row = record();
  assert.throws(() => segments.assertOwner(app, row, { ...identity('one'), session: 'invalid-fixture' }), /会话无效/);
  assert.throws(() => segments.assertOwner(app, row, { ...identity('one'), clientId: 'other-device' }), /会话不完整/);
  assert.equal(profiles.mock.callCount(), 0);
});
test('runtime owner: authenticated other account still cannot claim the conversation', t => {
  noProfiles(t);
  const row = record();
  assert.throws(() => segments.assertOwner(app, row, identity('two')), /另一个账号或服务/);
  assert.equal(row.owner, runtime.scope(identity('one')));
});
test('runtime owner: same account remains valid after service and device changes without rewriting ownership', t => {
  noProfiles(t);
  const row = record();
  assert.doesNotThrow(() => segments.assertOwner(app, row, identity('one')));
  assert.doesNotThrow(() => segments.assertOwner(app, row,
    { hub: 'https://moved.invalid', clientId: 'device-two', session: sessions().otherDevice }));
  assert.equal(row.owner, runtime.scope(identity('one')));
});
test('runtime owner: legacy fingerprints require matching saved profiles and never change the record', t => {
  const previous = { hub: 'https://old.invalid', clientId: 'old-device' };
  const row = Object.freeze({ owner: runtime.legacyScope(previous.hub, previous.clientId, identity('one')) });
  const profiles = t.mock.method(deviceAuth, 'profiles', () => [previous]);
  assert.doesNotThrow(() => segments.assertOwner(app, row, identity('one')));
  assert.throws(() => segments.assertOwner(app, row, identity('two')), /另一个账号或服务/);
  profiles.mock.mockImplementation(() => []);
  assert.throws(() => segments.assertOwner(app, row, identity('one')), /另一个账号或服务/);
});
test('runtime owner: absence of a segment record preserves the existing unbound conversation path', t => {
  const profiles = noProfiles(t);
  assert.doesNotThrow(() => segments.assertOwner(app, null, null));
  assert.equal(profiles.mock.callCount(), 0);
});
