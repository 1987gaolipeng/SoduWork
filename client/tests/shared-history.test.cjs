'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { create: createStore } = require('../main/conversation/replica-store.cjs');
const { create } = require('../main/conversation/shared-history.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-shared-'));
  const app = { getPath: () => root }, file = path.join(root, 'pi-agent', 'sessions', 'one.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'session', id: 'one' },
    { type: 'message', id: 'msg-1', message: { role: 'user', content: 'saved by Alice' } },
    { type: 'message', id: 'msg-2', message: { role: 'assistant', content: [{ type: 'text', text: 'local answer' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const row = { id: 'one', title: 'History', path: file, adapterId: 'pi', count: 2, at: 1,
    creator: { account: 'one', hub: identity().hub } };
  const store = createStore(path.join(root, 'replicas.sqlite'));
  const flags = new Map();
  let live = null, current = identity();
  const session = { archivedConversation: async idApp => row,
    historyEntry: async () => fs.existsSync(file) ? { ok: true, entry: row } : { ok: false, notFound: true },
    findBySessionId: () => live, setArchived: (_app, id, value) => flags.set(id, value),
    forgetRunner: async () => ({ ok: false, notFound: true }) };
  const identityOf = () => current;
  const history = create({ app, session, store, identityOf });
  t.after(async () => { await history.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, app, row, session, store, history, flags, identityOf,
    set identity(value) { current = value; }, set live(value) { live = value; },
    switch(value) { current = value; } };
}
test('shared local reader opens native text without starting any account runtime', async t => {
  const f = setup(t);
  const rows = await f.history.projectRows([f.row]);
  assert.equal(rows.length, 1);
  const view = await f.history.open('one');
  assert.equal(view.localReplica, true);
  assert.deepEqual(view.snapshot().messages.map(row => row.text), ['saved by Alice', 'local answer']);
  assert.equal(view.snapshot().messages[1].blocks[0].text, 'local answer');
  assert.equal((await view.send('should not execute')).accepted, false);
  f.switch(identity('two'));
  assert.equal((await f.history.projectRows([f.row])).length, 1);
  assert.equal((await f.history.open('one')).snapshot().messages[0].text, 'saved by Alice');
  assert.throws(() => view.snapshot(), /切换/, 'A new device view does not revive the old account epoch');
});

test('legacy automatic account caches stay on disk without entering local history or source resolution', async t => {
  const f = setup(t), actor = f.identityOf(), account = require('../main/device-auth-request').accountId(actor);
  const copy = (sourceId, extra = {}) => ({
    id: 'copy-' + require('node:crypto').createHash('sha256').update(JSON.stringify([actor.hub, account, sourceId])).digest('hex'),
    cached: true, adapterId: 'account-sync', locationMode: 'account', title: 'Other PC automatic cache',
    source: { hub: actor.hub, account, id: sourceId }, creator: { hub: actor.hub, account }, ...extra,
  });
  const hidden = copy('acct-old', { historyAliasIds: ['old-account-alias'], sourceSessionId: 'old-other-native' });
  const archived = copy('acct-archived', { archived: true });
  const manual = copy('acct-manual', { importDigest: 'explicit-import' });
  const imported = copy('acct-imported', { importedHistory: true });
  const recovered = copy('native-recovered', { id: 'recovered-local-outbox', archived: true });
  const nativeEntry = f.session.historyEntry;
  f.session.historyEntry = (app, id) => id === f.row.id ? nativeEntry(app, id) : { ok: false, notFound: true };
  f.session.archivedConversation = async (_app, id) => id === f.row.id ? f.row : null;
  await f.history.projectRows([f.row]);
  await f.store.register([hidden, archived, manual, imported, recovered]);
  await f.store.cache(hidden.id, [{ role: 'user', text: 'Retained synthetic account cache' }], { expectedRevision: 0 });
  const retained = f.store.get(hidden.id), messages = f.store.messages(hidden.id);
  await f.history.capture({ historyRow: () => ({ id: 'cloud-preserved', cloud: true, locationMode: 'remote' }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Cloud content' }] }) }, actor);
  const page = await f.history.page(), ids = page.chats.map(row => row.id);
  assert.equal(ids.includes(hidden.id), false);
  assert.ok(ids.includes('one') && ids.includes(manual.id) && ids.includes(imported.id));
  assert.ok(page.chats.some(row => row.source?.id === 'cloud-preserved'));
  const catalog = JSON.stringify(page.localCatalog);
  for (const id of [hidden.id, archived.id, 'acct-old', 'old-account-alias', 'old-other-native']) {
    assert.equal(catalog.includes(id), false);
    assert.equal(await f.history.resolve(id), null);
    assert.equal(await f.history.indexedRow(id), null);
    assert.equal(await f.history.open(id), null);
  }
  await assert.rejects(f.history.read(hidden.id), /不存在/);
  assert.deepEqual((await f.history.page({ archived: true })).chats.map(row => row.id), [recovered.id]);
  assert.equal((await f.history.indexedRows(false, 200)).some(row => row.id === hidden.id), false);
  f.session.history = f.session.archivedHistory = async () => ({ ok: true, chats: [] });
  assert.equal((await f.history.directory()).items.some(row => row.id === hidden.id || row.id === archived.id), false);
  assert.equal((await f.history.lifecycleRows()).some(row => row.id === archived.id), false);
  assert.deepEqual(f.store.get(hidden.id), retained);
  assert.deepEqual(f.store.messages(hidden.id), messages);
  await f.history.close();
  const restartedStore = createStore(path.join(f.root, 'replicas.sqlite'));
  const restarted = create({ app: f.app, session: f.session, store: restartedStore, identityOf: f.identityOf });
  try {
    assert.equal((await restarted.page()).chats.some(row => row.id === hidden.id), false);
    assert.equal(await restarted.resolve('old-other-native'), null);
    assert.deepEqual(restartedStore.get(hidden.id), retained);
    assert.deepEqual(restartedStore.messages(hidden.id), messages);
  } finally { await restarted.close(); }
});

test('opening an account projection does not create a new automatic local cache', async t => {
  const f = setup(t);
  await f.history.capture({ historyRow: () => ({ id: 'acct-new', accountProjection: true, adapterId: 'account-sync' }),
    snapshot: () => ({ messages: [{ role: 'user', text: 'Synthetic remote PC content' }] }) }, f.identityOf());
  assert.deepEqual(f.store.catalog().items, []);
});

test('retired account cache locators cannot shadow a cold native archive', async t => {
  const f = setup(t), actor = f.identityOf(), account = require('../main/device-auth-request').accountId(actor);
  const source = { hub: actor.hub, account, id: 'acct-native-source' };
  const id = require('../main/conversation/history-cache-policy.cjs').capturedCopyId(source.hub, source.account, source.id);
  await f.store.register([{ id, cached: true, adapterId: 'account-sync', source,
    sourceSessionId: f.row.id, creator: { hub: actor.hub, account } }]);
  assert.equal((await f.history.resolve(f.row.id)).id, f.row.id);
  assert.deepEqual((await f.history.open(f.row.id)).snapshot().messages.map(row => row.text),
    ['saved by Alice', 'local answer']);
  assert.equal(await f.history.resolve(id), null);
  assert.ok(f.store.get(id), 'the retired cache remains retained on disk');
});

test('account switching during automatic cloud cache cleanup preserves both accounts data', async t => {
  const f = setup(t), original = { id: 'cloud-cleanup', cloud: true, locationMode: 'remote' };
  await f.history.capture({ historyRow: () => original, snapshot: () => ({ messages: [] }) }, f.identityOf());
  const copy = (await f.history.page()).chats[0], sourceCopies = f.store.sourceCopies.bind(f.store);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.store.sourceCopies = async ids => { const rows = sourceCopies(ids); entered();
    await new Promise(resolve => { release = resolve; }); return rows; };
  const deleting = f.history.deleteCloudCaches([original.id]);
  await waiting; f.switch(identity('two')); release();
  await assert.rejects(deleting, /切换/);
  assert.equal(f.store.get(copy.id).deleted, false);
});
test('logout during a protected native transcript page cancels the read before returning local content', async t => {
  const f = setup(t);
  const metadata = path.join(f.root, 'requirement-session-context', require('node:crypto').createHash('sha256').update(f.row.id).digest('hex') + '.json');
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, JSON.stringify({ version: 1, owner: require('../main/platform-connections/runtime.cjs').scope(f.identityOf()) }));
  await f.history.projectRows([f.row]);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.session.historyEntry = async () => { entered(); return new Promise(resolve => { release = () => resolve({ ok: true, entry: f.row }); }); };
  const pending = f.history.read(f.row.id);
  await waiting; f.identity = null; release();
  await assert.rejects(pending, /账号(?:或服务)?已切换/);
});

test('cached pages reject same-account Hub or device changes while allowing same-connection renewal', async t => {
  const f = setup(t), first = identity(), tokens = require('./helpers/platform-session-fixture.cjs').sessions();
  await f.history.capture({ historyRow: () => ({ id: 'private', cloud: true }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Private synthetic content' }] }) }, first);
  const copy = (await f.history.list()).items[0], original = f.store.messages.bind(f.store);
  for (const [next, allowed] of [[{ ...first, hub: 'https://another.invalid' }, false],
    [{ ...first, clientId: 'device-two', session: tokens.otherDevice }, false],
    [{ ...first, session: tokens.renewed }, true]]) {
    f.identity = first;
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    f.store.messages = (...args) => { entered(); return new Promise(resolve => { release = () => resolve(original(...args)); }); };
    const pending = f.history.read(copy.id);
    await waiting; f.identity = next; release();
    if (allowed) assert.equal((await pending).items[0].text, 'Private synthetic content');
    else await assert.rejects(pending, /账号(?:或服务)?已切换/);
  }
});
test('protected local actions reject account changes during resolution before confirmation or revision replies', async t => {
  const f = setup(t), first = identity();
  await f.history.capture({ historyRow: () => ({ id: 'protected', cloud: true }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Protected synthetic transcript' }] }) }, first);
  const copy = (await f.history.list()).items[0];
  await f.history.lifecycle(copy.id, 'archive');
  const resolve = f.history.resolve.bind(f.history);
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f });
  for (const [operation, options] of [['delete', {}], ['archive', { expectedRevision: 0 }]]) {
    f.identity = first;
    let release, entered, calls = 0;
    const waiting = new Promise(done => { entered = done; });
    f.history.resolve = async id => {
      const row = await resolve(id);
      if (++calls === 2) { entered(); await new Promise(done => { release = done; }); }
      return row;
    };
    const pending = action(operation, copy.id, options);
    await waiting; f.identity = identity('two'); release();
    await assert.rejects(pending, /账号(?:或服务)?已切换/);
    assert.equal(await resolve(copy.id), null);
    assert.equal((await f.store.get(copy.id)).deleted, false);
    assert.equal((await f.store.get(copy.id)).archived, true);
  }
});
test('expired credentials cannot read a protected cached copy even with a remembered local owner', async t => {
  const f = setup(t), first = identity();
  await f.history.capture({ historyRow: () => ({ id: 'private-expiry', cloud: true }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Protected synthetic transcript' }] }) }, first);
  const copy = (await f.history.list()).items[0], auth = require('../main/device-auth'), prior = auth.localOwner;
  auth.localOwner = () => require('../main/platform-connections/runtime.cjs').scope(first);
  t.after(() => { auth.localOwner = prior; });
  f.identity = { ...first, session: require('./helpers/platform-session-fixture.cjs').sessions().expired };
  assert.deepEqual((await f.history.list()).items, []);
  await assert.rejects(f.history.read(copy.id), /不存在/);
});
test('multi-page native indexing removes protected rows collected before an account change', async t => {
  const f = setup(t), first = identity();
  await f.history.capture({ historyRow: () => ({ id: 'private-index', cloud: true }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Protected synthetic transcript' }] }) }, first);
  const copy = (await f.history.list()).items[0];
  let pages = 0;
  f.store.list = async () => {
    if (++pages === 1) return { items: [copy], next: 1 };
    f.identity = identity('two');
    return { items: [], next: null };
  };
  await assert.rejects(f.history.indexedRows(false, 2), /账号(?:或服务)?已切换/);
});
test('deleted protected receipts remain private across account, Hub and signout changes', async t => {
  const f = setup(t), owner = identity();
  await f.history.capture({ historyRow: () => ({ id: 'private-receipt', cloud: true, title: 'Private receipt title' }),
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Private receipt body' }] }) }, owner);
  const copy = (await f.history.list()).items[0];
  await f.history.lifecycle(copy.id, 'delete');
  const remote = require('../main/pi-session/local-history-remote.cjs').create({ ...f });
  for (const other of [identity('two'), { ...owner, hub: 'https://another.invalid' }, null]) {
    f.identity = other;
    assert.deepEqual((await f.history.list()).items, []);
    await assert.rejects(remote({ action: 'read', id: copy.id }, async () => {}), /不存在/);
  }
  f.identity = owner;
  const receipt = await remote({ action: 'read', id: copy.id }, async () => {});
  assert.equal(receipt.conversation.title, 'Private receipt title');
  assert.equal(receipt.conversation.deleted, true);
  assert.deepEqual(receipt.items, []);
  await f.history.projectRows([f.row]);
  await f.history.lifecycle(f.row.id, 'delete');
  f.identity = identity('two');
  await assert.rejects(remote({ action: 'read', id: f.row.id }, async () => {}), /不存在|账号/,
    'ordinary deletion receipts cannot disclose the previous account history');
  const resolve = f.history.resolve.bind(f.history);
  f.identity = owner;
  f.history.resolve = async id => { const row = await resolve(id); f.identity = identity('two'); return row; };
  await assert.rejects(remote({ action: 'read', id: copy.id }, async () => {}), /账号(?:或服务)?已切换/);
});
for (const operation of ['archive', 'restore', 'delete']) {
  test(`a late protected ${operation} commit cannot publish or return its payload to the next account`, async t => {
    const f = setup(t), owner = identity(), deliveries = [];
    await f.history.capture({ historyRow: () => ({ id: 'private-mutation', cloud: true, title: 'Private lifecycle title' }),
      snapshot: () => ({ messages: [{ role: 'assistant', text: 'Private lifecycle body' }] }) }, owner);
    const copy = (await f.history.list()).items[0];
    if (operation === 'restore') await f.history.lifecycle(copy.id, 'archive');
    const mutate = f.store.lifecycle.bind(f.store);
    f.store.lifecycle = async (...args) => {
      const result = await mutate(...args);
      if (args[1] === operation) f.identity = identity('two');
      return result;
    };
    const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f,
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {
        send: (_event, payload) => deliveries.push({ identity: f.identityOf(), payload }) } }] } });
    await assert.rejects(action(operation, copy.id, { confirmed: true }), /账号(?:或服务)?已切换/);
    assert.ok(deliveries.every(item => item.identity.session === owner.session), 'only the original account receives authorized notifications');
    assert.equal(await f.history.resolve(copy.id), null);
    const retained = await f.store.get(copy.id);
    assert.equal(retained.deleted, operation === 'delete');
    assert.equal(retained.archived, operation === 'archive');
    assert.deepEqual((await f.history.list()).items, []);
  });
}
test('ordinary local lifecycle cannot publish completion after signout', async t => {
  const f = setup(t), deliveries = [], mutate = f.store.lifecycle.bind(f.store);
  f.store.lifecycle = async (...args) => { const result = await mutate(...args); f.identity = null; return result; };
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f,
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_event, payload) => deliveries.push(payload) } }] } });
  await assert.rejects(action('archive', f.row.id), /账号(?:或服务)?已切换/);
  assert.equal(deliveries.length, 0);
  const retained = await f.store.get(f.row.id);
  assert.equal(retained.archived, true, 'an accepted local mutation is retained without publishing to a new actor');
  assert.equal(await f.history.resolve(f.row.id), null);
  const access = require('../main/conversation/history-access');
  assert.throws(() => access.assertOwner(f.app, f.row.id, access.actor(f.app, null), retained), /登录/);
});
test('legacy outbox recovery preserves sparse positions with bounded batches before metadata-only sync', async t => {
  const f = setup(t), original = f.store.cache.bind(f.store); let writes = 0;
  f.store.cache = (...args) => { writes++; return original(...args); };
  const messages = Array.from({ length: 250 }, (_, i) => ({ position: i < 150 ? i : i + 10,
    role: 'user', text: 'retained-' + i }));
  const job = { hub: identity().hub, ownerKey: 'original', body: {
    sourceSessionId: 'orphan', sourceEpoch: 'first', title: 'Recovered', messages } };
  await f.history.preserveLegacyOutbox(job, identity());
  const recovered = (await f.history.list({ archived: true })).items[0];
  assert.equal(writes, 3);
  const first = await f.store.messages(recovered.id, { limit: 200 });
  const last = await f.store.messages(recovered.id, { after: first.next, limit: 200 });
  assert.deepEqual([...first.items, ...last.items].map(row => [row.position, row.text]), messages.map(row => [row.position, row.text]));
  await f.history.preserveLegacyOutbox(job, identity());
  assert.equal((await f.history.list({ archived: true })).items.length, 1);
});
test('local lifecycle never calls cloud or account mutation endpoints', async t => {
  const f = setup(t), events = [];
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f,
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_event, data) => events.push(data) } }] },
    trash: async (_shell, file) => fs.renameSync(file, path.join(f.root, 'recycled.jsonl')) });
  assert.equal((await action('delete', 'one')).needsConfirm, true);
  assert.equal((await action('delete', 'one', null)).needsConfirm, true);
  assert.equal(fs.existsSync(f.file), true);
  assert.equal((await action('archive', 'one')).archived, true);
  assert.equal((await f.history.projectRows([f.row])).length, 0);
  assert.equal((await action('restore', 'one')).archived, false);
  assert.equal((await action('delete', 'one', { confirmed: true })).deleted, true);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal((await f.history.projectRows([f.row])).length, 0);
  assert.equal(events.at(-1).presence.deleted, true);
  assert.equal((await action('delete', 'one', { confirmed: true })).alreadyDeleted, true);
});
test('failed recycle preserves archived retry entry and original bytes', async t => {
  const f = setup(t);
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f,
    trash: async () => { throw Error('recycle failed'); } });
  await assert.rejects(action('delete', 'one', { confirmed: true }), /recycle failed/);
  assert.equal(fs.existsSync(f.file), true);
  assert.equal((await f.history.resolve('one')).archived, true);
  assert.equal((await f.history.resolve('one')).deleted, false);
});
test('active local execution remains protected from archive or delete', async t => {
  const f = setup(t);
  f.live = { inFlight: () => true };
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f, trash: async () => assert.fail('must not recycle') });
  await assert.rejects(action('archive', 'one'), /还在执行/);
  await assert.rejects(action('delete', 'one', { confirmed: true }), /还在执行/);
  assert.equal((await f.history.resolve('one')).deleted, false);
});
test('downloaded cloud copy remains with its account and late refresh cannot revive its deletion', async t => {
  const f = setup(t);
  const handle = { snapshot: () => ({ messages: [{ role: 'assistant', text: 'saved cloud answer' }] }),
    historyRow: () => ({ id: 'remote-one', cloud: true, remoteProjection: true, adapterId: 'codex-harness', title: 'Cloud result' }) };
  await f.history.capture(handle, identity());
  const copy = (await f.history.list()).items[0];
  assert.ok(copy.id.startsWith('copy-'));
  assert.equal(copy.cloud, false);
  assert.equal((await f.history.read(copy.id)).items[0].text, 'saved cloud answer');
  await assert.rejects(f.history.lifecycle(copy.id, 'delete', identity('two')), /账号/);
  f.switch(identity('two'));
  assert.equal((await f.history.list()).items.length, 0);
  await assert.rejects(f.history.read(copy.id), /不存在/);
  f.switch(identity());
  await f.history.lifecycle(copy.id, 'delete', identity());
  await f.history.capture(handle, identity());
  assert.equal((await f.history.list()).items.length, 0);
  assert.equal((await f.history.resolve(copy.id)).deleted, true);
  assert.equal((await f.history.resolve(copy.id)).source.id, 'remote-one');
});

