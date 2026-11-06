'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stream = require('../main/pi-session/event-stream');
const { create } = require('../main/pi-session/controlled-task-turn');
const live = require('../main/conversation/task-live-output');

function target() {
  const acc = stream.create();
  return { acc, handle: {
    appendTaskMessage(role, text, files, taskId, taskOutputKey) {
      if (role === 'assistant') Object.assign(acc.appendAssistant(text), { taskId, taskOutputKey });
      else acc.push({ type: 'message_end', message: { role, taskId, content: [{ type: 'text', text }] } });
    },
    appendTaskTool(event) { acc.push(event); }, taskExecutionChanged() {},
  } };
}

test('live task output is ordinary messages and collapsed tool events before completion', () => {
  const { acc, handle } = target(), output = live.create(handle, 't');
  output.consume('a', [{ seq: 2, kind: 'do', tool: 'bash', callId: 'one', text: 'test' },
    { seq: 1, kind: 'say', text: 'progress' }]);
  assert.equal(acc.snapshot().messages[0].blocks[0].text, 'progress');
  assert.equal(acc.snapshot().tools[0].state, 'running');
  output.consume('a', [{ seq: 1, kind: 'say', text: 'progress' },
    { seq: 3, kind: 'out', tool: 'bash', callId: 'one', full: 'test passed' },
    { seq: 4, kind: 'say', text: 'preview', full: 'actual result '.repeat(600) }]);
  const snapshot = acc.snapshot();
  assert.equal(snapshot.messages.length, 2);
  assert.ok(snapshot.messages[1].blocks[0].text.length > 4000);
  assert.equal(snapshot.tools.length, 1); assert.equal(snapshot.tools[0].result, 'test passed');
  assert.equal(snapshot.tools[0].state, 'done');
  output.consume('b', [{ seq: 1, kind: 'say', text: 'second node' }]);
  assert.equal(acc.snapshot().messages.length, 3);
});

test('live non-Pi user turns preserve attachment display metadata', () => {
  const calls = [];
  const output = live.create({ appendTaskMessage: (...args) => calls.push(args) }, 'cloud-task', { includeUser: true });
  output.consume('remote', [{ seq: 1, kind: 'user', text: '请查看附件', attachments: [
    { name: 'screen.png', type: 'image/png', size: 2048, previewRef: 'att1.preview' },
    { name: 'notes.md', type: 'text/markdown', size: 128 },
  ] }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][2], [
    { name: 'screen.png', type: 'image/png', size: 2048, previewRef: 'att1.preview' },
    { name: 'notes.md', type: 'text/markdown', size: 128 },
  ]);
});

test('concurrent same-name tools are matched by call ID and failures stay failures', () => {
  const { acc, handle } = target(), output = live.create(handle, 't');
  output.consume('r', [
    { seq: 1, kind: 'do', tool: 'bash', callId: 'a' },
    { seq: 2, kind: 'do', tool: 'bash', callId: 'b' },
    { seq: 3, kind: 'out', tool: 'bash', callId: 'b', text: 'error', isError: true },
    { seq: 4, kind: 'out', tool: 'bash', callId: 'a', text: 'ok' },
  ]);
  assert.deepEqual(acc.snapshot().tools.map(t => t.state), ['done', 'error']);
});

test('legacy tool start without call ID is closed by the identified result', () => {
  const { acc, handle } = target(), output = live.create(handle, 't');
  output.consume('r', [{seq:1,kind:'do',tool:'bash'},
    {seq:2,kind:'out',tool:'bash',callId:'call-new',text:'ok'}]);
  assert.equal(acc.snapshot().tools.length,1);
  assert.equal(acc.snapshot().tools[0].state,'done');
});

