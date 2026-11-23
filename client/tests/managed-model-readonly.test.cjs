'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const fs = require('./renderer-source.cjs');

async function fixture() {
  const requests = [], localSaves = [], localProbes = [], values = new Map();
  const catalog = { providers: [
    { id: 'organization', personal: false },
    { id: 'custom-shared', personal: false },
    { id: 'custom-personal', personal: true },
  ], usable: [], myModels: [] };
  let read = () => Response.json(catalog), cachedReads = 0;
  const localCatalog = { revision: 1,
    providers: [{ id: 'organization', localOnly: true, personal: true }],
    myModels: [{ id: 'local:model-' + '1'.repeat(32), providerId: 'organization', name: 'local-model' }] };
  const box = { URL, URLSearchParams, AbortController, AbortSignal, Response, TextEncoder, crypto: require('node:crypto').webcrypto,
    CustomEvent: class {}, navigator: { platform: 'test' },
    console: { log() {}, error() {} }, dispatchEvent() {}, addEventListener() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    soduWorkAPI: {
      getAppVersion: async () => 'test', getSysInfo: async () => ({}),
      configureRunner: async () => ({ ok: true }),
      deviceAuthBootstrap: async () => ({ ok: true, stored: true, authState: 'active',
        user: { id: 'alice' }, clientId: 'desktop', session: 'synthetic-session', expiresIn: 1800 }),
      deviceAuthLogout: async () => ({ ok: true }),
      deviceAuthClearSession: async () => ({ ok: true }),
      clientDomainRead: async () => { cachedReads++; return { ok: true,
        value: { ...catalog, providers: catalog.providers.map(row => ({ ...row, personal: true })) } }; },
      localModels: {
        get: async () => localCatalog,
        save: async input => { localSaves.push(input); return localCatalog; },
        test: async (...args) => { localProbes.push(args); return { ok: true }; },
        checkCapabilities: async input => { localProbes.push(input); return { ok: true }; },
      },
    },
    fetch: async (url, options = {}) => {
      const request = { url, options, method: options.method || 'GET',
        body: options.body && JSON.parse(options.body) };
      requests.push(request);
      if (url.endsWith('/my-models') && request.method === 'GET') return read();
      return Response.json({ ok: true });
    },
  };
  box.window = box;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), box);
  await box.SoduWorkAPI.registerClient();
  return { api: box.SoduWorkAPI, requests, localSaves, localProbes, catalog, localCatalog,
    setRead: fn => { read = fn; }, cachedReads: () => cachedReads,
    writes: () => requests.filter(row => row.method !== 'GET') };
}

function captureTarget(api, prepared, user = 'alice') {
  const clientId = 'desktop', session = Buffer.from(JSON.stringify({ typ: 'device', cid: clientId, uid: user })).toString('base64url') + '.fixture';
  return require('../main/pi-session/model-failure-target.cjs').capture({ id: prepared.id, provider: 'soduwork' }, prepared,
    { hub: api.hubBase(), session, clientId });
}

test('chat checks bind the Hub account, model, provider and saved revision', async () => {
  const f = await fixture(), revision = 'b'.repeat(64);
  const model = { id: 'model', quotaProvider: 'custom-personal', configRevision: revision };
  const request = target => f.api.inspectFailedModel(target, { check: true });
  const target = captureTarget(f.api, model);
  f.catalog.usable = [{ providerId: 'custom-personal', name: 'model', configRevision: revision }];
  assert.equal((await request(captureTarget(f.api, model, 'bob'))).state, 'account');
  assert.equal(f.requests.length, 0);
  assert.equal((await request({ ...target, revision: 'c'.repeat(64) })).state, 'changed');
  assert.equal((await request({ ...target, revision: '' })).state, 'unversioned');
  assert.equal((await request({ ...target, model: 'deleted' })).state, 'changed');
  f.catalog.providers.find(row => row.id === model.quotaProvider).personal = false;
  assert.equal((await request(target)).state, 'managed');
  assert.equal(f.writes().length, 0);
  f.catalog.providers.find(row => row.id === model.quotaProvider).personal = true;
  await request(target);
  assert.deepEqual(f.writes().map(row => row.body), [{ providerId: 'custom-personal', model: 'model',
    expectedConfigRevision: revision, checks: ['connection', 'streaming', 'toolCalling'] }]);
});

test('device chat diagnostics use only the captured opaque reference until resolving the local catalog', async () => {
  const f = await fixture(), model = f.localCatalog.myModels[0];
  model.configRevision = 'd'.repeat(64);
  const target = captureTarget(f.api, { localOnly: true, modelRef: model.id, id: model.id, providerName: 'private-service',
    wireModelId: model.name, baseUrl: 'https://private.invalid', key: 'fixture-secret', configRevision: model.configRevision });
  assert.doesNotMatch(JSON.stringify(target), /private|fixture-secret|local-model|alice|desktop/);
  const labels = await f.api.inspectFailedModel(target);
  assert.equal(labels.state, 'ready'); assert.equal(labels.model, 'local-model');
  await f.api.inspectFailedModel(target, { check: true });
  assert.equal(f.localProbes[0].modelRef, model.id);
  assert.equal(f.localProbes[0].expectedTargetRevision, model.configRevision);
  model.id = 'local:model-' + '2'.repeat(32);
  assert.equal((await f.api.inspectFailedModel(target, { check: true })).state, 'changed');
  assert.equal(f.localProbes.length, 1);
  assert.equal(f.requests.length, 0);
});

