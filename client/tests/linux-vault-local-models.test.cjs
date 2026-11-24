'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const store = require('../main/local-model-store.cjs');
const agentStore = require('../main/local-agent-model-store.cjs');
const automationStore = require('../main/local-automation-model-store.cjs');
const capabilities = require('../main/local-model-capabilities.cjs');
const ipc = require('../main/local-model-ipc.cjs');
const agentIpc = require('../main/local-agent-model-ipc.cjs');
const automationIpc = require('../main/local-automation-model-ipc.cjs');
const renderer = require('./renderer-source.cjs');

const passphrase = 'synthetic vault passphrase';
const wrongPassphrase = 'wrong vault passphrase!!';
const secret = 'synthetic-local-model-key';
const hub = 'https://fixture.invalid';
const clientId = 'fixture-device';

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-vault-models-'));
  t.after(() => {
    store.configure(null);
    agentStore.configure(null);
    automationStore.configure(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function blockedNative() {
  return {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString() { throw Error('native encrypt must not run'); },
    decryptString() { throw Error('native decrypt must not run'); },
  };
}

function nativeKeyring() {
  const calls = [];
  return {
    calls,
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) {
      calls.push('encrypt');
      return Buffer.concat([Buffer.from('v11'), Buffer.from(value, 'utf8')]);
    },
    decryptString(value) {
      calls.push('decrypt');
      const bytes = Buffer.from(value);
      if (!bytes.subarray(0, 3).equals(Buffer.from('v11'))) throw Error('bad electron cipher');
      return bytes.subarray(3).toString('utf8');
    },
  };
}

function payload(baseUrl) {
  return {
    providers: [{ id: 'local', name: 'Local', baseUrl, authMode: 'key' }],
    models: [{ providerId: 'local', name: 'fixture-model' }],
    keys: { local: secret },
  };
}

function modelFile(dir) { return path.join(dir, 'local-models.secure.json'); }

function envelope(dir) { return JSON.parse(fs.readFileSync(modelFile(dir), 'utf8')); }

function deskEvent() {
  const url = require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href;
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: frame, getURL: () => url } };
}

function humanLoader(file, startMarker, endMarker, call) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, file);
  const box = { console: { error() {} } };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(text.slice(start, end), box);
  return (error, fallback) => {
    box.error = error;
    box.fallback = fallback;
    return vm.runInContext(call, box);
  };
}

function listen(t) {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization || '' });
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'fixture-model' }, { id: 'discovered-model' }] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  t.after(() => server.close());
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      seen, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    }));
  });
}

test('plain secure-storage errors stay visible without hiding mapped transport errors', () => {
  const pet = humanLoader(path.join(__dirname, '../components/pet/pet-ui.js'),
    'function _humanErr(', '/* Speech bubbles. */', '_humanErr(error, fallback)');
  const desk = humanLoader(path.join(__dirname, '../desk-boot.js'),
    'window._humanErr = function', 'window.petSay = function', 'window._humanErr(error, fallback)');
  const storageError = new Error('系统安全存储不可用，无法保存本地模型凭据');
  for (const human of [pet, desk]) {
    assert.equal(human(storageError, '没测成'), '系统安全存储不可用，无法保存本地模型凭据');
    assert.equal(human(new Error("Error invoking remote method 'local-models-save': Error: 本地模型配置无法读取"), '没测成'), '本地模型配置无法读取');
    assert.equal(human(new Error("Error invoking remote method 'local-models-get': Error: 系统安全存储不可用，无法保存本地模型凭据"), '没测成'), '系统安全存储不可用，无法保存本地模型凭据');
    assert.equal(human(new Error("Error invoking remote method 'local-models-capabilities-check': Error: 系统安全存储不可用，无法读取能力检测记录"), '没测成'), '系统安全存储不可用，无法读取能力检测记录');
    assert.equal(human(new Error("Error invoking remote method 'local-models-capabilities-check': Error: 能力检测记录无法解密，当前密钥与历史记录不匹配，请恢复匹配的密钥后重试"), '没测成'), '能力检测记录无法解密，当前密钥与历史记录不匹配，请恢复匹配的密钥后重试');
    assert.equal(human(new Error('本地模型配置无法读取'), '没测成'), '本地模型配置无法读取');
    assert.equal(human(new Error('x'.repeat(300)), '没测成'), '没测成');
    assert.equal(human({ message: 'Failed to fetch' }, '没测成'), '没测成');
    assert.equal(human({ message: 'HTTP 401 from hub' }, '没测成'), '没权限或登录过期了');
    assert.equal(human({ status: 500, message: 'HTTP 500' }, '没测成'), '没测成');
    assert.equal(human({ detail: '具体原因', message: '其他原文' }, '没测成'), '具体原因');
    assert.equal(human(new Error('   '), '没测成'), '没测成');
    assert.equal(human({ status: 500, message: 'Hub 拒绝了这次保存' }, '没存上'), 'Hub 拒绝了这次保存');
  }
});

