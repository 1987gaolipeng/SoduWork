'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const filename = path.join(__dirname, '../main/automation-conversations.js');
const source = fs.readFileSync(filename, 'utf8'), sourceRequire = createRequire(filename);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const trustedEvent = () => ({ senderFrame: { url: pathToFileURL(path.join(__dirname, '../desk.html')).href } });

function harness() {
  const ready = deferred(), handlers = new Map();
  const h = { starts: 0, stops: 0, wakes: 0, unsubscribes: 0, requests: [], directories: [],
    identity: { hub: 'http://hub-a:8989', clientId: 'device-1' } };
  const app = new EventEmitter();
  app.whenReady = () => ready.promise;
  app.getPath = () => path.join(__dirname, 'unused-profile');
  const mocks = {
    'node:fs': { ...fs, mkdirSync: directory => h.directories.push(directory) },
    './automation-preflight.cjs': { install() {} },
    './native-discovery.cjs': {
      ...sourceRequire('./native-discovery.cjs'),
      register(topic, callback) { h.topic = topic; h.push = callback; return () => { h.unsubscribes++; }; },
    },
    './automation-conversation-polling.cjs': {
      POLL_INTERVAL_MS: 5000,
      createPoller({ tick }) {
        h.tick = tick;
        return { start() { h.starts++; }, stop() { h.stops++; }, wake() { h.wakes++; } };
      },
    },
    './pi-session/task-input': { request: async (_identity, route) => { h.requests.push(route); return { items: [] }; } },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console,
    require: name => mocks[name] || sourceRequire(name) }, { filename });
  module.exports.install({ app, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    identityOf: async () => h.identity, conversation: {}, platformConnections: {} });
  h.ready = async () => { ready.resolve(); await ready.promise; };
  h.quit = () => app.emit('before-quit');
  h.wake = (event = trustedEvent(), payload = { hub: 'http://hub-a:8989' }) => handlers.get('automation-conversations-wake')(event, payload);
  return h;
}

test('native automation wake accepts only a trusted client and its current Hub', async () => {
  const h = harness(); await h.ready();
  assert.equal(h.starts, 1);
  assert.equal((await h.wake()).ok, true);
  assert.equal((await h.wake(trustedEvent(), { hub: 'http://hub-a:8989/' })).ok, true);
  assert.equal(h.wakes, 2);
  for (const url of ['https://hub-a:8989', 'data:text/html,client',
    pathToFileURL(path.resolve(__dirname, '../../outside.html')).href, 'not-a-url']) {
    assert.equal((await h.wake({ senderFrame: { url } })).ok, false);
  }
  assert.equal((await h.wake(trustedEvent(), { hub: 'http://hub-b:8989' })).ok, false);
  assert.equal((await h.wake(trustedEvent(), {})).ok, false);
  h.identity = null;
  assert.equal((await h.wake()).ok, false);
  assert.equal(h.wakes, 2, 'rejected callers must not bypass polling backoff');
  h.quit();
});

test('readiness starts one poller, quit stops both timers and worker requests', async () => {
  const h = harness();
  assert.equal((await h.wake()).ok, false);
  assert.equal(h.starts, 0);
  await h.ready();
  assert.equal(h.starts, 1);
  assert.equal(h.directories.length, 1);
  await h.tick();
  assert.deepEqual(h.requests, ['/automation-conversations/inbox']);
  h.quit();
  assert.equal(h.stops, 1);
  assert.equal((await h.wake()).ok, false);
  await h.tick();
  assert.equal(h.requests.length, 1, 'a stopped worker must not issue further requests');
  assert.equal(h.wakes, 0);
});

test('quit before readiness cannot start an automation worker later', async () => {
  const h = harness();
  h.quit();
  await h.ready();
  assert.equal(h.starts, 0);
  assert.equal(h.directories.length, 0);
  assert.equal((await h.wake()).ok, false);
});

test('shared main-process push only wakes authenticated discovery and unsubscribes on quit', async () => {
  const h = harness(); await h.ready();
  assert.equal(h.topic, 'automation-inbox');
  h.push({ type: 'native-discovery', topic: 'automation-inbox', input: { text: 'untrusted hint' } });
  assert.equal(h.wakes, 1);
  assert.deepEqual(h.requests, [], 'a push itself cannot dispatch or execute work');
  await h.tick();
  assert.deepEqual(h.requests, ['/automation-conversations/inbox']);
  h.quit(); assert.equal(h.unsubscribes, 1);
});