test('a mixed save rejects a forged organization provider before writing either ownership domain', async () => {
  const f = await fixture();
  await assert.rejects(f.api.saveMyModels({
    providers: [{ id: 'organization', localOnly: false, personal: true, baseUrl: 'https://changed.invalid' }],
    keys: { organization: 'synthetic-secret' },
    localProviders: [{ id: 'device:organization', localOnly: true, personal: true }],
    localModels: [], localKeys: {}, localRevision: 1, expectedRevision: 'catalog-before-edit',
  }), { code: 'MODEL_PROVIDER_READ_ONLY' });
  assert.equal(f.localSaves.length, 0);
  assert.equal(f.writes().length, 0);
  assert.equal(f.cachedReads(), 0, 'an editable flag in a cached catalog cannot authorize a write');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.cache, 'no-store');
  assert.equal(f.requests[0].body, undefined);
});

for (const [name, body] of [
  ['key replacement', { keys: { 'custom-shared': 'synthetic-secret' } }],
  ['key removal', { keys: { 'custom-shared': null } }],
  ['model addition', { models: [{ providerId: 'custom-shared', name: 'extra-model', own: true, personal: true }] }],
  ['provider replacement', { providers: [{ id: 'custom-shared', personal: true }] }],
]) test('organization ' + name + ' is rejected even with a custom-looking ID', async () => {
  const f = await fixture();
  await assert.rejects(f.api.saveMyModels(body), { code: 'MODEL_PROVIDER_READ_ONLY' });
  assert.equal(f.writes().length, 0);
  assert.equal(f.localSaves.length, 0);
});

test('unknown provider key patches fail closed instead of trusting caller ownership flags', async () => {
  const f = await fixture();
  await assert.rejects(f.api.saveMyModels({ keys: { 'custom-missing': 'synthetic-secret' }, personal: true }),
    { code: 'MODEL_PROVIDER_UNAVAILABLE' });
  assert.equal(f.writes().length, 0);
});

test('personal service updates and newly declared personal services still save their own models and keys', async () => {
  const f = await fixture();
  await f.api.saveMyModels({ providers: [{ id: 'custom-personal', name: 'Mine', baseUrl: 'https://personal.invalid/v1' },
    { id: 'custom-new', name: 'New', baseUrl: 'https://new.invalid/v1' }],
    models: [{ providerId: 'custom-new', name: 'new-model' }],
    keys: { 'custom-personal': null, 'custom-new': 'synthetic-secret' }, expectedRevision: 'personal-revision' });
  assert.equal(f.writes().length, 1);
  assert.deepEqual(f.writes()[0].body.models, [{ providerId: 'custom-new', name: 'new-model' }]);
  assert.deepEqual(f.writes()[0].body.keys, { 'custom-personal': null, 'custom-new': 'synthetic-secret' });
  assert.equal(f.localSaves.length, 0);
});

for (const method of ['testMyModel', 'checkMyModelCapabilities']) test(method + ' refuses organization probes', async () => {
  const f = await fixture();
  const input = method === 'testMyModel' ? 'custom-shared'
    : { providerId: 'custom-shared', model: 'shared-model', personal: true, localOnly: false };
  await assert.rejects(f.api[method](input), { code: 'MODEL_PROVIDER_READ_ONLY' });
  assert.equal(f.writes().length, 0);
  assert.equal(f.localProbes.length, 0);
});

test('personal probes serialize only saved provider and model identifiers', async () => {
  const f = await fixture();
  await f.api.testMyModel('custom-personal');
  await f.api.checkMyModelCapabilities({ providerId: 'custom-personal', model: 'personal-model',
    baseUrl: 'https://untrusted.invalid', personal: true, checks: ['connection'] });
  assert.deepEqual(f.writes().map(row => row.body), [
    { providerId: 'custom-personal' },
    { providerId: 'custom-personal', model: 'personal-model', checks: ['connection'] },
  ]);
});

test('an unreadable current Hub catalog prevents mixed saves without changing local settings', async () => {
  const f = await fixture();
  f.setRead(() => Response.json({ ok: false }));
  await assert.rejects(f.api.saveMyModels({ keys: { 'custom-personal': 'synthetic-secret' },
    localProviders: [], localModels: [], localRevision: 1 }));
  assert.equal(f.localSaves.length, 0);
  assert.equal(f.writes().length, 0);
});

test('logging out during ownership validation prevents the late managed mutation', async () => {
  const f = await fixture();
  let finish;
  f.setRead(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.api.saveMyModels({ keys: { 'custom-personal': 'synthetic-secret' } });
  const rejected = assert.rejects(pending, { code: 'STALE_TASK_SCOPE' });
  while (!finish) await new Promise(setImmediate);
  await f.api.clientLogout();
  finish(Response.json({ providers: [{ id: 'custom-personal', personal: true }] }));
  await rejected;
  assert.equal(f.writes().length, 0);
});

test('canceling capability checks during Hub ownership validation prevents a late probe', async () => {
  const f = await fixture(), controller = new AbortController();
  let finish;
  f.setRead(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.api.checkMyModelCapabilities({ providerId: 'custom-personal', model: 'personal-model' },
    { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  while (!finish) await new Promise(setImmediate);
  controller.abort();
  finish(Response.json({ providers: [{ id: 'custom-personal', personal: true }] }));
  await rejected;
  assert.equal(f.writes().length, 0);
});

test('device-owned services with a matching raw organization ID remain separate and work offline', async () => {
  const f = await fixture();
  f.setRead(() => { throw Error('Hub must not be contacted'); });
  await f.api.saveMyModels({ localProviders: [{ id: 'device:organization', localOnly: true, personal: true }],
    localModels: [], localKeys: {}, localRevision: 1 });
  await f.api.testMyModel('device:organization');
  await f.api.checkMyModelCapabilities({ providerId: 'device:organization', model: 'local-model' });
  assert.equal(f.localSaves.length, 1);
  assert.equal(f.localProbes.length, 2);
  assert.equal(f.requests.length, 0);
});
