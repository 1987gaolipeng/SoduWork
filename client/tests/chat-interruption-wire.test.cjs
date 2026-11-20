'use strict';
// Real Pi SDK, local synthetic SSE endpoint and persisted archive. No paid model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
test('manual stop survives SDK persistence and reopen; ordinary followup retains the original marker', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-stop-wire-'));
  const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root, { signal: t.signal });
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await f.open();
  f.reply(() => ({ respond(response) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ id: 'stop-fixture', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial fixture output.' }, finish_reason: null }] }) + '\n\n');
    // The request remains live until the real cancel path aborts it.
  } }));
  const turn = f.handle.submit('Start isolated streaming response', [], { submissionId: 'stop-wire', sentAt: Date.now() });
  for (let i = 0; i < 200 && !f.handle.snapshot().messages.some(message =>
    message.blocks?.some(block => block.text?.includes('Partial fixture'))); i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(f.handle.snapshot().messages.some(message => message.blocks?.some(block => block.text?.includes('Partial fixture'))));
  await f.handle.cancel({ userInitiated: true }); await turn.completion;
  const stopped = f.handle.snapshot().turnMetrics.at(-1);
  assert.equal(stopped.outcome, 'stopped');
  assert.ok(Number.isFinite(stopped.elapsedMs));
  f.handle.close(); await f.open();
  assert.equal(f.requests.length, 1, 'opening history never issues a model request');
  assert.equal(f.handle.historyRow().state, 'stopped');
  assert.equal(f.handle.snapshot().turnMetrics.at(-1).elapsedMs, stopped.elapsedMs);
  f.reply(() => ({ text: 'Followup finished.' }));
  assert.equal((await f.handle.submit('Continue with the next request').completion).ok, true);
  assert.equal(f.handle.historyRow().state, 'completed');
  assert.equal(f.handle.snapshot().turnMetrics.filter(row => row.outcome === 'stopped').length, 1);
  f.handle.close(); await f.open();
  assert.equal(f.requests.length, 2);
  const metrics = f.handle.snapshot().turnMetrics;
  assert.equal(metrics.at(-2).outcome, 'stopped');
  assert.equal(metrics.at(-2).elapsedMs, stopped.elapsedMs);
  assert.equal(metrics.at(-1).outcome, undefined);
});
