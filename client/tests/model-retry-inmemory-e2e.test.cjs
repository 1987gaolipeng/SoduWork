'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const toolGuard = require('../main/pi-session/tool-guard');
const { create } = require('../e2e/fixtures/resumed-pi.cjs');
const { patchPiRetrySchedule } = require('../scripts/patch-pi-retry-schedule.cjs');

function sseBody(events) {
  return events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n';
}

test('full Session and SDK flow follows the explicit retry schedule without network access',
  { timeout: 15000 }, async t => {
    const originalPrepareBash = toolGuard.prepareGuardedBash;
    const originalDispatcher = getGlobalDispatcher();
    const calls = [];
    let mockAgent = null;
    const patchResult = patchPiRetrySchedule();
    assert.equal(patchResult.ok, true, JSON.stringify(patchResult.results));
    toolGuard.prepareGuardedBash = async (sdk, cwd, settingsManager) =>
      toolGuard.createGuardedBash(sdk, cwd, settingsManager,
        { resolvedShell: { shellPath: process.execPath, source: 'memory-e2e' } });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-memory-retry-e2e-'));
    let fixture;
    t.after(async () => {
      toolGuard.prepareGuardedBash = originalPrepareBash;
      setGlobalDispatcher(originalDispatcher);
      await mockAgent?.close();
      try { await fixture?.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    fixture = await create(root);
    fs.writeFileSync(path.join(fixture.agentDir, 'settings.json'), JSON.stringify({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 100, delayScheduleMs: [20, 40, 60] },
    }));
    await fixture.open();
    const models = JSON.parse(fs.readFileSync(path.join(fixture.agentDir, 'models.json'), 'utf8'));
    const baseUrl = models.providers.soduwork.baseUrl;
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.get(new URL(baseUrl).origin).intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(() => {
        calls.push({});
        return { statusCode: 200, headers: { 'content-type': 'text/event-stream' },
          data: calls.length <= 3
            ? 'data: ' + JSON.stringify({ error: { message: 'temporary stream failure (HTTP 503)', type: 'soduwork_proxy_error', code: 503 } }) + '\n\n'
            : sseBody([
                { id: 'memory-e2e', object: 'chat.completion.chunk', model: 'fixture-model',
                  choices: [{ index: 0, delta: { role: 'assistant', content: '重试后完成' }, finish_reason: null }] },
                { id: 'memory-e2e', object: 'chat.completion.chunk', model: 'fixture-model',
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
              ]) };
      }).persist();
    setGlobalDispatcher(mockAgent);
    const retries = [];
    fixture.handle.on(() => {
      const row = fixture.handle.snapshot().modelRetry;
      if (row?.active && !retries.some(item => item.attempt === row.attempt)) retries.push(row);
    });

    const result = await fixture.handle.submit('验证重试链路。').completion;
    assert.equal(result.ok, true);
    assert.equal(fixture.handle.snapshot().status, 'idle', JSON.stringify({ calls: calls.length,
      completion: fixture.handle.snapshot().completion,
      retry: fixture.handle.snapshot().modelRetry }));
    assert.equal(calls.length, 4);
    assert.deepEqual(retries.map(row => row.delayMs), [20, 40, 60]);
    assert.deepEqual(retries.map(row => row.max), [3, 3, 3]);
  });
