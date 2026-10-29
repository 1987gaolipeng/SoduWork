'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.window = global;
const tools = require('../components/panels/panels-chat-tools');
delete global.window;

test('runtime semantic tool kinds survive localized or ambiguous titles', () => {
  for (const [tool, expected] of [
    [{ name: 'Read README using terminal', toolKind: 'execute', args: { command: 'cat README.md' } }, 'command'],
    [{ name: 'Readme update', toolKind: 'edit', args: { path: 'README.md' } }, 'edit'],
    [{ name: '查看资料', toolKind: 'read', args: { path: 'notes.md' } }, 'read'],
    [{ name: '生成报告', toolKind: 'write', args: { path: 'report.md' } }, 'write'],
    [{ name: 'Inspect code', toolKind: 'search' }, 'search'],
  ]) {
    assert.equal(tools.kind(tool), expected);
    assert.ok(tools.icon(tool).includes('data-tool-kind="' + expected + '"'));
  }
  assert.equal(tools.kind({ name: 'write_stdin', args: { chars: 'y' } }), 'command');
  assert.equal(tools.kind({ name: 'write_file', toolKind: 'other' }), 'write');
});

test('file reads and changes use the workbench; commands remain summaries', () => {
  const write = tools.render({ name: 'write_file', state: 'done', args: { path: 'a.md', content: 'hi' } });
  const edit = tools.render({ name: 'edit_file', state: 'done', args: { path: 'b.js', edits: [{ oldText: 'a', newText: 'b' }] } });
  const cmd = tools.render({ name: 'bash', state: 'done', args: { command: 'ls' }, result: 'x' });
  assert.equal(write.side, true);
  assert.equal(edit.side, true);
  assert.equal(tools.render({ name: 'read', args: { path: 'a.md' } }).side, true);
  assert.notEqual(cmd.side, true);
  // Without document, openSide rejects gracefully rather than throwing.
  assert.equal(tools.openSide(null), false);
  assert.equal(tools.openSide(cmd), false);
});
