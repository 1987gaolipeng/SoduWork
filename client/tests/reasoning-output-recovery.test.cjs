'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stream = require('../main/pi-session/event-stream');
const continuation = require('../main/pi-session/output-continuation');

function fixture(replies) {
  const acc = stream.create(), calls = [];
  const session = {
    model: { maxTokens: 4096, contextWindow: 64000 },
    async prompt(text) {
      calls.push(text);
      acc.push({ type: 'agent_start' });
      acc.push({ type: 'message_end', message: { role: 'user', content: text } });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (reply.tool) {
        acc.push({ type: 'tool_execution_start', toolCallId: 'completed-tool', toolName: 'write', args: { path: 'result.txt' } });
        acc.push({ type: 'tool_execution_end', toolCallId: 'completed-tool', toolName: 'write', result: { content: [{ type: 'text', text: 'saved' }] } });
      }
      acc.push({ type: 'message_start', message: { role: 'assistant' } });
      acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: reply.stop || 'length',
        content: reply.text ? [{ type: 'text', text: reply.text }] : [{ type: 'thinking', thinking: 'Bounded reasoning without an answer.' }] } });
      if (reply.pendingTool) acc.push({ type: 'tool_execution_start', toolCallId: 'pending-tool', toolName: 'write', args: {} });
      if (reply.pendingUi) acc.state.pendingUi = { type: 'confirmation' };
      acc.push({ type: 'agent_settled' });
    },
  };
  return { acc, session, calls };
}

test('one reasoning-only length stop gets a bounded same-session continuation', async () => {
  const f = fixture([{}, { text: 'Completed answer.', stop: 'stop' }]);
  const result = await continuation.complete(f.session, f.acc, 'Complete the request', {});
  assert.deepEqual(result, { continuations: 1, incomplete: false });
  assert.match(f.calls[1], /输出.*思考/);
  assert.match(f.calls[1], /较小|小步骤/);
  assert.equal(f.session.model.maxTokens, 4096);
  assert.equal(f.acc.snapshot().messages.filter(row => row.role === 'user').length, 1);
});

test('reasoning recovery remains single-use after tools and later text truncation', async () => {
  for (const replies of [
    [{ tool: true }, { text: 'Partial answer' }, {}],
    [{ text: 'Partial answer' }, {}, {}],
  ]) {
    const f = fixture(replies);
    const result = await continuation.complete(f.session, f.acc, 'Complete the request', {});
    assert.equal(result.continuations, 2);
    assert.equal(result.incompleteReason, 'reasoning-limit');
    assert.equal(f.calls.length, 3);
  }
  const repeated = fixture([{}]);
  const result = await continuation.complete(repeated.session, repeated.acc, 'Complete the request', {}, { maxContinuations: 4 });
  assert.equal(result.continuations, 1);
  assert.equal(result.incompleteReason, 'reasoning-limit');
  assert.equal(repeated.calls.length, 2);
});

