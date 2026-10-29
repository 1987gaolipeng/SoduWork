const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');

test('active renderer uses only the short device session for HTTP and WebSocket', async () => {
  const values = new Map([
    ['soduwork_work_device_secret', 'legacy-key-that-must-leave-renderer'],
    ['soduwork_work_hub_url', 'http://127.0.0.1:18989'],
  ]);
  const calls = [];
  const runnerConfigs = [];
  const sockets = [];
  const events = [];
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(String(data)); }
    close() {}
  }
  const fireOpen = () => sockets.forEach(s => { try { s.onopen && s.onopen(); } catch (e) {} });
  const bridge = {
    getAppVersion: async () => 'test',
    getSysInfo: async () => ({ username: 'tester', hostname: 'host' }),
    deviceAuthBootstrap: async (payload) => {
      assert.equal(payload.legacySecret, 'legacy-key-that-must-leave-renderer');
      return { ok: true, stored: true, clientId: 'soduwork-install-1',
        authState: 'active', activationRequired: false,
        session: 'short-session-token', expiresIn: 1800 };
    },
    configureRunner: async (payload) => { runnerConfigs.push(payload); return { ok: true }; },
  };
  const window = { soduWorkAPI: bridge, dispatchEvent(event) { events.push(event); } };
  const context = {
    window, localStorage, User: { id: 'device-test-1', name: 'Tester' },
    navigator: { platform: 'test' }, WebSocket: FakeSocket,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    FormData: class { append() {} }, console: { log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => url.endsWith('/client-auth/me') ?
        JSON.stringify({ user: { id: 'test-user' }, device: { authState: 'active' } }) : '[]' };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'api.js' });
  const api = window.SoduWorkAPI;

  const enrolled = await api.registerClient();
  assert.equal(enrolled.session, 'short-session-token');
  assert.equal(values.has('soduwork_work_device_secret'), false);
  assert.ok(runnerConfigs.length >= 1);
  assert.equal(Object.prototype.hasOwnProperty.call(runnerConfigs.at(-1), 'secret'), false);

  await api.getTasks();
  const request = calls.at(-1);
  assert.equal(request.options.headers.Authorization, 'Device short-session-token');
  assert.equal(Object.prototype.hasOwnProperty.call(request.options.headers, 'X-Soduwork-Secret'), false);
  assert.equal(request.options.headers['X-Soduwork-Device'], 'soduwork-install-1');

  api.connectWS(() => {});
  /* Send session credentials only in the authenticated first frame, never in URLs. */
  fireOpen();
  assert.equal(events.filter(event => event.type === 'soduwork-ws-open').length, 0, '原始握手不能冒充已鉴权连接');
  sockets[0].onmessage({ data: JSON.stringify({ type: 'ready' }) });
  assert.equal(events.filter(event => event.type === 'soduwork-ws-open').length, 1);
  assert.match(sockets[0].url, /[?&]device=soduwork-install-1/);
  assert.equal(sockets[0].url.includes('session='), false);
  assert.equal(sockets[0].url.includes('secret='), false);
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1)),
    { t: 'auth', device: 'soduwork-install-1', session: 'short-session-token' });
  assert.match(api.termWsUrl('task-1', 100, 30), /[?&]device=soduwork-install-1/);
  assert.equal(api.termWsUrl('task-1', 100, 30).includes('session='), false);
  assert.equal(api.termWsUrl('task-1', 100, 30).includes('secret='), false);
  const beforeProbe = calls.length;
  assert.equal(await api.checkConnection(), true);
  assert.equal(calls.length, beforeProbe + 1, '缓存的设备会话不能代替 HTTP 心跳');
  assert.match(calls.at(-1).url, /\/client-auth\/me$/);
  assert.equal(calls.at(-1).options.headers.Authorization, 'Device short-session-token');
  context.fetch = async () => { throw Error('network unavailable'); };
  assert.equal(await api.checkConnection(), false);
});

