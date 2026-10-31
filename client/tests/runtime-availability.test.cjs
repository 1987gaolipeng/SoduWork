'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');

function adapter(id, health) {
  return {
    id, displayName: id.toUpperCase(), capabilities: [],
    async detect() { return typeof health === 'function' ? health() : health; },
    async createSession() { throw Error('not used in availability test'); },
  };
}

test('availableRuntimes probes every registered adapter, keeps Pi, and separates missing rows', async () => {
  const calls = [];
  const bridge = createPiSessionBridge({
    adapter: adapter('pi', { ok: false, state: 'warming', reason: 'Pi is warming' }),
    runnerAdapters: [
      adapter('opencode', { ok: true, state: 'ready', version: '1.2.3' }),
      adapter('qwen', { ok: false, state: 'missing', reason: 'not installed' }),
      adapter('dsh', () => { calls.push('dsh'); throw Error('offline'); }),
    ],
    sessionModule: { open: async () => { throw Error('not used'); }, probe: async () => ({ ok: true }) },
  });
  const result = await bridge.availableRuntimes(null, { force: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.availableRuntimes.map(row => row.id), ['pi', 'opencode']);
  assert.deepEqual(result.missing.map(row => row.id), ['qwen', 'dsh']);
  assert.equal(result.runtimes.some(row => row.id === 'qwen'), true, 'catalog remains available to metadata consumers');
  assert.deepEqual(calls, ['dsh']);
  await bridge.dispose();
});

test('availableRuntimes coalesces concurrent probes and reuses the short cache', async () => {
  let count = 0;
  const bridge = createPiSessionBridge({
    adapter: adapter('pi', { ok: true }),
    runnerAdapters: [adapter('opencode', async () => { count++; await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true }; })],
    sessionModule: { open: async () => { throw Error('not used'); }, probe: async () => ({ ok: true }) },
  });
  const [a, b] = await Promise.all([
    bridge.availableRuntimes(null, { force: true }),
    bridge.availableRuntimes(null),
  ]);
  assert.strictEqual(a, b);
  assert.equal(count, 1);
  const c = await bridge.availableRuntimes(null);
  assert.strictEqual(c, a);
  assert.equal(count, 1);
  await bridge.dispose();
});
