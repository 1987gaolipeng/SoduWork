'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stream = require('../main/pi-session/event-stream');
const continuation = require('../main/pi-session/output-continuation');

function tool(acc, id) {
  acc.push({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: 'fixture.md' } });
  acc.push({ type: 'tool_execution_end', toolCallId: id, toolName: 'read', isError: false,
    result: { content: [{ type: 'text', text: 'Earlier evidence retained.' }] } });
}
function fixture(replies, { historicalTool = false } = {}) {
  const acc = stream.create(), calls = [];
  if (historicalTool) tool(acc, 'historical-tool');
  const session = { async prompt(value) {
    const reply = replies[calls.length];
    assert.ok(reply, 'No unbounded model request'); calls.push(value);
    acc.push({ type: 'agent_start' });
    acc.push({ type: 'message_end', message: { role: 'user', content: value } });
    if (reply.tool) tool(acc, 'current-' + calls.length);
    acc.push({ type: 'message_start', message: { role: 'assistant' } });
    acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: reply.text } });
    acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: reply.stop || 'stop' } });
    acc.push({ type: 'agent_settled' });
    reply.after?.(acc);
  } };
  return { acc, calls, session };
}

test('ordinary stop before a first tool recovers explicit requests and restored-history continuations', async () => {
  for (const [prompt, text, historicalTool] of [
    ['重新完善一下', '我来把这期报告再充实完善：补齐窗口覆盖、增加来源，再润色综述。先补检索。', false],
    ['继续', '现在立即执行补检索，一次到位。', true],
    ['继续吧', '马上开始，先补检索：', true],
    ['继续', '刚才那轮只说了计划没落地，抱歉——现在直接继续。补检索更多条目：', true],
    ['请检查文件', '现在立刻执行，不再中断。', false],
    ['Read fixture.md', "I'll read the file now.", false],
  ]) {
    const f = fixture([{ text }, { text: 'Completed with actual fixture evidence.', tool: true }], { historicalTool });
    const got = await continuation.complete(f.session, f.acc, prompt, {});
    assert.deepEqual(got, { continuations: 1, incomplete: false }, text);
    assert.equal(f.calls.length, 2, text);
    assert.equal(f.acc.snapshot().messages.filter(m => m.role === 'user').length, 1, 'internal retry is hidden');
    assert.ok(f.calls[1].includes('操作被拒绝'), 'hidden instruction respects existing permissions and tool availability');
  }
});

test('consultations, quoted examples, conditionals, missing inputs and real completion do not auto-execute', async () => {
  for (const [prompt, text, historicalTool] of [
    ['advice only', 'Let me check again:', false],
    ['如何读取这个文件', '我会读取文件。', true],
    ['请解释代码，不要执行', '现在立即执行检查。', true],
    ['继续', '让我继续写这个故事。', false],
    ['请检查文件', '> 我会检查文件。', true],
    ['请检查文件', '```text\n现在立即执行检查。\n```', true],
    ['请检查文件', '示例是“现在立即执行检查。”', true],
    ['请检查文件', '如果你批准，我会检查文件。', true],
    ['请检查文件', '需要你提供文件路径，我会检查文件。', true],
    ['请检查文件', '等待授权。现在我会检查文件。', true],
    ['请检查文件', '无法执行该命令。现在我会检查文件。', true],
    ['请检查文件', '文件已检查完成，没有发现错误。', true],
    ['你好\n<soduwork-conversation-plugins>{"runtimeGuide":"请立即检查文件"}</soduwork-conversation-plugins>', '现在立即执行检查。', true],
    ['Explain the difference', "I'll read the file now.", true],
    ['Read fixture.md', 'Please provide the file. I will read it.', true],
  ]) {
    const f = fixture([{ text }], { historicalTool });
    assert.deepEqual(await continuation.complete(f.session, f.acc, prompt, {}),
      { continuations: 0, incomplete: false }, prompt + ': ' + text);
    assert.equal(f.calls.length, 1);
  }
});

