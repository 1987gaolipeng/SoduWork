'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const budget = require('../main/pi-session/model-retry-budget.cjs');
const control = require('../main/pi-session/run-control');
const stall = require('../main/pi-session/stall-recovery');
const defaults = { enabled: true, maxRetries: 6, delayScheduleMs: [5000, 15000, 30000, 60000, 120000, 240000] };

test('opening one Runner history entry hydrates only that journal across a large inventory', async t => {
  const journals = require('../main/conversation/task-output-journal');
  const reads = [], adapterModule = require('../main/agent-runtime/runner-adapter');
  t.mock.method(journals, 'usedHarnesses', async (_app, ref) => { reads.push(ref); return ['pi']; });
  let inventories = 0;
  const runnerRuntime = { rpc: async method => {
    assert.equal(method, 'runtime.sessions'); inventories++;
    return { ok: true, data: { runs: Array.from({ length: 10000 }, (_, i) =>
      ({ ref: 'run-' + i, taskId: 'chat-' + i, cli: adapterModule.ADAPTER_ID, workDir: 'fixture' })) } };
  } };
  const adapter = adapterModule.createRunnerRuntimeAdapter({ runnerRuntime });
  const result = await adapter.historyEntry('run-9999');
  assert.equal(result.chats[0].id, 'run-9999');
  assert.deepEqual(reads, ['run-9999']);
  assert.equal((await adapter.historyEntry('missing')).chats.length, 0);
  assert.equal(inventories, 1);
});

test('retry wait survives the watchdog; an expired scheduler remains detectable', () => {
  const state = control.createState();
  control.observeEvent(state, { type: 'auto_retry_start', delayMs: 240000 });
  const input = { ...state, promptActive: true };
  assert.equal(stall.shouldInterrupt(input, state.lastActivityAt + 181000), false);
  assert.equal(stall.shouldInterrupt(input, state.retryWaitUntil + stall.HARD_IDLE_MS), true);
  control.observeEvent(state, { type: 'message_start' });
  assert.equal(state.retryWaitUntil, 0);
});

test('SDK success segments and recovery branches share one bounded turn budget', () => {
  let now = 1000;
  const value = budget.create({ clock: () => now, random: () => .5 });
  for (let i = 0; i < 6; i++) {
    // The SDK resets its own counter after successful tool-call replies.
    assert.equal(value.plan({ settings: defaults, attempt: 1 }).delayMs, 5000);
    now += 5001;
  }
  assert.equal(value.plan({ settings: defaults, attempt: 1 }), false);
  assert.equal(value.reserve(), false);
  value.reset();
  assert.equal(value.reserve(), true);
  for (let i = 0; i < 5; i++) assert.ok(value.plan({ settings: defaults, attempt: 1 }));
  assert.equal(value.plan({ settings: defaults, attempt: 1 }), false);
});

test('default jitter, Retry-After and explicit user schedules retain their contracts', () => {
  const low = budget.create({ random: () => 0 }), high = budget.create({ random: () => 1 });
  assert.equal(low.plan({ settings: defaults, attempt: 6 }).delayMs, 192000);
  assert.equal(high.plan({ settings: defaults, attempt: 6 }).delayMs, 288000);
  const value = budget.create();
  const settings = { enabled: true, maxRetries: 3, delayScheduleMs: [20, 40, 60] };
  assert.equal(value.plan({ settings, attempt: 1 }).delayMs, 20);
  assert.equal(value.plan({ settings, attempt: 2, error: { errorMessage: 'HTTP 429. Retry after 120 seconds.' } }).delayMs, 120000);
  assert.equal(value.plan({ settings, attempt: 3, error: { retryAfterMs: 999999999 } }), false);
  value.reset();
  assert.equal(value.plan({ settings: { ...settings, enabled: false }, attempt: 1 }), false);
});

test('large journal streams asynchronously and preserves interleaving, unsent context and restart', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-journal-pressure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 6 }));
  const app = { getPath: () => root }, journals = require('../main/conversation/task-output-journal');
  let log = await journals.create(app, 'pressure');
  const text = 'x'.repeat(4096);
  for (let i = 0; i < 256; i++) log.appendMany(Array.from({ length: 100 }, (_, n) =>
    ({ after: i * 100 + n, kind: 'message', role: 'assistant', taskId: 'fixture', text })));
  log.append(25600, { kind: 'context-sent' }); log.close();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    log = await journals.create(app, 'pressure');
    assert.equal(log.context(), '');
    const rows = [];
    await log.restore(1, row => rows.push(row.after));
    log.append(25601, { kind: 'message', role: 'user', text: 'New turn' });
    await log.restore(3, row => rows.push(row.after));
    assert.deepEqual(rows, [0, 1, 2, 3]);
    assert.match(log.context(), /New turn/);
    assert.ok(ticks > 10, '100 MB replay must yield to the main loop');
    log.close();
    log = await journals.create(app, 'pressure');
    assert.match(log.context(), /New turn/);
  } finally { clearInterval(timer); log.close(); }
});

test('plugin IPC catalog coalesces work, keeps the loop responsive and rereads changed data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-catalog-pressure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 6 }));
  const app = { getPath: () => root, isPackaged: false };
  const worker = require('../main/personal-plugin-catalog-worker.cjs');
  const sync = require('../main/personal-plugins');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const first = worker.catalog(app);
    for (let i = 0; i < 100; i++) assert.equal(worker.catalog(app), first);
    assert.deepEqual(await first, sync.catalog(app, false));
    assert.ok(ticks > 5);
    const changed = sync.create(app, { key: 'fresh-fixture', name: 'Fresh fixture', template: 'method',
      description: 'An isolated catalog fixture', instructions: 'Produce an isolated test report from the supplied input.' });
    assert.ok(changed);
    assert.deepEqual(await worker.catalog(app), sync.catalog(app, false));
  } finally { clearInterval(timer); }
});