test('desktop startup rebinds only local model stores after vault unlock', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(source, /const _linuxModelStorage = process\.platform === 'linux'/);
  assert.match(source, /const _modelSafeStorage = _linuxModelStorage \|\| safeStorage/);
  for (const line of [
    "require('./main/local-model-ipc.cjs').install({ app, ipcMain, safeStorage: _modelSafeStorage",
    "require('./main/local-agent-model-ipc.cjs').install({ app, ipcMain, safeStorage: _modelSafeStorage",
    "require('./main/local-automation-model-ipc.cjs').install({ app, ipcMain, safeStorage: _modelSafeStorage",
    "require('./main/automation-conversations').install({ app, ipcMain, identityOf: _sessionIdentity, conversation: _ordinaryConversations, platformConnections: _platformConnections, safeStorage: _modelSafeStorage })",
  ]) assert.ok(source.includes(line), line);
  assert.match(source, /if \(_linuxModelStorage\) _linuxModelStorage\.bindVault\(credentials\)/);
  assert.match(source, /app-settings-ipc\.cjs'\)\.install\(\{ app, ipcMain, safeStorage,/);
  assert.match(source, /_cloudComputerCredentials\.install\(\{ app, ipcMain, deviceAuth: _deviceAuth, safeStorage \}\)/);
  assert.match(source, /_personalPlugins\.install\(\{ app, ipcMain, dialog: require\('electron'\)\.dialog, safeStorage,/);
  assert.match(source, /platform-connections\/index\.cjs'\)\.install\(\{ app, ipcMain, identityOf: _sessionIdentity, safeStorage, shell \}\)/);
});

test('unlocked vault encrypts local model credentials that native safeStorage cannot read', async t => {
  const vault = require('../main/linux-device-vault.cjs');
  const adapter = require('../main/linux-vault-safe-storage.cjs');
  const binding = require('../main/linux-model-safe-storage.cjs');
  const dir = profile(t);
  const endpoint = await listen(t);
  const opened = await vault.unlock(dir, 'create', passphrase);
  assert.equal(vault.isUnlockedVault(opened), true);
  assert.equal(opened.key, undefined);
  assert.equal(typeof opened.exportKey, 'undefined');
  for (const value of Object.values(opened)) assert.equal(Buffer.isBuffer(value) && value.length === 32, false);
  const headerPath = path.join(dir, 'device-vault-v1');
  const header = fs.readFileSync(headerPath);
  assert.equal(header.length, 48);
  assert.equal(header.includes(Buffer.from(passphrase)), false);

  const deviceCipher = opened.encrypt(secret, hub, clientId);
  assert.throws(() => opened.unprotect(vault.localModelsLabel, deviceCipher), /Cannot decrypt the stored local secret/);
  const localCipher = opened.protect(vault.localModelsLabel, secret);
  assert.throws(() => opened.decrypt('', {
    storage: opened.storage, cipher: localCipher.toString('base64'), hub, clientId,
  }), /Cannot decrypt the stored device credential/);
  assert.notEqual(localCipher.toString('base64'), deviceCipher.toString('base64'));
  assert.throws(() => opened.protect('soduwork-passphrase-v1', secret), /Unsupported vault protection label/);
  assert.equal(localCipher.includes(Buffer.from(secret)), false);
  assert.notEqual(opened.protect(vault.localModelsLabel, secret).toString('base64'), localCipher.toString('base64'));

  const facade = binding.create(blockedNative());
  const handlers = new Map();
  let changes = 0;
  ipc.install({ app: { getPath: () => dir }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    safeStorage: facade, changed: () => { changes += 1; } });
  const event = deskEvent();
  assert.throws(() => handlers.get('local-models-save')(event, payload(endpoint.baseUrl)), /系统安全存储不可用，无法保存本地模型凭据/);
  assert.equal(fs.existsSync(modelFile(dir)), false);
  assert.equal(facade.bindVault(undefined), false);
  assert.equal(facade.bindVault({ platform: 'linux', storage: vault.storage, available: () => true,
    protect() {}, unprotect() {} }), false);
  assert.equal(facade.bindVault(opened), true);
  assert.equal(facade.getSelectedStorageBackend(), vault.localModelsLabel);
  assert.notEqual(facade.getSelectedStorageBackend(), 'basic_text');
  assert.equal(adapter.create(opened).isEncryptionAvailable(), true);

  const saved = handlers.get('local-models-save')(event, payload(endpoint.baseUrl));
  assert.equal(changes, 1);
  assert.equal(saved.providers[0].keySet, true);
  const onDisk = fs.readFileSync(modelFile(dir));
  const parsed = envelope(dir);
  assert.equal(parsed.schema, 2);
  assert.equal(typeof parsed.cipher, 'string');
  assert.equal(Object.keys(parsed).sort().join(), 'cipher,schema');
  assert.equal(onDisk.includes(Buffer.from(secret)), false);
  assert.equal(onDisk.includes(Buffer.from('fixture-model')), false);
  const savedCipher = Buffer.from(parsed.cipher, 'base64');
  assert.equal(adapter.hasEnvelope(savedCipher), true);
  assert.notEqual(savedCipher.subarray(0, 3).toString(), 'v11');
  assert.throws(() => nativeKeyring().decryptString(savedCipher));
  if (process.platform === 'linux') assert.equal(fs.statSync(modelFile(dir)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(headerPath), header);

  const tested = await handlers.get('local-models-test')(event, 'local', 'fixture-model');
  assert.equal(tested.ok, true);
  assert.match(tested.detail, /连接通过/);
  assert.equal(endpoint.seen.some(row => row.url === '/v1/models' && row.authorization === 'Bearer ' + secret), true);
  assert.equal(endpoint.seen.some(row => row.url.includes('/api/v1/my-models/test')), false);
  const afterTest = fs.readFileSync(modelFile(dir), 'utf8');
  assert.equal(afterTest.includes(secret), false);
  assert.equal(afterTest.includes('discovered-model'), false);
  assert.equal(store.get().myModels.some(row => row.name === 'discovered-model'), true);

  const modelName = saved.usable[0].name;
  agentStore.configure({ app: { getPath: () => dir }, safeStorage: facade, modelStore: store,
    runtimes: { runtime: id => id === 'pi' ? { modelMode: 'managed' } : null } });
  automationStore.configure({ app: { getPath: () => dir }, safeStorage: facade });
  assert.equal(agentStore.set({ hub, clientId, owner: 'account:fixture', agentId: 'pi', modelName }).modelName, modelName);
  assert.equal(automationStore.set({ hub, clientId, owner: 'account:fixture', scheduleId: 'schedule-1', modelName }).modelName, modelName);
  for (const name of ['agent-models.secure.json', 'automation-models.secure.json']) {
    const bytes = fs.readFileSync(path.join(dir, name));
    assert.equal(bytes.includes(Buffer.from(secret)), false);
    assert.equal(bytes.includes(Buffer.from(modelName)), false);
  }

  const tampered = Buffer.from(envelope(dir).cipher, 'base64');
  tampered[tampered.length - 1] ^= 1;
  const tamperedText = JSON.stringify({ schema: 2, cipher: tampered.toString('base64') });
  fs.writeFileSync(modelFile(dir), tamperedText);
  assert.throws(() => store.get(), /本地模型配置无法读取/);
  assert.equal(fs.readFileSync(modelFile(dir), 'utf8'), tamperedText);
  fs.writeFileSync(modelFile(dir), afterTest);

  await assert.rejects(vault.unlock(dir, 'unlock', wrongPassphrase), /Could not unlock device vault/);
  assert.deepEqual(fs.readFileSync(headerPath), header);
  assert.equal(fs.readFileSync(modelFile(dir), 'utf8'), afterTest);

  store.configure(null);
  const reopened = await vault.unlock(dir, 'unlock', passphrase);
  const rebound = binding.create(blockedNative());
  assert.equal(rebound.bindVault(reopened), true);
  store.configure({ app: { getPath: () => dir }, safeStorage: rebound });
  assert.equal(store.resolve(modelName).key, secret);
  agentStore.configure({ app: { getPath: () => dir }, safeStorage: rebound, modelStore: store,
    runtimes: { runtime: id => id === 'pi' ? { modelMode: 'managed' } : null } });
  automationStore.configure({ app: { getPath: () => dir }, safeStorage: rebound });
  assert.equal(agentStore.get({ hub, clientId, owner: 'account:fixture', agentId: 'pi' }).modelName, modelName);
  assert.equal(automationStore.get({ hub, clientId, owner: 'account:fixture', scheduleId: 'schedule-1' }).modelName, modelName);

  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-vault-other-'));
  t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));
  const other = binding.create(blockedNative());
  assert.equal(other.bindVault(await vault.unlock(otherDir, 'create', passphrase)), true);
  store.configure({ app: { getPath: () => dir }, safeStorage: other });
  assert.throws(() => store.get(), /本地模型配置无法读取/);
  assert.equal(fs.readFileSync(modelFile(dir), 'utf8'), afterTest);
  assert.equal(fs.readFileSync(path.join(otherDir, 'device-vault-v1')).equals(header), false);
});

test('native keyring ciphertext stays on Electron safeStorage when no vault is unlocked', async t => {
  const binding = require('../main/linux-model-safe-storage.cjs');
  const dir = profile(t);
  const native = nativeKeyring();
  const facade = binding.create(native);
  assert.equal(facade.bindVault(), false);
  store.configure({ app: { getPath: () => dir }, safeStorage: facade });
  store.save(payload('http://127.0.0.1:9/v1'));
  assert.deepEqual(native.calls, ['encrypt']);
  const bytes = Buffer.from(envelope(dir).cipher, 'base64');
  assert.equal(bytes.subarray(0, 3).toString(), 'v11');
  assert.equal(JSON.parse(native.decryptString(bytes)).keys.local, secret);
  assert.equal(facade.getSelectedStorageBackend(), 'gnome_libsecret');
  store.configure(null);
  store.configure({ app: { getPath: () => dir }, safeStorage: facade });
  assert.equal(store.get().providers[0].keyLen, secret.length);
  assert.deepEqual(native.calls, ['encrypt', 'decrypt', 'decrypt']);
});

test('bound vault still reads existing native records and never falls back after vault authentication failure', async t => {
  const vault = require('../main/linux-device-vault.cjs');
  const adapter = require('../main/linux-vault-safe-storage.cjs');
  const binding = require('../main/linux-model-safe-storage.cjs');
  const dir = profile(t);
  const opened = await vault.unlock(dir, 'create', passphrase);
  const header = fs.readFileSync(path.join(dir, 'device-vault-v1'));
  const native = nativeKeyring();
  const facade = binding.create(native);
  store.configure({ app: { getPath: () => dir }, safeStorage: facade });
  store.save(payload('http://127.0.0.1:9/v1'));
  const original = fs.readFileSync(modelFile(dir));
  const originalCipher = Buffer.from(envelope(dir).cipher, 'base64');
  assert.equal(originalCipher.subarray(0, 3).toString(), 'v11');
  assert.equal(adapter.hasEnvelope(originalCipher), false);
  const modelName = store.get().usable[0].name;
  native.calls.length = 0;

  assert.equal(facade.bindVault(opened), true);
  assert.equal(facade.getSelectedStorageBackend(), 'gnome_libsecret');
  agentStore.configure({ app: { getPath: () => dir }, safeStorage: facade, modelStore: store,
    runtimes: { runtime: id => id === 'pi' ? { modelMode: 'managed' } : null } });
  automationStore.configure({ app: { getPath: () => dir }, safeStorage: facade });
  assert.equal(store.resolve(modelName).key, secret);
  assert.equal(agentStore.set({ hub, clientId, owner: 'account:fixture', agentId: 'pi', modelName }).modelName, modelName);
  assert.equal(automationStore.set({ hub, clientId, owner: 'account:fixture', scheduleId: 'schedule-1', modelName }).modelName, modelName);
  assert.ok(native.calls.includes('decrypt'));
  assert.equal(fs.readFileSync(modelFile(dir)).equals(original), true);
  store.save(payload('http://127.0.0.1:9/v1'));
  const afterNativeSave = Buffer.from(envelope(dir).cipher, 'base64');
  assert.equal(afterNativeSave.subarray(0, 3).toString(), 'v11');
  assert.equal(adapter.hasEnvelope(afterNativeSave), false);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'device-vault-v1')), header);

  const unprotectCalls = [];
  const originalUnprotect = opened.unprotect;
  opened.unprotect = (...args) => {
    unprotectCalls.push(args.length);
    return originalUnprotect.apply(opened, args);
  };
  const previousDecrypt = native.decryptString.bind(native);
  native.isEncryptionAvailable = () => false;
  native.decryptString = value => { native.calls.push('decrypt'); throw Error('keyring unavailable'); };
  native.calls.length = 0;
  const duringOutage = fs.readFileSync(modelFile(dir), 'utf8');
  assert.throws(() => store.get(), /本地模型配置无法读取/);
  assert.equal(fs.readFileSync(modelFile(dir), 'utf8'), duringOutage);
  assert.deepEqual(native.calls, ['decrypt']);
  assert.equal(unprotectCalls.length, 0);
  assert.throws(() => store.save(payload('http://127.0.0.1:9/v1')), /本地模型配置无法读取/);
  assert.equal(fs.readFileSync(modelFile(dir), 'utf8'), duringOutage);

  native.isEncryptionAvailable = () => true;
  native.decryptString = previousDecrypt;
  native.calls.length = 0;
  assert.equal(store.resolve(modelName).key, secret);
  assert.equal(agentStore.get({ hub, clientId, owner: 'account:fixture', agentId: 'pi' }).modelName, modelName);
  assert.equal(automationStore.get({ hub, clientId, owner: 'account:fixture', scheduleId: 'schedule-1' }).modelName, modelName);
  assert.ok(native.calls.includes('decrypt'));
  assert.equal(unprotectCalls.length, 0);
  assert.equal(fs.readFileSync(modelFile(dir), 'utf8'), duringOutage);

  const vaultOnly = binding.create(blockedNative());
  assert.equal(vaultOnly.bindVault(opened), true);
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-vault-format-'));
  t.after(() => fs.rmSync(vaultDir, { recursive: true, force: true }));
  store.configure({ app: { getPath: () => vaultDir }, safeStorage: vaultOnly });
  store.save(payload('http://127.0.0.1:9/v1'));
  const vaultBytes = fs.readFileSync(modelFile(vaultDir));
  const vaultCipher = Buffer.from(envelope(vaultDir).cipher, 'base64');
  assert.equal(adapter.hasEnvelope(vaultCipher), true);
  const tampered = Buffer.from(vaultCipher);
  tampered[tampered.length - 1] ^= 1;
  const tamperedText = JSON.stringify({ schema: 2, cipher: tampered.toString('base64') });
  fs.writeFileSync(modelFile(vaultDir), tamperedText);
  const tempting = nativeKeyring();
  const mixed = binding.create(tempting);
  assert.equal(mixed.bindVault(opened), true);
  store.configure({ app: { getPath: () => vaultDir }, safeStorage: mixed });
  tempting.calls.length = 0;
  unprotectCalls.length = 0;
  assert.throws(() => store.get(), /本地模型配置无法读取/);
  assert.equal(fs.readFileSync(modelFile(vaultDir), 'utf8'), tamperedText);
  assert.equal(tempting.calls.includes('decrypt'), false);
  assert.ok(unprotectCalls.length > 0);

  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-vault-wrong-'));
  t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));
  fs.writeFileSync(modelFile(vaultDir), vaultBytes);
  const wrongNative = blockedNative();
  const wrongNativeCalls = [];
  wrongNative.decryptString = () => {
    wrongNativeCalls.push('decrypt');
    throw Error('native decrypt must not run');
  };
  const wrong = binding.create(wrongNative);
  assert.equal(wrong.bindVault(await vault.unlock(otherDir, 'create', passphrase)), true);
  store.configure({ app: { getPath: () => vaultDir }, safeStorage: wrong });
  assert.throws(() => store.get(), /本地模型配置无法读取/);
  assert.equal(fs.readFileSync(modelFile(vaultDir)).equals(vaultBytes), true);
  assert.equal(wrongNativeCalls.includes('decrypt'), false);
});