test('archived task copies keep executable origins out of cold recent history until explicit restore', async t => {
  const f = setup(t), who = identity();
  const origin = { id: 'remote-one', taskId: 'task-one', cloud: true, remoteProjection: true,
    title: 'Same title', at: 20 };
  const alias = { ...origin, id: 'remote-alias', historyAliasIds: [origin.id] };
  const namesake = { ...origin, id: 'other', taskId: 'other-task' };
  await f.history.capture({ snapshot: () => ({ messages: [{ role: 'assistant', text: 'retained' }] }),
    historyRow: () => origin }, who);
  const copy = (await f.history.list()).items[0];
  await f.history.lifecycle(copy.id, 'archive', who);
  const projections = [origin, alias, namesake];
  assert.equal((await f.history.remoteLifecycle(projections, who)).length, 2);
  assert.deepEqual(await f.history.remoteLifecycle(projections, identity('two')), []);
  assert.deepEqual(await f.history.remoteLifecycle(projections, { ...who, hub: 'https://other.invalid' }), []);
  const makeBridge = () => {
    const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app: f.app,
      sessionModule: { open: async () => ({}), probe: async () => ({ ok: true }),
        history: async () => ({ ok: true, chats: [] }) }, runnerAdapters: [] });
    bridge.setExternalHistory({ history: async options => ({ ok: true, chats: options?.archived ? [] : projections }) });
    bridge.setReplicaHistory({ ...f.history, remoteLifecycle: rows => f.history.remoteLifecycle(rows, who) });
    return bridge;
  };
  let bridge = makeBridge();
  assert.deepEqual((await bridge.history()).chats.map(row => row.id), ['other']);
  await bridge.dispose();
  bridge = makeBridge();
  assert.deepEqual((await bridge.history()).chats.map(row => row.id), ['other']);
  assert.ok((await bridge.archivedHistory()).chats.some(row => row.id === copy.id));
  await f.history.lifecycle(copy.id, 'restore', who);
  const restored = await bridge.history();
  const restoredTask = restored.chats.filter(row => row.taskId === 'task-one');
  assert.equal(restoredTask.length, 2, 'restoring the local transcript also restores access to its independent cloud original');
  assert.ok(restoredTask.some(row => row.id === copy.id && row.cached));
  assert.ok(restoredTask.some(row => row.cloud && row.id !== copy.id));
  assert.ok(restored.lifecycle.some(row => row.id === origin.id && !row.archived && row.lifecycleRevision > 0));
  assert.equal((await f.history.read(copy.id)).items[0].text, 'retained');
  await f.history.lifecycle(copy.id, 'delete', who);
  assert.deepEqual(await f.history.remoteLifecycle(projections, who), []);
  assert.equal((await bridge.history()).chats.filter(row => row.taskId === 'task-one').length, 1);
  await bridge.dispose();
});

