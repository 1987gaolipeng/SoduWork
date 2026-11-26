'use strict';
// Invoked by test_model_gateway_diagnostics.py: real production Session/SDK ->
// loopback Hub -> simulated provider. Only synthetic data and temporary workspaces are used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create } = require('./fixtures/resumed-pi.cjs');
const guard = require('../main/pi-session/tool-guard');
const errors = require('../main/pi-session/model-errors');

(async () => {
  const hub = new URL(process.env.SODUWORK_FIXTURE_HUB);
  assert.equal(hub.hostname, '127.0.0.1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-billing-sdk-'));
  const original = guard.prepareGuardedBash;
  let fixture;
  try {
    guard.prepareGuardedBash = async (sdk, cwd, settings) => guard.createGuardedBash(sdk, cwd, settings,
      { resolvedShell: { shellPath: process.execPath, source: 'isolated-billing-check' } });
    const category = process.env.SODUWORK_FIXTURE_REFUSAL;
    fixture = await create(root);
    fs.writeFileSync(path.join(fixture.agentDir, 'settings.json'), JSON.stringify({
      compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3,
        baseDelayMs: 20, delayScheduleMs: [20, 40, 60] },
    }));
    fixture.reply((_, index) => category && index === 1
      ? { tool: 'write', args: { path: 'receipt.txt', content: 'verified once' } }
      : ({ respond: async (response, body) => {
      const upstream = await fetch(new URL('/api/v1/ai-proxy/v1/chat/completions', hub), {
        method: 'POST', headers: { 'content-type': 'application/json',
          authorization: 'Bearer ' + process.env.SODUWORK_FIXTURE_TICKET }, body: JSON.stringify(body),
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') });
      response.end(await upstream.text());
    } }));
    await fixture.open();
    let retryAttempts = 0;
    fixture.handle.on(() => { if (fixture.handle.snapshot().modelRetry?.active) retryAttempts++; });
    await fixture.handle.submit(category ? 'Save receipt.txt and summarize.' : 'Check the isolated billing response.').completion;
    // The queue records recovery in a microtask after settling the submission receipt.
    await new Promise(resolve => setImmediate(resolve));
    const snapshot = fixture.handle.snapshot();
    assert.equal(retryAttempts, 0);
    if (category) {
      assert.equal(fixture.requests.length, 2);
      assert.equal(snapshot.tools.filter(tool => tool.name === 'write').length, 1);
      assert.equal(snapshot.completion.retryable, false);
      assert.equal(snapshot.execution.modelRecovery?.mode, category === 'generic' ? 'text-summary' : undefined);
      assert.match(snapshot.completion.error, /工具已完成.*HTTP 403/);
    } else {
      assert.equal(fixture.requests.length, 1);
      assert.match(JSON.stringify(snapshot), /余额|billing_required/);
    }
    const classified = errors.describe(JSON.stringify(snapshot));
    assert.equal(classified.retryable, false);
    assert.doesNotMatch(classified.publicText, /private\.invalid/);
    process.stdout.write(JSON.stringify({ ok: true, retryAttempts, requests: fixture.requests.length }) + '\n');
  } finally {
    guard.prepareGuardedBash = original;
    await fixture?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
