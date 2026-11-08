'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { resolve } = require('../main/conversation/account-native-source.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const segments = require('../main/conversation/runtime-segments');
const { scope } = require('../main/platform-connections/runtime.cjs');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = { getPath: () => dir }, actor = identity();
  const native = { id: 'native', title: 'Requirement', adapterId: 'pi', workOwner: scope(actor) };
  return { app, identity: actor, item: { id: 'account-copy', sourceSessionId: native.id, sourceClientId: actor.clientId },
    native, session: { findBySessionId: () => ({ historyRow: () => native }) } };
}

test('owned account projection resolves to the native conversation without importing its partial transcript', async t => {
  const f = setup(t), row = await resolve(f);
  assert.equal(row.id, 'native');
  assert.equal(row.adapterId, 'pi');
  assert.deepEqual(row.historyAliasIds, ['native', 'account-copy']);
  assert.equal(row.accountConversation, undefined);
  assert.equal(await resolve({ ...f, item: { ...f.item, sourceClientId: 'another-device' } }), null);
  assert.equal((await resolve({ ...f, item: { ...f.item, deleted: true } })).id, 'native',
    'a deleted account row still identifies its native alias for suppression');
});

test('an account alias probes native archives without reentering the external account history provider', async t => {
  const f = setup(t);
  f.session = { findBySessionId: () => null, archivedConversation: async (_app, id, opts) => {
    assert.equal(id, 'native'); assert.deepEqual(opts, { nativeOnly: true }); return f.native;
  } };
  assert.equal((await resolve(f)).id, 'native');
  f.session.archivedConversation = async () => null;
  assert.equal(await resolve(f), null, 'a remote-only archive must remain accessible');
  f.session.archivedConversation = async () => ({ ...f.native, workOwner: scope(identity('two')) });
  await assert.rejects(resolve(f), /当前账号/);
});

test('runtime segments resolve to their stable public identity after rework or an Agent switch', async t => {
  const f = setup(t);
  await segments.save(f.app, { version: 1, id: 'native', owner: scope(f.identity),
    active: { adapterId: 'qwen', sessionId: 'second-runtime' }, segments: [{ adapterId: 'pi', sessionId: 'native' }] });
  f.item.sourceSessionId = 'second-runtime';
  f.session.findBySessionId = id => {
    assert.equal(id, 'native'); return { historyRow: () => f.native };
  };
  const resolved = await resolve(f);
  assert.equal(resolved.id, 'native');
  assert.deepEqual(resolved.nativeIds, ['native', 'second-runtime']);
  assert.deepEqual(require('../main/conversation/account-native-source.cjs').aliases({
    app: f.app, id: 'second-runtime', identity: f.identity }), ['native', 'second-runtime']);
  assert.throws(() => require('../main/conversation/account-native-source.cjs').aliases({
    app: f.app, id: 'second-runtime', identity: identity('two') }), /账号/);
});

test('archived native conversations preserve their archive state instead of falling back to an active account projection', async t => {
  const f = setup(t);
  f.session.isArchived = () => true;
  assert.equal((await resolve(f)).archived, true);
});

test('account history canonicalizes both fresh and cached rows while keeping foreign records', async t => {
  const f = setup(t);
  let calls = 0;
  const sync = require('../main/conversation/account-sync').create({ app: f.app,
    identityOf: async () => f.identity, store: { jobs: () => [] },
    resolveNativeSource: (item, identity) => resolve({ ...f, item, identity }),
    fetch: async () => { calls++; return { ok: true, json: async () => ({ items: [f.item,
      { ...f.item, id: 'foreign', sourceClientId: 'other-device', sourceSessionId: 'foreign-native' }], hasMore: false }) }; },
  });
  t.after(() => sync.close());
  for (let i = 0; i < 2; i++) {
    const result = await sync.history();
    assert.deepEqual(result.chats.map(row => row.id), ['native', 'foreign']);
    assert.deepEqual(result.chats[0].historyAliasIds, ['native', 'account-copy']);
    assert.equal(result.chats[1].accountConversation, true);
  }
  assert.equal(calls, 1);
});

test('account history collapses device projections that share one source session', async t => {
  const f = setup(t);
  const duplicate = { ...f.item, id: 'account-old-device', sourceClientId: 'another-device', title: 'Requirement' };
  let calls = 0;
  const sync = require('../main/conversation/account-sync').create({ app: f.app,
    identityOf: async () => f.identity, store: { jobs: () => [] },
    resolveNativeSource: (item, identity) => resolve({ ...f, item, identity }),
    fetch: async () => { calls++; return { ok: true, json: async () => ({ items: [f.item, duplicate], hasMore: false }) }; },
  });
  t.after(() => sync.close());
  const result = await sync.history();
  assert.equal(calls, 1);
  assert.deepEqual(result.chats.map(row => row.id), ['native']);
  assert.deepEqual(result.chats[0].historyAliasIds, ['native', 'account-copy', 'account-old-device']);
  assert.equal(result.lifecycle.length, 1);
  assert.deepEqual(result.lifecycle[0].historyAliasIds, ['account-copy', 'native', 'account-old-device']);
});

test('source aliases resolve to the current device account record when Hub has a stale duplicate', async t => {
  const f = setup(t), duplicate = { ...f.item, id: 'account-old-device', sourceClientId: 'another-device' };
  const sync = require('../main/conversation/account-sync').create({ app: f.app,
    identityOf: async () => f.identity, store: { jobs: () => [] },
    fetch: async () => ({ ok: true, json: async () => ({ items: [f.item, duplicate], hasMore: false }) }),
  });
  t.after(() => sync.close());
  await sync.history();
  assert.equal((await sync.row('native')).id, 'account-copy');
});
