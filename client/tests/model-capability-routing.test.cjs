'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const fs = require('./renderer-source.cjs');
const reference = 'local:model-' + '1'.repeat(32);
function fixture() {
  const requests = [], localChecks = [], values = new Map();
  const box = { URL, URLSearchParams, AbortController, Response, CustomEvent: class {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, navigator: { platform: 'test' },
    console: { log() {}, error() {} }, dispatchEvent() {}, addEventListener() {},
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    soduWorkAPI: { localModels: { get: async () => ({ providers: [{ id: 'local', localOnly: true }],
      myModels: [{ id: reference, providerId: 'local', name: 'wire-model', configRevision: 'a'.repeat(64) }] }),
    test: () => { throw Error('Discovery must not be used as a capability test'); },
    checkCapabilities: async input => { localChecks.push(input); return { checks: {}, capabilityProfile: {} }; } } },
    fetch: async (url, options = {}) => { if (options.method === 'POST') requests.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, providers: [{ id: 'managed', personal: true }], usable: [], myModels: [] })); } };
  box.window = box; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), box);
  return { api: box.SoduWorkAPI, bridge: box.soduWorkAPI.localModels, requests, localChecks };
}
test('desktop Hub capability requests forward the optional target revision and omit local IPC fields', async () => {
  const f = fixture();
  await f.api.checkMyModelCapabilities({ providerId: 'managed', model: 'saved-model', checks: ['imageInput'], localOnly: false, requestId: 'ui-request' });
  assert.deepEqual(f.requests[0].body, { providerId: 'managed', model: 'saved-model', checks: ['imageInput'] });
  await f.api.checkMyModelCapabilities({ providerId: 'managed', model: 'saved-model', expectedConfigRevision: 'saved-revision', requestId: 'ui-request' });
  assert.deepEqual(f.requests[1].body, { providerId: 'managed', model: 'saved-model', expectedConfigRevision: 'saved-revision' });
});
test('device capability checks use the exact saved opaque model reference and its target revision', async () => {
  const f = fixture();
  await f.api.checkMyModelCapabilities({ providerId: 'device:local', model: 'wire-model', checks: ['imageInput'], localOnly: true, requestId: 'ui-request' });
  assert.equal(f.localChecks.length, 1); assert.equal(f.requests.length, 0);
  assert.equal(f.localChecks[0].modelRef, reference);
  assert.equal(f.localChecks[0].expectedTargetRevision, 'a'.repeat(64));
  assert.equal(f.localChecks[0].requestId, 'ui-request');
});
test('a removed device model cannot be replaced by another model in the same service', async () => {
  const f = fixture();
  await assert.rejects(f.api.checkMyModelCapabilities({ providerId: 'device:local', model: 'removed', checks: ['imageInput'] }), /模型.*不存在|模型.*不可用/);
  assert.equal(f.localChecks.length, 0);
});

test('cancellation while reading the catalog prevents a late local IPC probe from starting', async () => {
  const f = fixture(), controller = new AbortController(), catalog = await f.bridge.get();
  let release;
  f.bridge.get = () => new Promise(resolve => { release = resolve; });
  const pending = f.api.checkMyModelCapabilities({ providerId: 'device:local', model: 'wire-model', checks: ['imageInput'] }, { signal: controller.signal });
  controller.abort(); release(catalog);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.localChecks.length, 0); assert.equal(f.requests.length, 0);
});