test('reasoning recovery respects the total continuation cap and unsettled controls', async () => {
  for (const blocked of ['cap', 'cancel', 'permissions', 'tool']) {
    const f = fixture([{ pendingUi: blocked === 'permissions', pendingTool: blocked === 'tool' }]);
    const result = await continuation.complete(f.session, f.acc, 'Complete the request', {}, {
      maxContinuations: blocked === 'cap' ? 0 : 2,
      shouldStop: () => blocked === 'cancel' && f.calls.length > 0,
    });
    assert.equal(result.incomplete, true, blocked);
    assert.equal(result.continuations, 0, blocked);
    assert.equal(f.calls.length, 1, blocked);
  }
});

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { resultState } = require('../main/pi-session/task-turn');
async function nativeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-reasoning-recovery-'));
  const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root, { signal: t.signal,
    modelOptions: { maxOutputTokens: 4096, reasoning: true, thinkingFormat: 'openai', supportsReasoningEffort: true } });
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await f.open({ thinkingLevel: 'medium' });
  return f;
}
function reasoningLength(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [delta, finish_reason] of [[{ role: 'assistant', reasoning_content: 'Preserved reasoning checkpoint.' }, null], [{}, 'length']]) {
    response.write('data: ' + JSON.stringify({ id: 'reasoning-fixture', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  }
  response.end('data: [DONE]\n\n');
}

for (const withTool of [false, true]) {
  test('native Pi resumes reasoning truncation with unchanged budget and retained history' + (withTool ? ' after a tool' : ''), { timeout: 30000 }, async t => {
    const f = await nativeFixture(t);
    const id = f.handle.sessionId, thinking = f.handle.snapshot().thinking;
    f.reply((body, count) => {
      if (withTool && count === 1) return { tool: 'web_search', args: { query: 'once-before-reasoning-limit' } };
      if (count === (withTool ? 2 : 1)) return { respond: reasoningLength };
      assert.match(JSON.stringify(body.messages), /Previous report is preserved/);
      assert.equal(body.messages.filter(row => row.role === 'user' && JSON.stringify(row.content).includes('Complete the isolated request.')).length, 1);
      assert.match(JSON.stringify(body.messages.at(-1)), /较小的未完成步骤/);
      if (withTool) assert.ok(body.messages.some(row => row.role === 'tool'));
      return { text: 'Completed using the retained results.' };
    });
    const result = await f.handle.submit('Complete the isolated request.').completion;
    assert.equal(resultState(result), 'completed', JSON.stringify({ failure: result.failureKind, status: f.handle.snapshot().statusText }));
    assert.equal(f.requests.length, withTool ? 3 : 2);
    assert.ok(f.requests.every(row => (row.max_tokens ?? row.max_completion_tokens) === 4096));
    assert.ok(f.requests.every(row => row.reasoning_effort === 'medium'));
    assert.equal(f.handle.sessionId, id);
    assert.match(JSON.stringify(f.handle.snapshot().messages), /Preserved reasoning checkpoint/);
    assert.deepEqual(f.handle.snapshot().thinking, thinking);
    assert.equal(f.handle.snapshot().messages.filter(row => row.role === 'user').length, 2);
    if (withTool) assert.equal(fs.readFileSync(f.executed, 'utf8'), 'once-before-reasoning-limit\n');
    f.handle.close(); await f.open();
    assert.match(JSON.stringify(f.handle.snapshot().messages), /Completed using the retained results/);
    assert.equal(f.handle.snapshot().messages.filter(row => row.role === 'user').length, 2);
  });
}

test('repeated native reasoning truncation pauses queued work after one recovery', { timeout: 30000 }, async t => {
  const f = await nativeFixture(t);
  f.reply(() => ({ respond: reasoningLength }));
  const first = f.handle.submit('Complete the first request.');
  const queued = f.handle.submit('Wait for the first request.');
  const result = await first.completion;
  assert.equal(result.failureKind, 'output-incomplete');
  assert.equal(f.requests.length, 2);
  assert.equal(f.handle.snapshot().execution.turnQueue.paused, true);
  assert.equal(f.handle.snapshot().execution.queue.length, 1);
  assert.equal(f.handle.snapshot().completion.incompleteReason, 'reasoning-limit');
  f.handle.cancel(); assert.equal((await queued.completion).cancelled, true);
});

test('native reasoning recovery never executes a length-truncated tool call', { timeout: 30000 }, async t => {
  const f = await nativeFixture(t);
  f.reply((_body, count) => {
    if (count === 1) return { tool: 'web_search', args: { query: 'completed-once' } };
    if (count === 2) return { respond(response) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', tool_calls: [{ index: 0, id: 'truncated-call',
        type: 'function', function: { name: 'web_search', arguments: '{"query":"must-not-run"}' } }] }, null], [{}, 'length']]) {
        response.write('data: ' + JSON.stringify({ id: 'truncated-fixture', object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      }
      response.end('data: [DONE]\n\n');
    } };
    if (count === 3) return { respond: reasoningLength };
    return { text: 'Completed from retained tool results.' };
  });
  assert.equal(resultState(await f.handle.submit('Complete the isolated request.').completion), 'completed');
  assert.equal(f.requests.length, 4);
  assert.equal(fs.readFileSync(f.executed, 'utf8'), 'completed-once\n');
  const rejected = f.handle.snapshot().tools.find(tool => tool.id === 'truncated-call');
  assert.equal(rejected.isError, true);
  assert.equal(rejected.state, 'error');
});

test('cancelling native reasoning recovery prevents another request', { timeout: 30000 }, async t => {
  const f = await nativeFixture(t);
  let arrived, release;
  const started = new Promise(resolve => { arrived = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  f.reply(async (_body, count) => {
    if (count === 1) return { respond: reasoningLength };
    arrived(); await wait;
    return { respond: reasoningLength };
  });
  const pending = f.handle.submit('Complete the isolated request.');
  await started;
  f.handle.cancel(); release();
  assert.equal((await pending.completion).cancelled, true);
  assert.equal(f.requests.length, 2);
  assert.equal(f.handle.snapshot().execution.running, false);
  assert.equal(fs.existsSync(f.executed), false);
});