test('remote lifecycle skips unrelated inventory and resolves all alias batches with the newest explicit intent', async t => {
  const f = setup(t), who = identity();
  f.store.list = () => assert.fail('Lifecycle overlays must not scan the local inventory');
  let queries = 0;
  const lookup = f.store.remoteLifecycleRows.bind(f.store);
  f.store.remoteLifecycleRows = options => { queries++; return lookup(options); };
  assert.deepEqual(await f.history.remoteLifecycle([], who), []);
  assert.deepEqual(await f.history.remoteLifecycle([{ id: 'native' }], who), []);
  assert.equal(queries, 0);
  const origin = { id: 'last-alias', taskId: 'shared-task', cloud: true };
  await f.history.capture({ snapshot: () => ({ messages: [{ role: 'assistant', text: 'retained' }] }),
    historyRow: () => origin }, who);
  const original = f.store.get('last-alias');
  await f.history.lifecycle(original.id, 'archive', who);
  f.store.register([{ id: 'second-copy', cached: true, taskId: origin.taskId,
    source: { id: 'another-origin', account: 'one', hub: who.hub } }]);
  await f.history.lifecycle('second-copy', 'archive', who);
  await f.history.lifecycle('second-copy', 'restore', who);
  f.store.register([{ id: 'foreign-copy', cached: true, taskId: origin.taskId,
    source: { id: 'foreign-origin', account: 'one', hub: 'https://foreign.test' } }]);
  f.identity = { ...who, hub: 'https://foreign.test' };
  await f.history.lifecycle('foreign-copy', 'archive', f.identityOf());
  f.identity = who;
  const rows = Array.from({ length: 205 }, (_, index) => ({ id: 'view-' + index, cloud: true,
    historyAliasIds: [index === 204 ? 'last-alias' : 'missing-' + index] }));
  rows.push({ id: 'task-view', taskId: origin.taskId, remoteProjection: true });
  const states = await f.history.remoteLifecycle(rows, who);
  assert.deepEqual(states.map(row => [row.id, row.archived]).sort(), [['task-view', false], ['view-204', true]]);
  assert.equal(queries, 3, 'Every source identity batch is queried, including the last alias');
  assert.deepEqual(await f.history.remoteLifecycle(rows, { ...who, hub: 'malformed' }), []);
  assert.equal(queries, 3);
});