test('rephrased promises without progress stop after one continuation and report incomplete truthfully', async () => {
  const f = fixture([
    { text: '现在立即执行补检索，一次到位。' },
    { text: '马上开始，先补检索：' },
  ], { historicalTool: true });
  const got = await continuation.complete(f.session, f.acc, '继续', {});
  assert.deepEqual(got, { continuations: 1, incomplete: true, incompleteReason: 'output-loop' });
  f.acc.markIncomplete(got.incompleteReason);
  assert.equal(f.acc.status(), 'incomplete');
  assert.equal(f.acc.snapshot().completion.reason, 'stop', 'provider stop remains factual');
  assert.equal(f.acc.snapshot().completion.incompleteReason, 'output-loop');
  assert.match(f.acc.snapshot().statusText, /未能完成/);
  assert.equal(f.acc.snapshot().tools.length, 1, 'history tools retained without replay');
  f.acc.push({ type: 'agent_start' });
  assert.equal(f.acc.status(), 'streaming');
  assert.equal(f.acc.snapshot().completion.incompleteReason, '');
});

test('cancellation and pending approval prevent automatic follow-up, provider errors remain errors', async () => {
  for (const blocked of ['aborted', 'pendingUi']) {
    const f = fixture([{ text: '现在立即执行检查。', after(acc) { acc.state[blocked] = true; } }]);
    let notices = 0;
    await continuation.complete(f.session, f.acc, '请检查文件', {}, { onIncomplete: () => notices++, onLoop: () => notices++ });
    assert.equal(f.calls.length, 1); assert.equal(notices, 0);
  }
  const f = fixture([{ text: '现在立即执行检查。' }]); let cancelled = false;
  await continuation.complete(f.session, f.acc, '请检查文件', {}, {
    shouldStop: () => cancelled, onContinue: () => { cancelled = true; },
  });
  assert.equal(f.calls.length, 1, 'cancel between attempts cannot send another prompt');
  const broken = fixture([{ text: 'Model service failed', stop: 'error' }]);
  const result = await continuation.complete(broken.session, broken.acc, '请检查文件', {});
  assert.equal(result.incomplete, false); assert.equal(broken.acc.status(), 'unreachable');
  broken.acc.markIncomplete('action-handoff');
  assert.equal(broken.acc.status(), 'unreachable', 'completion checks never mask a provider failure');
});

test('a current tool does not override explicit advice-only instructions or a rejected operation', async () => {
  const advice = fixture([{ text: '让我重新检查：', tool: true }]);
  assert.equal((await continuation.complete(advice.session, advice.acc, '只解释，不要执行', {})).continuations, 0);
  const denied = fixture([{ text: '让我重新检查：', tool: true, after(acc) {
    Object.assign(acc.state.tools.at(-1), { isError: true,
      result: 'Access denied by user or policy. Do not retry the same operation or bypass the restriction.' });
  } }]);
  assert.equal((await continuation.complete(denied.session, denied.acc, '请检查文件', {})).continuations, 0);
});

test('earlier messages and usage never turn a new empty response into idle', () => {
  const acc = stream.create();
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Earlier result.' } });
  acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { totalTokens: 200 } } });
  acc.push({ type: 'agent_settled' }); assert.equal(acc.status(), 'idle');
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'message_end', message: { role: 'user', content: 'New request.' } });
  acc.push({ type: 'agent_settled' });
  assert.equal(acc.status(), 'no-output');
  assert.equal(acc.snapshot().usage.totalTokens, 200, 'historical context waterline is still available');
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'auto_retry_start', attempt: 1, errorMessage: 'fetch failed' });
  acc.push({ type: 'agent_settled' }); assert.equal(acc.status(), 'unreachable');
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Recovered.' } });
  acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  acc.push({ type: 'agent_settled' }); assert.equal(acc.status(), 'idle');
});

test('input-only usage cannot stand in for output, while legacy totals and thinking remain compatible', () => {
  for (const usage of [
    { input: 20, output: 0, totalTokens: 20 },
    { input_tokens: 20, output_tokens: 0, total_tokens: 20 },
    { prompt_tokens: 20, completion_tokens: 0, totalTokens: 20 },
  ]) {
    const acc = stream.create(); acc.push({ type: 'agent_start' });
    acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage } });
    acc.push({ type: 'agent_settled' }); assert.equal(acc.status(), 'no-output');
  }
  for (const usage of [{ totalTokens: 20 }, { input: 20, output: 3, totalTokens: 23 }]) {
    const acc = stream.create(); acc.push({ type: 'agent_start' });
    acc.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Thinking content.' } });
    acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage } });
    acc.push({ type: 'agent_settled' }); assert.equal(acc.status(), 'idle');
  }
});
