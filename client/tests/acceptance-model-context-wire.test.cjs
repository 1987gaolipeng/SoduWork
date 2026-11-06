'use strict';
// Real Pi session, SDK, HTTP requests and archive restoration with synthetic evidence only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-acceptance-wire-'));
  const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root, { signal: t.signal });
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await f.open();
  return f;
}

test('acceptance context reaches the actual Pi request but never its visible or restored user message', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const display = '【验收分析】季度总结\n\n验收标准\n- 数据准确\n\n交付成果\n- 总结.md';
  const promptText = 'Pinned evidence: {"artifactVersionId":"version-internal","criterion":"criterion-internal"}';
  for (let round = 0; round < 3; round++) {
    assert.equal((await f.handle.submit(display, [], { promptText }).completion).ok, true);
    const input = JSON.stringify(f.requests.at(-1).messages.findLast(row => row.role === 'user').content);
    assert.match(input, /version-internal/);
    assert.match(input, /criterion-internal/);
    assert.equal(f.handle.snapshot().messages.filter(row => row.role === 'user').at(-1).text, display);
  }
  assert.equal(f.requests.length, 3);
  f.handle.close();
  await f.open();
  const restored = f.handle.snapshot().messages.filter(row => row.role === 'user').slice(-3);
  assert.deepEqual(restored.map(row => row.text), [display, display, display]);
  assert.doesNotMatch(JSON.stringify(restored), /version-internal|criterion-internal|soduwork-material-context/);
});

test('reasoning-only provider length stops preserve history and never issue an automatic retry', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.reply(() => ({ respond(response) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', reasoning_content: 'Synthetic bounded reasoning.' }, null], [{}, 'length']]) {
      response.write('data: ' + JSON.stringify({ id: 'budget-fixture', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  } }));
  await f.handle.submit('检查隔离测试材料').completion;
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].max_tokens ?? f.requests[0].max_completion_tokens, 65536);
  const snapshot = f.handle.snapshot();
  assert.equal(snapshot.status, 'incomplete');
  assert.match(snapshot.statusText, /单次输出上限/);
  assert.ok(snapshot.messages.some(row => row.role === 'assistant' && row.blocks?.some(block => block.kind === 'thinking')));
});
