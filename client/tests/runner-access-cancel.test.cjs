
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const adapterId of ['qwen', 'opencode', 'codex-harness']) test(adapterId + ' preserves a withdrawn approval as neutral across live and archived projection', async t => {
  let phase = 0;
  const rows = [
    { seq: 1, kind: 'user', text: 'fixture' },
    { seq: 2, kind: 'do', callId: 'withdrawn', tool: 'Run command', arguments: { command: 'fixture' } },
    { seq: 3, kind: 'out', callId: 'withdrawn', tool: 'stderr', text: 'Original permission response',
      state: 'cancelled', cancelReason: 'access-change', isError: false },
    { seq: 4, kind: 'do', callId: 'failed', tool: 'Run command', arguments: { command: 'fixture' } },
    { seq: 5, kind: 'out', callId: 'failed', text: 'Genuine failure', isError: true,
      state: 'cancelled', cancelReason: 'access-change' }
  ];
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(adapterId),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op) {
      if (op === 'job.session') return { ok: true, data: { status: phase ? 'done' : 'running', items: rows } };
      return { ok: true, data: { ok: true } };
    } }
  });
  const options = { native: { runner: { openOptions: { cwd: os.tmpdir(), resumePath: 'access-cancel-' + adapterId } } } };
  const sessions = [];
  t.after(async () => { for (const session of sessions) await session.dispose(); });
  for (phase = 0; phase < 2; phase++) {
    const session = await adapter.resumeSession(options); sessions.push(session);
    const handle = getRunnerSessionDetails(session).handle;
    for (let n = 0; n < 300 && handle.snapshot().tools.length < 2; n++) await delay(10);
    const [cancelled, failed] = handle.snapshot().tools;
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.cancelReason, 'access-change');
    assert.equal(cancelled.isError, false);
    assert.equal(cancelled.result, 'Original permission response');
    assert.equal(failed.state, 'error');
    assert.equal(failed.isError, true);
    assert.equal(failed.cancelReason, undefined);
    await session.dispose();
  }
});
