'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const capabilities = require('../main/conversation/capabilities');
const models = require('../main/pi-session/model-config');
const auth = require('../main/device-auth-request');
const { identity, sessions } = require('./helpers/platform-session-fixture.cjs');
const clear = () => {
  capabilities._policyCache.clear(); capabilities._policyPending.clear();
  models._modelCache.clear(); models._modelPending.clear();
};
const response = owner => ({ ok: true, status: 200, json: async () => ({ ok: true,
  skills: [{ name: owner }], enabled: [owner], key: owner + '-proxy-ticket', model: 'fixture-model', expiresIn: 1800 }) });
const readers = [
  ['enterprise policy', id => capabilities.fetchPolicy(id), result => result.enabled[0]],
  ['model credentials', id => models.fetchModel(id), result => result.model.key],
];

for (const [name, read, value] of readers) {
  test(name + ' never reuses a different account cache on the same device', async t => {
    clear(); t.after(clear); let requests = 0;
    t.mock.method(global, 'fetch', async (_, options) => {
      requests++;
      return response(auth.accountId({ clientId: 'device', session: options.headers.Authorization.slice(7) }));
    });
    const first = await read(identity('one')), second = await read(identity('two'));
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.match(value(first), /^one/); assert.match(value(second), /^two/); assert.equal(requests, 2);
    assert.equal(value(await read({ ...identity('one'), session: sessions().renewed })), value(first));
    assert.equal(requests, 2, 'same-account token renewal can keep its own cache');
  });

  test(name + ' does not share a pending old-account response with the new account', async t => {
    clear(); t.after(clear); let finishOld, requests = 0;
    t.mock.method(global, 'fetch', async (_, options) => {
      requests++;
      const owner = auth.accountId({ clientId: 'device', session: options.headers.Authorization.slice(7) });
      if (owner === 'one') return new Promise(resolve => { finishOld = resolve; });
      return response(owner);
    });
    const old = read(identity('one'));
    await new Promise(resolve => setImmediate(resolve));
    const current = await read(identity('two'));
    assert.match(value(current), /^two/);
    finishOld(response('one')); await old;
    assert.match(value(await read(identity('two'))), /^two/); assert.equal(requests, 2);
  });

  test(name + ' never caches an account-unknown device-key response', async t => {
    clear(); t.after(clear); let requests = 0;
    t.mock.method(global, 'fetch', async () => response('account-' + (++requests)));
    const device = { hub: 'https://fixture.invalid', clientId: 'device', secret: 'legacy-fixture-key' };
    assert.notEqual(value(await read(device)), value(await read(device)));
    assert.equal(requests, 2);
  });
}
