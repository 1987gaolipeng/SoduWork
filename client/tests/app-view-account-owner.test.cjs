'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const owners = require('../main/work-preview-app-owner.cjs');
const store = require('../main/app-settings-store.cjs');
const connection = require('../main/work-preview-app-connection.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-view-owner-'));
  const app = { getPath: () => root }, pluginId = 'market-fixture';
  const origin = require('../core/plugin-package-page.cjs').origin(pluginId);
  let owner = 'https://fixture.invalid/account-a', afterFetch = async () => {}, requests = 0;
  store.configure({ app, ownerOf: () => owner, safeStorage: { isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() } });
  const source = { type: 'package', entry: 'ui/index.html', bridge: { capabilities: ['settings.read', 'settings.write', 'mcp.connect'] } };
  const installed = { pluginId, installed: true, enabled: true, permissions: { canUse: true },
    capabilities: { mcpServers: ['fixture'] }, ui: { contributions: [{ id: 'main', slot: 'workspace.navigation', source }] } };
  const deps = { app, identityOf: async () => ({ hub: 'https://fixture.invalid', clientId: 'device', session: 'fixture-session' }),
    fetchImpl: async () => { requests++; await afterFetch(); return Response.json({ items: [installed] }); } };
  const wc = new EventEmitter(); let sent = 0;
  wc.isDestroyed = () => false; wc.getURL = () => origin + '/ui/index.html'; wc.send = () => { sent++; };
  const item = { appBridge: { appId: 'plugin:' + pluginId, contributionId: 'main', origin },
    view: { webContents: wc }, composer: { view: { webContents: wc } } };
  owners.capture(item, deps); owners.associate(wc, item);
  t.after(async () => { await require('../main/work-preview-app-attachments.cjs').dispose(item); store.configure(undefined); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, item, wc, deps, binding: { pluginId, origin }, setOwner: value => { owner = value; },
    onFetch: action => { afterFetch = action; }, requests: () => requests, sent: () => sent };
}

test('a retained prior-account page cannot read secrets, write, connect, automate, attach or send in the next account', async t => {
  const f = fixture(t), attachments = require('../main/work-preview-app-attachments.cjs');
  store.update(f.binding, { values: { token: 'synthetic-account-a' } });
  f.setOwner('https://fixture.invalid/account-b');
  store.update(f.binding, { values: { token: 'synthetic-account-b' } });
  for (const request of [
    { method: 'settings.get', params: { keys: ['token'], includeSecrets: true } },
    { method: 'settings.update', params: { values: { token: 'wrong-owner-write' } } },
  ]) assert.throws(() => connection.settings({ item: f.item }, request, f.deps), { code: 'APP_ACCOUNT_CHANGED' });
  assert.throws(() => connection.connect({ item: f.item }, { server: 'fixture', url: f.binding.origin + '/mcp', credentialKey: 'token' }, f.deps), { code: 'APP_ACCOUNT_CHANGED' });
  assert.throws(() => require('../main/work-preview-app-automation.cjs').submit({ owner: {}, item: f.item, request: {}, deps: f.deps }), { code: 'APP_ACCOUNT_CHANGED' });
  let dialogs = 0;
  assert.equal((await attachments.handle(f.item, 'attachments.pick', {}, { dialog: { showOpenDialog: async () => { dialogs++; return {}; } } })).ok, false);
  assert.equal((await attachments.handle(f.item, 'attachments.begin', { name: 'file.txt', size: 0 })).ok, false);
  await assert.rejects(attachments.checkout(f.item, []), { code: 'APP_ACCOUNT_CHANGED' });
  assert.equal((await require('../main/work-preview-app-chat.cjs').send(f.item, { text: 'stale', requestId: 'stale' })).ok, false);
  assert.deepEqual([f.requests(), f.sent(), dialogs], [0, 0, 0]);
  assert.equal(store.get(f.binding, { keys: ['token'], includeSecrets: true }).values.token, 'synthetic-account-b');
  assert.equal(store.get(f.binding).revision, 1);
});

test('missing, copied or renderer-forged bindings fail closed; trusted inherited pages share only the original account', t => {
  const f = fixture(t), forged = { ...f.item, ownerScope: store.scope(f.binding) };
  assert.throws(() => owners.assertCurrent(forged), { code: 'APP_ACCOUNT_CHANGED' });
  assert.throws(() => owners.capture(f.item, f.deps), { code: 'APP_ACCOUNT_CHANGED' });
  const child = { ...f.item };
  owners.inherit(child, f.item); owners.assertCurrent(child);
  f.setOwner('https://fixture.invalid/account-b');
  assert.throws(() => owners.assertCurrent(child), { code: 'APP_ACCOUNT_CHANGED' });
  assert.throws(() => owners.inherit({ ...f.item }, f.item), { code: 'APP_ACCOUNT_CHANGED' });
});

test('same-account renewal remains valid and local offline pages retain their own scope until login', t => {
  const f = fixture(t);
  f.deps.identityOf = async () => ({ session: 'renewed-same-account-token' });
  owners.assertCurrent(f.item);
  f.setOwner(null);
  const local = { appBridge: { appId: 'plugin:local:offline', origin: 'https://offline.invalid' } };
  owners.capture(local, f.deps); owners.assertCurrent(local);
  f.setOwner('https://fixture.invalid/account-a');
  owners.assertCurrent(f.item);
  assert.throws(() => owners.assertCurrent(local), { code: 'APP_ACCOUNT_CHANGED' });
});

test('account changes during catalog and native-dialog awaits reject the original operation', async t => {
  const f = fixture(t);
  f.onFetch(async () => f.setOwner('https://fixture.invalid/account-b'));
  await assert.rejects(connection.settings({ item: f.item }, { method: 'settings.get', params: {} }, f.deps), { code: 'APP_ACCOUNT_CHANGED' });
  f.setOwner('https://fixture.invalid/account-a');
  const result = await require('../main/work-preview-app-attachments.cjs').handle(f.item, 'attachments.pick', {}, {
    dialog: { showOpenDialog: async () => { f.setOwner('https://fixture.invalid/account-b'); return { filePaths: [] }; } },
  });
  assert.equal(result.ok, false);
});

test('retained native senders and queued turns reject a new account before any global app fallback', async t => {
  const f = fixture(t), grants = require('../main/pi-session/app-mcp-grant.cjs');
  const preview = require('../main/work-preview'), globalApps = require('../main/app-conversation-connection.cjs');
  const originalPreview = preview.appContextFor, originalGlobal = globalApps.context;
  let fallbacks = 0;
  preview.appContextFor = () => ({ pluginId: 'market-fixture', requiresMcp: false, connection: null });
  globalApps.context = () => { fallbacks++; return { pluginId: 'market-fixture', connection: { token: 'must-not-read' } }; };
  try {
    const session = {}, turn = { beforeTurn: async () => f.setOwner('https://fixture.invalid/account-b') };
    grants.bind(session, f.wc, 'market-fixture', f.app);
    grants.guardSend(session, turn);
    await assert.rejects(turn.beforeTurn(), { code: 'APP_ACCOUNT_CHANGED' });
    preview.appContextFor = () => null;
    assert.throws(() => grants.context(f.wc, 'market-fixture', undefined, f.app), { code: 'APP_ACCOUNT_CHANGED' });
    assert.throws(() => grants.guardSend(session, {}), { code: 'APP_ACCOUNT_CHANGED' });
    assert.equal(fallbacks, 0);
  } finally { preview.appContextFor = originalPreview; globalApps.context = originalGlobal; }
});
