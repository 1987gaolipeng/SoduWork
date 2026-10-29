'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('real SDK protocol recovery waits for native abort and keeps completed tools in the same submission',
  { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-protocol-wire-'));
    const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
    t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
    let savedAt;
    f.reply((_body, count) => {
      if (count === 1) return { tool: 'write', args: { path: 'saved.txt', content: 'saved once' } };
      if (count === 2) {
        savedAt = fs.statSync(path.join(f.cwd, 'saved.txt')).mtimeMs;
        return { text: Array(8).fill('Let me read README now.').join('\n') };
      }
      return { text: 'The summary is complete.' };
    });
    await f.open();
    const first = f.handle.submit('Write saved.txt once and finish the summary.');
    const next = f.handle.submit('Reply after the first request finishes.');
    await first.completion; await next.completion;
    const snapshot = f.handle.snapshot();
    assert.equal(f.requests.length, 4, 'one write, one protocol incident, one recovery, then the queued message');
    assert.equal(snapshot.status, 'idle');
    assert.equal(snapshot.execution.stopped, false);
    assert.equal(snapshot.completion.protocolIssue, null);
    assert.equal(snapshot.tools.filter(tool => tool.name === 'write').length, 1);
    assert.equal(fs.statSync(path.join(f.cwd, 'saved.txt')).mtimeMs, savedAt);
    assert.ok(f.requests[2].messages.some(message => message.role === 'tool'));
    assert.ok(f.requests[2].messages.some(message => message.role === 'user' &&
      JSON.stringify(message).includes('<soduwork-internal-protocol-recovery>')));
    assert.equal(f.requests[2].messages.some(message => message.role === 'user' &&
      JSON.stringify(message).includes('Reply after the first request finishes.')), false,
    'next queue item cannot overtake the pending original recovery');
  });