test('large cloud snapshots are cached in bounded batches without losing their tail', async t => {
  const f = setup(t), original = f.store.cache.bind(f.store), writes = [];
  f.store.cache = (id, messages, options) => {
    writes.push({ bytes: Buffer.byteLength(JSON.stringify(messages)), ...options });
    return original(id, messages, options);
  };
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'assistant', text: String(i) + 'x'.repeat(600000) }));
  const handle = { snapshot: () => ({ messages }), historyRow: () => ({ id: 'large-remote', cloud: true }) };
  await f.history.capture(handle, identity());
  assert.ok(writes.length > 1);
  assert.ok(writes.every(row => row.bytes < 16 * 1024 * 1024));
  assert.equal(writes.at(-1).complete, true);
  const copy = (await f.history.list()).items[0];
  const stored = []; let after = 0;
  do {
    const page = await f.history.read(copy.id, { after });
    stored.push(...page.items); after = page.nextCursor;
  } while (after !== null);
  assert.deepEqual(stored.map(row => row.text), messages.map(row => row.text));
  messages.splice(2);
  await f.history.capture(handle, identity());
  assert.equal((await f.history.read(copy.id)).items.length, 2);
});

test('verified same-account native history remains readable and manageable offline without execution authority', async t => {
  const f = setup(t), first = identity(), auth = require('../main/device-auth'), previous = auth.localOwner;
  await f.history.projectRows([f.row]);
  auth.localOwner = () => require('../main/platform-connections/runtime.cjs').scope(first);
  t.after(() => { auth.localOwner = previous; });
  f.identity = { ...first, session: require('./helpers/platform-session-fixture.cjs').sessions().expired };
  const view = await f.history.open(f.row.id);
  assert.equal(view.snapshot().messages[0].text, 'saved by Alice');
  assert.equal((await view.send('must not execute')).accepted, false);
  assert.equal((await f.history.lifecycle(f.row.id, 'archive')).conversation.archived, true);
  assert.equal((await f.history.lifecycle(f.row.id, 'restore')).conversation.archived, false);
  f.identity = { ...f.identityOf(), hub: 'https://another.invalid' };
  assert.equal(await f.history.open(f.row.id), null);
  assert.equal(await f.history.lifecycle(f.row.id, 'delete'), null);
  assert.equal((await f.store.get(f.row.id)).deleted, false);
});

