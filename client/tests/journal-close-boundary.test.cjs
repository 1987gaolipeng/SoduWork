'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const journal = require('../main/conversation/task-output-journal');
test('closed cloud projections ignore late callbacks while the journal rejects direct writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-close-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 6 }));
  const app = { getPath: () => root }, ref = 'synthetic';
  const view = await require('../main/conversation/cloud-conversation-view').create({ app, ref,
    record: { transferId: ref }, saved: { snapshot: { messages: [] } } });
  view.appendTaskMessage('assistant', 'Committed', [], 'task', 'original');
  view.close(); view.close();
  for (let i = 0; i < 1000; i++) {
    view.appendTaskMessage('assistant', 'Late', [], 'task', 'late-' + i);
    view.appendTaskTool({ type: 'tool_execution_end', toolName: 'read', result: 'Late' }, 'task');
    view.appendTaskRuntimeEvent({ kind: 'text', streamId: 'late', text: 'Late', done: true }, 'task');
  }
  const log = await journal.create(app, 'cloud:' + ref), rows = [];
  try { await log.restore(Infinity, row => rows.push(row)); }
  finally { log.close(); }
  assert.equal(rows.length, 1); assert.equal(rows[0].text, 'Committed');
  assert.throws(() => log.append(1, { kind: 'context-sent' }), /journal is closed/);
});
