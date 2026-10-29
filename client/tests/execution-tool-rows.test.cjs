'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const sandbox = { console, ChatDomPatch: require('../components/panels/chat-dom-patch'),
    ExecutionToolArgs: require('../components/shared/execution-tool-args') };
  sandbox.window = sandbox;
  for (const name of ['panels-chat-tools', 'chat-context-meter', 'chat-scroll-follow',
    'chat-markdown', 'chat-acceptance-results', 'chat-message-renderer', 'task-execution-stream']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8'), sandbox);
  }
  sandbox.esc = sandbox.ChatTools.esc;
  const ctx = { esc: sandbox.esc, _openTool: new Set(), _hotToolBodies: new Set() };
  return { sandbox, tools: sandbox.ChatTools, ctx, renderer: sandbox.ChatMessageRenderer.create(ctx) };
}

function unreadableOutput(tool) {
  for (const key of ['result', 'partial']) Object.defineProperty(tool, key, {
    enumerable: true, get() { throw Error('Command ' + key + ' must not be read by the row renderer'); },
  });
  return tool;
}

test('commands retain only their status in both transcripts even after a remembered expansion', () => {
  const { tools, renderer, sandbox, ctx } = harness();
  for (const state of ['running', 'done']) {
    const command = unreadableOutput({ id: 'normal-command', name: 'bash', state, after: 0,
      args: { command: 'npm test' } });
    ctx._openTool.add(command.id);
    const expected = state === 'running' ? /正在运行命令/ : /运行了命令/;
    for (const html of [renderer._toolHtml(command), sandbox._executionStreamToolHtml({ key: command.id, model: command })]) {
      assert.match(html, expected);
      assert.doesNotMatch(html, /npm test|<button|ntool-body|ntool-caret|aria-expanded|title=/);
    }
    const input = [command, { id: 'terminal-input', name: 'write_stdin', state, after: 1, args: { chars: 'next' } }];
    const group = tools.batchHtml(input, 'remembered', true, tool => renderer._toolHtml(tool));
    assert.match(group, expected);
    assert.doesNotMatch(group, /npm test|<button|ntool-batch-body|ntool-batch-caret|aria-expanded|title=/);
    const parts = [], previous = [];
    tools.appendTimeline(parts, input, previous, 'turn', true, tool => renderer._toolHtml(tool), new Set(['remembered']));
    assert.match(parts.join(''), expected);
    assert.doesNotMatch(parts.join(''), /npm test|ntool-batch-body|ntool-batch-caret|aria-expanded/);
    assert.equal(previous.length, 2, 'execution history remains intact for status and progress');
    assert.equal(command.state, state);
    assert.equal(command.args.command, 'npm test');
  }
});

test('command failures and permission changes retain visible status without command details', () => {
  const { tools, renderer, sandbox } = harness();
  for (const extra of [{ state: 'error' }, { state: 'done', isError: true },
    { state: 'failed' }, { state: 'cancelled', cancelReason: 'access-change' }]) {
    const command = unreadableOutput({ id: 'important-command', name: 'exec_command',
      args: { command: 'npm test' }, ...extra });
    assert.match(renderer._toolHtml(command), /命令执行异常|权限已调整，未执行/);
    assert.match(sandbox._executionStreamToolHtml({ key: command.id, model: command }), /命令执行异常|权限已调整，未执行/);
    assert.equal(tools.render(command).summaryOnly, true);
    assert.doesNotMatch(renderer._toolHtml(command), /npm test|ntool-body|ntool-caret|<button/);
  }
});

test('file read rows defer large results and partial output until a workbench click', () => {
  const { tools, renderer, ctx } = harness();
  for (const state of ['done', 'running']) {
    const tool = unreadableOutput({ id: 'read', name: 'read', state, args: { path: '报告.html' } });
    ctx._openTool.add(tool.id); ctx._hotToolBodies.add(tool.id);
    assert.equal(tools.render(tool).readSnapshot, true);
    const html = renderer._toolHtml(tool);
    assert.match(html, /data-tool-side="1"/);
    assert.match(html, /报告.html/);
    assert.doesNotMatch(html, /ntool-body|class="[^"]* open/);
  }
});

