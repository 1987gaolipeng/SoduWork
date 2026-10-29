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
    setThinkingLevel: async level => { calls.push(['level', level]); return { ok: true, thinking: { level } }; },
    setThinkingMode: enabled => { calls.push(['boolean', enabled]); return { ok: true }; } };
  install({ app: {}, ipcMain: { handle: (id, action) => handlers.set(id, action) },
    session: { get: () => current }, identityOf: async () => online ? identity : null,
    memories: { assertOwner() { if (!owned) throw Error('Another account'); } },
    cloud: { guard: () => cloud } });
  return { handle, calls, send: value => handlers.get('pi-session-set-thinking')({}, 'chat', value),
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
