'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server } = require('ssh2');

const credentials = require('../main/cloud-computer-credentials.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-cloud-computer-'));
  const app = { getPath: name => name === 'userData' ? root : root };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => Buffer.from(String(value), 'utf8'),
    decryptString: value => Buffer.from(value).toString('utf8'),
  };
  const deviceAuth = {
    identity: (_app, hub) => ({ hub: hub || 'http://127.0.0.1:9080', clientId: 'client-1' }),
    localOwner: () => 'owner-1',
  };
  credentials.install({ app, ipcMain: { handle: () => {} }, deviceAuth });
  // install() configures the module's process-global storage dependency only
  // through the IPC adapter, so test the direct API with a fresh IPC shim below.
  // The module intentionally exposes no raw secret accessor.
  return { root, app, safeStorage, deviceAuth };
}

function configure(app, safeStorage, deviceAuth) {
  credentials.install({ app, ipcMain: { handle: () => {} }, deviceAuth });
  // Inject the deterministic fake through the test-only IPC adapter contract.
  // A second adapter is installed by the module's exported test hook below.
  return credentials;
}

test('cloud computer credentials are encrypted, scoped and redacted', () => {
  const f = fixture();
  // The production module receives safeStorage from main.js. For an isolated
  // test, use the explicit test hook if available; this assertion also catches
  // accidental plaintext persistence when the hook is removed.
  credentials._private.setSafeStorage?.(f.safeStorage);
  const saved = credentials.save(f.app, { credential: {
    host: '192.0.2.4', port: 22, username: 'runner',
    platform: 'linux', authMethod: 'password', password: 'unit-secret', workRoot: '/srv/soduwork',
  }, hub: 'http://127.0.0.1:9080'
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.profile.hasPassword, true);
  assert.equal(Object.prototype.hasOwnProperty.call(saved.profile, 'password'), false);
  const raw = fs.readFileSync(path.join(f.root, 'cloud-computer-credentials.json'), 'utf8');
  assert.equal(raw.includes('unit-secret'), false);
  assert.equal(raw.includes('runner'), true);
  const read = credentials.get(f.app, { hub: 'http://127.0.0.1:9080' });
  assert.equal(read.ok, true, read.error);
  assert.equal(read.profile.host, '192.0.2.4');
  assert.equal(Object.prototype.hasOwnProperty.call(read.profile, 'password'), false);
  const cleared = credentials.clear(f.app, { hub: 'http://127.0.0.1:9080' });
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(credentials.get(f.app, { hub: 'http://127.0.0.1:9080' }).configured, false);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('install never executes a renderer command without the Hub setup response', async () => {
  const f = fixture();
  credentials._private.setSafeStorage?.(f.safeStorage);
  const result = await credentials.installRemote(f.app, {
    hub: 'http://127.0.0.1:9080', command: 'echo unsafe',
    credential: { host: '127.0.0.1', username: 'runner', authMethod: 'password', password: 'x' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SETUP_RESPONSE_REQUIRED');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('managed filesystem EXDEV preserves encrypted cloud credentials and recovers a failed replacement', (t) => {
  const f = fixture();
  credentials._private.setSafeStorage(f.safeStorage);
  const realRename = fs.renameSync, realCopy = fs.copyFileSync;
  const target = path.join(f.root, 'cloud-computer-credentials.json');
  let failCopy = false;
  t.after(() => { fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.rmSync(f.root, { recursive: true, force: true }); });
  fs.renameSync = () => { throw Object.assign(Error('managed volume'), { code: 'EXDEV' }); };
  fs.copyFileSync = (source, destination, ...args) => {
    if (failCopy && String(source).includes('.next-')) {
      fs.writeFileSync(destination, '{partial');
      throw Object.assign(Error('interrupted copy'), { code: 'EIO' });
    }
    return realCopy(source, destination, ...args);
  };
  const input = { host: '192.0.2.4', username: 'runner', password: 'test-only-secret', authMethod: 'password' };
  assert.equal(credentials.save(f.app, input).ok, true);
  assert.equal(fs.readFileSync(target, 'utf8').includes(input.password), false);
  assert.equal(credentials.save(f.app, { ...input, host: '192.0.2.5' }).ok, true);
  failCopy = true;
  assert.equal(credentials.save(f.app, { ...input, host: '192.0.2.6' }).ok, false);
  assert.equal(credentials.get(f.app).profile.host, '192.0.2.5');
  failCopy = false;
  assert.equal(credentials.clear(f.app).ok, true);
  assert.equal(credentials.get(f.app).configured, false);
});

test('a partially written EXDEV credential backup never replaces the intact encrypted profile', t => {
  const f = fixture(); credentials._private.setSafeStorage(f.safeStorage);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const input = { host: '192.0.2.4', username: 'runner', password: 'fixture-secret', authMethod: 'password' };
  assert.equal(credentials.save(f.app, input).ok, true);
  const target = path.join(f.root, 'cloud-computer-credentials.json'), original = fs.readFileSync(target);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(Error('managed volume'), { code: 'EXDEV' }); });
  const copy = fs.copyFileSync.bind(fs);
  t.mock.method(fs, 'copyFileSync', (source, destination, ...args) => {
    if (source === target) {
      fs.writeFileSync(destination, '{partial'); throw Object.assign(Error('backup interrupted'), { code: 'EIO' });
    }
    return copy(source, destination, ...args);
  });
  assert.equal(credentials.save(f.app, { ...input, host: '192.0.2.5' }).ok, false);
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(credentials.get(f.app).profile.host, input.host);
  assert.deepEqual(fs.readdirSync(f.root), ['cloud-computer-credentials.json']);
});

test('password SSH probe and Runner setup pin the host fingerprint', async () => {
  const f = fixture();
  credentials._private.setSafeStorage?.(f.safeStorage);
  const hostKey = fs.readFileSync(path.join(__dirname, '../node_modules/ssh2/test/fixtures/ssh_host_rsa_key'));
  const server = new Server({ hostKeys: [hostKey] }, client => {
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'runner' && ctx.password === 'synthetic-password') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (accept, _reject, info) => {
        const stream = accept();
        if (String(info.command).includes('soduwork-cloud-check')) stream.write('soduwork-cloud-check');
        stream.exit(0); stream.end();
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const port = server.address().port;
    const credential = { hub: 'http://127.0.0.1:9080', host: '127.0.0.1', port, username: 'runner', platform: 'linux', authMethod: 'password', password: 'synthetic-password' };
    const probe = await credentials.test(f.app, credential);
    assert.equal(probe.ok, true, probe.error);
    assert.match(probe.hostFingerprint, /^sha256:/);
    const install = await credentials.installRemote(f.app, { credential, setup: {
      runnerId: 'personal', key: 'fixture-enrollment-key-123456789', hub: 'http://127.0.0.1:9080',
      commands: { linux: 'echo personal fixture-enrollment-key-123456789' },
    }});
    assert.equal(install.ok, true, install.error);
    const saved = credentials.get(f.app, credential);
    assert.equal(saved.profile.host, '127.0.0.1');
    assert.equal(saved.profile.hostFingerprint, install.hostFingerprint);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('install accepts only a matching Hub setup command shape', async () => {
  const f = fixture();
  credentials._private.setSafeStorage?.(f.safeStorage);
  const key = 'setup-key-0123456789';
  const result = await credentials.installRemote(f.app, {
    hub: 'http://127.0.0.1:9080',
    credential: { host: '127.0.0.1', port: 1, username: 'runner', authMethod: 'password', password: 'x' },
    setup: { hub: 'http://127.0.0.1:9080', key, runnerId: 'runner-id-1',
      commands: { linux: 'echo ' + key + ' runner-id-1' } },
  });
  // Port 1 is expected to fail at SSH, but it must pass setup validation first.
  assert.notEqual(result.code, 'SETUP_RESPONSE_REQUIRED');
  fs.rmSync(f.root, { recursive: true, force: true });
});