test('catalog scope retains persisted protection without disclosing protected IDs after credential expiry', async t => {
  const f = setup(t), first = identity(), auth = require('../main/device-auth'), previous = auth.localOwner;
  const scope = require('../main/platform-connections/runtime.cjs').scope(first);
  const signals = [{ historyProtection: 'account' }, { acceptanceReview: true }, { requirementContext: { private: 'context' } },
    { taskId: 'private-task' }, { taskRef: 'private-ref' }, { activeTaskId: 'private-active' },
    { taskIds: ['private-task'] }, { taskBindings: [{ taskId: 'private-task' }] }];
  await f.history.register(signals.map((signal, index) => ({ id: 'protected-catalog-' + index,
    creator: f.row.creator, workOwner: scope, title: 'Private protected title', ...signal })));
  const authorized = await f.history.page({ limit: 20 });
  assert.equal(authorized.chats.length, signals.length);
  assert.equal(authorized.localCatalog.items.length, signals.length);
  assert.ok(!JSON.stringify(authorized.localCatalog).includes('private-'));
  auth.localOwner = () => scope;
  t.after(() => { auth.localOwner = previous; });
  f.identity = { ...first, session: require('./helpers/platform-session-fixture.cjs').sessions().expired };
  const denied = await f.history.page({ limit: 20 });
  assert.deepEqual(denied.chats, []);
  assert.deepEqual(denied.localCatalog.items, [], 'Catalog IDs and aliases obey the full row protection boundary');
  assert.equal((await f.store.list({ limit: 20 })).items.length, signals.length, 'Filtering does not delete protected records');
});

test('a missing runtime archive cannot strand new user and assistant text behind the initial empty capture', async t => {
  const f = setup(t);
  fs.unlinkSync(f.file);
  let messages = [];
  const handle = { snapshot: () => ({ messages }), historyRow: () => f.row };
  await f.history.capture(handle, f.identityOf());
  messages = [{ role: 'user', text: 'A new request' }, { role: 'assistant', blocks: [{ kind: 'text', text: 'A reply' }] }];
  await f.history.capture(handle, f.identityOf());
  messages = [];
  await f.history.capture(handle, f.identityOf());
  f.switch(identity('two'));
  const view = await f.history.open('one', { historyPreview: true, allowContinuation: true });
  assert.deepEqual(view.snapshot().messages.map(m => m.text), ['A new request', 'A reply']);
  assert.equal(view.snapshot().execution.canContinueOnDevice, false);
  await assert.rejects(f.history.prepareContinuation('one'), { code: 'HISTORY_INCOMPLETE' });
  await view.close();
});

