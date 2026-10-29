'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const control = require('../main/pi-session/run-control'), recovery = require('../main/pi-session/stall-recovery');

for (const recovers of [true, false]) test('real silent SDK stream ' + (recovers ? 'restarts once after native abort' : 'stops after one failed restart'),
  { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-stall-wire-'));
    const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
    const originalMonitor = control.startMonitor;
    let state, runtime, mtime;
    const incidents = [];
    control.startMonitor = (run, ctx) => {
      state = run; runtime = ctx; originalMonitor(run, ctx);
    };
    t.after(async () => {
      control.startMonitor = originalMonitor;
      await f.close(); fs.rmSync(root, { recursive: true, force: true });
    });
    f.reply((_body, count) => {
      if (count === 1) return { tool: 'write', args: { path: 'saved.txt', content: 'saved once' } };
      if (count === 2 || !recovers && count === 3) return { respond(response) {
        mtime ??= fs.statSync(path.join(f.cwd, 'saved.txt')).mtimeMs;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': keepalive without model progress\n\n');
        // Time is advanced at the watchdog boundary only. Abort, native idle,
        // same-session continuation, queue ownership and HTTP stay real.
        setTimeout(() => {
          state.lastActivityAt = Date.now() - recovery.HARD_IDLE_MS;
          assert.equal(recovery.shouldInterrupt({ promptActive: state.promptActive,
            activeTool: state.activeTools.size > 0, lastActivityAt: state.lastActivityAt }), true);
          assert.equal(runtime.piSession.isIdle, false);
          incidents.push(count);
          control.stopStalledAgent(state, runtime);
        }, 20);
      } };
      return { text: 'Remaining summary completed.' };
    });
    await f.open();
    const turn = f.handle.submit('Write saved.txt once and finish the summary.');
    const next = recovers ? f.handle.submit('Reply after the first request finishes.') : null;
    await turn.completion;
    if (next) await next.completion;
    const snapshot = f.handle.snapshot();
    assert.equal(f.requests.length, recovers ? 4 : 3);
    assert.deepEqual(incidents, recovers ? [2] : [2, 3]);
    assert.equal(snapshot.tools.filter(tool => tool.name === 'write').length, 1);
    assert.equal(fs.statSync(path.join(f.cwd, 'saved.txt')).mtimeMs, mtime);
    assert.ok(f.requests[2].messages.some(message => message.role === 'tool'), 'native recovery retains the completed write receipt');
    assert.equal(f.requests[2].messages.filter(message => message.role === 'user' &&
      JSON.stringify(message).includes('<soduwork-internal-runtime-recovery>')).length, 1);
    if (recovers) {
      assert.equal(snapshot.completion.reason, 'stop'); assert.equal(snapshot.execution.stopped, false);
    } else {
      assert.equal(snapshot.execution.stopKind, 'agent-stall');
      assert.equal(snapshot.execution.running, false);
    }
  });
