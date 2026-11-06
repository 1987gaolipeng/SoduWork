'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const { getEventListeners } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
const response = (status = 200) => ({ status, ok: status === 200, text: async () => '{"id":"task"}' });
const tick = () => new Promise(setImmediate);
function fixture(fetch, modern = false) {
  const timers = new Map(), storage = new Map(); let serial = 0;
  const window = { __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true } };
  vm.runInNewContext(source, { window, fetch, User: { id: 'synthetic' }, navigator: { platform: 'test' },
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    AbortController, AbortSignal: modern ? AbortSignal : {}, console,
    FormData: class {}, WebSocket: class {},
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  return { api: window.SoduWorkAPI, window, timers, timeout() {
    for (const [id, timer] of [...timers]) if (timer.ms === 8000 && timers.delete(id)) timer.fn();
  } };
}
function waitingFetch(signals) {
  return async (_, { signal }) => {
    signals.push(signal);
    if (signal.aborted) throw signal.reason;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
}
for (const modern of [false, true]) {
  test('task timeout survives caller signals with AbortSignal.any ' + modern, async () => {
    const signals = [], caller = new AbortController(), f = fixture(waitingFetch(signals), modern);
    const result = assert.rejects(f.api.getTask('task', { signal: caller.signal }), /请求超时/);
    await tick(); assert.equal(signals.length, 1); f.timeout();
    assert.equal(signals[0].aborted, true);
    await result;
    assert.equal(caller.signal.aborted, false); assert.equal(f.api.online, false);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0); assert.equal(f.timers.size, 0);
  });
  test('caller cancellation remains distinct from connectivity failure ' + modern, async () => {
    for (const already of [true, false]) {
      const caller = new AbortController(), signals = [];
      const f = fixture(async (...args) => args[0].includes('/tasks/ready') ? response() : waitingFetch(signals)(...args), modern);
      await f.api.getTask('ready'); assert.equal(f.api.online, true);
      if (already) caller.abort();
      const result = assert.rejects(f.api.getTask('pending', { signal: caller.signal }), e => e === caller.signal.reason);
      await tick(); if (!already) caller.abort(); await result;
      assert.equal(f.api.online, true); assert.equal(f.timers.size, 0);
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    }
  });
}
test('successful and failed reads release timers and shared caller listeners under pressure', async () => {
  const caller = new AbortController(); let count = 0;
  const f = fixture(async () => ++count % 2 ? response() : response(403));
  for (let i = 0; i < 1000; i++) {
    await f.api.getTask('task', { signal: caller.signal }).catch(e => assert.equal(e.status, 403));
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0); assert.equal(f.timers.size, 0);
  }
});

test('authentication replay retains the original timeout and cancellation signal', async () => {
  const signals = [], caller = new AbortController(); let registrations = 0;
  const f = fixture(async (url, options) => {
    if (!signals.length) { signals.push(options.signal); return response(401); }
    return waitingFetch(signals)(url, options);
  });
  f.window.soduWorkAPI = { deviceAuthBootstrap: async () => ({ ok: true, stored: true,
    clientId: 'synthetic', authState: 'active', activationRequired: false,
    session: 'synthetic-session-' + ++registrations, expiresIn: 1800 }) };
  const result = assert.rejects(f.api.getTask('task', { signal: caller.signal }), /请求超时/);
  await tick();
  assert.equal(signals.length, 2); assert.equal(signals[0], signals[1]);
  assert.equal([...f.timers.values()].filter(row => row.ms === 8000).length, 1);
  f.timeout(); await result;
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  assert.equal(f.timers.size, 0);
});
