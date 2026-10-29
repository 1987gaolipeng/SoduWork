'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const adapterId of ['codex', 'dsh', 'qwen', 'opencode', 'codex-harness']) {
  test(adapterId + ' honors explicit tool results even when a successful command contains Error', async t => {
    const outcomes = [
      { tool: "$ErrorActionPreference = 'Stop'; Write-Output 'ok'", isError: false },
      { tool: 'stderr', isError: false },
      { tool: 'Run command', isError: true },
      { tool: 'error' }
    ];
    const rows = outcomes.flatMap((result, i) => [
      { seq: i * 2 + 1, kind: 'do', callId: String(i), tool: result.tool },
      { seq: i * 2 + 2, kind: 'out', callId: String(i), text: 'result', ...result }
    ]);
    const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(adapterId),
      modelConfig: { fetchModel: async () => ({ ok: true, model: { id: "fixture", key: "fixture" } }) },
      runnerRuntime: { async rpc(op) {
        if (op === 'job.session') return { ok: true, data: { status: 'done', items: rows } };
        return { ok: true, data: {} };
      } }
    });
    const session = await adapter.resumeSession({ native: { runner: { openOptions: {
      cwd: os.tmpdir(), resumePath: 'tool-outcome-' + adapterId
    } } } });
    t.after(() => session.dispose());
    const handle = getRunnerSessionDetails(session).handle;
    for (let n = 0; n < 300 && handle.snapshot().tools.length < outcomes.length; n++) await delay(10);
    assert.deepEqual(handle.snapshot().tools.map(tool => [tool.state, tool.isError]), [
      ['done', false], ['done', false], ['error', true], ['error', true]
    ]);
  });
}
