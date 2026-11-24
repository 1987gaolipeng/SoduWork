'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { install } = require('../main/pi-session/runtime-selection-ipc');
const preferences = require('../main/access-control/preferences');

function fixture(t) {
  const calls = [], handlers = new Map();
  let trusted = true, online = true, cloud = false, owned = true, current;
  t.mock.method(preferences, 'isTrusted', () => trusted);
  const identity = { hub: 'http://fixture', clientId: 'device' };
  const now = Math.floor(Date.now() / 1000);
  identity.session = Buffer.from(JSON.stringify({ typ: 'device', uid: 'owner', cid: 'device',
    iat: now - 10, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64);
  const handle = current = { sessionId: 'chat', adapterId: 'codex',
    selectAgent: async (agent, selection) => { calls.push(['agent', agent, selection]); return { ok: true }; },
    snapshot: () => ({ status: 'idle' }),
    setThinkingLevel: async level => { calls.push(['level', level]); return { ok: true, thinking: { level } }; },
    setThinkingMode: enabled => { calls.push(['boolean', enabled]); return { ok: true }; } };
  install({ app: {}, ipcMain: { handle: (id, action) => handlers.set(id, action) },
    session: { get: () => current }, identityOf: async () => online ? identity : null,
    memories: { assertOwner() { if (!owned) throw Error('Another account'); } },
    cloud: { guard: () => cloud, selectExecution: async (_handle, choice) => {
      calls.push(['cloud', choice]); return { ok: true };
    } }, publish() {} });
  return { handle, calls, catalog: () => handlers.get('pi-session-runtime-models')({}, 'codex', 'chat'), send: value => handlers.get('pi-session-set-thinking')({}, 'chat', value),
    select: (agent, choice) => handlers.get('pi-session-select-agent')({}, 'chat', agent, choice),
    trust: value => { trusted = value; }, login: value => { online = value; },
    cloud: value => { cloud = value; }, owner: value => { owned = value; }, close: () => { current = null; } };
}

test('native Codex thinking strings reach the existing handle without boolean coercion', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.send('xhigh'), { ok: true, thinking: { level: 'xhigh' } });
  assert.deepEqual(f.calls, [['level', 'xhigh']]);
  assert.equal((await f.send(false)).ok, true);
  assert.deepEqual(f.calls.at(-1), ['boolean', false]);
});

test('native effort rejects untrusted, signed-out, foreign-account and closed sessions', async t => {
  const f = fixture(t);
  f.trust(false); assert.equal((await f.send('high')).ok, false);
  f.trust(true); f.login(false); assert.equal((await f.send('high')).ok, false);
  f.login(true); f.owner(false); assert.equal((await f.send('high')).ok, false);
  f.owner(true); f.close(); assert.equal((await f.send('high')).ok, false);
  assert.deepEqual(f.calls, []);
});

test('cloud and other adapters cannot mutate a local Codex effort setting', async t => {
  const f = fixture(t);
  f.cloud(true); assert.equal((await f.send('high')).ok, false);
  f.cloud(false); f.handle.adapterId = 'pi'; assert.equal((await f.send('high')).ok, false);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.send(true)).ok, true);
  assert.deepEqual(f.calls, [['boolean', true]]);
});

test('Agent selection forwards only the explicit model choice and keeps authorization inside main', async t => {
  const f = fixture(t);
  assert.equal((await f.select('qwen', { modelName: 'chosen-model', identity: 'untrusted', allowLocal: true })).ok, true);
  const selection = f.calls[0][2];
  assert.equal(selection.modelName, 'chosen-model');
  assert.notEqual(selection.identity, 'untrusted');
  assert.equal(typeof selection.validate, 'function');
  assert.equal(selection.allowLocal, undefined);
});

test('cloud Agent selection rejects device model references before any selection or remote request', async t => {
  const f = fixture(t); f.cloud(true);
  for (const modelName of ['local:model-private', '  local:model-private  ', 'image::device:provider::local:model-private']) {
    assert.equal((await f.select('claude', { modelName })).ok, false);
    assert.deepEqual(f.calls, []);
  }
  assert.equal((await f.select('qwen', { modelName: 'hub-model' })).ok, true);
  assert.deepEqual(f.calls, [['cloud', { agentId: 'qwen', modelName: 'hub-model' }]]);
});

test('a bound Codex catalog is authorized before and after its read', async t => {
  const f = fixture(t);
  f.handle.accountCatalog = async () => ({ ok: true, models: [{ id: 'fixture' }] });
  assert.equal((await f.catalog()).models[0].id, 'fixture');
  f.owner(false);
  assert.deepEqual(await f.catalog(), { ok: false, models: [] });
  f.owner(true);
  f.handle.accountCatalog = async () => {
    f.close();
    return { ok: true, models: [{ id: 'old-session' }] };
  };
  assert.deepEqual(await f.catalog(), { ok: false, models: [] });
});