test('structured cloud service metadata survives the task event projection', () => {
  const { acc, handle } = target(), output = live.create(handle, 't');
  output.consume('r', [{ seq: 1, kind: 'do', tool: 'bash', text: 'node server.js',
    host: '192.0.2.20', port: 4173, serviceUrl: 'http://192.0.2.20:4173/' },
  { seq: 2, kind: 'out', tool: 'bash', callId: 'call-1', text: 'ready',
    host: '192.0.2.20', port: 4173, serviceUrl: 'http://192.0.2.20:4173/' }]);
  const tool = acc.snapshot().tools[0];
  assert.equal(tool.serviceUrl, 'http://192.0.2.20:4173/');
  assert.equal(tool.host, '192.0.2.20');
  assert.equal(tool.port, 4173);
});

test('cloud file do events preserve file paths, structured arguments and semantic kinds', () => {
  const { acc, handle } = target(), output = live.create(handle, 'cloud-task');
  const filename = '云端运行验证.html';
  const events = ['write', 'read', 'edit'].flatMap((tool, i) => [
    { seq: i * 2 + 1, kind: 'do', tool, callId: 'call-' + tool, text: filename },
    { seq: i * 2 + 2, kind: 'out', tool, callId: 'call-' + tool, text: 'completed' },
  ]);
  events.push({ seq: 7, kind: 'do', tool: '查看资料', toolKind: 'read', text: filename,
    arguments: { file_path: 'actual.md', offset: 12 } },
  { seq: 8, kind: 'do', tool: 'bash', text: 'grep subtitle ' + filename },
  { seq: 9, kind: 'do', tool: 'mcp__database__read', text: filename });
  output.consume('execution', events);
  const tools = acc.snapshot().tools;
  for (const tool of tools.slice(0, 3)) { assert.deepEqual(tool.args, { path: filename }); assert.equal(tool.state, 'done'); }
  assert.deepEqual(tools[3].args, { file_path: 'actual.md', offset: 12 }); assert.equal(tools[3].toolKind, 'read');
  assert.deepEqual(tools[4].args, { command: 'grep subtitle ' + filename });
  assert.deepEqual(tools[5].args, { detail: filename });
});

test('existing cloud tool journals repair only unambiguous command-only file inputs on replay', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-cloud-tool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, filename = '云端运行验证.html';
  const journal = await require('../main/conversation/task-output-journal').create(app, 'cloud:legacy-file-inputs');
  for (const [i, toolName] of ['write', 'read', 'edit', 'bash', 'mcp__read'].entries()) {
    journal.append(0, { kind: 'tool', event: { type: 'tool_execution_start', toolCallId: String(i),
      toolName, args: { command: filename } } });
    journal.append(0, { kind: 'tool', event: { type: 'tool_execution_end', toolCallId: String(i),
      toolName, result: { content: [{ type: 'text', text: 'complete' }] } } });
  }
  const view = await require('../main/conversation/cloud-conversation-view').create({ app, ref: 'view',
    record: { transferId: 'legacy-file-inputs', sessionId: 'session', taskId: 'task' },
    saved: { cwd: root, adapterId: 'pi', snapshot: { messages: [] } } });
  const tools = view.snapshot().tools;
  assert.equal(tools.length, 5);
  for (const tool of tools.slice(0, 3)) assert.deepEqual(tool.args, { path: filename });
  for (const tool of tools.slice(3)) assert.deepEqual(tool.args, { command: filename });
  view.close();
});

test('Pi restart replays actual tool evidence and task answers through ordinary history', () => {
  const acc=stream.create(), session=require('../main/pi-session/session');
  const messages=[
    {role:'user',taskId:'t',content:[{type:'text',text:'task materials'}]},
    {role:'assistant',taskId:'t',content:[{type:'toolCall',id:'task:t:call',name:'bash',arguments:{command:'verify'}}]},
    {role:'toolResult',taskId:'t',toolCallId:'task:t:call',toolName:'bash',content:[{type:'text',text:'actual-evidence-456'}]},
    {role:'assistant',taskId:'t',taskOutputKey:'task:t:r:3',content:[{type:'text',text:'Actual answer actual-evidence-456'}]},
  ];
  session._seed(acc,{state:{messages},sessionManager:{getEntries:()=>messages.map(message=>({type:'message',message}))}});
  const snapshot=acc.snapshot();
  assert.equal(snapshot.tools.length,1);
  assert.equal(snapshot.tools[0].result,'actual-evidence-456');
  assert.equal(snapshot.tools[0].state,'done');
  assert.equal(snapshot.messages.at(-1).taskOutputKey,'task:t:r:3');
  assert.equal(snapshot.messages.at(-1).taskId,'t');
});