test('legacy local and controlled cloud read clicks share the readonly snapshot action', () => {
  const { sandbox, tools } = harness();
  sandbox.document = {};
  const requests = [];
  sandbox.ChatWorkbench = { openPath(path, hint) { requests.push({ path, hint }); return true; } };
  const events = [{ kind: 'do', seq: 1, tool: 'read', text: '云端运行验证.html' },
    { kind: 'out', seq: 2, tool: 'read', text: 'Read snapshot contents' }];
  const html = sandbox.TaskExecutionStream.rowsHtml(events, 'done');
  assert.match(html, /data-dks-read="tool-1"/);
  assert.doesNotMatch(html, /ntool-body|Read snapshot contents|data-dks-tool/);
  for (const controlled of [false, true]) {
    const run = { ref: 'run-a', items: events, status: 'done' };
    const entry = controlled ? { taskId: 'task', trace: { execution: { sessions: [run] } } } :
      { taskId: 'task', controller: { snapshot: () => ({ events, status: 'done' }) } };
    const stream = { dataset: { taskStream: 'task', taskRun: controlled ? 'run-a' : '', chatNode: 'task:run-a' } };
    const button = { closest: () => stream, getAttribute: () => 'tool-1' };
    assert.equal(sandbox.TaskExecutionStream.openRead(button, [entry]), true);
    assert.equal(requests.at(-1).hint.readSnapshot.text, 'Read snapshot contents');
    assert.equal(requests.at(-1).path, '云端运行验证.html');
  }
  assert.equal(tools.render({ name: 'mcp__read__query', args: { path: 'db' } }).readSnapshot, undefined);
});

test('command aliases retain status without details or reading output', () => {
  const { tools, renderer, ctx } = harness();
  const variants = [
    ['bash', { command: 'npm run build' }], ['shell', { command: 'npm test' }],
    ['exec_command', { cmd: 'npm test' }], ['run_shell_command', { command: 'npm test' }],
    ['command_execution', { command: 'npm test' }], ['write_stdin', { chars: 'continue' }],
    ['查看 README', { command: 'cat README.md' }, 'execute'],
  ];
  for (const [name, args, toolKind] of variants) for (const state of ['running', 'done', 'error']) {
    const tool = unreadableOutput({ id: name, name, args, toolKind, state });
    ctx._openTool.add(tool.id); ctx._hotToolBodies.add(tool.id);
    const view = tools.render(tool);
    assert.equal(view.commandOnly, true, name);
    // Compact status summaries do not expand or read tool result bodies.
    assert.equal(view.sub, '');
    assert.equal(view.tip, '');
    assert.equal(view.body, '');
    ctx._openTool.delete(tool.id);
    const folded = renderer._toolHtml(tool);
    assert.doesNotMatch(folded, /npm (?:run build|test)|cat README\.md/);
    assert.doesNotMatch(folded, /title="[^"]| class="[^"]* open/);
    assert.doesNotMatch(folded, /ntool-body|ntool-caret|<button/);
    ctx._openTool.add(tool.id);
    const html = renderer._toolHtml(tool);
    assert.equal(html, folded, 'a remembered expansion cannot restore command details');
    assert.match(html, state === 'error' ? /命令执行异常/ : state === 'running' ? /正在运行命令/ : /运行了命令/);
  }
});