test('missing, locked, and basic_text storage still fail closed', async t => {
  const vault = require('../main/linux-device-vault.cjs');
  const binding = require('../main/linux-model-safe-storage.cjs');
  const dir = profile(t);
  const opened = await vault.unlock(dir, 'create', passphrase);
  const header = fs.readFileSync(path.join(dir, 'device-vault-v1'));
  const facade = binding.create(blockedNative());
  store.configure({ app: { getPath: () => dir }, safeStorage: facade });
  assert.throws(() => store.save(payload('http://127.0.0.1:9/v1')), /系统安全存储不可用，无法保存本地模型凭据/);
  assert.equal(fs.existsSync(modelFile(dir)), false);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'device-vault-v1')), header);

  const revoked = Object.create(opened);
  revoked.available = () => false;
  const wrapped = require('../main/linux-vault-safe-storage.cjs').create(revoked);
  assert.equal(wrapped.isEncryptionAvailable(), false);
  assert.throws(() => wrapped.encryptString('synthetic'), /系统安全存储不可用/);
  store.configure({ app: { getPath: () => dir }, safeStorage: wrapped });
  assert.throws(() => store.save(payload('http://127.0.0.1:9/v1')), /系统安全存储不可用/);
  assert.equal(fs.existsSync(modelFile(dir)), false);

  if (process.platform === 'linux') {
    const native = nativeKeyring();
    native.getSelectedStorageBackend = () => 'basic_text';
    store.configure({ app: { getPath: () => dir }, safeStorage: binding.create(native) });
    assert.throws(() => store.save(payload('http://127.0.0.1:9/v1')), /系统安全存储不可用，无法保存本地模型凭据/);
    assert.equal(native.calls.length, 0);
    assert.equal(fs.existsSync(modelFile(dir)), false);
  }
  assert.throws(() => require('../main/linux-vault-safe-storage.cjs').create({ protect() {}, unprotect() {} }),
    /Linux vault store is not available/);
});

