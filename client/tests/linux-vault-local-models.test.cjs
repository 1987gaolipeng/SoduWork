'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const store = require('../main/local-model-store.cjs');
const agentStore = require('../main/local-agent-model-store.cjs');
const automationStore = require('../main/local-automation-model-store.cjs');
const ipc = require('../main/local-model-ipc.cjs');

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