test('a verified prefix enriches the displayed dialogue without discarding a newer turn or authorizing replay', async t => {
  const f = setup(t);
  f.row.workOwner = require('../main/platform-connections/runtime.cjs').scope(f.identityOf());
  await f.history.register([f.row]);
  const live = [{ role: 'user', text: 'saved by Alice' }, { role: 'assistant', text: 'local answer' },
    { role: 'user', text: 'next request' }, { role: 'assistant', text: 'newest reply' }];
  await f.history.capture({ snapshot: () => ({ messages: live }), historyRow: () => f.row }, f.identityOf());
  const page = await f.history.read(f.row.id);
  assert.deepEqual(page.items.map(m => m.text), live.map(m => m.text));
  assert.ok(page.items[1].blocks.length);
  assert.equal(page.coverage.complete, false);
  await assert.rejects(f.history.exportPortable(f.row.id), /尚未完整/);
  fs.appendFileSync(f.file, '\n' + live.slice(2).map((m, i) => JSON.stringify({ type: 'message', id: 'new-' + i,
    message: { role: m.role, content: [{ type: 'text', text: m.text }] } })).join('\n') + '\n');
  const restored = await f.history.prepareContinuation(f.row.id, { refresh: true });
  assert.deepEqual(restored.prefix.messages.map(m => m.text), live.map(m => m.text));
});

async function pendingTailFixture(t) {
  const f = setup(t), segments = require('../main/conversation/runtime-segments');
  const key = 'chat:recovery:qwen', ref = require('../main/agent-runtime/runner-adapter').runnerRefForDispatch(key);
  const original = [{ role: 'user', text: 'saved by Alice' }, { role: 'assistant', text: 'local answer' }];
  const pending = { role: 'user', text: 'a request to review before sending' };
  const admitted = new Set(), delivered = new Set(), awaitingAdmission = new Set();
  t.mock.method(require('../main/runner-runtime'), 'rpc', async (method, args) => {
    if (method === 'job.session') {
      if (delivered.has(args.ref)) return { ok: true, data: { ref: args.ref, seq: 2, items: [
        { seq: 1, kind: 'user', text: pending.text }, { seq: 2, kind: 'say', text: 'received once' }] } };
      return { ok: true, data: { ok: false, ref: args.ref, code: 'NATIVE_HISTORY_MISSING', items: [] } };
    }
    assert.equal(method, 'job.has');
    assert.equal(args.checkPendingWork, true);
    const persisted = Boolean(admitted.has(args.ref) && args.admissionKey);
    return { ok: true, data: { has: persisted, persisted, inflight: false, admissionDurable: true,
      localWorkPending: awaitingAdmission.has(args.ref),
      bootId: 'one-boot', admissionKey: args.admissionKey || '' } };
  });
  f.row.workOwner = segments.scope(f.identityOf());
  await segments.save(f.app, { version: 1, id: f.row.id, owner: f.row.workOwner, originAdapter: 'pi', cwd: f.row.cwd,
    segments: [{ sessionId: f.row.id, adapterId: 'pi' }], active: { adapterId: 'qwen', sessionId: ref, nativeDispatchId: key, started: false } });
  await f.history.register([f.row]);
  const capture = messages => f.history.capture({ historyRow: () => f.row, snapshot: () => ({ messages }) }, f.identityOf());
  await capture([...original, pending]);
  const preview = async () => {
    const view = await f.history.open(f.row.id, { historyPreview: true, allowContinuation: true });
    try { return view.snapshot(); } finally { await view.close(); }
  };
  const strict = expectedPendingUserDigest => f.history.prepareContinuation(f.row.id,
    { refresh: true, allowUndispatchedTail: true, expectedPendingUserDigest });
  return { f, segments, ref, pending, original, admitted, delivered, awaitingAdmission, capture, preview, strict };
}

test('a captured history tail remains read-only while its local dispatch is waiting for admission', async t => {
  const { ref, awaitingAdmission, preview, strict } = await pendingTailFixture(t);
  const initial = await preview();
  assert.equal(initial.execution.canContinueOnDevice, true);
  awaitingAdmission.add(ref);
  assert.equal((await preview()).execution.canContinueOnDevice, false);
  await assert.rejects(strict(initial.historyRecovery.pendingUserDigest));
});

test('only the owner can recover a single unadmitted user message outside native execution history', async t => {
  const { f, ref, pending, original, admitted, delivered, capture, preview, strict } = await pendingTailFixture(t);
  const owner = await preview();
  assert.equal(owner.execution.canContinueOnDevice, true);
  assert.equal(owner.historyRecovery.reasonCode, 'HISTORY_UNDISPATCHED_USER_TAIL');
  assert.equal(owner.historyRecovery.pendingUserText, pending.text);
  assert.deepEqual(owner.messages.map(m => m.text), original.map(m => m.text));
  const digest = owner.historyRecovery.pendingUserDigest;
  const changed = { code: 'HISTORY_PENDING_USER_TAIL_CHANGED' };
  await assert.rejects(strict('stale'), changed);
  await assert.rejects(strict(null), changed);
  const verified = await strict(digest);
  assert.equal(verified.historyRecovery.transcriptTail.digest, owner.historyRecovery.pendingUserDigest);
  assert.equal(verified.historyRecovery.pendingUserText, undefined);
  assert.deepEqual(verified.prefix.messages.map(m => m.text), original.map(m => m.text));
  await assert.rejects(f.history.prepareContinuation(f.row.id, { refresh: true }), { code: 'HISTORY_INCOMPLETE' });
  await assert.rejects(f.history.exportPortable(f.row.id), /尚未完整/);
  assert.deepEqual(f.store.conversationTranscript(f.row.id).at(-1), pending, 'a preview or strict check must not consume the draft');

  admitted.add(ref);
  const late = await preview();
  assert.equal(late.execution.canContinueOnDevice, false);
  assert.equal(late.historyRecovery.reasonCode, 'HISTORY_UNCONFIRMED_USER_TAIL');
  assert.equal(late.historyRecovery.pendingUserText, undefined);
  assert.equal(late.messages.at(-1).text, pending.text);
  await assert.rejects(strict(), { code: 'HISTORY_INCOMPLETE' });
  await assert.rejects(strict(digest), changed);
  admitted.delete(ref);
  f.switch(identity('two'));
  assert.equal((await preview()).execution.canContinueOnDevice, false);
  await assert.rejects(strict());
  f.switch(identity());
  await capture([...original, pending, { role: 'assistant', text: 'received once' }]);
  assert.equal((await preview()).historyRecovery.pendingUserText, undefined);
  await assert.rejects(strict(), { code: 'HISTORY_INCOMPLETE' });
  delivered.add(ref);
  await assert.rejects(strict(digest), changed);
  assert.equal((await strict(null)).prefix.messages.at(-1).text, 'received once');
});

