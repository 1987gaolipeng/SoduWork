'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stream = require('../main/pi-session/event-stream');
const { seed } = require('../main/pi-session/history-seed');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname,
  '../components/panels/chat-context-meter.js'), 'utf8'), sandbox);
const render = snap => sandbox.window.ChatContextMeter.create({
  _snap: snap, _model: { contextWindow: 100000, contextWindowKnown: true },
})._ctxHtml();
const usage = value => render({ contextUsage: value });

test('Pi input includes cache read and cache creation exactly once', () => {
  assert.match(usage({ input: 1000, cacheRead: 90000, cacheWrite: 5000 }), /已用 96,000 标记/);
  assert.match(usage({ input: 0, cacheRead: 90000, totalTokens: 90100 }), /已用 90,000 标记/);
  assert.match(usage({ input: 96000, cacheRead: 90000, cacheWrite: 5000,
    inputIncludesCache: true }), /已用 96,000 标记/);
  assert.match(usage({ input: 96000, cacheRead: 95000,
    input_includes_cache: true }), /已用 96,000 标记/);
});

test('OpenAI input includes cached subsets while native nested cache is separate', () => {
  assert.match(usage({ input_tokens: 96000, cached_input_tokens: 95000 }), /已用 96,000 标记/);
  assert.match(usage({ input_tokens: 96000, cached_input_tokens: 95000,
    cache_write_input_tokens: 0 }), /已用 96,000 标记/);
  assert.match(usage({ prompt_tokens: 96000,
    prompt_tokens_details: { cached_tokens: 95000 } }), /已用 96,000 标记/);
  assert.match(usage({ input: 1000, cache: { read: 90000, write: 5000 } }), /已用 96,000 标记/);
  assert.match(usage({ input_tokens: 1000, cache_read_input_tokens: 90000,
    cache_creation_input_tokens: 5000 }), /已用 96,000 标记/);
});

test('output, totals and invalid counters never masquerade as input', () => {
  for (const value of [{ totalTokens: 90000 }, { output: 90000 }, { input: null },
    { input: '' }, { input: false }, { input: -1 }, { input: Infinity }, { input: null, cache: 0 }]) {
    assert.match(usage(value), /暂无用量数据/);
  }
  assert.match(usage({ input: 0, totalTokens: 90000 }), /0% 已用/);
});

test('cumulative snapshot usage cannot override a settled request or missing watermark', () => {
  const messages = [{ role: 'assistant', done: true, usage: { input: 50000 } }];
  assert.match(render({ usage: { input: 300000 }, messages }), /已用 50,000 标记/);
  assert.match(render({ usage: { input: 300000 } }), /暂无用量数据/);
  assert.match(render({ contextUsage: null, usage: { input: 300000 }, messages }), /暂无用量数据/);
  assert.match(render({ messages: [{ role: 'assistant', done: false,
    usage: { input: 50000 } }] }), /暂无用量数据/);
});

test('Pi settled usage survives partial zeros and is invalidated by compaction', () => {
  const acc = stream.create();
  acc.push({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }],
    usage: { input: 1000, cacheRead: 90000, cacheWrite: 5000, output: 10 } } });
  assert.match(render(acc.snapshot()), /已用 96,000 标记/);
  acc.push({ type: 'message_start', message: { role: 'assistant' } });
  acc.push({ type: 'message_update', assistantMessageEvent: { usage: { input: 0, output: 0 } } });
  assert.match(render(acc.snapshot()), /已用 96,000 标记/);
  acc.push({ type: 'compaction_start' });
  acc.push({ type: 'compaction_end' });
  assert.match(render(acc.snapshot()), /暂无用量数据/);
  acc.push({ type: 'message_end', message: { role: 'assistant', usage: { input: 12000, output: 20 } } });
  assert.match(render(acc.snapshot()), /已用 12,000 标记/);
});

test('reopening Pi history respects compaction boundaries and active model', () => {
  const message = { role: 'assistant', model: 'before', provider: 'fixture',
    content: [{ type: 'text', text: 'done' }], usage: { input: 90000, output: 10 } };
  for (const compacted of [true, false]) {
    const acc = stream.create();
    seed(acc, { model: { id: 'after', provider: 'fixture' }, state: { messages: [message] },
      sessionManager: { getEntries: () => [{ type: 'message', message },
        ...(compacted ? [{ type: 'compaction', summary: 'summary' }] : [])] } });
    assert.match(render(acc.snapshot()), /暂无用量数据/);
  }
  const acc = stream.create();
  seed(acc, { model: { id: 'before', provider: 'fixture' }, state: { messages: [message] },
    sessionManager: { getEntries: () => [{ type: 'message', message }, { type: 'compaction' }] } });
  assert.match(render(acc.snapshot()), /暂无用量数据/);
  acc.push({ type: 'message_end', message });
  assert.match(render(acc.snapshot()), /已用 90,000 标记/);
  acc.push({ type: 'context_reset' });
  assert.match(render(acc.snapshot()), /暂无用量数据/);
});

test('active branch measurement ignores imported task receipts and other branches', () => {
  const own = { type: 'message', message: { role: 'assistant',
    content: [{ type: 'text', text: 'own' }], usage: { input: 10000 } } };
  const other = { type: 'message', message: { ...own.message, usage: { input: 70000 } } };
  const imported = { type: 'message', message: require('../main/conversation/task-message-stream.cjs')
    .nativeMessage({ text: 'child result', taskId: 'task-1', taskOutputKey: 'task-output:1' },
      { id: 'same', provider: 'fixture' }) };
  const acc = stream.create();
  seed(acc, { state: { messages: [] }, sessionManager: {
    getEntries: () => [own, imported, { type: 'compaction' }, other],
    getBranch: () => [own, imported],
  } });
  assert.match(render(acc.snapshot()), /已用 10,000 标记/);
});

test('real Pi session branch changes restore that branch request watermark', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const manager = SessionManager.inMemory();
  const root = manager.appendMessage({ role: 'user', content: 'root', timestamp: 1 });
  const make = input => ({ role: 'assistant', model: 'same', provider: 'fixture',
    content: [{ type: 'text', text: String(input) }], usage: { input }, timestamp: 2 });
  const first = manager.appendMessage(make(10000));
  manager.branch(root);
  manager.appendMessage(make(70000));
  manager.branch(first);
  const acc = stream.create();
  seed(acc, { model: { id: 'same', provider: 'fixture' },
    state: { messages: manager.buildSessionContext().messages }, sessionManager: manager });
  assert.match(render(acc.snapshot()), /已用 10,000 标记/);
});

test('future model selection cannot change the last request window', () => {
  assert.match(render({ contextUsage: { input: 50000 }, modelSelection: {
    pending: true, activeModel: { contextWindow: 200000 },
    model: { contextWindow: 1000000 },
  } }), /25% 已用/);
});
