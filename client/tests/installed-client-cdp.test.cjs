'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { connect } = require('../../tools/ci/installed-client-cdp.cjs');
class Socket extends EventTarget {
  static active;
  constructor() { super(); Socket.active = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(value) { this.sent = JSON.parse(value); }
  close() { this.dispatchEvent(new Event('close')); }
  reply(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
test('CDP handles out-of-order replies and emits method timing without expression or result contents', async () => {
  const events = [], client = await connect('ws://fixture', { Socket, timeoutMs: 100, trace: event => events.push(event) });
  const one = client.call('Runtime.evaluate', { expression: 'secret expression' }), first = Socket.active.sent.id;
  const two = client.call('Runtime.evaluate'), second = Socket.active.sent.id;
  Socket.active.reply({ id: second, result: { value: 'second secret result' } });
  Socket.active.reply({ id: first, result: { value: 'first' } });
  assert.deepEqual(await Promise.all([one, two]), [{ value: 'first' }, { value: 'second secret result' }]);
  assert.equal(events.length, 3); assert.ok(!JSON.stringify(events).includes('secret')); client.close();
});
test('CDP close, malformed JSON and request timeout fail promptly and clean pending requests', async () => {
  for (const mode of ['close', 'invalid', 'timeout']) {
    const client = await connect('ws://fixture', { Socket, timeoutMs: 15 });
    const result = client.call('Runtime.evaluate');
    if (mode === 'close') Socket.active.close();
    if (mode === 'invalid') Socket.active.dispatchEvent(new MessageEvent('message', { data: 'invalid secret' }));
    await assert.rejects(result, /closed|invalid JSON|timed out/); client.close();
  }
});
test('CDP connection establishment has a deadline even if neither open nor error arrives', async () => {
  class Silent extends EventTarget { close() {} }
  await assert.rejects(connect('ws://fixture', { Socket: Silent, timeoutMs: 10 }), /connection timed out/);
});
