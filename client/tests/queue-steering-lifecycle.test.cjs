'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const result = check(); if (result) return result; await delay(10); }
  throw Error('Timed out waiting for isolated steering state');
}
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-steer-lifecycle-'));
  const controller = new AbortController();
  t.signal.addEventListener('abort', () => controller.abort(), { once: true });
  let f;
  t.after(async () => { controller.abort(); await f?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  f = await require('../e2e/fixtures/steering-lifecycle.cjs').create(root, { ...options, signal: controller.signal });
  return f;
}

test('steering interrupts real native compaction and delivers the original queued message once', { timeout: 15000 }, async t => {
  const f = await fixture(t, { largeTool: true });
  await f.runtime.setModel({ ...f.runtime.model, contextWindow: 8192, maxTokens: 1024 });
  const summaryClosed = require('../e2e/fixtures/steering-lifecycle.cjs').holdCompaction(f);
  const first = f.handle.submit('检索这个隔离样本。');
  await until(() => f.requests.length === 3);
  assert.equal(f.runtime.isCompacting, true, 'the held HTTP request must be a native summary');
  const selected = f.handle.submit('使用已有结果，交付标准可以直接发布。');
  const later = f.handle.submit('页面风格保持原主题。');
  const steering = f.handle.updateQueue(selected.queueId, 'send-now');
  const result = await Promise.race([steering, delay(1500).then(() => ({ timedOut: true }))]);
  assert.equal(result.timedOut, undefined, 'steering must abort the summarizer, not wait for its model response');
  assert.equal(result.ok, true);
  assert.equal((await first.completion).cancelled, true);
  assert.equal((await selected.completion).ok, true); assert.equal((await later.completion).ok, true);
  await until(summaryClosed);
  assert.equal(f.requests.length, 5);
  assert.equal(fs.readFileSync(f.executed, 'utf8'), 'before-compaction-once\n');
  assert.equal(f.handle.snapshot().execution.queue.length, 0);
  assert.equal(f.handle.snapshot().execution.turnQueue.paused, false);
});

test('a slow real tool receives cancellation, steering waits without an error, duplicate clicks do not resend', { timeout: 15000 }, async t => {
  const f = await fixture(t, { slowTool: true });
  f.reply((_body, count) => count === 1 ? { tool: 'web_search', args: { query: 'slow-once' } } : { text: '已按补充要求完成。' });
  const first = f.handle.submit('检索隔离样本。');
  await until(() => fs.existsSync(f.executed));
  const later = f.handle.submit('最后解释结果。');
  const selected = f.handle.submit('优先核对主题。');
  const request = f.handle.updateQueue(selected.queueId, 'send-now');
  const duplicate = f.handle.updateQueue(selected.queueId, 'send-now');
  await until(f.toolAborted);
  assert.equal(f.handle.snapshot().execution.queueImmediate.pending, true);
  assert.equal(f.handle.snapshot().execution.stopped, false, 'steering is not a budget/error stop');
  assert.equal(f.requests.length, 1, 'no new model request while a tool is still settling');
  f.releaseTool();
  assert.equal((await request).ok, true); assert.equal((await duplicate).ok, true);
  assert.equal((await first.completion).cancelled, true);
  await selected.completion; await later.completion;
  assert.equal(f.requests.length, 3);
  assert.match(JSON.stringify(f.requests[1].messages.at(-1)), /优先核对主题/);
  assert.match(JSON.stringify(f.requests[2].messages.at(-1)), /最后解释结果/);
  assert.equal(fs.readFileSync(f.executed, 'utf8'), 'slow-once\n');
});

test('explicit stop during slow-tool steering releases the guide immediately and never sends queued content', { timeout: 15000 }, async t => {
  const f = await fixture(t, { slowTool: true });
  f.reply(() => ({ tool: 'web_search', args: { query: 'cancel-guide' } }));
  const first = f.handle.submit('检索隔离样本。');
  await until(() => fs.existsSync(f.executed));
  const selected = f.handle.submit('这条消息不应再发出。');
  const request = f.handle.updateQueue(selected.queueId, 'send-now'); await until(f.toolAborted);
  f.handle.cancel();
  const result = await Promise.race([request, delay(250).then(() => ({ timedOut: true }))]);
  assert.equal(result.cancelled, true); assert.equal((await selected.completion).cancelled, true);
  assert.equal(f.requests.length, 1);
  f.releaseTool(); await first.completion;
  f.reply(() => ({ text: '停止后可正常对话。' }));
  assert.equal((await f.handle.submit('解释当前状态。').completion).ok, true);
  assert.equal(f.requests.length, 2); assert.equal(f.handle.snapshot().execution.stopped, false);
});

test('steering before native summary authentication settles also cancels the later-created summary', { timeout: 15000 }, async t => {
  const f = await fixture(t, { largeTool: true });
  await f.runtime.setModel({ ...f.runtime.model, contextWindow: 8192, maxTokens: 1024 });
  let releaseOverflow, releaseAuth, authEntered = false;
  const overflowGate = new Promise(resolve => { releaseOverflow = resolve; });
  const authGate = new Promise(resolve => { releaseAuth = resolve; });
  t.after(() => { releaseOverflow(); releaseAuth(); });
  f.reply(async (body, count) => {
    if (count === 1) return { tool: 'web_search', args: { query: 'auth-boundary-once' } };
    if (count === 2) { await overflowGate; return { respond: response => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length is 8192 tokens; prompt is too long' } }));
    } }; }
    if (JSON.stringify(body.messages.at(-1)).includes('AUTH_GUIDE')) return { text: '认证交接后引导完成。' };
    return { respond: response => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': summary parked\n\n'); } };
  });
  const first = f.handle.submit('检索隔离样本。');
  await until(() => f.requests.length === 2);
  const runtime = f.runtime, original = runtime._getSummarizationRequestAuth;
  runtime._getSummarizationRequestAuth = async function (...args) { authEntered = true; await authGate; return original.apply(this, args); };
  t.after(() => { runtime._getSummarizationRequestAuth = original; });
  releaseOverflow(); await until(() => authEntered);
  assert.equal(runtime.isCompacting, true, 'native compaction owns cancellation while authentication is pending');
  const selected = f.handle.submit('AUTH_GUIDE：使用已有结果答复。');
  const request = f.handle.updateQueue(selected.queueId, 'send-now');
  await until(() => f.handle.snapshot().execution.queueImmediate.pending); await delay(10); releaseAuth();
  const result = await Promise.race([request, delay(1500).then(() => ({ timedOut: true }))]);
  assert.equal(result.ok, true, 'late-created compaction is cancelled within the same interruption');
  assert.equal((await first.completion).cancelled, true);
  assert.equal((await selected.completion).ok, true);
  assert.equal(fs.readFileSync(f.executed, 'utf8'), 'auth-boundary-once\n');
  assert.equal(f.requests.filter(body => JSON.stringify(body.messages.at(-1)).includes('AUTH_GUIDE')).length, 1);
  assert.equal(f.handle.snapshot().execution.queueImmediate.pending, false);
});

