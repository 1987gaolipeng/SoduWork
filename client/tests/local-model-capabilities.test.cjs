'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../main/local-model-store.cjs');
const modulePath = path.join(__dirname, '../main/local-model-capabilities.cjs');
function capabilities() { assert.equal(fs.existsSync(modulePath), true, 'encrypted local evidence service must exist'); return require(modulePath); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-cap-evidence-'));
  const deps = { app: { getPath: () => root }, safeStorage: { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString() } };
  store.configure(deps);
  t.after(() => { store.configure(null); fs.rmSync(root, { recursive: true, force: true }); });
  const saved = store.save({ providers: [{ id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1' }],
    models: [{ providerId: 'fixture', name: 'private-wire-name', config: {} }], keys: { fixture: 'synthetic-private-key' } });
  return { root, deps, ref: saved.usable[0].id };
}
const result = (status = 'passed') => ({ reportVersion: 3, apiFamily: 'chat-completions', checkedAt: new Date().toISOString(),
  checks: { imageInput: { status, code: status === 'passed' ? 'verified' : 'timeout', checkedAt: new Date().toISOString() } } });

test('local evidence is encrypted, survives restart and reaches the public catalog and trusted resolver', async t => {
  const c = capabilities(), f = fixture(t), revision = store.get().revision;
  await c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: async () => result() });
  assert.equal(store.get().revision, revision, 'evidence must not change the settings save revision');
  const file = path.join(f.root, 'local-model-capabilities.secure.json');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private-wire-name|synthetic-private-key|passed/);
  store.configure(f.deps);
  assert.deepEqual(store.get().usable[0].input, ['text', 'image']);
  assert.equal(store.resolve(f.ref).imageRouting, 'native');
  assert.equal(store.get().myModels[0].capabilityCheck.checks.imageInput.status, 'passed');
});

test('inconclusive rechecks retain verified evidence without masking the latest attempt', async t => {
  const c = capabilities(), f = fixture(t);
  await c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: async () => result() });
  const checked = await c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: async () => result('inconclusive') });
  assert.equal(checked.checks.imageInput.status, 'inconclusive');
  assert.equal(checked.capabilityProfile.imageInput.state, 'supported');
  assert.equal(checked.runtimeChanged, false);
});

test('credential changes discard a late probe even when its transport ignores cancellation', async t => {
  const c = capabilities(), f = fixture(t); let release;
  const pending = c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: () => new Promise(resolve => { release = resolve; }) });
  await new Promise(resolve => setImmediate(resolve));
  store.save({ keys: { fixture: 'new-synthetic-key' } });
  release(result());
  await assert.rejects(pending, /配置.*变化/);
  assert.equal(store.resolve(f.ref).capabilityProfile.imageInput.state, 'unknown');
});

test('display-only edits preserve evidence while manual capability declarations remain authoritative', async t => {
  const c = capabilities(), f = fixture(t);
  await c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: async () => result() });
  const current = store.get();
  store.save({ models: [{ ...current.myModels[0], label: 'New label', config: { capabilities: { imageInput: 'unsupported' } } }] });
  assert.equal(store.resolve(f.ref).capabilityProfile.imageInput.source, 'configured');
  assert.equal(store.resolve(f.ref).capabilityProfile.imageInput.conflict, true);
  assert.ok(store.get().myModels[0].capabilityCheck);
});

test('the first cosmetic save of a pre-upgrade model preserves matching new evidence', async t => {
  const c = capabilities(), f = fixture(t), file = path.join(f.root, 'local-models.secure.json');
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const old = JSON.parse(f.deps.safeStorage.decryptString(Buffer.from(envelope.cipher, 'base64')));
  delete old.models[0].capabilityEpoch;
  fs.writeFileSync(file, JSON.stringify({ ...envelope, cipher: f.deps.safeStorage.encryptString(JSON.stringify(old)).toString('base64') }));
  await c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: async () => result() });
  const current = store.get();
  store.save({ models: current.myModels.map(row => ({ ...row, label: 'Cosmetic upgrade edit' })) });
  assert.equal(store.resolve(f.ref).capabilityProfile.imageInput.state, 'supported');
  assert.equal(store.resolve(f.ref).capabilityProfile.imageInput.source, 'verified');
});

test('concurrent windows share one target probe and a missing model is never replaced with the first model', async t => {
  const c = capabilities(), f = fixture(t); let calls = 0, release;
  const runProbe = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe });
  const second = c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe });
  await new Promise(resolve => setImmediate(resolve)); release(result());
  await Promise.all([first, second]); assert.equal(calls, 1);
  await assert.rejects(c.check({ modelRef: 'local:model-' + '0'.repeat(32), checks: ['imageInput'] }), /不存在/);
});