test('full desktop registration order saves automation local model selection and serves scheduled runs', async t => {
  const vault = require('../main/linux-device-vault.cjs');
  const adapter = require('../main/linux-vault-safe-storage.cjs');
  const binding = require('../main/linux-model-safe-storage.cjs');
  const dir = profile(t);
  const opened = await vault.unlock(dir, 'create', passphrase);
  const facade = binding.create(blockedNative());
  const handlers = new Map();
  const identity = {
    hub, clientId,
    session: Buffer.from(JSON.stringify({ typ: 'device', cid: clientId, uid: 'fixture' })).toString('base64url') + '.fixture',
  };
  const owner = require('../main/device-auth-request').accountScopeKey(identity);
  assert.equal(owner, 'account:fixture');
  const openedConversations = [];
  let pollerTick = null;

  function installDesktopStack(activeFacade) {
    handlers.clear();
    pollerTick = null;
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const instanceApp = Object.assign(new EventEmitter(), {
      getPath: () => dir,
      whenReady: () => ready,
    });
    const instanceIpcMain = { handle: (name, fn) => handlers.set(name, fn) };
    ipc.install({ app: instanceApp, ipcMain: instanceIpcMain, safeStorage: activeFacade, changed: () => {} });
    agentIpc.install({
      app: instanceApp, ipcMain: instanceIpcMain, safeStorage: activeFacade, changed: () => {},
      scopeOf: () => ({ hub, clientId, owner }),
      runtimes: { runtime: id => id === 'pi' ? { modelMode: 'managed' } : null },
    });
    automationIpc.install({
      app: instanceApp, ipcMain: instanceIpcMain, safeStorage: activeFacade,
      identityOf: async () => identity,
      currentIdentityOf: () => identity,
    });

    const automationFile = path.join(__dirname, '../main/automation-conversations.js');
    const automationSource = fs.readFileSync(automationFile, 'utf8');
    const sourceRequire = createRequire(automationFile);
    const mocks = {
      electron: { safeStorage: blockedNative() },
      './automation-preflight.cjs': { install() {} },
      './native-discovery.cjs': {
        ...sourceRequire('./native-discovery.cjs'),
        register: () => () => {},
      },
      './automation-conversation-polling.cjs': {
        POLL_INTERVAL_MS: 5000,
        createPoller({ tick }) {
          pollerTick = tick;
          return { start() {}, stop() {}, wake() {} };
        },
      },
      './jiyong-scheduled-plugins.cjs': { catalog: async () => [] },
      './pi-session/task-input': {
        request: async (_identity, route) => {
          const runId = openedConversations.length === 0 ? 'run-1' : 'run-2';
          if (route === '/automation-conversations/inbox') return { items: [{ id: runId }] };
          if (route === `/automation-conversations/${runId}/claim`) {
            return {
              ok: true, scheduleId: 'schedule-1', modelSource: 'device', trigger: 'schedule',
              input: { runId, text: 'scheduled prompt', adapterId: 'pi', modelSource: 'device' },
            };
          }
          return { ok: true };
        },
      },
    };
    const automationModule = { exports: {} };
    vm.runInNewContext(automationSource, {
      module: automationModule,
      exports: automationModule.exports,
      console: { log() {}, warn() {}, error() {} },
      require: name => mocks[name] || sourceRequire(name),
    }, { filename: automationFile });
    automationModule.exports.install({
      app: instanceApp, ipcMain: instanceIpcMain,
      identityOf: async () => identity,
      conversation: {
        open: async options => {
          openedConversations.push(options);
          return { ok: true, ref: 'ref-' + openedConversations.length, sessionId: 'sess-' + openedConversations.length, capabilities: [] };
        },
        send: async () => ({ ok: true }),
      },
      platformConnections: {},
      safeStorage: activeFacade,
    });
    t.after(() => instanceApp.emit('before-quit'));
    return {
      stop: () => instanceApp.emit('before-quit'),
      startWorker: async () => {
        resolveReady();
        await ready;
        await new Promise(resolve => setImmediate(resolve));
      },
    };
  }

  const firstRun = installDesktopStack(facade);
  assert.equal(facade.bindVault(opened), true);
  const event = deskEvent();
  const savedCatalog = handlers.get('local-models-save')(event, payload('http://127.0.0.1:9/v1'));
  const modelName = savedCatalog.usable[0].name;
  const savedAgent = handlers.get('local-agent-models-set')(event, {
    scopeKey: agentStore.scopeKey({ hub, clientId, owner }),
    agentId: 'pi', modelName,
  });
  assert.equal(savedAgent.modelName, modelName);

  const savedAutomation = await handlers.get('automation-models-set')(event, {
    hub, clientId, owner, scheduleId: 'schedule-1', modelName,
  });
  assert.equal(savedAutomation.ok, true);
  assert.equal(savedAutomation.modelName, modelName);
  const automationPath = path.join(dir, 'automation-models.secure.json');
  assert.equal(fs.existsSync(automationPath), true);
  const automationDisk = fs.readFileSync(automationPath);
  assert.equal(automationDisk.includes(Buffer.from(modelName)), false);
  const automationCipher = Buffer.from(JSON.parse(automationDisk.toString('utf8')).cipher, 'base64');
  assert.equal(adapter.hasEnvelope(automationCipher), true);
  if (process.platform === 'linux') assert.equal(fs.statSync(automationPath).mode & 0o777, 0o600);

  await firstRun.startWorker();
  assert.equal(typeof pollerTick, 'function');
  await pollerTick();
  assert.equal(openedConversations.length, 1);
  assert.equal(openedConversations[0].modelName, modelName);
  firstRun.stop();

  // Simulate desktop restart: unlock the same vault passphrase, reinstall the desktop stack, and verify scheduled run read.
  store.configure(null);
  agentStore.configure(null);
  automationStore.configure(null);
  const reopened = await vault.unlock(dir, 'unlock', passphrase);
  const restartedFacade = binding.create(blockedNative());
  const secondRun = installDesktopStack(restartedFacade);
  assert.equal(restartedFacade.bindVault(reopened), true);
  const restoredAutomation = await handlers.get('automation-models-get')(event, {
    hub, clientId, owner, scheduleId: 'schedule-1',
  });
  assert.equal(restoredAutomation.ok, true);
  assert.equal(restoredAutomation.modelName, modelName);
  await secondRun.startWorker();
  await pollerTick();
  assert.equal(openedConversations.length, 2);
  assert.equal(openedConversations[1].modelName, modelName);
  secondRun.stop();
});