test('terminal result drains incremental pages before releasing the next turn', async () => {
  const { acc, handle } = target(), requested = [];
  const adapter = create({ task: { id: 't' }, spec: { mode: 'dispatch', context: {} }, scope: {}, wait: async () => {},
    request: async (url, body) => {
      if (body) return { ref: 'r' };
      requested.push(url);
      const since = Number(new URL(url, 'http://local').searchParams.get('since'));
      return { ref: 'r', status: 'done', seq: 2, last: since + 1,
        items: [{ seq: since + 1, kind: 'say', text: since ? 'final answer' : 'progress' }] };
    } });
  await adapter.execute(handle, 'task material', []);
  assert.equal(requested.length, 2); assert.match(requested[1], /since=1/);
  assert.deepEqual(acc.snapshot().messages.slice(1).map(m => m.blocks[0].text), ['progress', 'final answer']);
});

test('workflow forwards each node attempt, holds on approval and retries transient reads', async () => {
  const { acc, handle } = target(); let polls = 0, nodeReads = 0;
  const adapter = create({ task: { id: 't' }, spec: { mode: 'workflow', context: {} }, scope: {}, wait: async () => {},
    request: async (url, body) => {
      if (body) return { id: 'w' };
      if (url.startsWith('/plugin-runs/')) return { id: 'w', state: ++polls < 3 ? 'waiting_human' : 'succeeded',
        nodes: [{ executor: { kind: 'ai', ref: 'attempt1' } }, { executor: { kind: 'ai', ref: 'attempt2' } }] };
      if (++nodeReads === 1) throw Error('network');
      const ref = new URL(url, 'http://local').searchParams.get('ref');
      return { ref, seq: 1, last: 1, items: [{ seq: 1, kind: 'say', text: ref }] };
    } });
  await adapter.execute(handle, 'task', []);
  assert.equal(polls, 3);
  assert.deepEqual(acc.snapshot().messages.slice(1).map(m => m.blocks[0].text), ['attempt1', 'attempt2']);
});

test('Runner journal restores task interleaving and forwards context only until accepted', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = () => require('../main/conversation/task-output-journal').create({ getPath: () => root }, 'runner:test');
  const journal = await make();
  journal.append(3, { kind: 'message', role: 'assistant', text: 'actual answer', taskId: 't' });
  journal.append(3, { kind: 'tool', event: { type: 'tool_execution_end' } });
  assert.match(await journal.context(), /actual answer/);
  const restored = await make(), rows = [];
  await restored.restore(2, x => rows.push(x)); assert.equal(rows.length, 0);
  await restored.restore(3, x => rows.push(x)); assert.equal(rows.length, 2);
  await restored.restore(4, x => rows.push(x)); assert.equal(rows.length, 2);
  restored.append(4, { kind: 'context-sent' }); assert.equal(await (await make()).context(), '');
});

