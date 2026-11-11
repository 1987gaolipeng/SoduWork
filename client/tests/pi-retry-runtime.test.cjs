'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { patchPiRetrySchedule } = require('../scripts/patch-pi-retry-schedule.cjs');

test('the bundled Pi AgentSession consumes each explicit retry delay', async () => {
  const patched = patchPiRetrySchedule();
  assert.equal(patched.ok, true, JSON.stringify(patched.results));
  const { AgentSession } = await import('../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js');
  const events = [];
  const runtime = {
    settingsManager: {
      getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 100,
        delayScheduleMs: [1, 2, 3] }),
    },
    _retryAttempt: 0,
    _emit: event => events.push(event),
    agent: { state: { messages: [] } },
  };
  assert.equal(await AgentSession.prototype._prepareRetry.call(runtime, { errorMessage: 'temporary' }), true);
  assert.equal(await AgentSession.prototype._prepareRetry.call(runtime, { errorMessage: 'temporary' }), true);
  assert.equal(await AgentSession.prototype._prepareRetry.call(runtime, { errorMessage: 'temporary' }), true);
  assert.deepEqual(events.map(event => event.delayMs), [1, 2, 3]);
  assert.deepEqual(events.map(event => event.maxAttempts), [3, 3, 3]);
});