test('models panel preserves concrete storage errors on initial load failure and test-after-save failure', async t => {
  const vault = require('../main/linux-device-vault.cjs');
  const binding = require('../main/linux-model-safe-storage.cjs');
  const dir = profile(t);
  const opened = await vault.unlock(dir, 'create', passphrase);
  const native = nativeKeyring();
  const initialFacade = binding.create(native);
  assert.equal(initialFacade.bindVault(opened), true);
  store.configure({ app: { getPath: () => dir }, safeStorage: initialFacade });
  store.save(payload('http://127.0.0.1:9/v1'));
  const nativeBytes = fs.readFileSync(modelFile(dir));

  const timers = new Set();
  const notices = [];
  const values = new Map();
  const listeners = new Map();
  const button = { disabled: false, textContent: '' };
  const body = {
    innerHTML: '', setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  let failNetwork = false;
  const invoke = (channel, fn) => async (...args) => {
    try { return await fn(...args); }
    catch (error) { throw new Error(`Error invoking remote method '${channel}': Error: ${error.message}`); }
  };
  const box = {
    URL, URLSearchParams, AbortController, AbortSignal, Response, structuredClone,
    CustomEvent: class { constructor(type) { this.type = type; } },
    __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true },
    setTimeout: (...args) => { const timer = setTimeout(...args); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => 0, navigator: { platform: 'linux' },
    console: { log() {}, error() {} },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    document: { getElementById: id => id === 'mdBody' ? body : id === 'mdSave' ? button : null },
    petSay: message => notices.push(message),
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    soduWorkAPI: {
      localModels: {
        get: invoke('local-models-get', () => store.get()),
        save: invoke('local-models-save', input => store.save(input)),
        test: invoke('local-models-test', (providerId, model) => store.test(providerId, model)),
      },
    },
    fetch: async () => {
      if (failNetwork) throw new Error('Failed to fetch');
      return new Response(JSON.stringify({ revision: 'hub-1', providers: [], myModels: [], usable: [] }));
    },
  };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  box.window = box;
  vm.createContext(box);
  const human = fs.readFileSync(path.join(__dirname, '../components/pet/pet-ui.js'), 'utf8');
  vm.runInContext(human.slice(human.indexOf('function _humanErr('), human.indexOf('/* Speech bubbles. */')), box);
  vm.runInContext(renderer.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), box);
  for (const file of ['model-capabilities.js', 'model-catalog-editor.js', 'model-service-delete.js', 'panels-models.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), box, { filename: file });
  }
  const evaluate = source => vm.runInContext(source, box);

  assert.equal(await evaluate('_mdLoad()'), true);
  const outageFacade = binding.create(blockedNative());
  assert.equal(outageFacade.bindVault(opened), true);
  store.configure({ app: { getPath: () => dir }, safeStorage: outageFacade });

  evaluate('_mdTouchProvider("device:local", { name: "Edited while keyring down" })');
  await evaluate('_mdDoTest({ getAttribute: () => "device:local" })');
  assert.equal(fs.readFileSync(modelFile(dir)).equals(nativeBytes), true);
  assert.equal(notices.at(-1), '本地模型配置无法读取');
  assert.equal(notices.at(-1).includes('Error invoking remote method'), false);
  assert.equal(evaluate('_mdTest["device:local"].detail'), '本地模型配置无法读取');
  assert.match(body.innerHTML, /class="md-test-r is-bad">本地模型配置无法读取</);
  assert.doesNotMatch(body.innerHTML, /class="md-test-r is-bad">没测成</);

  evaluate('closeModelsPanel()');
  assert.equal(await evaluate('_mdLoad()'), false);
  assert.match(body.innerHTML, /data-md-load-error/);
  assert.match(body.innerHTML, /<span>本地模型配置无法读取<\/span>/);
  assert.doesNotMatch(body.innerHTML, /Error invoking remote method/);
  assert.doesNotMatch(body.innerHTML, /请检查服务连接后重试/);

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-empty-net-'));
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));
  store.configure({ app: { getPath: () => emptyDir }, safeStorage: outageFacade });
  failNetwork = true;
  assert.equal(await evaluate('_mdLoad()'), false);
  assert.match(body.innerHTML, /暂时无法获取模型清单，请检查服务连接后重试。/);
});