test('pending renderer removes the long-lived key as soon as secure storage owns it', async () => {
  const values = new Map([
    ['soduwork_work_device_secret', 'legacy-key-that-must-leave-renderer'],
    ['soduwork_work_hub_url', 'http://127.0.0.1:18989'],
  ]);
  const calls = [];
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const window = {
    dispatchEvent() {},
    soduWorkAPI: {
      getAppVersion: async () => 'test',
      getSysInfo: async () => ({ username: 'tester', hostname: 'host' }),
      deviceAuthBootstrap: async () => ({
        ok: true, stored: true, clientId: 'soduwork-install-2',
        authState: 'pending', activationRequired: true,
      }),
      configureRunner: async () => ({ ok: false }),
    },
  };
  const context = {
    window, localStorage, User: { id: 'device-test-2', name: 'Tester' },
    navigator: { platform: 'test' },
    WebSocket: class { close() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    FormData: class { append() {} }, console: { log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    fetch: async (url, options) => {
      calls.push({ url, options });
      throw new Error('legacy registration must not run after secure storage takes ownership');
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'api.js' });

  const enrolled = await window.SoduWorkAPI.registerClient();
  assert.equal(enrolled.activationRequired, true);
  assert.equal(values.has('soduwork_work_device_secret'), false);
  assert.equal(calls.length, 0);
});

test('first authenticated request bootstraps the device session before it reaches the Hub', async () => {
  const values = new Map([['soduwork_work_hub_url', 'http://127.0.0.1:18989']]);
  const calls = [];
  let bootstraps = 0;
  const window = {
    dispatchEvent() {},
    soduWorkAPI: {
      getAppVersion: async () => 'test',
      getSysInfo: async () => ({ username: 'tester', hostname: 'host' }),
      deviceAuthBootstrap: async () => {
        bootstraps += 1;
        return { ok: true, stored: true, clientId: 'soduwork-install-retry',
          authState: 'active', activationRequired: false,
          session: 'renewed-short-session', expiresIn: 1800 };
      },
      configureRunner: async () => ({ ok: true }),
    },
  };
  const context = {
    window,
    localStorage: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    User: { id: 'legacy-device', name: 'Tester' },
    navigator: { platform: 'test' }, WebSocket: class { close() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    FormData: class { append() {} }, console: { log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => '[]' };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'api.js' });

  const tasks = await window.SoduWorkAPI.getTasks();
  assert.equal(Array.isArray(tasks), true);
  assert.equal(tasks.length, 0);
  assert.equal(bootstraps, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, 'Device renewed-short-session');
  assert.equal(calls[0].options.headers['X-Soduwork-Device'], 'soduwork-install-retry');
});

test('renderer never falls back to plaintext enrollment when secure storage refuses the key', async () => {
  const values = new Map([
    ['soduwork_work_device_secret', 'legacy-key-that-must-not-be-rewritten'],
    ['soduwork_work_hub_url', 'http://127.0.0.1:18989'],
  ]);
  const calls = [];
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const window = {
    dispatchEvent() {},
    soduWorkAPI: {
      getAppVersion: async () => 'test',
      getSysInfo: async () => ({ username: 'tester', hostname: 'host' }),
      deviceAuthBootstrap: async () => ({
        ok: false, stored: false, error: 'system key store unavailable',
      }),
      configureRunner: async () => ({ ok: false }),
    },
  };
  const context = {
    window, localStorage, User: { id: 'device-test-3', name: 'Tester' },
    navigator: { platform: 'test' }, WebSocket: class { close() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    FormData: class { append() {} }, console: { log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    fetch: async (url, options) => {
      calls.push({ url, options });
      throw new Error('plaintext legacy enrollment must not run');
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'api.js' });

  const enrolled = await window.SoduWorkAPI.registerClient();
  assert.equal(enrolled.ok, false);
  assert.equal(enrolled.stored, false);
  assert.equal(calls.length, 0);
  assert.equal(values.get('soduwork_work_device_secret'), 'legacy-key-that-must-not-be-rewritten');
});
