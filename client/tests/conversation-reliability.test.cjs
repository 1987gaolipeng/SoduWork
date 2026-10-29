'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { resultState } = require('../main/pi-session/task-turn');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function chunk(delta, finish = null, usage) {
  return 'data: ' + JSON.stringify({ id: 'reliability', object: 'chat.completion.chunk', model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n';
}
async function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-reliability-'));
  const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root, options);
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await f.open(); return f;
}
for (const ending of ['eof', 'done-without-finish', 'broken-json']) {
  test('partial model stream with ' + ending + ' cannot masquerade as a completed turn', { timeout: 15000 }, async t => {
    const f = await fixture(t);
    f.reply(() => ({ respond: async response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(chunk({ role: 'assistant', content: '已保留的部分结果：' }));
      await delay(20);
      response.end(ending === 'done-without-finish' ? 'data: [DONE]\n\n' : ending === 'broken-json' ? 'data: {"choices":[' : '');
    } }));
    const result = await f.handle.submit('请分析这个隔离样本。').completion;
    assert.notEqual(resultState(result), 'completed', 'transport truncation is not successful model completion');
    assert.match(JSON.stringify(f.handle.snapshot().messages), /已保留的部分结果/);
    assert.equal(f.handle.snapshot().execution.running, false);
    assert.equal(f.handle.snapshot().execution.turnQueue.paused, true);
    assert.ok(f.requests.length <= 2, 'no unbounded transport replay');
  });
}

test('a settled incomplete turn does not block a fresh message when no queue remains', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.reply((_body, count) => count === 1 ? { respond: async response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(chunk({ role: 'assistant', content: 'partial result' }));
    response.end();
  } } : { text: 'fresh turn completed' });
  const first = await f.handle.submit('first turn').completion;
  assert.notEqual(resultState(first), 'completed');
  assert.equal(f.handle.snapshot().execution.turnQueue.paused, true);
  assert.equal(f.handle.snapshot().execution.queue.length, 0);
  const next = f.handle.submit('new turn');
  assert.equal(next.queued, false);
  assert.equal(resultState(await next.completion), 'completed');
  assert.equal(f.requests.length, 2);
  assert.equal(f.handle.snapshot().execution.turnQueue.paused, false);
});