test('capability checks preserve native v11 evidence across keyring outage and cross-process recovery', async t => {
  const vault = require('../main/linux-device-vault.cjs');
  const adapter = require('../main/linux-vault-safe-storage.cjs');
  const binding = require('../main/linux-model-safe-storage.cjs');
  const dir = profile(t);
  const sha256 = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const capFile = path.join(dir, 'local-model-capabilities.secure.json');
  const passProbe = async () => ({
    reportVersion: 3, apiFamily: 'chat-completions', checkedAt: new Date().toISOString(),
    checks: { imageInput: { status: 'passed', code: 'verified', checkedAt: new Date().toISOString() } },
  });

  // Process 1: save two models under basic_text + unlocked vault.
  const opened1 = await vault.unlock(dir, 'create', passphrase);
  const vaultOnly1 = binding.create(blockedNative());
  assert.equal(vaultOnly1.bindVault(opened1), true);
  store.configure({ app: { getPath: () => dir }, safeStorage: vaultOnly1 });
  const saved = store.save({
    providers: [{ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', authMode: 'key' }],
    models: [
      { providerId: 'local', name: 'alpha' },
      { providerId: 'local', name: 'bravo' },
    ],
    keys: { local: secret },
  });
  const alphaRef = saved.myModels.find(row => row.name === 'alpha').id;
  const bravoRef = saved.myModels.find(row => row.name === 'bravo').id;
  const catalogHash = sha256(modelFile(dir));
  assert.equal(adapter.hasEnvelope(Buffer.from(envelope(dir).cipher, 'base64')), true);

  // Process 2: GNOME keyring available + vault unlocked; check both alpha and bravo.
  store.configure(null);
  const opened2 = await vault.unlock(dir, 'unlock', passphrase);
  const gnomeFacade2 = binding.create(nativeKeyring());
  assert.equal(gnomeFacade2.bindVault(opened2), true);
  store.configure({ app: { getPath: () => dir }, safeStorage: gnomeFacade2 });
  await capabilities.check({ modelRef: alphaRef, checks: ['imageInput'] }, { runProbe: passProbe });
  await capabilities.check({ modelRef: bravoRef, checks: ['imageInput'] }, { runProbe: passProbe });
  const nativeCapBytes = fs.readFileSync(capFile);
  const nativeCapHash = sha256(capFile);
  const nativeCapCipher = Buffer.from(JSON.parse(nativeCapBytes.toString('utf8')).cipher, 'base64');
  assert.equal(nativeCapCipher.subarray(0, 3).toString(), 'v11');

  // Process 3: keyring temporarily unavailable (basic_text) + vault unlocked; recheck alpha only.
  store.configure(null);
  const opened3 = await vault.unlock(dir, 'unlock', passphrase);
  const outageFacade3 = binding.create(blockedNative());
  assert.equal(outageFacade3.bindVault(opened3), true);
  store.configure({ app: { getPath: () => dir }, safeStorage: outageFacade3 });
  await assert.rejects(
    capabilities.check({ modelRef: alphaRef, checks: ['imageInput'] }, { runProbe: passProbe }),
    /系统安全存储不可用，无法读取能力检测记录/,
  );
  assert.equal(sha256(capFile), nativeCapHash);
  assert.equal(fs.readFileSync(capFile).equals(nativeCapBytes), true);
  assert.equal(sha256(modelFile(dir)), catalogHash);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.corrupt-')), []);

  // Process 4: restore GNOME keyring + vault unlocked; both alpha and bravo remain passed.
  store.configure(null);
  const opened4 = await vault.unlock(dir, 'unlock', passphrase);
  const gnomeFacade4 = binding.create(nativeKeyring());
  assert.equal(gnomeFacade4.bindVault(opened4), true);
  store.configure({ app: { getPath: () => dir }, safeStorage: gnomeFacade4 });
  const restored = store.get().myModels;
  assert.equal(restored.find(row => row.id === alphaRef).capabilityCheck.checks.imageInput.status, 'passed');
  assert.equal(restored.find(row => row.id === bravoRef).capabilityCheck.checks.imageInput.status, 'passed');
  assert.equal(sha256(capFile), nativeCapHash);
  assert.equal(sha256(modelFile(dir)), catalogHash);

  // Symmetric guard: vault-encrypted capability evidence must not be overwritten while vault is locked.
  const vaultCapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-vault-cap-'));
  t.after(() => fs.rmSync(vaultCapDir, { recursive: true, force: true }));
  const openedVaultCap = await vault.unlock(vaultCapDir, 'create', passphrase);
  const vaultCapFacade = binding.create(blockedNative());
  assert.equal(vaultCapFacade.bindVault(openedVaultCap), true);
  store.configure({ app: { getPath: () => vaultCapDir }, safeStorage: vaultCapFacade });
  const vaultCatalog = store.save(payload('http://127.0.0.1:9/v1'));
  const vaultModelRef = vaultCatalog.myModels[0].id;
  await capabilities.check({ modelRef: vaultModelRef, checks: ['imageInput'] }, { runProbe: passProbe });
  const vaultCapPath = path.join(vaultCapDir, 'local-model-capabilities.secure.json');
  const vaultCapHash = sha256(vaultCapPath);
  const nativeOnlyCatalog = binding.create(nativeKeyring());
  store.configure({ app: { getPath: () => vaultCapDir }, safeStorage: nativeOnlyCatalog });
  // Keep catalog readable via bound vault while simulating an unbound capability backend directly.
  capabilities.configure({
    app: { getPath: () => vaultCapDir },
    safeStorage: nativeOnlyCatalog,
    read: () => ({
      schema: 2, revision: 1, aliases: {},
      providers: [{ id: 'local', name: 'Local', kind: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', authMode: 'key' }],
      models: [{ id: vaultModelRef, providerId: 'local', name: 'fixture-model', modality: 'chat', config: {} }],
      keys: { local: secret },
    }),
  });
  await assert.rejects(
    capabilities.check({ modelRef: vaultModelRef, checks: ['imageInput'] }, { runProbe: passProbe }),
    /系统安全存储不可用，无法读取能力检测记录/,
  );
  assert.equal(sha256(vaultCapPath), vaultCapHash);
  assert.deepEqual(fs.readdirSync(vaultCapDir).filter(name => name.includes('.corrupt-')), []);

  // Genuine corruption while the matching backend is usable still backs up and rebuilds cleanly.
  store.configure({ app: { getPath: () => dir }, safeStorage: gnomeFacade4 });
  fs.writeFileSync(capFile, '{"schema":1,"cipher":"not-valid-cipher"}');
  const rebuilt = await capabilities.check({ modelRef: alphaRef, checks: ['imageInput'] }, { runProbe: passProbe });
  assert.equal(rebuilt.ok, true);
  assert.equal(fs.readdirSync(dir).filter(name => name.includes('.corrupt-')).length, 1);
});

test('capability rechecks stop without probing or overwriting when active evidence uses another unlocked key', async t => {
  const vault = require('../main/linux-device-vault.cjs');
  const adapter = require('../main/linux-vault-safe-storage.cjs');
  const binding = require('../main/linux-model-safe-storage.cjs');
  const sha256 = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const passProbe = async () => ({
    reportVersion: 3, apiFamily: 'chat-completions', checkedAt: new Date().toISOString(),
    checks: { imageInput: { status: 'passed', code: 'verified', checkedAt: new Date().toISOString() } },
  });
  function keyedNativeKeyring(tag) {
    const marker = Buffer.from(`v11:${tag}:`);
    return {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: value => Buffer.concat([marker, Buffer.from(value, 'utf8')]),
      decryptString(value) {
        const bytes = Buffer.from(value);
        if (bytes.length < marker.length || !bytes.subarray(0, marker.length).equals(marker)) {
          throw Error('Error while decrypting the ciphertext provided to safeStorage.decryptString');
        }
        return bytes.subarray(marker.length).toString('utf8');
      },
    };
  }

  // Case 1: matching unlocked vault + mismatched unlocked GNOME keyring (v11 evidence).
  const dir1 = profile(t);
  const capFile1 = path.join(dir1, 'local-model-capabilities.secure.json');
  const vaultA1 = await vault.unlock(dir1, 'create', passphrase);
  const vaultOnly1 = binding.create(blockedNative());
  assert.equal(vaultOnly1.bindVault(vaultA1), true);
  store.configure({ app: { getPath: () => dir1 }, safeStorage: vaultOnly1 });
  const saved1 = store.save({
    providers: [{ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', authMode: 'key' }],
    models: [
      { providerId: 'local', name: 'alpha' },
      { providerId: 'local', name: 'bravo' },
    ],
    keys: { local: secret },
  });
  const alphaRef1 = saved1.myModels.find(row => row.name === 'alpha').id;
  const bravoRef1 = saved1.myModels.find(row => row.name === 'bravo').id;
  const catalogHash1 = sha256(modelFile(dir1));

  // Detect alpha and bravo with keyring A.
  store.configure(null);
  const keyringA1 = binding.create(keyedNativeKeyring('keyring-a'));
  assert.equal(keyringA1.bindVault(await vault.unlock(dir1, 'unlock', passphrase)), true);
  store.configure({ app: { getPath: () => dir1 }, safeStorage: keyringA1 });
  await capabilities.check({ modelRef: alphaRef1, checks: ['imageInput'] }, { runProbe: passProbe });
  await capabilities.check({ modelRef: bravoRef1, checks: ['imageInput'] }, { runProbe: passProbe });
  const capHash1 = sha256(capFile1);
  const capBytes1 = fs.readFileSync(capFile1);
  assert.equal(Buffer.from(JSON.parse(capBytes1.toString('utf8')).cipher, 'base64').subarray(0, 3).toString(), 'v11');

  // Switch to another unlocked GNOME keyring B while the vault still matches; recheck alpha only.
  store.configure(null);
  const keyringB1 = binding.create(keyedNativeKeyring('keyring-b'));
  assert.equal(keyringB1.bindVault(await vault.unlock(dir1, 'unlock', passphrase)), true);
  store.configure({ app: { getPath: () => dir1 }, safeStorage: keyringB1 });
  let probeCalls1 = 0;
  await assert.rejects(
    capabilities.check({ modelRef: alphaRef1, checks: ['imageInput'] }, {
      runProbe: async () => { probeCalls1 += 1; return passProbe(); },
    }),
    /能力检测记录无法解密.*恢复匹配的密钥/,
  );
  assert.equal(probeCalls1, 0);
  assert.equal(sha256(capFile1), capHash1);
  assert.equal(fs.readFileSync(capFile1).equals(capBytes1), true);
  assert.equal(sha256(modelFile(dir1)), catalogHash1);
  assert.deepEqual(fs.readdirSync(dir1).filter(name => name.includes('.corrupt-')), []);

  // Restore keyring A across process restart: both alpha and bravo remain passed.
  store.configure(null);
  const restoredA1 = binding.create(keyedNativeKeyring('keyring-a'));
  assert.equal(restoredA1.bindVault(await vault.unlock(dir1, 'unlock', passphrase)), true);
  store.configure({ app: { getPath: () => dir1 }, safeStorage: restoredA1 });
  const restoredModels1 = store.get().myModels;
  assert.equal(restoredModels1.find(row => row.id === alphaRef1).capabilityCheck.checks.imageInput.status, 'passed');
  assert.equal(restoredModels1.find(row => row.id === bravoRef1).capabilityCheck.checks.imageInput.status, 'passed');

  // Case 2: matching unlocked GNOME keyring (v11 catalog) + mismatched unlocked official vault (vault evidence).
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-mismatch-vault-'));
  const otherVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-other-vault-'));
  t.after(() => {
    store.configure(null);
    fs.rmSync(dir2, { recursive: true, force: true });
    fs.rmSync(otherVaultDir, { recursive: true, force: true });
  });
  const capFile2 = path.join(dir2, 'local-model-capabilities.secure.json');
  const vaultA2 = await vault.unlock(dir2, 'create', passphrase);
  const vaultOnly2 = binding.create(blockedNative());
  assert.equal(vaultOnly2.bindVault(vaultA2), true);
  store.configure({ app: { getPath: () => dir2 }, safeStorage: vaultOnly2 });
  const saved2 = store.save({
    providers: [{ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', authMode: 'key' }],
    models: [
      { providerId: 'local', name: 'alpha' },
      { providerId: 'local', name: 'bravo' },
    ],
    keys: { local: secret },
  });
  const alphaRef2 = saved2.myModels.find(row => row.name === 'alpha').id;
  const bravoRef2 = saved2.myModels.find(row => row.name === 'bravo').id;
  await capabilities.check({ modelRef: alphaRef2, checks: ['imageInput'] }, { runProbe: passProbe });
  await capabilities.check({ modelRef: bravoRef2, checks: ['imageInput'] }, { runProbe: passProbe });
  const vaultCapBytes2 = fs.readFileSync(capFile2);
  const vaultCapHash2 = sha256(capFile2);
  assert.equal(adapter.hasEnvelope(Buffer.from(JSON.parse(vaultCapBytes2.toString('utf8')).cipher, 'base64')), true);

  // Re-save the catalog once with GNOME keyring A so catalog is native v11 while capability evidence stays vault-encrypted.
  store.configure(null);
  const mixedKeyring2 = binding.create(keyedNativeKeyring('keyring-a'));
  assert.equal(mixedKeyring2.bindVault(await vault.unlock(dir2, 'unlock', passphrase)), true);
  store.configure({ app: { getPath: () => dir2 }, safeStorage: mixedKeyring2 });
  store.save({ providers: [{ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', authMode: 'key' }] });
  const nativeCatalogHash2 = sha256(modelFile(dir2));
  assert.equal(Buffer.from(envelope(dir2).cipher, 'base64').subarray(0, 3).toString(), 'v11');
  assert.equal(sha256(capFile2), vaultCapHash2);

  // Move to another unlocked official vault B while GNOME keyring A still matches; recheck alpha only.
  store.configure(null);
  const vaultB2 = await vault.unlock(otherVaultDir, 'create', passphrase);
  const mismatchedVaultFacade2 = binding.create(keyedNativeKeyring('keyring-a'));
  assert.equal(mismatchedVaultFacade2.bindVault(vaultB2), true);
  store.configure({ app: { getPath: () => dir2 }, safeStorage: mismatchedVaultFacade2 });
  let probeCalls2 = 0;
  await assert.rejects(
    capabilities.check({ modelRef: alphaRef2, checks: ['imageInput'] }, {
      runProbe: async () => { probeCalls2 += 1; return passProbe(); },
    }),
    /能力检测记录无法解密.*恢复匹配的密钥/,
  );
  assert.equal(probeCalls2, 0);
  assert.equal(sha256(capFile2), vaultCapHash2);
  assert.equal(fs.readFileSync(capFile2).equals(vaultCapBytes2), true);
  assert.equal(sha256(modelFile(dir2)), nativeCatalogHash2);
  assert.deepEqual(fs.readdirSync(dir2).filter(name => name.includes('.corrupt-')), []);

  // Restore original vault A across process restart: both alpha and bravo remain passed.
  store.configure(null);
  const restoredVault2 = binding.create(keyedNativeKeyring('keyring-a'));
  assert.equal(restoredVault2.bindVault(await vault.unlock(dir2, 'unlock', passphrase)), true);
  store.configure({ app: { getPath: () => dir2 }, safeStorage: restoredVault2 });
  const restoredModels2 = store.get().myModels;
  assert.equal(restoredModels2.find(row => row.id === alphaRef2).capabilityCheck.checks.imageInput.status, 'passed');
  assert.equal(restoredModels2.find(row => row.id === bravoRef2).capabilityCheck.checks.imageInput.status, 'passed');
});
