const assert = require('node:assert/strict');
const stream = require('./event-stream');
const continuation = require('./output-continuation');

function fakeSession(acc, reasons) {
  const calls = [];
  return {
    calls,
    async prompt(text) {
      const reason = reasons[calls.length] || 'stop';
      calls.push(String(text || ''));
      acc.push({ type: 'agent_start' });
      acc.push({ type: 'message_end', message: { role: 'user', content: text } });
      acc.push({ type: 'message_update', assistantMessageEvent: {
        type: 'text_end', contentIndex: 0, content: '第' + calls.length + '段',
      } });
      acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: reason } });
      acc.push({ type: 'agent_settled' });
    },
  };
}

(async () => {
  const acc = stream.create();
  const session = fakeSession(acc, ['length', 'stop']);
  const result = await continuation.complete(session, acc, '请完整回答', { images: [] });
  assert.deepEqual(result, { continuations: 1, incomplete: false });
  assert.equal(session.calls.length, 2);
  assert.ok(continuation.isContinuationPrompt(session.calls[1]));
  assert.equal(acc.status(), 'idle');
  assert.equal(acc.state.auditFrom, -1, '自动续写不能误开目标复核区间');
  assert.equal(acc.snapshot().messages.filter((item) => item.role === 'user').length, 1,
    '内部续写提示不能出现在对话里');

  const cappedAcc = stream.create();
  const cappedSession = fakeSession(cappedAcc, ['length', 'length', 'length', 'stop']);
  const capped = await continuation.complete(cappedSession, cappedAcc, '写一个很长的答案', {}, {
    maxContinuations: 2,
  });
  assert.deepEqual(capped, { continuations: 2, incomplete: true });
  assert.equal(cappedSession.calls.length, 3, '最多只补两轮，不能无限循环');
  assert.equal(cappedAcc.status(), 'incomplete');

  const loopAcc = stream.create();
  const loopSession = {
    calls: 0,
    async prompt(text) {
      this.calls += 1;
      loopAcc.push({ type: 'agent_start' });
      loopAcc.push({ type: 'message_end', message: { role: 'user', content: text } });
      loopAcc.push({ type: 'message_start', message: { role: 'assistant' } });
      loopAcc.push({ type: 'message_update', assistantMessageEvent: {
        type: 'text_end', contentIndex: 0, content: [
          'I will read README now.',
          'Let me read README.',
          'Execute read README.',
          'Let me read README.',
          'Execute read README.',
        ].join('\n'),
      } });
      loopAcc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'length' } });
      loopAcc.push({ type: 'agent_settled' });
    },
  };
  const loopResult = await continuation.complete(loopSession, loopAcc, 'read the README', {}, {
    maxContinuations: 2,
  });
  assert.deepEqual(loopResult, { continuations: 0, incomplete: true, incompleteReason: 'output-loop' });
  assert.equal(loopSession.calls, 1,
    'repeated tool narration must stop before a continuation can amplify it');

  const thinkingOnlyAcc = stream.create();
  const thinkingOnlySession = {
    calls: 0,
    async prompt(text) {
      this.calls += 1;
      thinkingOnlyAcc.push({ type: 'agent_start' });
      thinkingOnlyAcc.push({ type: 'message_end', message: { role: 'user', content: text } });
      thinkingOnlyAcc.push({ type: 'message_start', message: { role: 'assistant' } });
      thinkingOnlyAcc.push({ type: 'message_update', assistantMessageEvent: {
        type: 'thinking_end', contentIndex: 0,
        content: '先规划实现细节，但还没有开始执行。',
      } });
      thinkingOnlyAcc.push({ type: 'message_end', message: {
        role: 'assistant', stopReason: 'length',
      } });
      thinkingOnlyAcc.push({ type: 'agent_settled' });
    },
  };
  const thinkingOnly = await continuation.complete(
    thinkingOnlySession, thinkingOnlyAcc, '制作一个网页游戏', {}, { maxContinuations: 2 });
  assert.deepEqual(thinkingOnly, {
    continuations: 0, incomplete: true, incompleteReason: 'reasoning-limit',
  });
  thinkingOnlyAcc.markIncomplete(thinkingOnly.incompleteReason);
  assert.equal(thinkingOnlyAcc.snapshot().status, 'incomplete');
  assert.match(thinkingOnlyAcc.snapshot().statusText, /单次输出上限.*检查模型管理中的最大输出量/);
  assert.match(thinkingOnlyAcc.snapshot().statusText, /部分模型不支持关闭思考/);
  assert.equal(thinkingOnlySession.calls, 1,
    'thinking-only length stops must not re-enter an automatic continuation loop');

  const terminalThinkingAcc = stream.create();
  const terminalThinkingSession = {
    calls: 0,
    async prompt(text) {
      this.calls += 1;
      terminalThinkingAcc.push({ type: 'agent_start' });
      terminalThinkingAcc.push({ type: 'message_end', message: { role: 'user', content: text } });
      terminalThinkingAcc.push({ type: 'message_end', message: {
        role: 'assistant', stopReason: 'length',
        content: [{ type: 'thinking', thinking: '终止事件才携带的完整思考内容。' }],
      } });
      terminalThinkingAcc.push({ type: 'agent_settled' });
    },
  };
  const terminalThinking = await continuation.complete(
    terminalThinkingSession, terminalThinkingAcc, '制作一个网页游戏', {}, { maxContinuations: 2 });
  assert.deepEqual(terminalThinking, {
    continuations: 0, incomplete: true, incompleteReason: 'reasoning-limit',
  });
  assert.equal(terminalThinkingSession.calls, 1,
    '完整内容只在 message_end 到达时也必须阻止重复续写');
  const semanticAcc = stream.create();
  const semanticCalls = [];
  const semanticSession = {
    async prompt(text) {
      const turn = semanticCalls.length;
      semanticCalls.push(String(text || ''));
      semanticAcc.push({ type: 'agent_start' });
      semanticAcc.push({ type: 'message_end', message: { role: 'user', content: text } });
      if (turn === 0) {
        semanticAcc.push({ type: 'message_start', message: { role: 'assistant' } });
        semanticAcc.push({ type: 'message_update', assistantMessageEvent: {
          type: 'text_end', contentIndex: 0, content: 'Read the current page first.',
        } });
        semanticAcc.push({ type: 'message_end', message: {
          role: 'assistant', stopReason: 'toolUse',
        } });
        semanticAcc.push({ type: 'tool_execution_start',
          toolCallId: 'semantic-tool', toolName: 'bash', args: { command: 'verify' } });
        semanticAcc.push({ type: 'tool_execution_end',
          toolCallId: 'semantic-tool', toolName: 'bash', isError: false,
          result: { content: [{ type: 'text', text: 'ok' }] } });
        semanticAcc.push({ type: 'message_start', message: { role: 'assistant' } });
        semanticAcc.push({ type: 'message_update', assistantMessageEvent: {
          type: 'text_end', contentIndex: 0,
          content: '\u6211\u5199\u9519\u4e86\u5e38\u91cf\u3002\u8ba9\u6211\u7528\u6b63\u786e\u5199\u6cd5\u91cd\u65b0\u67e5\u8be2\uff1a',
        } });
      } else {
        semanticAcc.push({ type: 'message_start', message: { role: 'assistant' } });
        semanticAcc.push({ type: 'message_update', assistantMessageEvent: {
          type: 'text_end', contentIndex: 0, content: 'The query and verification are complete.',
        } });
      }
      semanticAcc.push({ type: 'message_end', message: {
        role: 'assistant', stopReason: 'stop',
      } });
      semanticAcc.push({ type: 'agent_settled' });
    },
  };
  const semantic = await continuation.complete(
    semanticSession, semanticAcc, 'continue verification', { images: [] });
  assert.deepEqual(semantic, { continuations: 1, incomplete: false });
  assert.equal(semanticCalls.length, 2,
    'a tool-backed action hand-off should continue automatically');
  assert.ok(continuation.isContinuationPrompt(semanticCalls[1]));
  assert.match(semanticCalls[1], /\u7acb\u5373\u6267\u884c\u521a\u624d\u627f\u8bfa\u7684\u52a8\u4f5c/);
  assert.equal(semanticAcc.snapshot().messages.filter((item) => item.role === 'user').length, 1,
    'the semantic continuation prompt must stay out of the conversation');

  const advisoryAcc = stream.create();
  const advisorySession = {
    calls: 0,
    async prompt(text) {
      this.calls += 1;
      advisoryAcc.push({ type: 'agent_start' });
      advisoryAcc.push({ type: 'message_end', message: { role: 'user', content: text } });
      advisoryAcc.push({ type: 'message_start', message: { role: 'assistant' } });
      advisoryAcc.push({ type: 'message_update', assistantMessageEvent: {
        type: 'text_end', contentIndex: 0, content: 'Let me check again:',
      } });
      advisoryAcc.push({ type: 'message_end', message: {
        role: 'assistant', stopReason: 'stop',
      } });
      advisoryAcc.push({ type: 'agent_settled' });
    },
  };
  const advisory = await continuation.complete(
    advisorySession, advisoryAcc, 'advice only', { images: [] });
  assert.deepEqual(advisory, { continuations: 0, incomplete: false });
  assert.equal(advisorySession.calls, 1,
    'an advisory answer without tools must not become an autonomous loop');

  const noisyAcc = stream.create();
  const noisyCalls = [];
  const noisySession = {
    async prompt(text) {
      noisyCalls.push(String(text || ''));
      noisyAcc.push({ type: 'agent_start' });
      noisyAcc.push({ type: 'message_start', message: { role: 'assistant' } });
      const touched = noisyAcc.push({ type: 'message_update', assistantMessageEvent: {
        type: 'text_end', contentIndex: 0,
        content: '正在验证。\n' + Array.from({ length: 20 }, () => 'user').join('\n\n'),
      } });
      assert.equal(touched.kind, 'protocol-leak');
      noisyAcc.push({ type: 'message_end', message: {
        role: 'assistant', stopReason: 'length',
      } });
      noisyAcc.push({ type: 'agent_settled' });
    },
  };
  const guarded = await continuation.complete(noisySession, noisyAcc, '继续完成工作', {}, {
    shouldStop: () => Boolean(noisyAcc.state.protocolIssue),
  });
  assert.deepEqual(guarded, { continuations: 0, incomplete: true });
  assert.equal(noisyCalls.length, 1, '异常重复输出不能触发自动续写继续放大');
  assert.doesNotMatch(JSON.stringify(noisyAcc.snapshot().messages), /(?:^|\\n)user(?:\\n|$)/i);

  const promiseAcc = stream.create();
  const promiseCalls = [];
  const promiseSession = {
    async prompt(text) {
      const turn = promiseCalls.length;
      promiseCalls.push(String(text || ''));
      promiseAcc.push({ type: 'agent_start' });
      promiseAcc.push({ type: 'message_end', message: { role: 'user', content: text } });
      if (turn === 0) {
        promiseAcc.push({ type: 'tool_execution_start',
          toolCallId: 'promise-tool', toolName: 'bash', args: { command: 'verify' } });
        promiseAcc.push({ type: 'tool_execution_end',
          toolCallId: 'promise-tool', toolName: 'bash', isError: false,
          result: { content: [{ type: 'text', text: 'ok' }] } });
        promiseAcc.push({ type: 'message_start', message: { role: 'assistant' } });
        promiseAcc.push({ type: 'message_update', assistantMessageEvent: {
          type: 'text_end', contentIndex: 0,
          content: '刚才的验证还缺最后一步。让我重新发出验证命令确认无报错。',
        } });
      } else {
        promiseAcc.push({ type: 'message_start', message: { role: 'assistant' } });
        promiseAcc.push({ type: 'message_update', assistantMessageEvent: {
          type: 'text_end', contentIndex: 0, content: '验证完成，结果可正常使用。',
        } });
      }
      promiseAcc.push({ type: 'message_end', message: {
        role: 'assistant', stopReason: 'stop',
      } });
      promiseAcc.push({ type: 'agent_settled' });
    },
  };
  const promised = await continuation.complete(
    promiseSession, promiseAcc, '完成验证', { images: [] });
  assert.deepEqual(promised, { continuations: 1, incomplete: false });
  assert.equal(promiseCalls.length, 2,
    'a full-stop action promise must continue without waiting for the user');
  assert.ok(continuation.isContinuationPrompt(promiseCalls[1]));

  process.stdout.write('  PASS  output continuation 4 项全过\n');


