'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('./remote-screen-source.cjs');

function response(value, ok = true) {
  return { ok, status: ok ? 200 : 409, text: async () => JSON.stringify(value) };
}
function wait(ms = 0) { return new Promise(resolve => setTimeout(resolve, ms)); }

function fixture(answer = 0) {
  const calls = [];
  const sockets = [];
  class FakeSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(value) { this.onmessage?.({ data: value }); }
  }
  const jpeg = Buffer.from([0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  const image = { isEmpty: () => false, getSize: () => ({ width: 640, height: 480 }), toJPEG: () => jpeg };
  const fetch = async (_identity, url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/remote-screen/requests')) return response({ items: [{ id: 'grant-1', state: 'pending', viewerName: 'phone' }] });
    if (url.endsWith('/approve')) return response({ id: 'grant-1', state: 'active' });
    if (url.endsWith('/stop')) return response({ id: 'grant-1', state: 'stopped' });
    throw new Error('unexpected URL');
  };
  const app = { whenReady: fn => Promise.resolve().then(fn) };
  const dialog = { showMessageBox: async () => ({ response: answer }) };
  const source = create({ app, dialog, identityOf: async () => ({ hub: 'https://hub.example', clientId: 'desktop-1', session: 'session-1' }), fetch, WebSocketImpl: FakeSocket,
    capture: { getSources: async () => [{ display_id: 'display-1', thumbnail: image }] },
    displays: { getPrimaryDisplay: () => ({ id: 'display-1' }) },
    frameMs: 100000, logger: { warn() {} } });
  return { source, calls, sockets, jpeg };
}

test('desktop source requires consent and publishes authenticated JPEG frames', async () => {
  const f = fixture(0);
  await f.source.poll();
  await wait(10);
  assert.equal(f.calls.some(call => call.url.endsWith('/approve')), true);
  assert.equal(f.sockets.length, 1);
  const socket = f.sockets[0];
  assert.equal(socket.url, 'wss://hub.example/api/v1/remote-screen/media');
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: 'source-auth', grantId: 'grant-1', device: 'desktop-1', session: 'session-1',
  });
  socket.message(JSON.stringify({ type: 'ready', role: 'source', permission: 'view' }));
  await wait(10);
  assert.equal(typeof socket.sent[1], 'string');
  assert.deepEqual(JSON.parse(socket.sent[1]).type, 'frame');
  assert.deepEqual(socket.sent[2], f.jpeg);
  assert.equal(socket.url.includes('session'), false);
  f.source.dispose();
});

test('desktop source denies a request without opening a socket', async () => {
  const f = fixture(1);
  await f.source.poll();
  await wait(10);
  assert.equal(f.sockets.length, 0);
  assert.equal(f.calls.some(call => call.url.endsWith('/stop')), true);
  f.source.dispose();
});

test('a slow discovery request is shared and disposal aborts it', async () => {
  let calls = 0, signal;
  const source = create({ autoStart: false, logger: { warn() {} },
    identityOf: async () => ({ hub: 'http://hub', clientId: 'pc', session: 'alice' }),
    fetch: async (_identity, _url, options) => {
      calls++; signal = options.signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
  const first = source.poll(), second = source.poll();
  assert.equal(first, second);
  await wait(); assert.equal(calls, 1); assert.equal(signal.aborted, false);
  source.dispose(); await first; assert.equal(signal.aborted, true);
  await source.poll(); assert.equal(calls, 1);
});

test('a delayed response from another account never opens a consent dialog', async () => {
  let identity = { hub: 'http://hub', clientId: 'pc', session: 'alice' }, resolve, prompts = 0;
  const source = create({ autoStart: false, logger: { warn() {} }, identityOf: async () => identity,
    dialog: { showMessageBox() { prompts++; } },
    fetch: async () => new Promise(done => { resolve = done; }) });
  const pending = source.poll(); await wait();
  identity = { ...identity, session: 'bob' };
  resolve(response({ items: [{ id: 'old', state: 'pending' }] }));
  await pending; assert.equal(prompts, 0); source.dispose();
});

test('consent is serialized and an account switch while the dialog is open prevents approval', async () => {
  let identity = { hub: 'http://hub', clientId: 'pc', session: 'alice' }, resolve, prompts = 0;
  const calls = [];
  const source = create({ autoStart: false, logger: { warn() {} }, identityOf: async () => identity,
    dialog: { showMessageBox() { prompts++; return new Promise(done => { resolve = done; }); } },
    fetch: async (_identity, url) => { calls.push(url); return response({ items: [
      { id: 'one', state: 'pending' }, { id: 'two', state: 'pending' }] }); } });
  await source.poll(); assert.equal(prompts, 1);
  identity = { ...identity, hub: 'http://another-hub' };
  resolve({ response: 0 }); await wait();
  assert.equal(calls.length, 1); source.dispose();
});