test('reopening after allocating a new empty recovery segment rechecks all earlier unadmitted allocations', async t => {
  const { f, segments, ref, pending, admitted, delivered, preview, strict } = await pendingTailFixture(t);
  const digest = (await preview()).historyRecovery.pendingUserDigest;
  const verified = await strict(digest);
  const before = segments.read(f.app, f.row.id);
  const key = 'chat:recovery:next', next = require('../main/agent-runtime/runner-adapter').runnerRefForDispatch(key);
  await segments.save(f.app, { ...before, prefix: verified.prefix, deviceHistoryComplete: true,
    historyRecovery: verified.historyRecovery, segments: [...before.segments, before.active],
    active: { adapterId: 'qwen', sessionId: next, nativeDispatchId: key, started: false } });
  assert.equal((await strict(digest)).historyRecovery.transcriptTail.sourceId, ref);
  const verifySend = () => f.history.verifyRecoverySend(f.row.id, next, verified.historyRecovery.transcriptTail);
  await verifySend();
  for (const receipt of [ref, next]) {
    admitted.add(receipt);
    assert.equal((await preview()).execution.canContinueOnDevice, false);
    await assert.rejects(strict(digest), { code: 'HISTORY_PENDING_USER_TAIL_CHANGED' });
    await assert.rejects(verifySend(), { code: 'HISTORY_PENDING_USER_TAIL_CHANGED' });
    assert.deepEqual(f.store.conversationTranscript(f.row.id).at(-1), pending);
    admitted.delete(receipt);
  }
  delivered.add(ref);
  await assert.rejects(strict(digest), { code: 'HISTORY_PENDING_USER_TAIL_CHANGED' });
  delivered.delete(ref);
  const nativeEntry = f.session.historyEntry;
  f.session.historyEntry = (app, id) => id === f.row.id ? nativeEntry(app, id) : { ok: false, notFound: true };
  await segments.save(f.app, { ...segments.read(f.app, f.row.id),
    active: { adapterId: 'pi', sessionId: 'new-pi-without-archive', started: false } });
  assert.equal((await preview()).execution.canContinueOnDevice, false);
  await assert.rejects(strict(digest), { code: 'HISTORY_PENDING_USER_TAIL_CHANGED' });
  assert.deepEqual(f.store.conversationTranscript(f.row.id).at(-1), pending);
});