test('passive cloud replay preserves native reasoning and usage once across pages and reopening', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-cloud-thought-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = () => require('../main/conversation/cloud-conversation-view').create({
    app: { getPath: () => root }, ref: 'cloud-test', record: { transferId: 'test', sessionId: 'test', taskId: 't' },
    saved: { cwd: root, adapterId: 'pi', snapshot: { messages: [] } },
  });
  const handle = await make(), output = live.create(handle, 't', { includeUser: true });
  const first = [
    { seq: 1, kind: 'user', text: 'Make a report', round: 1 },
    { seq: 2, kind: 'thinking', streamId: 'pi:11:0', text: 'Let', delta: true, done: false, round: 1 },
    { seq: 3, kind: 'thinking', streamId: 'pi:11:0', text: ' me understand', delta: true, done: false, round: 1 },
  ];
  output.consume('r', first);
  assert.equal(handle.snapshot().messages[1].blocks[0].text, 'Let me understand');
  assert.equal(handle.snapshot().messages[1].done, false);
  const last = [
    { seq: 4, kind: 'thinking', streamId: 'pi:11:0', text: 'Let me understand', done: true, round: 1 },
    { seq: 5, kind: 'say', text: 'Report complete', round: 1 },
    { seq: 6, kind: 'usage', usageScope: 'message', usage: { input: 20, output: 10 }, round: 1 },
  ];
  output.consume('r', last); output.consume('r', first.concat(last));
  let snapshot = handle.snapshot();
  assert.equal(snapshot.messages.length, 3); assert.equal(snapshot.tools.length, 0);
  assert.equal(snapshot.messages[1].blocks[0].text, 'Let me understand');
  assert.equal(snapshot.messages[1].done, true);
  assert.equal(snapshot.messages[2].usage.totalTokens, 30);
  handle.close();
  const reopened = await make();
  live.create(reopened, 't', { includeUser: true }).consume('r', first.concat(last));
  snapshot = reopened.snapshot();
  assert.equal(snapshot.messages.length, 3); assert.equal(snapshot.tools.length, 0);
  assert.equal(snapshot.messages[1].blocks[0].text, 'Let me understand');
  assert.equal(snapshot.messages[2].usage.totalTokens, 30);
  reopened.close();
});

test('workflow text chunks form complete paragraphs and retain complete handoff evidence', () => {
  const { acc, handle } = target(), output = live.create(handle, '', { coalesceText: true });
  const chunks = [{seq:1,kind:'say',text:'Hello',delta:true,streamId:'a'},
    {seq:2,kind:'say',text:' world',delta:true,streamId:'a'}];
  output.consume('node1', chunks); output.consume('node1', chunks);
  assert.equal(acc.snapshot().messages.length,0);
  output.consume('node1',[{seq:3,kind:'say',text:'',delta:true,done:true,streamId:'a'}]);
  assert.equal(acc.snapshot().messages.length,1);
  assert.equal(output.lastText('node1'),'Hello world');
  output.consume('node2',[{seq:1,kind:'say',text:'Next',delta:true,streamId:'a'}]);
  output.finish('node2'); output.finish('node2');
  assert.equal(acc.snapshot().messages.length,2);assert.equal(output.lastText('node2'),'Next');
});
test('workflow cumulative final snapshots replace deltas and batched failures preserve buffers', () => {
  let fail = true; const rows=[];
  const output = live.create({ appendTaskBatch(ops){if(fail)throw Error('disk'); rows.push(...ops);}}, '', {coalesceText:true});
  output.consume('node',[{seq:1,kind:'say',text:'He',delta:true,streamId:'a'}]);
  const final=[{seq:2,kind:'say',text:'Hello',done:true,streamId:'a'}];
  assert.throws(()=>output.consume('node',final),/disk/);
  fail=false; output.consume('node',final); output.consume('node',final);
  assert.equal(rows.length,1); assert.equal(rows[0].args[1],'Hello');assert.equal(output.lastText('node'),'Hello');
});

test('native Codex metadata diagnostics do not become a separate collaboration reply',()=>{
 const calls=[];const handle={appendTaskMessage:(...args)=>calls.push(args)};
 const output=require('../main/conversation/task-live-output').create(handle,'',{coalesceText:true,sourceAgent:{agentId:'codex-harness',nodeKey:'work',runId:'r'}});
 output.consume('child',[{seq:1,kind:'say',text:'Warning: Model metadata for `test` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',done:true},{seq:2,kind:'say',text:'Real result',done:true}]);
 assert.equal(calls.length,1);assert.equal(calls[0][1],'Real result');
});

