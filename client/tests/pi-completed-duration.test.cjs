'use strict';
// Real Pi session, SDK archive and local HTTP model. No user profile or service.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('completed Pi duration freezes and its receipt survives reopening and another turn', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-completed-duration-'));
  const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await f.open();
  const result = await f.handle.send('Answer this isolated timing regression.', [], { internal: true });
  assert.equal(result.ok, true);
  assert.equal(f.handle.inFlight(), false);
  const completed = f.handle.snapshot(), elapsed = completed.execution.elapsedMs;
  assert.ok(completed.turnMetrics.at(-1).elapsedMs >= 0);
  const entries = fs.readFileSync(f.resumePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const archived = entries.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1);
  assert.equal(archived.message.completedAt, completed.messages.at(-1).completedAt,
    'the SDK archive stores the exact live completion timestamp before provenance projection');
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 60000;
    assert.equal(f.handle.snapshot().execution.elapsedMs, elapsed, 'idle snapshots cannot count time after completion');
    assert.deepEqual(f.handle.snapshot().turnMetrics, completed.turnMetrics);
  } finally { Date.now = originalNow; }
  f.handle.close();
  await f.open();
  assert.deepEqual(f.handle.snapshot().turnMetrics, completed.turnMetrics, 'reopening restores the same persisted turn receipts');
  let received, release;
  const started = new Promise(resolve => { received = resolve; });
  f.reply(async () => { received(); await new Promise(resolve => { release = resolve; }); return { text: 'Second completed answer.' }; });
  const next = f.handle.send('A second independent turn.', [], { internal: true });
  await started;
  assert.equal(f.handle.snapshot().execution.running, true);
  const running = f.handle.snapshot().execution.elapsedMs;
  try {
    Date.now = () => originalNow() + 2000;
    assert.ok(f.handle.snapshot().execution.elapsedMs >= running + 2000, 'active execution still advances');
  } finally { Date.now = originalNow; release(); }
  await next;
  assert.deepEqual(f.handle.snapshot().turnMetrics.slice(0, -1), completed.turnMetrics);
});
