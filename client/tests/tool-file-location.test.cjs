'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { project } = require('../main/conversation/tool-file-location.cjs');
const live = require('../main/conversation/task-live-output');
const stream = require('../main/pi-session/event-stream');

test('same filenames in different nodes open the corresponding actual child files, never the parent copy', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-tool-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'step1.txt'), 'parent');
  const acc = stream.create(), handle = { appendTaskTool: event => acc.push(event) };
  for (const name of ['one', 'two']) {
    const cwd = path.join(root, name); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'step1.txt'), name);
    const event = Object.freeze({ seq: 1, kind: 'do', callId: 'write', tool: 'write', args: Object.freeze({ path: 'step1.txt', content: name }) });
    live.create(handle, '', { cwd }).consume(name, [event]);
    assert.equal(event.args.path, 'step1.txt', 'the original native/execution event stays untouched');
  }
  const tools = acc.snapshot().tools;
  assert.notEqual(tools[0].args.path, tools[1].args.path);
  assert.deepEqual(tools.map(tool => fs.readFileSync(tool.args.path, 'utf8')), ['one', 'two']);
  assert.equal(fs.readFileSync(path.join(root, 'step1.txt'), 'utf8'), 'parent');
});

test('file argument aliases resolve relative to the actual node; absolute and URI values stay exact', () => {
  const cwd = 'D:\\workspace\\node';
  for (const key of ['path', 'file_path', 'filePath', 'filepath', 'filename', 'fileName', 'file', 'target', 'target_path', 'targetPath']) {
    assert.equal(project({ tool: 'read', args: { [key]: '中文文件.txt' } }, cwd)[key], 'D:\\workspace\\node\\中文文件.txt');
  }
  for (const value of ['D:\\real\\file.txt', '\\\\server\\share\\file.txt', '/srv/real/file.txt', 'file:///srv/real/file.txt', 'https://example.invalid/file.txt']) {
    assert.equal(project({ tool: 'write', args: { path: value } }, cwd).path, value);
  }
});

test('unknown tools, commands and empty native inputs do not acquire invented file paths', () => {
  const cwd = path.resolve('node');
  for (const tool of ['bash', 'exec_command', 'mcp__read_database', 'unknown']) {
    const args = { path: 'relative.txt', command: 'cat relative.txt' };
    assert.deepEqual(project({ tool, args }, cwd), args);
  }
  assert.deepEqual(project({ tool: 'read', args: {}, text: 'step1.txt' }, cwd), {});
  assert.deepEqual(project({ tool: 'read', text: 'step1.txt' }, cwd), { path: 'step1.txt' }, 'legacy normalization is not promoted into a claimed node-local native path');
  assert.deepEqual(project({ tool: 'write', args: { path: 'relative.txt' } }), { path: 'relative.txt' });
});

test('preparing a file uses the same node location as its subsequent actual tool card', () => {
  const preparations = [], tools = [], cwd = path.resolve('child-node');
  const output = live.create({ appendTaskRuntimeEvent: event => preparations.push(event), appendTaskTool: event => tools.push(event) }, '', { cwd });
  output.consume('node', [
    { seq: 1, kind: 'tool-preparing', callId: 'write', tool: 'write', arguments: { file_path: 'x.txt' } },
    { seq: 2, kind: 'do', callId: 'write', tool: 'write', arguments: { file_path: 'x.txt', content: 'body' } },
  ]);
  assert.equal(preparations[0].arguments.file_path, path.join(cwd, 'x.txt'));
  assert.equal(tools[0].args.file_path, preparations[0].arguments.file_path);
});