test('valid split UTF-8/SSE frames complete without losing text or leaving a busy session', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const content = '中文分片 🙂 — 保留完整内容。'.repeat(50);
  f.reply(() => ({ respond: async response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const wire = Buffer.from(chunk({ role: 'assistant', content }) + chunk({}, 'stop',
      { prompt_tokens: 40, completion_tokens: 200, total_tokens: 240 }) + 'data: [DONE]\n\n');
    for (let offset = 0; offset < wire.length; offset += 17) response.write(wire.subarray(offset, offset + 17));
    response.end();
  } }));
  const result = await f.handle.submit('解释这个隔离样本。').completion;
  assert.equal(resultState(result), 'completed');
  const reply = f.handle.snapshot().messages.filter(row => row.role === 'assistant').at(-1);
  assert.equal(reply.blocks.filter(row => row.kind === 'text').map(row => row.text).join(''), content);
  assert.equal(f.handle.snapshot().execution.running, false); assert.equal(f.requests.length, 1);
});
test('a reasoning-only stop must obtain a final answer or explicitly remain incomplete', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.reply((_body, count) => count > 1 ? { text: '这是最终答复。' } : { respond: async response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chunk({ role: 'assistant', reasoning_content: '先分析输入中的约束，再给出结论。' }) +
      chunk({}, 'stop', { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 }) + 'data: [DONE]\n\n');
  } });
  const result = await f.handle.submit('解释一下这个隔离样本。').completion;
  const snap = f.handle.snapshot();
  assert.equal(resultState(result), 'completed');
  assert.match(JSON.stringify(snap.messages), /这是最终答复/);
  assert.equal(f.requests.length, 2);
  assert.equal(snap.messages.filter(row => row.role === 'user').length, 2, 'one archived user and one new user, no internal duplicate');
});
test('repeated reasoning-only completion is bounded and does not silently unblock queued work', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.reply(() => ({ respond: async response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chunk({ role: 'assistant', reasoning_content: '这里只返回思考，没有最终答复。' }) +
      chunk({}, 'stop', { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 }) + 'data: [DONE]\n\n');
  } }));
  const first = f.handle.submit('解释一下样本。');
  const next = f.handle.submit('请等待前一轮完成。');
  const result = await first.completion;
  assert.equal(resultState(result), 'failed'); assert.equal(result.failureKind, 'output-incomplete');
  assert.equal(f.requests.length, 2); assert.equal(f.handle.snapshot().execution.turnQueue.paused, true);
  assert.equal(f.handle.snapshot().execution.queue.length, 1);
  f.handle.cancel(); assert.equal((await next.completion).cancelled, true);
});
test('long conversation survives 40 turns, 160 real tool calls, history reopens and ordinary queues', { timeout: 60000 }, async t => {
  const f = await fixture(t), expected = [];
  const sessionId = f.handle.sessionId;
  let turn = 0, step = 0;
  f.reply(body => {
    if (body.messages.at(-1).role !== 'tool') step = 0;
    if (step++ < 4) {
      const query = `turn-${turn}-step-${step}`;
      expected.push(query); return { tool: 'web_search', args: { query } };
    }
    return { text: `已完成第 ${turn} 轮验证。` + ' 本轮结果完整，依据已确认。'.repeat(60) };
  });
  for (turn = 1; turn <= 40; turn++) {
    const result = await f.handle.submit(`执行隔离检索第 ${turn} 轮。`).completion;
    assert.equal(resultState(result), 'completed', `turn ${turn}: ${result.reason}`);
    assert.equal(f.handle.snapshot().execution.running, false);
    assert.equal(f.handle.snapshot().execution.turnQueue.paused, false);
    if (turn % 10 === 0 && turn < 40) {
      f.handle.close(); await f.open(); assert.equal(f.handle.sessionId, sessionId);
      assert.match(JSON.stringify(f.handle.snapshot()), new RegExp(`已完成第 ${turn} 轮验证`));
    }
  }
  assert.equal(f.requests.length, 200);
  assert.equal(expected.length, 160);
  assert.deepEqual(fs.readFileSync(f.executed, 'utf8').trim().split('\n'), expected);
  const before = f.requests.length;
  f.reply(() => ({ text: '普通队列回复完成。' }));
  const queued = Array.from({ length: 5 }, (_, index) => f.handle.submit(`队列验证 ${index}，请简短回复。`).completion);
  assert.ok((await Promise.all(queued)).every(result => resultState(result) === 'completed'));
  assert.equal(f.requests.length - before, 5);
  assert.equal(f.handle.snapshot().execution.queue.length, 0);
  assert.equal(f.handle.snapshot().execution.turnQueue.paused, false);
  assert.ok(fs.readFileSync(f.resumePath, 'utf8').startsWith(f.archivePrefix));
});
test('explicit length truncation continues without duplicate user prompts and stays bounded if never complete', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.reply((_body, count) => count === 1 ? { respond: async response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chunk({ role: 'assistant', content: '回答的前半部分。' }) + chunk({}, 'length') + 'data: [DONE]\n\n');
  } } : { text: '回答的后半部分，现已完整。' });
  assert.equal(resultState(await f.handle.submit('解释这个样本。').completion), 'completed');
  assert.equal(f.requests.length, 2);
  assert.equal(f.handle.snapshot().messages.filter(row => row.role === 'user').length, 2);
  const before = f.requests.length;
  f.reply((_body, count) => ({ respond: async response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chunk({ role: 'assistant', content: `截断位置 ${count}。` }) + chunk({}, 'length') + 'data: [DONE]\n\n');
  } }));
  const result = await f.handle.submit('再解释另一个样本。').completion;
  assert.equal(result.failureKind, 'output-incomplete'); assert.equal(f.requests.length - before, 3);
  assert.equal(f.handle.snapshot().status, 'incomplete');
});
test('in-flight cancel preserves completed tool effects and later continuation remains usable', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let arrived, release;
  const waiting = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.reply(async (_body, count) => {
    if (count === 1) return { tool: 'web_search', args: { query: 'persist-once-before-cancel' } };
    arrived(); await gate; return { text: 'This response was cancelled.' };
  });
  const submitted = f.handle.submit('执行隔离检索。');
  await waiting; f.handle.cancel(); release();
  assert.equal((await submitted.completion).cancelled, true);
  assert.equal(fs.readFileSync(f.executed, 'utf8'), 'persist-once-before-cancel\n');
  f.reply(body => { assert.ok(body.messages.some(message => message.role === 'tool')); return { text: '已基于保留结果继续。' }; });
  assert.equal(resultState(await f.handle.submit('请根据已有结果答复。').completion), 'completed');
  assert.equal(f.requests.length, 3);
  assert.equal(fs.readFileSync(f.executed, 'utf8'), 'persist-once-before-cancel\n');
});
test('automatic protocol recovery settles the original queue item before the next user turn', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.reply((_body, count) => ({ text: count === 1 ? Array(8).fill('Let me read README now.').join('\n') : '已恢复并完成答复。' }));
  const first = f.handle.submit('检查 README 并给出结论。');
  const result = await first.completion;
  const end = Date.now() + 3000;
  while ((f.requests.length < 2 || f.handle.snapshot().execution.running) && Date.now() < end) await delay(10);
  assert.equal(f.requests.length, 2, 'one bounded provider recovery');
  assert.equal(f.handle.snapshot().status, 'idle');
  assert.equal(f.handle.snapshot().execution.turnQueue.paused, false, 'successful internal recovery must release the original queue');
  assert.equal(resultState(result), 'completed', 'submission completion must describe the recovered turn, not intermediate waiting');
  const followup = await f.handle.submit('解释一下当前结果。').completion;
  assert.equal(resultState(followup), 'completed'); assert.equal(f.requests.length, 3);
});
test('queued task waits for automatic recovery and receives one final completion receipt', { timeout: 15000 }, async t => {
  const f = await fixture(t), receipts = [];
  let reached, release;
  const pending = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.reply(async (_body, count) => {
    if (count === 1) return { text: Array(8).fill('Let me read README now.').join('\n') };
    if (count === 2) { reached(); await gate; }
    return { text: '已完成这一项。' };
  });
  const first = f.handle.submit('检查第一项。', [], { taskId: 'a', afterTurn: async state => receipts.push('a:' + state) });
  const second = f.handle.submit('检查第二项。', [], { taskId: 'b', afterTurn: async state => receipts.push('b:' + state) });
  await pending;
  assert.equal(f.requests.length, 2); assert.deepEqual(receipts, []);
  assert.equal(f.handle.snapshot().execution.turnQueue.activeTaskId, 'a');
  release();
  assert.equal(resultState(await first.completion), 'completed');
  assert.equal(resultState(await second.completion), 'completed');
  assert.deepEqual(receipts, ['a:completed', 'b:completed']);
});
test('stop during internal recovery cancels the original submission and never drains queued work', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let reached, release;
  const pending = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.reply(async (_body, count) => {
    if (count === 1) return { text: Array(8).fill('Let me read README now.').join('\n') };
    reached(); await gate; return { text: 'Cancelled recovery.' };
  });
  const first = f.handle.submit('检查第一项。');
  const second = f.handle.submit('检查第二项。');
  await pending; f.handle.cancel(); release();
  assert.equal((await first.completion).cancelled, true); assert.equal((await second.completion).cancelled, true);
  const stoppedBy = Date.now() + 3000;
  while (f.handle.snapshot().execution.running && Date.now() < stoppedBy) await delay(10);
  assert.equal(f.requests.length, 2); assert.equal(f.handle.snapshot().execution.running, false);
  f.reply(() => ({ text: '新请求正常。' }));
  assert.equal(resultState(await f.handle.submit('解释当前状态。').completion), 'completed');
});
test('persistent protocol failure is bounded and leaves subsequent queued messages waiting', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.reply(() => ({ text: Array(8).fill('Let me read README now.').join('\n') }));
  const first = f.handle.submit('检查第一项。'); const second = f.handle.submit('检查第二项。');
  assert.notEqual(resultState(await first.completion), 'completed');
  assert.equal(f.requests.length, 2); assert.equal(f.handle.snapshot().execution.turnQueue.paused, true);
  assert.equal(f.handle.snapshot().execution.queue.length, 1);
  f.handle.cancel(); await second.completion;
});
test('real stalled stream abort/recovery settles the same submission without starving the next turn', { timeout: 15000 }, async t => {
  const control = require('../main/pi-session/run-control');
  const original = control.startMonitor;
  let run, context;
  // Trigger the production watchdog callback after the real request starts.
  // The separate stall-recovery suite verifies the unchanged three-minute gate.
  control.startMonitor = (state, ctx) => { run = state; context = ctx; original(state, ctx); };
  t.after(() => { control.startMonitor = original; });
  const f = await fixture(t);
  f.reply((_body, count) => count === 1 ? { respond: async response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': keep-alive\n\n');
    setImmediate(() => control.stopStalledAgent(run, context));
  } } : { text: '静默流恢复完成。' });
  const first = f.handle.submit('检查隔离样本。');
  const second = f.handle.submit('解释一下结果。');
  assert.equal(resultState(await first.completion), 'completed');
  assert.equal(resultState(await second.completion), 'completed');
  assert.equal(f.requests.length, 3); assert.equal(f.handle.snapshot().execution.turnQueue.paused, false);
});