test('steering during pre-prompt compaction never launches the cancelled old prompt and later summaries still work', { timeout: 15000 }, async t => {
  const f = await fixture(t, { largeTool: true });
  f.reply((_body, count) => count === 1 ? { tool: 'web_search', args: { query: 'preflight-once' } }
    : { text: '已完成隔离检索，保留现有工作结果。' });
  assert.equal((await f.handle.submit('检索隔离样本。').completion).ok, true);
  const runtime = f.runtime;
  // Simulate provider-reported context pressure on the real completed message.
  const last = runtime.agent.state.messages.filter(row => row.role === 'assistant').at(-1);
  last.usage = { ...last.usage, input: 9000, output: 12, totalTokens: 9012 };
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const original = runtime._getSummarizationRequestAuth;
  runtime._getSummarizationRequestAuth = async function (...args) {
    if (!entered) { entered = true; await gate; }
    return original.apply(this, args);
  };
  t.after(() => { release(); runtime._getSummarizationRequestAuth = original; });
  const before = f.requests.length;
  const first = f.handle.submit('OLD_PROMPT_MUST_NOT_START：继续检索旧方向。');
  await until(() => entered); assert.equal(runtime.isStreaming, true, 'the SDK owns the run during pre-prompt compaction');
  const selected = f.handle.submit('PREFLIGHT_GUIDE：使用现有结果回答。');
  const request = f.handle.updateQueue(selected.queueId, 'send-now');
  await until(() => f.handle.snapshot().execution.queueImmediate.pending); await delay(10); release();
  assert.equal((await request).ok, true);
  assert.equal((await first.completion).cancelled, true);
  assert.equal((await selected.completion).ok, true);
  assert.ok(f.requests.length > before, 'the selected turn can compact and send after old interruption listeners retire');
  assert.equal(f.requests.filter(body => JSON.stringify(body.messages.at(-1)).includes('OLD_PROMPT_MUST_NOT_START')).length, 0);
  assert.equal(f.requests.filter(body => JSON.stringify(body.messages.at(-1)).includes('PREFLIGHT_GUIDE')).length, 1);
  assert.equal(fs.readFileSync(f.executed, 'utf8'), 'preflight-once\n');
  assert.equal(f.handle.snapshot().execution.queue.length, 0);
});