test('large command results and bridge details never enter transcript markup', () => {
  const { renderer } = harness();
  const huge = 'PRIVATE_OUTPUT_NEVER_SHOWN\n'.repeat(100000);
  for (const state of ['done', 'running']) {
    const html = renderer._toolHtml({ id: 'large', name: 'bash', state,
      args: { command: 'npm test' }, partial: huge, result: huge });
    assert.ok(html.length < 1000);
    assert.doesNotMatch(html, /PRIVATE_OUTPUT_NEVER_SHOWN|title="[^"]/);
  }
  const bridge = unreadableOutput({ id: 'bridge', name: 'bash', state: 'done', args: {
    command: 'node "C:/private/mcp.mjs" --config "C:/private/secret.json" call soduwork task_list',
  } });
  const html = renderer._toolHtml(bridge);
  assert.match(html, /SoduWork|查看我的任务/);
  assert.doesNotMatch(html, /mcp\.mjs|secret\.json|C:\/private|ntool-body|title=/);
});

test('consecutive command groups retain a status line without a remembered expansion', () => {
  const { tools } = harness();
  const commands = [1, 2].map(after => unreadableOutput({ id: 'cmd-' + after,
    name: 'bash', state: after === 2 ? 'running' : 'done', args: { command: 'npm test' }, after }));
  const messages = [{ role: 'user', text: 'Check' }, ...[1, 2].map(() => ({
    role: 'assistant', blocks: [{ kind: 'toolcall' }],
  }))];
  const grouped = tools.groupConsecutiveCommands(commands, messages);
  assert.deepEqual(Array.from(grouped, tool => tool.after), [1, 1]);
  assert.equal(commands[1].after, 2);
  const html = tools.batchHtml(grouped, 'commands', true, () => { throw Error('Unexpected child row'); });
  assert.match(html, /正在运行命令/); assert.match(html, />2 项</);
  assert.doesNotMatch(html, /npm test|data-tool-group|aria-expanded|ntool-batch-caret|ntool-batch-body| open/);
  commands[1].state = 'error';
  assert.match(tools.batchHtml(commands, 'commands', false), /命令执行有异常/);
  const boundary = { id: 'read', name: 'read', args: { path: 'report.md' }, state: 'done', after: 2 };
  assert.deepEqual(Array.from(tools.groupConsecutiveCommands([commands[0], boundary, commands[1]], messages),
    tool => tool.after), [1, 2, 2], 'file operations break consecutive command groups');
});

test('file operation aliases keep their basename, tooltip and original detail action', () => {
  const { tools, renderer, ctx } = harness();
  const target = 'C:/资料/报告.html';
  const cases = [
    ['read', 'path', '读取', true], ['read_file', 'file_path', '读取', true], ['open_file', 'filePath', '读取', true],
    ['write', 'path', '写入', true], ['write_file', 'file_path', '写入', true], ['create_file', 'filename', '写入', true],
    ['edit', 'path', '修改', true], ['Edit', 'file_path', '修改', true], ['replace', 'filePath', '修改', true],
    ['delete_file', 'path', '删除'], ['remove_file', 'file_path', '删除'], ['unlink', 'file', '删除'],
  ];
  for (const [name, field, title, side] of cases) {
    const tool = { id: name, name, state: 'done', args: { [field]: target, content: '<h1>Report</h1>' }, result: 'Operation evidence' };
    ctx._openTool.add(name);
    const view = tools.render(tool), html = renderer._toolHtml(tool);
    assert.equal(view.title, title, name); assert.equal(view.sub, '报告.html');
    assert.equal(view.file, true); assert.equal(Boolean(view.side), Boolean(side));
    assert.match(html, /class="ntool-args ntool-file"/);
    assert.match(html, /data-tool="/); assert.match(html, /title="C:\/资料\/报告.html"/);
    if (title === '读取') assert.doesNotMatch(html, /ntool-body|class="[^"]* open/);
    else assert.match(html, /ntool-body rich/);
    assert.equal(html.includes('data-tool-side="1"'), Boolean(side));
  }
  const html = tools.batchHtml([
    { id: 'read', name: 'read', state: 'done', args: { path: target }, result: 'Read evidence' },
    unreadableOutput({ id: 'cmd', name: 'bash', state: 'done', args: { command: 'npm test' } }),
  ], 'mixed', true, tool => renderer._toolHtml(tool));
  assert.match(html, /data-tool-group="mixed"/);
  assert.match(html, /ntool-file/); assert.match(html, /运行了命令/);
  assert.doesNotMatch(html, /npm test/);
});