test('an accepted turn checkpoints its dialogue while native replay is still blocked', async t => {
  const f = setup(t);
  let begin, finish;
  const started = new Promise(resolve => { begin = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const lookup = f.session.historyEntry;
  f.session.historyEntry = async (...args) => { begin(); await gate; return lookup(...args); };
  let messages = [], on;
  const handle = { snapshot: () => ({ messages }), historyRow: () => f.row,
    on(listener) { on = listener; return () => {}; }, close: async () => true };
  f.history.observe(handle, f.identityOf());
  await started;
  try {
    messages = [{ role: 'user', text: 'accepted while the archive is busy' }];
    on({ kind: 'started' });
    for (let i = 0; i < 20 && !f.store.conversationTranscript('one').length; i++)
      await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.store.conversationTranscript('one'), messages);
  } finally { finish(); await handle.close(); }
});

test('an accepted turn before initial registration survives even while the native read waits', async t => {
  const f = setup(t);
  let indexed, release, on, messages = [];
  const registered = new Promise(resolve => { indexed = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const lookup = f.session.historyEntry;
  f.session.historyEntry = async (...args) => { indexed(); await blocked; return lookup(...args); };
  const handle = { snapshot: () => ({ messages }), historyRow: () => f.row,
    on(listener) { on = listener; return () => {}; }, close: async () => true };
  f.history.observe(handle, f.identityOf());
  messages = [{ role: 'user', text: 'accepted before the index commit' }];
  on({ kind: 'started' });
  try {
    await registered;
    for (let i = 0; i < 20 && !f.store.conversationTranscript('one').length; i++)
      await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.store.conversationTranscript('one'), messages);
    messages = [...messages, { role: 'assistant', text: 'provisional', done: false }];
    on({ kind: 'message' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.conversationTranscript('one').at(-1).text, 'provisional');
    messages = [messages[0], { role: 'assistant', text: 'corrected', done: true }, { role: 'user', text: 'next' }];
    on({ kind: 'message' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.store.conversationTranscript('one').map(item => item.text),
      ['accepted before the index commit', 'corrected', 'next']);
  } finally { release(); await handle.close(); }
});

test('a live task binding protects the indexed conversation before the native read completes', async t => {
  const f = setup(t);
  let begin, release, on, original = f.row;
  const started = new Promise(resolve => { begin = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const lookup = f.session.historyEntry;
  f.session.historyEntry = async (...args) => { begin(); await blocked; return lookup(...args); };
  const handle = { snapshot: () => ({ messages: [{ role: 'user', text: 'protected' }] }), historyRow: () => original,
    on(listener) { on = listener; return () => {}; }, close: async () => true };
  const write = t.mock.method(f.store, 'saveConversationTranscript');
  f.history.observe(handle, f.identityOf());
  await started;
  try {
    original = { ...f.row, taskBindings: [{ taskId: 'bound-after-index' }] };
    on({ kind: 'message' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(write.mock.callCount(), 0);
    assert.equal(f.store.get('one').historyProtection, 'account');
    original = f.row;
  } finally { release(); await handle.close(); }
  assert.equal(f.store.get('one').historyProtection, 'account');
  f.switch(identity('two'));
  assert.equal(await f.history.open('one'), null);
});

test('additional dialogue write failures leave native archiving available', async t => {
  const f = setup(t);
  f.store.saveConversationTranscript = () => { throw Error('synthetic transcript write failure'); };
  const handle = { snapshot: () => ({ messages: [{ role: 'user', text: 'visible' }] }), historyRow: () => f.row };
  await f.history.capture(handle, f.identityOf());
  assert.match(handle.localHistoryError, /synthetic transcript write failure/);
  const saved = f.store.deviceHistory('one');
  assert.equal(saved.coverage.complete, true);
  assert.equal(saved.snapshot.messages[0].text, 'saved by Alice');
});

test('dialogue retries a concurrent index refresh only after checking the latest protection', async t => {
  for (const protectedRow of [false, true]) await t.test(protectedRow ? 'bound task' : 'ordinary update', async t => {
    const f = setup(t), save = f.store.saveConversationTranscript;
    let writes = 0;
    f.store.saveConversationTranscript = (id, entries, expected) => {
      if (++writes === 1) f.store.register([{ id, title: 'New catalog revision',
        ...(protectedRow ? { taskId: 'private-task' } : {}) }]);
      return save(id, entries, expected);
    };
    const messages = [{ role: 'user', text: 'Latest visible request' }];
    await f.history.capture({ snapshot: () => ({ messages }), historyRow: () => f.row }, f.identityOf());
    assert.deepEqual(f.store.conversationTranscript('one'), protectedRow ? [] : messages);
    assert.equal(writes, protectedRow ? 1 : 2);
  });
});

test('cloud message events keep the batched cloud cache schedule', async t => {
  const f = setup(t);
  let on, messages = [{ role: 'user', text: 'first' }];
  const cloud = { id: 'cloud-origin', cloud: true };
  const handle = { snapshot: () => ({ messages }), historyRow: () => cloud,
    on(listener) { on = listener; return () => {}; }, close: async () => true };
  const cache = t.mock.method(f.store, 'cache'), dialogue = t.mock.method(f.store, 'saveConversationTranscript');
  f.history.observe(handle, f.identityOf());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cache.mock.callCount(), 1);
  messages.push({ role: 'assistant', text: 'cloud answer' });
  for (const kind of ['started', 'message', 'settled']) {
    on({ kind }); await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(cache.mock.callCount(), 1);
  await handle.close();
  assert.equal(cache.mock.callCount(), 2);
  assert.equal(dialogue.mock.callCount(), 0);
});

test('a cold desktop preview paints committed dialogue while the native history read is blocked', async t => {
  const f = setup(t);
  const messages = [{ role: 'user', text: 'saved by Alice' }, { role: 'assistant', text: 'local answer' }];
  await f.history.capture({ historyRow: () => f.row, snapshot: () => ({ messages }) }, f.identityOf());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const lookup = f.session.historyEntry;
  f.session.historyEntry = async (...args) => { await gate; return lookup(...args); };
  let timer;
  try {
    const view = await Promise.race([f.history.open('one', { historyPreview: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Preview waited for the native runtime')), 2000); })]);
    assert.deepEqual(view.snapshot().messages.map(m => m.text), messages.map(m => m.text));
    await view.close();
  } finally { clearTimeout(timer); release(); }
});

test('distinct saved versions keep rich native messages and mark the independent dialogue', async t => {
  const f = setup(t);
  const live = [{ role: 'user', text: 'saved by Alice' }, { role: 'assistant', text: 'a different confirmed reply', done: true }];
  await f.history.capture({ historyRow: () => f.row, snapshot: () => ({ messages: live }) }, f.identityOf());
  const view = await f.history.open('one', { historyPreview: true, allowContinuation: true });
  const messages = view.snapshot().messages;
  assert.deepEqual(messages.map(m => m.text), ['saved by Alice', 'local answer', 'a different confirmed reply']);
  assert.equal(messages[2].historyTranscriptBoundary, true);
  assert.equal(view.snapshot().execution.canContinueOnDevice, false);
  await view.close();
});

test('a stale streaming draft allows the verified final answer and following turns to be displayed', async t => {
  const f = setup(t);
  const live = [{ role: 'user', text: 'saved by Alice' }, { role: 'assistant', text: 'obsolete stream', done: false }];
  await f.history.capture({ historyRow: () => f.row, snapshot: () => ({ messages: live }) }, f.identityOf());
  const later = { type: 'message', id: 'msg-3', message: { role: 'user', content: 'another request' } };
  fs.appendFileSync(f.file, '\n' + JSON.stringify(later));
  const restored = await f.history.prepareContinuation('one', { refresh: true });
  assert.deepEqual(restored.prefix.messages.map(m => m.text), ['saved by Alice', 'local answer', 'another request']);
});

test('corruption of independent text leaves verified native history readable and explicitly blocks continuation', async t => {
  const f = setup(t);
  const live = [{ role: 'user', text: 'saved by Alice' }, { role: 'assistant', text: 'local answer' }];
  await f.history.capture({ historyRow: () => f.row, snapshot: () => ({ messages: live }) }, f.identityOf());
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(f.root, 'replicas.sqlite'));
  db.prepare('UPDATE conversation_transcript SET digest=? WHERE replica=? AND position=1').run('damaged', 'one');
  db.close();
  const page = await f.history.read('one');
  assert.deepEqual(page.items.map(m => m.text), live.map(m => m.text));
  assert.equal(page.nativeReadError.code, 'TRANSCRIPT_CHECKSUM_MISMATCH');
  await assert.rejects(f.history.prepareContinuation('one'), { code: 'HISTORY_INCOMPLETE' });
});

test('different stream boundaries for identical assistant text preserve native messages and execution evidence', async t => {
  const f = setup(t);
  const messages = [{ role: 'user', text: 'saved by Alice' }, { role: 'assistant', text: 'local ' },
    { role: 'assistant', text: 'answer' }];
  await f.history.capture({ historyRow: () => f.row, snapshot: () => ({ messages }) }, f.identityOf());
  const view = await f.history.open('one', { historyPreview: true, allowContinuation: true });
  assert.deepEqual(view.snapshot().messages.map(m => m.text), ['saved by Alice', 'local answer']);
  assert.equal(view.snapshot().execution.canContinueOnDevice, true);
  await view.close();
  assert.equal((await f.history.prepareContinuation('one', { refresh: true })).prefix.messages.length, 2);
});