function makeArchiveBase(acc, usages, seen) {
  return {
    model: { contextWindow: 128000, maxTokens: 32768 },
    settingsManager: { applyOverrides() {} },
    sessionManager: {
      getBranch() { return [{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '做一个大工程' }] } }]; },
      appendCustomEntry(type, data) { seen.push({ type, data }); return {}; },
      appendCompaction(summary) { seen.push({ compaction: String(summary || '').length }); return {}; },
      buildSessionContext() { return { messages: [{ role: 'user', content: [{ type: 'text', text: '压缩后的上下文' }] }] }; },
      getSessionFile() { return '/tmp/archive.jsonl'; },
    },
    agent: { state: { messages: [] } },
    async setModel() {},
    async sendCustomMessage(message) {
      seen.push({ customType: message.customType });
      acc.push({ type: 'message_end', message: { role: 'user', content: '压缩后继续' } });
      await this.prompt();
    },
    async prompt(text) {
      seen.push(String(text || ''));
      const u = usages[Math.min(seen.filter(x => typeof x === 'string').length, usages.length) - 1] || usages[usages.length - 1];
      acc.push({ type: 'agent_start' });
      acc.push({ type: 'message_end', message: { role: 'user', content: text } });
      acc.push({ type: 'message_start', message: { role: 'assistant' } });
      acc.push({ type: 'message_end', message: {
        role: 'assistant', stopReason: u.stop || 'length', usage: u.usage || u,
        content: [{ type: 'thinking', text: '只写了开头' }],
      } });
      acc.push({ type: 'agent_settled' });
    },
  };
}
{
  const seen = [];
  const acc = stream.create();
  // Recover the initial silent overflow and complete the retried request normally.
  const session = makeArchiveBase(acc, [
    { stop: 'length', usage: { input: 127018, output: 1 } },
    { stop: 'stop', usage: { input: 12000, output: 500 } },
  ], seen);
  const result = await continuation.complete(session, acc, '继续完成任务', { images: [] });
  assert.deepEqual(result, { continuations: 0, incomplete: false });
  assert.ok(seen.some(e => e && e.compaction), '静默溢出必须走免 LLM 的抽取式压缩');
  assert.equal(seen.filter(x => typeof x === 'string').length, 2, '压缩后自动重发一次，不靠续写提示');
  assert.equal(acc.status(), 'idle');
}
{
  const seen = [];
  const acc = stream.create();
  // If silent overflow persists after recovery, stop with a readable context-full result.
  const session = makeArchiveBase(acc, [
    { stop: 'length', usage: { input: 127018, output: 1 } },
    { stop: 'length', usage: { input: 127100, output: 1 } },
  ], seen);
  const result = await continuation.complete(session, acc, '继续完成任务', { images: [] });
  assert.deepEqual(result, { continuations: 0, incomplete: true, incompleteReason: 'context-full' });
  // Verify that session handling publishes incompleteReason so the queue banner explains the failure.
  acc.markIncomplete(result.incompleteReason);
  assert.equal(acc.status(), 'incomplete');
  assert.match(acc.snapshot().statusText, /上下文窗口/);
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