test('cancelled work cannot be joined by a retry or commit a late successful transport result', async t => {
  const c = capabilities(), f = fixture(t); let release;
  const pending = c.check({ modelRef: f.ref, checks: ['imageInput'], requestId: 'cancel-me' },
    { runProbe: () => new Promise(resolve => { release = resolve; }) });
  c.cancel({ modelRef: f.ref, requestId: 'cancel-me' });
  const retry = c.check({ modelRef: f.ref, checks: ['imageInput'], requestId: 'retry-me' });
  const outcome = retry.then(value => ({ value }), error => ({ error }));
  release(result());
  assert.match((await outcome).error?.message || '', /取消/);
  assert.equal((await pending).checks.imageInput.status, 'cancelled');
  assert.equal(store.resolve(f.ref).capabilityProfile.imageInput.state, 'unknown');
});

test('evidence cleanup failure cannot turn an already committed model edit into a failed save', async t => {
  const c = capabilities(), f = fixture(t);
  await c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: async () => result() });
  t.mock.method(f.deps.safeStorage, 'encryptString', value => {
    if (value.includes('"targets":')) throw Error('Synthetic evidence storage failure');
    return Buffer.from(value);
  });
  assert.doesNotThrow(() => store.save({ keys: { fixture: 'replacement-synthetic-key' } }));
  assert.equal(store.resolve(f.ref).key, 'replacement-synthetic-key');
  assert.equal(store.resolve(f.ref).capabilityProfile.imageInput.state, 'unknown');
});

test('malformed encrypted evidence is diagnosed without taking down the model catalog', async t => {
  const c = capabilities(), f = fixture(t);
  await c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: async () => result() });
  const file = path.join(f.root, 'local-model-capabilities.secure.json');
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const state = JSON.parse(Buffer.from(envelope.cipher, 'base64').toString());
  state.targets[f.ref].evidence.compatibility = null;
  envelope.cipher = Buffer.from(JSON.stringify(state)).toString('base64'); fs.writeFileSync(file, JSON.stringify(envelope));
  const catalog = store.get();
  assert.equal(catalog.usable.length, 1); assert.equal(catalog.myModels[0].capabilityEvidenceError, true);
});

test('a check of another capability retains previously negotiated stream compatibility', async t => {
  const c = capabilities(), f = fixture(t);
  await c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: async () => ({ ...result(), compatibility: { streamOptions: false } }) });
  const next = await c.check({ modelRef: f.ref, checks: ['connection'] }, { runProbe: async model => {
    assert.equal(model.compatibility?.streamOptions, false);
    return { ...result(), checks: { connection: result().checks.imageInput }, compatibility: model.compatibility };
  } });
  assert.equal(next.compatibility.streamOptions, false); assert.equal(next.runtimeChanged, false);
});

test('failed evidence cleanup cannot revive proof after a credential changes away and back across restart', async t => {
  const c = capabilities(), f = fixture(t);
  await c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: async () => result() });
  const patched = t.mock.method(f.deps.safeStorage, 'encryptString', value => {
    if (value.includes('"targets":')) throw Error('Synthetic evidence storage failure');
    return Buffer.from(value);
  });
  store.save({ keys: { fixture: 'temporary-synthetic-key' } });
  store.save({ keys: { fixture: 'synthetic-private-key' } });
  assert.equal(store.resolve(f.ref).capabilityProfile.imageInput.state, 'unknown');
  patched.mock.restore(); store.configure(f.deps);
  assert.equal(store.resolve(f.ref).capabilityProfile.imageInput.state, 'unknown');
});

test('configuration changes abort in-flight work even while the evidence file is unreadable', async t => {
  const c = capabilities(), f = fixture(t); let release, signal;
  const pending = c.check({ modelRef: f.ref, checks: ['imageInput'] }, { runProbe: (_model, _checks, options) => {
    signal = options.signal; return new Promise(resolve => { release = resolve; });
  } });
  const readFile = fs.readFileSync;
  const patched = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).endsWith('local-model-capabilities.secure.json')) throw Error('Synthetic evidence read failure');
    return readFile(file, ...args);
  });
  store.save({ keys: { fixture: 'temporary-synthetic-key' } }); store.save({ keys: { fixture: 'synthetic-private-key' } });
  patched.mock.restore();
  const settled = pending.then(value => ({ value }), error => ({ error })); release(result());
  assert.equal(signal.aborted, true); assert.match((await settled).error?.message || '', /配置.*变化/);
});
