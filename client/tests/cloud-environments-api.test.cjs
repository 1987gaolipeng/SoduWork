'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('./renderer-source.cjs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Server } = require('ssh2');
const credentials = require('../main/cloud-computer-credentials.cjs');
const source = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const operations = {
  create: api => api.addCloudEnvironment({ name: 'My computer', hub: 'https://runner.example.test' }),
  rotate: api => api.rotateCloudEnvironmentCredential('personal', { hub: 'https://runner.example.test' }),
};

function setup(clientHub) {
  const value = { runnerId: 'personal', key: 'synthetic-enrollment-key-123456789',
    hub: 'https://runner.example.test', commands: {
      linux: 'curl -fsSL https://runner.example.test/api/v1/download/runner-install.sh | sudo bash -s -- --hub https://runner.example.test --id personal --key synthetic-enrollment-key-123456789',
    } };
  if (clientHub !== undefined) value.clientHub = clientHub;
  return { ok: true, environment: { id: 'personal' }, setup: value };
}

function harness(hub = 'https://hub.example.com') {
  let user = 'alice';
  const values = new Map(), calls = [];
  const h = { calls, values, fetch: async () => new Response(JSON.stringify(setup('http://internal-hub:8989'))) };
  const bridge = {
    getHubConnection: async () => ({ ok: true, hub, editable: true }),
    selectHubEnvironment: async () => ({ ok: true }),
    deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: user }, session: 'session-' + user, expiresIn: 1800 }),
  };
  const window = { soduWorkAPI: bridge, dispatchEvent() {} };
  vm.runInNewContext(source, { window, User: { id: 'device-1', name: 'Fixture' },
    navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { calls.push({ url, options }); return h.fetch(url, options); },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  });
  h.api = window.SoduWorkAPI;
  h.signIn = async next => { user = next; await h.api.registerClient(); };
  h.switchScope = async kind => kind === 'account' ? h.signIn('bob') :
    h.api.connectHub('production', 'https://other-hub.example.test');
  return h;
}

for (const [operation, invoke] of Object.entries(operations)) {
  for (const [shape, clientHub] of [
    ['older Hub without clientHub', undefined],
    ['TLS proxy with an HTTP backend', 'http://hub.example.com'],
    ['proxy with an internal hostname', 'http://internal-hub:8989'],
    ['matching public origin', 'https://hub.example.com'],
  ]) {
    test(`${operation} binds ${shape} setup to the authenticated request origin`, async () => {
      const h = harness(); await h.signIn('alice');
      const response = setup(clientHub);
      h.fetch = async () => new Response(JSON.stringify(response));
      const result = await invoke(h.api);
      assert.equal(result.setup.clientHub, 'https://hub.example.com');
      assert.equal(result.setup.hub, response.setup.hub);
      assert.equal(result.setup.commands.linux, response.setup.commands.linux);
      assert.equal(result.setup.key, response.setup.key);
      assert.equal(h.calls.length, 1);
      assert.match(h.calls[0].url, /^https:\/\/hub\.example\.com\/api\/v1\/cloud-environments/);
      assert.equal(h.calls[0].options.headers.Authorization, 'Device session-alice');
      assert.equal(JSON.stringify([...h.values]).includes(response.setup.key), false);
    });
  }

  for (const kind of ['account', 'Hub']) {
    test(`${operation} discards a one-time setup after the ${kind} changes`, async () => {
      const h = harness(); await h.signIn('alice');
      let finish;
      h.fetch = () => new Promise(resolve => { finish = resolve; });
      const pending = invoke(h.api); await tick();
      assert.equal(typeof finish, 'function');
      await h.switchScope(kind);
      finish(new Response(JSON.stringify(setup())));
      await assert.rejects(pending, error => error.code === 'STALE_TASK_SCOPE');
      assert.equal(h.calls.length, 1);
    });
  }

  test(`${operation} keeps a local client's credential origin separate from the remote Hub`, async () => {
    const h = harness('http://127.0.0.1:9080'); await h.signIn('alice');
    const result = await invoke(h.api);
    assert.equal(result.setup.clientHub, 'http://127.0.0.1:9080');
    assert.equal(result.setup.hub, 'https://runner.example.test');
  });

  test(`${operation} cannot mutate a different account discovered during authentication bootstrap`, async () => {
    const h = harness();
    await assert.rejects(invoke(h.api), error => error.code === 'STALE_TASK_SCOPE');
    assert.equal(h.calls.length, 0);
  });
}

test('a proxied setup returned by the client API installs through SSH and preserves host pinning', async t => {
  const h = harness(); await h.signIn('alice');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-cloud-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, hub = h.api.hubConfig().hub;
  credentials.install({ app, ipcMain: { handle() {} },
    deviceAuth: { identity: (_app, requested) => ({ hub: requested || hub }), localOwner: () => 'alice' },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
  });
  const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs1', format: 'pem' });
  const executed = [];
  const server = new Server({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'runner' && ctx.password === 'synthetic-password') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      accept().on('exec', (accept, _reject, info) => {
        executed.push(info.command);
        const stream = accept(); stream.exit(0); stream.end();
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const credential = { hub, host: '127.0.0.1', port: server.address().port, username: 'runner',
    platform: 'linux', authMethod: 'password', password: 'synthetic-password' };
  const response = await h.api.addCloudEnvironment({ name: 'My computer', hub: 'https://runner.example.test' });
  const result = await credentials.installRemote(app, { credential, setup: response.setup });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(executed, [response.setup.commands.linux]);
  assert.match(result.hostFingerprint, /^sha256:/);
  assert.equal(credentials.get(app).profile.hostFingerprint, result.hostFingerprint);
  assert.equal(fs.readFileSync(path.join(root, 'cloud-computer-credentials.json'), 'utf8')
    .includes(response.setup.key), false);
  const rejected = await credentials.installRemote(app, {
    credential, setup: { ...response.setup, clientHub: 'https://other-hub.example.test' },
  });
  assert.equal(rejected.code, 'SETUP_RESPONSE_REQUIRED');
  assert.equal(executed.length, 1);
});