test('live Codex task streams suppress split diagnostics and flush ambiguous text on finish', () => {
  const calls = [];
  const handle = { taskMessageStreaming: true, appendTaskRuntimeEvent: (...args) => calls.push(args) };
  const output = live.create(handle, '', { coalesceText: true, sourceAgent: { agentId: 'codex-harness' } });
  const warning = 'Warning: Model metadata for `private-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
  let seq = 0;
  for (const text of warning) output.consume('child', [{ seq: ++seq, kind: 'say', streamId: 'reply', delta: true, text }]);
  assert.equal(calls.length, 0);
  output.consume('child', [{ seq: ++seq, kind: 'say', streamId: 'reply', delta: true, text: '\nReady', done: true }]);
  assert.equal(calls[0][0].text, 'Ready');
  output.consume('next', [{ seq: 1, kind: 'say', streamId: 'short', delta: true, text: 'Warning:' }]);
  assert.equal(calls.length, 1);
  output.finish('next');
  assert.equal(calls.at(-1)[0].text, 'Warning:');
  assert.equal(calls.at(-1)[0].done, true);
});

test('asynchronous output failure retains its cursor and stream for an explicit retry', async () => {
  let fail = true; const rows = [];
  const output = live.create({ async appendTaskBatch(operations) {
    await Promise.resolve(); if (fail) throw Error('remote save'); rows.push(...operations);
  } }, '', { coalesceText: true });
  await output.consume('node', [{ seq: 1, kind: 'say', text: 'He', delta: true, streamId: 'a' }]);
  const final = [{ seq: 2, kind: 'say', text: 'Hello', done: true, streamId: 'a' }];
  await assert.rejects(output.consume('node', final), /remote save/);
  assert.equal(output.lastText('node'), '');
  assert.equal(output.text('node'), '');
  fail = false; await output.consume('node', final); await output.consume('node', final);
  assert.equal(rows.length, 1); assert.equal(rows[0].args[1], 'Hello');
  assert.equal(output.text('node'), 'Hello');
});

test('stream completion waits for its remote save and remains retryable after rejection', async () => {
  let fail = true, finishes = 0;
  const output = live.create({ taskMessageStreaming: true, async appendTaskBatch(operations) {
    if (operations[0].args[0].kind !== 'task-stream-end') return;
    finishes++; if (fail) throw Error('finish save');
  } }, '', { coalesceText: true });
  await output.consume('node', [{ seq: 1, kind: 'say', text: 'Partial reply', streamId: 'a' }]);
  await assert.rejects(output.finish('node'), /finish save/); assert.equal(output.lastText('node'), '');
  fail = false; await output.finish('node'); assert.equal(output.lastText('node'), 'Partial reply');
  assert.equal(finishes, 2);
});

test('handoff includes every paragraph in original order without reasoning or replay duplicates', async () => {
  const output = live.create({ taskMessageStreaming: true, appendTaskBatch() {} }, '', { coalesceText: true });
  const items = [
    { seq: 1, kind: 'say', streamId: 'first', text: 'First', delta: true },
    { seq: 2, kind: 'thinking', streamId: 'thought', text: 'Private reasoning' },
    { seq: 3, kind: 'say', streamId: 'second', text: 'Second', delta: true },
    { seq: 4, kind: 'say', streamId: 'second', text: 'Second paragraph', done: true },
    { seq: 5, kind: 'say', streamId: 'first', text: 'First paragraph', done: true },
  ];
  await output.consume('one', items); await output.consume('one', items); await output.finish('one');
  assert.equal(output.text('one'), 'First paragraph\n\nSecond paragraph');
  assert.doesNotMatch(output.text('one'), /Private reasoning/);
  await output.consume('two', [{ seq: 1, kind: 'say', text: 'Other node' }]);
  assert.equal(output.text('two'), 'Other node');
  assert.equal(output.text('one'), 'First paragraph\n\nSecond paragraph');
});
