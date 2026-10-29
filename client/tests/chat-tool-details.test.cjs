'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '../components/panels/' + name + '.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const count = { highlight: 0, diff: 0, requests: 0 };
  const sandbox = { console, ChatDomPatch: { ...require('../components/panels/chat-dom-patch'), patchHtml: (node, html) => { node.innerHTML = html; } },
    ExecutionToolArgs: require('../components/shared/execution-tool-args'),
    hljs: { getLanguage: () => true, highlight(text) { count.highlight++; return { value: text }; } },
    Diff: { createTwoFilesPatch(a, b, before, after) { count.diff++; return before + after; } },
    Diff2Html: { html: patch => patch } };
  sandbox.window = sandbox;
  for (const name of ['panels-chat-tools', 'chat-tool-details', 'chat-context-meter', 'chat-scroll-follow',
    'chat-markdown', 'chat-acceptance-results', 'chat-message-renderer', 'task-execution-stream']) vm.runInNewContext(source(name), sandbox);
  sandbox.esc = sandbox.ChatTools.esc;
  const ctx = { _ref: 'test', _viewEpoch: 1, _openTool: new Set(), _hotToolBodies: new Set(),
    _mount: () => null, _snap: { tools: [] }, esc: sandbox.esc };
  const full = new Map();
  ctx._api = () => ({ toolDetail: async (ref, id) => { count.requests++; return { ok: true, tool: full.get(id) }; } });
  return { sandbox, ctx, count, full, tools: sandbox.ChatTools,
    details: sandbox.ChatToolDetails, renderer: sandbox.ChatMessageRenderer.create(ctx) };
}
function generic(id = 'generic', version = 'v1') {
  return { id, name: 'inspect_data', args: {}, state: 'done', detailsDeferred: true, detailVersion: version };
}
test('closed and title-only file cards never highlight or diff, including hot and running tools', () => {
  const { tools, renderer, ctx, count } = harness();
  for (const name of ['write', 'edit']) for (const state of ['running', 'done', 'error']) {
    const tool = { id: name, name, state, args: { path: 'a.js', content: 'const a=1;'.repeat(20000),
      oldText: 'old\n'.repeat(1000), newText: 'new\n'.repeat(1000) } };
    Object.defineProperty(tool, 'result', { get() { throw Error('summary must not access result'); } });
    Object.defineProperty(tool, 'partial', { get() { throw Error('summary must not access partial'); } });
    ctx._hotToolBodies.add(tool.id);
    assert.ok(tools.render(tool).title);
    assert.match(renderer._toolHtml(tool), /ntool-file/);
    assert.deepEqual([count.highlight, count.diff], [0, 0]);
    // Side-panel file cards never inline code, even with legacy remembered expansion.
    ctx._openTool.add(tool.id);
    assert.doesNotMatch(renderer._toolHtml(tool), /const a=1;|old\n|new\n/);
  }
  const write = tools.render({ name: 'write', args: { path: 'a.js', content: 'const a=1;' } });
  assert.equal(count.highlight, 0); assert.match(write.body, /const a=1/); assert.equal(count.highlight, 1);
  const edit = tools.render({ name: 'edit', args: { path: 'a.js', oldText: 'old', newText: 'new' } });
  assert.equal(count.diff, 0); assert.match(edit.body, /oldnew/); assert.equal(count.diff, 1);
});
test('generic summaries do not serialize large args or process results until expanded', () => {
  const { tools, renderer } = harness();
  const tool = { id: 'generic', name: 'inspect', args: { toJSON() { throw Error('unexpected JSON'); } }, state: 'error' };
  Object.defineProperty(tool, 'result', { get() { throw Error('unexpected result'); } });
  assert.equal(tools.render(tool).title, '调用'); assert.match(renderer._toolHtml(tool), /inspect/);
});
test('projected multi-edit summaries retain the original edit count', () => {
  const { tools, count } = harness();
  const tool = { id: 'batch', name: 'edit', args: { path: 'a.js', edits: [{ oldText: 'before', newText: 'after' }] },
    detailsDeferred: true, detailSummary: { editCount: 250 } };
  assert.equal(tools.render(tool).sub, 'a.js（250 处）'); assert.equal(count.diff, 0);
});
test('on-demand receipts deduplicate inflight reads and cache the current version without mutating snapshots', async () => {
  const { ctx, count, full, details, tools } = harness(), tool = generic();
  full.set(tool.id, { ...tool, result: 'complete receipt' }); ctx._snap.tools = [tool];
  const before = JSON.stringify(ctx._snap);
  details.activate(ctx, tool.id);
  assert.match(details.bodyHtml(ctx, tool, tools.render(tool)), /正在读取详情/);
  details.bodyHtml(ctx, tool, tools.render(tool)); await tick();
  assert.equal(count.requests, 1);
  assert.match(details.bodyHtml(ctx, tool, tools.render(tool)), /complete receipt/);
  assert.equal(JSON.stringify(ctx._snap), before);
  details.activate(ctx, tool.id); details.activate(ctx, tool.id); await tick();
  assert.equal(count.requests, 1);
  const done = { ...tool, state: 'done', detailVersion: 'v2' };
  full.set(tool.id, { ...done, result: 'final receipt' }); ctx._snap.tools = [done];
  details.bodyHtml(ctx, done, tools.render(done)); await tick();
  assert.equal(count.requests, 2); assert.match(details.bodyHtml(ctx, done, tools.render(done)), /final receipt/);
});
test('failed reads expose explicit retry without repeatedly fetching on stream refresh', async () => {
  const { ctx, details, tools } = harness(), tool = generic(); let calls = 0;
  ctx._snap.tools = [tool]; ctx._api = () => ({ toolDetail: async () => (++calls === 1 ? { ok: false } : { ok: true, tool: { ...tool, result: 'recovered' } }) });
  details.activate(ctx, tool.id); await tick();
  for (let i = 0; i < 5; i++) assert.match(details.bodyHtml(ctx, tool, tools.render(tool)), /data-tool-detail-retry/);
  assert.equal(calls, 1);
  details.activate(ctx, tool.id, true); await tick();
  assert.equal(calls, 2); assert.match(details.bodyHtml(ctx, tool, tools.render(tool)), /recovered/);
});
test('late responses cannot enter a switched or reset session cache', async () => {
  const { ctx, details, tools } = harness(), tool = generic(); let finish, calls = 0;
  ctx._snap.tools = [tool];
  ctx._api = () => ({ toolDetail: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  details.activate(ctx, tool.id); await tick();
  ctx._viewEpoch++; ctx._ref = 'other'; details.reset(ctx);
  finish({ ok: true, tool: { ...tool, result: 'PRIVATE OLD SESSION' } }); await tick();
  assert.match(details.bodyHtml(ctx, tool, tools.render(tool)), /正在读取详情/); await tick();
  assert.equal(calls, 2);
  finish({ ok: true, tool: { ...tool, result: 'new session' } }); await tick();
  assert.doesNotMatch(details.bodyHtml(ctx, tool, tools.render(tool)), /PRIVATE/);
});
test('receipt cache has an entry bound and a byte bound', async () => {
  const { ctx, count, full, details, tools } = harness();
  const items = Array.from({ length: 18 }, (_, i) => generic('item-' + i)); ctx._snap.tools = items;
  for (const tool of items) { full.set(tool.id, { ...tool, result: tool.id }); details.bodyHtml(ctx, tool, tools.render(tool)); await tick(); }
  assert.equal(count.requests, 18);
  details.bodyHtml(ctx, items[0], tools.render(items[0])); await tick(); assert.equal(count.requests, 19);
  // The large unused field counts against capacity even when visible output is short.
  const big = generic('big'); ctx._snap.tools.push(big);
  full.set(big.id, { ...big, args: { toJSON: undefined }, auxiliary: 'x'.repeat(9 * 1024 * 1024), result: 'short' });
  details.bodyHtml(ctx, big, tools.render(big)); await tick();
  assert.match(details.bodyHtml(ctx, big, tools.render(big)), /short/);
  assert.equal(count.requests, 20, 'the bounded rendered body is reusable after the oversized receipt is discarded');
});
test('command summaries ignore old detail clicks without queueing a receipt read', async () => {
  const { ctx, count, full, details, tools } = harness();
  const tool = { id: 'cmd', name: 'bash', state: 'done', detailsDeferred: true, detailVersion: 'v1',
    args: { command: 'netstat -ano | findstr ":9080"' } };
  Object.defineProperty(tool, 'result', { get() { throw Error('命令行的展开不得回读收据'); } });
  Object.defineProperty(tool, 'partial', { get() { throw Error('命令行的展开不得回读流式输出'); } });
  full.set(tool.id, { ...tool, result: 'LARGE_PRIVATE_OUTPUT'.repeat(1000) });
  ctx._snap.tools = [tool];
  assert.equal(tools.render(tool).commandOnly, true);
  assert.equal(tools.render(tool).summaryOnly, true);
  assert.equal(tools.render(tool).body, '');
  details.activate(ctx, tool.id);
  assert.equal(details.bodyHtml(ctx, tool, tools.render(tool)), '');
  await tick();
  assert.equal(count.requests, 0, '状态摘要不排队任何收据读取');
  assert.equal(ctx._openTool.has(tool.id), false);
});

test('stale task command clicks cannot hydrate raw output into the conversation', () => {
  const { sandbox } = harness();
  const events = [{ seq: 1, kind: 'do', tool: 'bash', text: 'netstat -ano' },
    { seq: 2, kind: 'out', tool: 'bash', text: 'PRIVATE_COMMAND_OUTPUT' }];
  const body = { innerHTML: '' }, stream = { dataset: { taskStream: 'task' } };
  const button = { closest: selector => selector === '.ntool' ? { querySelector: () => body } : stream,
    getAttribute: () => 'tool-1' };
  sandbox.TaskExecutionStream.hydrateTool(button, [{ taskId: 'task', controller: {
    snapshot: () => ({ events, status: 'done' }) } }]);
  assert.equal(body.innerHTML, '');
});
test('legacy task write/edit cards route to the workbench and generic errors hydrate on demand', () => {
  const { sandbox, count } = harness(); sandbox.document = {}; const opened = [];
  sandbox.ChatWorkbench = { openPath: (path, hint) => { opened.push({ path, hint }); return true; } };
  for (const name of ['write', 'edit']) {
    const events = [{ seq: 1, kind: 'do', tool: name, arguments: { path: 'cloud.js', content: 'const value=1;', oldText: 'before', newText: 'after' } },
      { seq: 2, kind: 'out', tool: name, text: 'done' }];
    const html = sandbox.TaskExecutionStream.rowsHtml(events, 'done');
    assert.match(html, /data-dks-read/); assert.doesNotMatch(html, /ntool-body/);
    const stream = { dataset: { taskStream: 'task' } }, button = { closest: () => stream, getAttribute: () => 'tool-1' };
    assert.equal(sandbox.TaskExecutionStream.openRead(button, [{ taskId: 'task', controller: { snapshot: () => ({ events, status: 'done' }) } }]), true);
    assert.equal(opened.at(-1).path, 'cloud.js');
  }
  assert.deepEqual([count.highlight, count.diff], [0, 0]);
  const events = [{ seq: 1, kind: 'do', tool: 'inspect', arguments: { query: 'q' } }, { seq: 2, kind: 'out', tool: 'inspect', text: 'specific failure detail' }];
  assert.doesNotMatch(sandbox.TaskExecutionStream.rowsHtml(events, 'done'), /specific failure detail/);
  const body = { innerHTML: '' }, stream = { dataset: { taskStream: 'task' } };
  const button = { closest: selector => selector === '.ntool' ? { querySelector: () => body } : stream, getAttribute: () => 'tool-1' };
  sandbox.TaskExecutionStream.hydrateTool(button, [{ taskId: 'task', controller: { snapshot: () => ({ events, status: 'done' }) } }]);
  assert.match(body.innerHTML, /specific failure detail/);
});
