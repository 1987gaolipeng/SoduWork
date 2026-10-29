'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8');
function fixture(outputs) {
  let timerId = 0, paints = 0;
  const timers = new Map(), requests = [];
  const ctx = { global: {}, _ref: 'a', _viewEpoch: 1, _outRequest: 0, _outRetryTimer: null,
    _outs: [], _outAt: '', _collabTasks: new Map(), _snap: { messages: [] },
    _api: () => ({ outputs: async ref => { requests.push(ref); return outputs(); } }),
    _render() { paints++; },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  };
  vm.createContext(ctx);
  const start = source.indexOf('  async function _pullOuts(');
  vm.runInContext(source.slice(start, source.indexOf('  let _wd =', start)), ctx);
  return { ctx, requests, timers, paints: () => paints, async tick() {
    const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn());
    for (let i = 0; i < 20; i++) await Promise.resolve();
  } };
}
test('opening a local conversation scans once, including an empty successful index', async () => {
  for (const files of [[], [{ name: 'result.html' }]]) {
    const f = fixture(() => ({ ok: true, files }));
    await f.ctx._pullOuts(); await f.tick();
    assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
    assert.equal(JSON.stringify(f.ctx._outs), JSON.stringify(files));
    await f.ctx._pullOuts();
    assert.equal(f.requests.length, 2, 'a later completion event still refreshes the index');
    assert.equal(f.paints(), 1, 'an unchanged index does not render again');
  }
});
test('a failed scan preserves the last index and retries at most twice', async () => {
  for (const failure of ['reject', 'error-result']) {
    const f = fixture(() => { if (failure === 'reject') throw Error('temporary'); return { ok: false }; });
    f.ctx._outs = [{ name: 'earlier.txt' }];
    await f.ctx._pullOuts(); await f.tick(); await f.tick(); await f.tick();
    assert.equal(f.requests.length, 3); assert.equal(f.timers.size, 0);
    assert.equal(f.ctx._outs[0].name, 'earlier.txt'); assert.equal(f.paints(), 0);
  }
});
test('a successful local retry stops retrying', async () => {
  let count = 0;
  const f = fixture(() => ++count === 1 ? { ok: false } : { ok: true, files: [{ name: 'new.txt' }] });
  await f.ctx._pullOuts(); await f.tick(); await f.tick();
  assert.equal(count, 2); assert.equal(f.timers.size, 0); assert.equal(f.ctx._outs[0].name, 'new.txt');
});
test('cloud sessions and task attachments retain the delayed refresh window', async () => {
  for (const context of ['cloud', 'handoff', 'task']) {
    const f = fixture(() => ({ ok: true, files: [] }));
    if (context === 'cloud') f.ctx._snap.execution = { cloud: true };
    if (context === 'handoff') f.ctx._snap.cloudHandoff = { taskId: 'remote-task' };
    if (context === 'task') f.ctx._snap.messages.push({ taskId: 'remote-task' });
    await f.ctx._pullOuts(); await f.tick(); await f.tick(); await f.tick();
    assert.equal(f.requests.length, 3); assert.equal(f.timers.size, 0);
  }
});
test('leaving a conversation prevents both an old result and its retries from affecting the next one', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.ctx._pullOuts(); f.ctx._ref = 'b'; f.ctx._viewEpoch++;
  resolve({ ok: false }); await pending; await f.tick();
  assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0); assert.equal(f.paints(), 0);
});
test('a delayed remote retry is discarded after switching conversations', async () => {
  const f = fixture(() => ({ ok: true, files: [] })); f.ctx._snap.execution = { cloud: true };
  await f.ctx._pullOuts(); f.ctx._ref = 'b'; f.ctx._viewEpoch++; await f.tick();
  assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
});