test('real cloud filename events and legacy command-only inputs render as file actions', () => {
  const { sandbox, tools } = harness(), filename = '云端运行验证.html';
  for (const [tool, title] of [['write', '写入'], ['read', '读取'], ['edit', '修改'], ['delete_file', '删除']]) {
    for (const input of [{ text: filename }, { arguments: { command: filename } }, { args: { command: filename } }]) {
      const events = [{ seq: 1, kind: 'do', tool, ...input }, { seq: 2, kind: 'out', tool, text: 'completed' }];
      const row = sandbox.TaskExecutionStream.rows(events, 'done').find(row => row.type === 'tool');
      assert.equal(row.model.args.path, filename);
      const view = tools.render(row.model);
      assert.equal(view.title, title); assert.equal(view.file, true); assert.equal(view.sub, filename);
      assert.match(sandbox.TaskExecutionStream.rowsHtml(events, 'done'), /ntool-file/);
    }
  }
  const normalize = sandbox.ExecutionToolArgs.normalize;
  for (const name of ['bash', 'mcp__read', 'read_database']) {
    const args = { command: filename };
    assert.equal(normalize({ name, args }), args, name + ' must not be guessed to be a file operation');
  }
  const structured = { path: 'actual.md', command: filename, content: 'precise content' };
  assert.equal(normalize({ tool: 'write', arguments: structured, text: filename }), structured);
  assert.deepEqual(normalize({ tool: '读取文件', toolKind: 'read', text: filename }), { path: filename });
  assert.deepEqual(normalize({ tool: 'read', toolKind: 'execute', text: 'cat ' + filename }), { command: 'cat ' + filename });
});

