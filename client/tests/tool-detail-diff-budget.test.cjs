'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// Run the real UI projection in a child so an unbounded synchronous diff cannot
// hang the test runner. The actual vendored diff is used in every regression.
const source = String.raw`
  const assert = require('node:assert/strict');
  const stream = require(process.argv[1]);
  const mode = process.argv[2];
  const oldText = mode === 'empty' ? ''
    : Array.from({ length: 10000 }, (_, i) => 'old,' + i + '\n').join('');
  const newText = mode === 'empty' ? '' : mode === 'small-change'
    ? oldText.replace('old,5000\n', 'new,5000\n')
    : mode === 'unchanged' ? oldText
      : Array.from({ length: 10000 }, (_, i) => 'new,' + i + '\n').join('');
  const args = mode === 'batch'
    ? { path: 'table.csv', edits: [{ oldText: 'first\n', newText: 'second\n' }, { oldText, newText }] }
    : mode === 'shared-clock'
      ? { path: 'table.csv', edits: Array.from({ length: 100 }, () => ({ oldText: 'old\n', newText: 'new\n' })) }
    : { path: 'table.csv', oldText, newText };
  const original = JSON.stringify(args);
  assert.ok(oldText.length + newText.length < 256 * 1024);
  const acc = stream.create();
  acc.push({ type: 'tool_execution_start', toolCallId: 'table-edit', toolName: 'edit', args });
  // Deterministic elapsed time proves that the batch cannot renew its budget
  // for each cheap edit. The large-rewrite cases above use the real clock.
  const originalNow = Date.now;
  let clock = originalNow();
  if (mode === 'shared-clock') Date.now = () => (clock += 5);
  const start = performance.now();
  let snapshot;
  try { snapshot = acc.uiSnapshot(); } finally { Date.now = originalNow; }
  const elapsedMs = performance.now() - start;
  assert.equal(JSON.stringify(acc.state.tools[0].args), original);
  assert.equal(JSON.stringify(acc.snapshot().tools[0].args), original);
  assert.equal(snapshot.tools[0].args.path, 'table.csv');
  process.stdout.write(JSON.stringify({ summary: snapshot.tools[0].detailSummary, elapsedMs }));
`;

function project(mode) {
  const result = spawnSync(process.execPath, ['-e', source,
    require.resolve('../main/pi-session/event-stream'), mode], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('a rewritten table below the text budget keeps its UI snapshot responsive', t => {
  const result = project('rewrite');
  assert.deepEqual(result.summary, { editCount: 1 });
  t.diagnostic(JSON.stringify(result));
});

test('an expensive batch edit cannot publish counts from only its completed prefix', t => {
  const result = project('batch');
  assert.deepEqual(result.summary, { editCount: 2 });
  t.diagnostic(JSON.stringify(result));
});

test('a small edit in a long table retains exact added and removed counts', () => {
  assert.deepEqual(project('small-change').summary, { editCount: 1, added: 1, removed: 1 });
});

test('an unchanged long table retains an exact zero diff', () => {
  assert.deepEqual(project('unchanged').summary, { editCount: 1, added: 0, removed: 0 });
});

test('all edits in one tool share the same elapsed-time allowance', () => {
  assert.deepEqual(project('shared-clock').summary, { editCount: 100 });
});

test('empty edit text retains a legitimate zero count', () => {
  assert.deepEqual(project('empty').summary, { editCount: 1, added: 0, removed: 0 });
});
