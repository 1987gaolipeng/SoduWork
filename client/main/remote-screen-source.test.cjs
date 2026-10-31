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