test('MCP server names cannot turn file tools into commands or record operations into file actions', () => {
  const { tools, renderer } = harness();
  for (const name of ['mcp__database__delete_record', 'mcp__terminal__query', 'mcp__delete__read_database']) {
    const tool = { id: name, name, args: { path: 'users/42' }, state: 'done', result: 'record evidence' };
    const view = tools.render(tool), html = renderer._toolHtml(tool);
    assert.equal(tools.kind(tool), 'tool'); assert.equal(view.title, '调用');
    assert.equal(Boolean(view.file), false); assert.equal(Boolean(view.summaryOnly), false);
    assert.match(html, /data-tool="/); assert.doesNotMatch(html, /ntool-file|ntool-summary/);
  }
  for (const [operation, title, side] of [['read_file', '读取', true], ['write_file', '写入', true],
    ['edit_file', '修改', true], ['delete_file', '删除', false]]) {
    const name = 'mcp__terminal_delete__' + operation;
    const tool = { id: name, name, args: { path: 'notes.md' }, state: 'done', result: 'file evidence' };
    const view = tools.render(tool), html = renderer._toolHtml(tool);
    assert.equal(view.title, title); assert.equal(view.file, true); assert.equal(Boolean(view.side), side);
    assert.match(html, /data-tool="/); assert.match(html, /ntool-file/); assert.doesNotMatch(html, /ntool-summary/);
  }
  const command = unreadableOutput({ id: 'mcp-shell', name: 'mcp__files__exec_command',
    args: { command: 'npm test' }, state: 'done' });
  assert.equal(tools.render(command).commandOnly, true);
  assert.match(renderer._toolHtml(command), /运行了命令/);
  assert.doesNotMatch(renderer._toolHtml(command), /<button|ntool-body|npm test/);
  assert.doesNotMatch(renderer._toolHtml(command), /title="[^"]/);
  assert.equal(tools.kind({ name: 'mcp__terminal__read_file', toolKind: 'execute' }), 'command');
  assert.equal(tools.kind({ name: 'mcp__terminal__query', toolKind: 'read' }), 'read');
});

test('semantic file kinds win over localized titles in chat and task execution streams', () => {
  const { tools, renderer, sandbox } = harness();
  for (const [toolKind, name, expected] of [
    ['read', '查看资料', '读取'], ['write', '生成报告', '写入'],
    ['edit', 'Readme update', '修改'], ['delete', 'Remove stale report', '删除'],
  ]) {
    const tool = { id: toolKind, name, toolKind, state: 'done', args: { path: '/work/报告.html' }, result: 'Evidence' };
    assert.equal(tools.render(tool).title, expected);
    assert.match(renderer._toolHtml(tool), /ntool-file/);
    const events = [{ seq: 1, kind: 'do', tool: name, toolKind, text: 'Localized action', arguments: tool.args },
      { seq: 2, kind: 'out', tool: name, text: 'Evidence' }];
    const html = sandbox.TaskExecutionStream.rowsHtml(events, 'done');
    assert.match(html, new RegExp('>' + expected + '<'));
    assert.match(html, /ntool-file[^"]*">报告.html</);
    assert.match(html, ['read', 'write', 'edit'].includes(toolKind) ? /data-dks-read/ : /data-dks-tool/);
  }
});

test('task command rows omit fallback details and preserve file evidence', () => {
  const { sandbox } = harness();
  const model = unreadableOutput({ id: 'task-command', name: 'bash', args: { command: 'npm test' }, state: 'running' });
  const row = { key: 'task-command', model,
    get item() { throw Error('Summary must not read fallback event details'); },
    get result() { throw Error('Summary must not read fallback result'); } };
  const html = sandbox._executionStreamToolHtml(row);
  assert.match(html, /正在运行命令/);
  assert.doesNotMatch(html, /<button|ntool-caret|ntool-body|npm test|data-dks-tool/);
  const events = [{ seq: 1, kind: 'do', tool: 'command_execution', text: 'npm test' },
    { seq: 2, kind: 'out', tool: 'command_execution', text: 'LARGE_PRIVATE_OUTPUT'.repeat(50000) }];
  const output = sandbox.TaskExecutionStream.rowsHtml(events, 'done');
  assert.doesNotMatch(output, /LARGE_PRIVATE_OUTPUT|title="[^"]/);
  assert.match(output, /运行了命令/);
  assert.doesNotMatch(output, /data-dks-tool|ntool-caret|npm test/);
  assert.equal(sandbox.TaskExecutionStream.rows(events, 'done').find(row => row.type === 'tool').model.state, 'done');
});

test('command summary and mixed file batches replace each other without stale command details', () => {
  const { tools, renderer } = harness();
  // Only the element operations used by the keyed list reconciler are needed.
  class Element {
    constructor(className, dataset = {}, children = []) {
      this.className = className; this.dataset = dataset; this.children = children;
      this.classList = { contains: name => this.className.split(' ').includes(name) };
      children.forEach(child => { child.parent = this; });
      this.attributes = new Map(); this.innerHTML = '';
    }
    querySelector(selector) {
      for (const child of this.children) {
        if (child.classList.contains(selector.slice(1))) return child;
        const nested = child.querySelector(selector); if (nested) return nested;
      }
      return null;
    }
    getAttribute(name) { return this.attributes.get(name) || null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    insertBefore(child, before) {
      child.remove(); child.parent = this;
      const at = this.children.indexOf(before); this.children.splice(at < 0 ? this.children.length : at, 0, child);
    }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  }
  function parse(html) {
    const batch = /<div class="(ntool-batch [^"]*)" data-tool-node="([^"]+)"/.exec(html);
    const head = new Element('ntool-batch-head');
    head.nodeName = /<button class="ntool-batch-head"/.test(html) ? 'BUTTON' : 'DIV';
    const children = [head];
    if (html.includes('class="ntool-batch-body"')) {
      const body = new Element('ntool-batch-body'); body.innerHTML = html; children.push(body);
    }
    return new Element('', {}, [new Element('nmsg ai', { chatNode: 'tools:turn' }, [
      new Element(batch[1], { toolNode: batch[2] }, children),
    ])]);
  }
  const sandbox = { window: null, document: { createElement() {
    return { set innerHTML(html) { this.content = parse(html); } };
  } } };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-dom-patch.js'), 'utf8'), sandbox);
  const host = new Element('host'), command = { id: 'cmd', name: 'bash', args: { command: 'npm test' }, state: 'error' };
  const file = { id: 'file', name: 'read', args: { path: 'report.md' }, result: 'File evidence', state: 'done' };
  const paint = items => sandbox.ChatDomPatch.patchList(host,
    tools.batchHtml(items, 'same-group', true, tool => renderer._toolHtml(tool)));
  paint([command, { ...command, id: 'cmd-2' }]);
  assert.equal(host.querySelector('.ntool-batch-head').nodeName, 'DIV');
  assert.equal(host.querySelector('.ntool-batch-body'), null);
  paint([command, file]);
  assert.equal(host.querySelector('.ntool-batch-head').nodeName, 'BUTTON');
  assert.match(host.querySelector('.ntool-batch-body').innerHTML, /ntool-file/);
  paint([command, { ...command, id: 'cmd-2' }]);
  assert.equal(host.querySelector('.ntool-batch-head').nodeName, 'DIV');
  assert.equal(host.querySelector('.ntool-batch-body'), null);
  paint([{ ...command, state: 'done' }]);
  assert.equal(host.querySelector('.ntool-batch-head').nodeName, 'DIV');
  assert.equal(host.querySelector('.ntool-batch-body'), null, 'settled commands leave no stale detail fold');
});

test('cloud stream shows a bounded preparation row and replaces it with a real file action', () => {
  const { sandbox } = harness();
  const preparing = { seq: 1, kind: 'tool-preparing', callId: 'a', tool: 'write', phase: 'preparing', arguments: { path: 'cloud.html' } };
  const rows = sandbox._executionStreamRows([preparing], 'running');
  const row = rows.find(row => row.type === 'tool');
  assert.equal(row.model.phase, 'preparing');
  assert.match(sandbox._executionStreamToolHtml(row), /正在生成文件/);
  assert.doesNotMatch(sandbox._executionStreamToolHtml(row), /<button|ntool-body/);
  const next = sandbox._executionStreamRows([preparing, { ...preparing, seq: 2, kind: 'do' }], 'running').filter(row => row.type === 'tool');
  assert.equal(next.length, 1); assert.equal(next[0].key, row.key);
  assert.equal(next[0].model.phase, undefined);
  assert.equal(sandbox._executionStreamRows([preparing], 'stopped').filter(row => row.type === 'tool').length, 0);
  assert.equal(sandbox._executionStreamRows([preparing, { ...preparing, seq: 2, phase: 'cancelled' }], 'running').filter(row => row.type === 'tool').length, 0);
});

test('cloud preparation from a killed round never reappears in the next live turn', () => {
  const { sandbox } = harness();
  const start = { seq: 1, round: 1, seg: 1, kind: 'tool-preparing', callId: 'a', tool: 'write', arguments: { path: 'old.html' } };
  for (const boundary of [{ seq: 2, kind: 'user', text: 'next' }, { seq: 2, round: 2, kind: 'say', text: 'next' }, { seq: 2, seg: 2, kind: 'say', text: 'next' }]) {
    const rows = sandbox._executionStreamRows([start, boundary], 'running');
    assert.equal(rows.filter(row => row.type === 'tool').length, 0);
  }
});
