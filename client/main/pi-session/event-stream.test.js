/* Offline regressions for Pi event-stream normalization: verify the two contracts without Electron,
   network access, or an installed Pi SDK. The event-stream module defines the event and state contracts. */
const assert = require('node:assert/strict');
const stream = require('./event-stream');
const outputContinuation = require('./output-continuation');
const goalQuality = require('../conversation/goal-quality');
const goalLoop = require('../conversation/goal-loop');
const protocolGuard = require('../agent-runtime/protocol-guard');
const stallRecovery = require('./stall-recovery');
const attachmentContract = require('./attachment-contract');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  PASS  ${name}\n`);
}

/* Thinking and text interleave; thinking_end may follow text_start. */
const INTERLEAVED = [
  { type: 'message_start' },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '先想一下' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '我能' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '先想一下要说什么' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '读写文件' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: '我能读写文件' } },
  { type: 'message_end', message: { usage: { input: 1597, output: 69, totalTokens: 1666 } } },
  { type: 'agent_settled' },
];

function feed(events) {
  const acc = stream.create();
  events.forEach((e) => acc.push(e));
  return acc;
}

check('★交错的 thinking 与 text 按 contentIndex 分成两块，不串成一锅', () => {
  const snap = feed(INTERLEAVED).snapshot();
  const blocks = snap.messages[0].blocks;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'thinking');
  assert.equal(blocks[0].text, '先想一下要说什么');
  assert.equal(blocks[1].kind, 'text');
  assert.equal(blocks[1].text, '我能读写文件');
});

check('★contentIndex 为 0 是合法下标，不能被当成"没给"', () => {
  const acc = feed([
    { type: 'message_start' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'a' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'c' } },
  ]);
  const blocks = acc.snapshot().messages[0].blocks;
  assert.deepEqual(blocks.map((b) => b.index), [0, 2]);
  assert.equal(blocks[0].text, 'a');
});

check('*_end 带的完整内容覆盖逐字拼接（逐字有丢字风险，*_end 没有）', () => {
  const acc = feed([
    { type: 'message_start' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '半截' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '完整的一整句' } },
  ]);
  assert.equal(acc.snapshot().messages[0].blocks[0].text, '完整的一整句');
});

check('正常跑完一轮＝idle，正文和 usage 都在', () => {
  const acc = feed(INTERLEAVED);
  assert.equal(acc.status(), 'idle');
  assert.equal(acc.snapshot().usage.totalTokens, 1666);
  assert.equal(acc.snapshot().statusText, '');
});

check('usage update reaches the snapshot before the message ends', () => {
  const acc = feed([
    { type: 'message_start' },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_delta', contentIndex: 0, delta: 'live',
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    } },
  ]);
  const snap = acc.snapshot();
  assert.equal(snap.usage.output_tokens, 3);
  assert.equal(snap.messages[0].usage.total_tokens, 15);
});

check('★有半截正文但 stopReason=length 仍是 incomplete，不许伪装完成', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0, content: '这是一条还没说完的回答',
    } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'length',
      usage: { input: 10, output: 20, totalTokens: 30 } } },
    { type: 'agent_settled' },
  ]);
  assert.equal(acc.status(), 'incomplete');
  assert.equal(acc.snapshot().completion.reason, 'length');
  assert.match(acc.snapshot().statusText, /输出长度上限/);
});

check('★有部分正文但 provider 报错仍是失败，并保留真实错误', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0, content: '已经回答了一半',
    } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'error',
      errorMessage: 'upstream connection reset' } },
    { type: 'agent_settled' },
  ]);
  assert.equal(acc.status(), 'unreachable');
  assert.match(acc.snapshot().statusText, /回答过程中中断/);
  assert.match(acc.snapshot().statusText, /模型服务暂时不可用/);
  assert.equal(acc.snapshot().completion.retryable, true);
  assert.match(acc.state.lastAssistantError, /connection reset/);
});

check('★SoduWork 代理 503 只展示人话，不泄露代理 JSON 或上游细节', () => {
  const raw = '503: {"message":"HTTP 503","type":"soduwork_work_proxy_error","code":503,' +
    '"upstream":"upstream connect error or disconnect/reset before headers. ' +
    'retried and the latest reset reason: connection timeout"}';
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: raw } },
    { type: 'agent_settled' },
  ]);
  const snap = acc.snapshot();
  assert.equal(snap.status, 'unreachable');
  assert.match(snap.statusText, /暂时不可用|超时|HTTP 503/);
  assert.doesNotMatch(snap.statusText, /soduwork_work_proxy_error|upstream connect|connection timeout/);
  assert.doesNotMatch(JSON.stringify(snap), /soduwork_work_proxy_error|upstream connect|connection timeout/);
  assert.match(acc.state.lastAssistantError, /soduwork_work_proxy_error/);
});
check('新一轮会清掉上一轮 length，正常结束后恢复 idle', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'length' } },
    { type: 'agent_settled' },
  ]);
  assert.equal(acc.status(), 'incomplete');
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_end', contentIndex: 0, content: '现在完整了',
  } });
  acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  acc.push({ type: 'agent_settled' });
  assert.equal(acc.status(), 'idle');
});

check('message_end 携带完整 thinking 时也能识别长度截断，避免重复自动续写', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_end', message: {
      role: 'assistant', stopReason: 'length',
      content: [{ type: 'thinking', thinking: '模型一直在思考，还没有给出答案。' }],
    } },
    { type: 'agent_settled' },
  ]);
  assert.equal(acc.state.messages[0].blocks[0].kind, 'thinking');
  assert.match(acc.state.messages[0].blocks[0].text, /一直在思考/);
  assert.equal(acc.status(), 'incomplete');
});

check('★重试三次后正文空、usage 全 0 ⇒ unreachable，不是"没话说"', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: 'fetch failed' },
    { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, errorMessage: 'fetch failed' },
    { type: 'auto_retry_start', attempt: 3, maxAttempts: 3, errorMessage: 'fetch failed' },
    { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'fetch failed' },
    { type: 'message_end', message: { usage: { input: 0, output: 0, totalTokens: 0 } } },
    { type: 'agent_settled' },
  ]);
  assert.equal(acc.status(), 'unreachable');
  assert.match(acc.snapshot().statusText, /连不上模型服务/);
  assert.match(acc.snapshot().statusText, /模型服务暂时不可用/);
  assert.match(acc.state.retryError, /fetch failed/);
  assert.match(acc.snapshot().statusText, /代理/);        // Provide an actionable diagnostic next step.
});

check('重试过但最终答上来了 ⇒ 还是 idle，别把成功的一轮报成打不通', () => {
  const acc = feed([
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: '529 overloaded' },
    { type: 'auto_retry_end', success: true, attempt: 2 },
    ...INTERLEAVED,
  ]);
  assert.equal(acc.status(), 'idle');
});

check('没 settled 时是 streaming，界面才知道要转圈', () => {
  const acc = feed(INTERLEAVED.slice(0, 4));
  assert.equal(acc.status(), 'streaming');
});

check('工具执行：start/update/end 收成一条，partialResult 是累计值所以覆盖不追加', () => {
  const acc = feed([
    { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls -la' } },
    { type: 'tool_execution_update', toolCallId: 'c1', partialResult: { content: [{ type: 'text', text: 'total 4' }] } },
    { type: 'tool_execution_update', toolCallId: 'c1', partialResult: { content: [{ type: 'text', text: 'total 488\na.js' }] } },
    { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'total 488\na.js\nb.js' }] } },
  ]);
  const tools = acc.snapshot().tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'bash');
  assert.equal(tools[0].args.command, 'ls -la');
  assert.equal(tools[0].partial, 'total 488\na.js');       // Replace cumulative output rather than concatenating repeated prefixes.
  assert.equal(tools[0].result, 'total 488\na.js\nb.js');
  assert.equal(tools[0].state, 'done');
});

check('★工具记着自己属于哪一轮（否则多轮之后全堆在最末尾）', () => {
  const acc = feed([
    ...INTERLEAVED,                                        // The first turn contains one assistant message.
    { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read' },
    { type: 'message_start' },                             // Start the second turn.
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '第二轮' } },
    { type: 'message_end', message: { role: 'assistant' } },
    { type: 'tool_execution_start', toolCallId: 'b', toolName: 'write' },
  ]);
  const tools = acc.snapshot().tools;
  assert.equal(tools.length, 2);
  assert.ok(tools[0].after < tools[1].after, JSON.stringify(tools.map((t) => t.after)));
});

check('工具报错标成 error，界面能红出来', () => {
  const acc = feed([
    { type: 'tool_execution_start', toolCallId: 'c9', toolName: 'read' },
    { type: 'tool_execution_end', toolCallId: 'c9', isError: true, result: { content: [{ type: 'text', text: 'ENOENT' }] } },
  ]);
  assert.equal(acc.snapshot().tools[0].state, 'error');
});

check('★扩展要人回答时挂起成 waiting-user（对话有人在场，该问就问）', () => {
  const acc = feed([
    { type: 'message_start' },
    { type: 'extension_ui_request', id: 'u1', method: 'confirm', title: '要删掉这个目录吗？' },
  ]);
  assert.equal(acc.status(), 'waiting-user');
  assert.equal(acc.snapshot().pendingUi.method, 'confirm');
  acc.answerUi();
  assert.notEqual(acc.status(), 'waiting-user');
});

check('★上游 404（模型名不存在）：一次重试都没有、正文空 ⇒ no-output，不能装作没事', () => {
  // A gateway can return 404 when its configured upstream model is unavailable.
  // A 404 is not retryable, so Pi emits no auto_retry; the previous idle-state classification hid the error.
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'user' } },
    { type: 'message_end', message: { role: 'user', content: '帮我把桌面整理一下' } },
    { type: 'turn_failed', errorMessage: 'The model `fixture-missing-model` does not exist.' },
    { type: 'agent_settled' },
  ]);
  assert.equal(acc.status(), 'no-output');
  assert.ok(/没吐出任何内容/.test(acc.snapshot().statusText), acc.snapshot().statusText);
  assert.ok(/fixture-missing-model/.test(acc.snapshot().statusText), '要把上游原话带出来');
});

check('★运行时通知随用户新一轮清除：256 上限提示不能钉死在后续对话里', () => {

  // This error notification remains pinned above new messages when the user continues the conversation.
  const acc = stream.create();
  acc.appendNotice('本轮已达到 256 次工具调用安全上限。为避免失败重试持续增加，SoduWork 已停止本轮；已有进度和文件都已保留。', 'error');
  assert.equal(acc.snapshot().notices.length, 1);
  acc.push({ type: 'message_end', message: { role: 'user', content: '继续' } });
  assert.equal(acc.snapshot().notices.length, 0, '新一轮用户消息应清掉上一轮的运行时通知');
});

check('★没起过轮次的空会话还是 idle（别一打开就报"没产出"）', () => {
  const acc = feed([{ type: 'agent_settled' }]);
  assert.equal(acc.status(), 'idle');
})

check('a new empty session is immediately ready for input', () => {
  const acc = stream.create();
  assert.equal(acc.status(), 'idle');
  assert.equal(acc.snapshot().messages.length, 0);
})

check('message_start marks an empty session as streaming', () => {
  const acc = stream.create();
  acc.push({ type: 'message_start', message: { role: 'assistant' } });
  assert.equal(acc.status(), 'streaming');
});;;

check('notify 这类只通知不等回答的，不许把会话卡住', () => {
  const acc = feed([
    { type: 'extension_ui_request', id: 'u2', method: 'notify', message: '命令被拦下了' },
    { type: 'agent_settled' },
  ]);
  assert.equal(acc.status(), 'idle');
});

check('压缩中单独一档，别让人以为卡死', () => {
  const acc = feed([{ type: 'compaction_start', reason: 'threshold' }]);
  assert.equal(acc.status(), 'compacting');
  acc.push({ type: 'compaction_end', reason: 'threshold' });
  acc.push({ type: 'agent_settled' });
  assert.equal(acc.status(), 'idle');
});

check('★第二轮开始时状态要回到 streaming（settled 不清会让「正在想」永远不出现）', () => {
  const acc = feed(INTERLEAVED);
  assert.equal(acc.status(), 'idle');            // Complete the first turn.
  acc.push({ type: 'agent_start' });             // Start the second turn.
  assert.equal(acc.status(), 'streaming');
  acc.push({ type: 'agent_settled' });
  assert.equal(acc.status(), 'no-output', '上一轮的正文不能冒充本轮实际产出');
});

check('叫停之后再发一轮，不该还挂着 aborted', () => {
  const acc = feed(INTERLEAVED);
  acc.abort();
  assert.equal(acc.status(), 'aborted');
  acc.push({ type: 'agent_start' });
  assert.equal(acc.status(), 'streaming');
});

check('★用户那条消息如实记成 user，不当成助手（否则界面多出空气泡）', () => {
  const acc = feed([
    { type: 'message_start', message: { role: 'user' } },
    { type: 'message_end', message: { role: 'user', content: '帮我看看这个文件' } },
    ...INTERLEAVED,
  ]);
  const msgs = acc.snapshot().messages;
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].text, '帮我看看这个文件');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs.length, 2);            // Preserve exactly the expected messages without empty shells.
});

check('user 的 content 是内容块数组时也取得出正文', () => {
  const acc = feed([
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '两段' }, { type: 'text', text: '拼起来' }] } },
  ]);
  assert.equal(acc.snapshot().messages[0].text, '两段\n拼起来');
});

check('目标模式内部交付复核不进入用户可见消息', () => {
  const acc = feed([
    { type: 'message_end', message: { role: 'user', content:
      '<soduwork-internal-goal-audit>\n内部复核\n</soduwork-internal-goal-audit>' } },
  ]);
  assert.equal(acc.snapshot().messages.length, 0);
});

check('目标循环的自动修订指令不伪装成用户消息', () => {
  const prompt = goalLoop.cyclePrompt(goalLoop.compile({ goal: '交付可运行网站' }), {
    reason: '缺少真实启动证据', gaps: [{ check: 'launch', reason: '服务未启动' }],
  });
  const acc = feed([
    { type: 'message_end', message: { role: 'user', content: prompt } },
  ]);
  assert.equal(acc.snapshot().messages.length, 0);
  acc.endGoalTurn();
  acc.push({ type: 'message_end', message: { role: 'user', content: '现在可以打开了吗' } });
  assert.equal(acc.snapshot().messages.at(-1).text, '现在可以打开了吗');
});

check('交付复核机器标记不泄露到最终可见答复', () => {
  const acc = feed([
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
      content: '<!-- soduwork-delivery-audit:pass -->\n已交付完整网站' } },
  ]);
  assert.equal(acc.snapshot().messages[0].blocks[0].text, '已交付完整网站');
});

check('内部复核分析不闪给用户，独占一行的结论后只显示正式交付', () => {
  const acc = feed([
    { type: 'message_end', message: { role: 'user', content:
      '<soduwork-internal-goal-audit>\n内部复核\n</soduwork-internal-goal-audit>' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
      content: '先检查文件和测试，目前还在分析。' } },
  ]);
  assert.equal(acc.snapshot().messages.length, 0);
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '先检查文件和测试。\n\n<!-- soduwork-delivery-audit:pass -->\n已交付并验证。' } });
  acc.revealAudit();
  assert.equal(acc.snapshot().messages[0].blocks[0].text, '已交付并验证。');
});

check('目标复核开始后收起首轮草稿，只留下通过复核的最终交付', () => {
  const acc = feed([
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
      content: '首轮声称已完成，但还没有经过复核。' } },
    { type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 1 } } },
  ]);
  assert.equal(acc.snapshot().messages.length, 1);
  acc.beginAudit();
  assert.equal(acc.snapshot().messages.length, 0);
  acc.push({ type: 'message_end', message: { role: 'user', content:
    '<soduwork-internal-goal-audit>\n内部复核\n</soduwork-internal-goal-audit>' } });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '<!-- soduwork-delivery-audit:pass -->\n最终交付已经验证。' } });
  acc.revealAudit();
  assert.equal(acc.snapshot().messages.length, 1);
  assert.equal(acc.snapshot().messages[0].blocks[0].text, '最终交付已经验证。');
});

check('目标首轮正文从一开始就是待复核草稿，不在复核前闪成最终答案', () => {
  const acc = feed([]);
  acc.beginGoalTurn();
  acc.push({ type: 'message_end', message: { role: 'user', content: '交付完整网站' } });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '我先声称做好了。' } });
  assert.deepEqual(acc.snapshot().messages.map((item) => item.role), ['user']);
  acc.push({ type: 'message_end', message: { role: 'user', content:
    '<soduwork-internal-goal-audit>\n内部复核\n</soduwork-internal-goal-audit>' } });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '<!-- soduwork-delivery-audit:pass -->\n这是唯一的最终交付。' } });
  acc.revealAudit();
  assert.equal(acc.snapshot().messages.at(-1).blocks[0].text, '这是唯一的最终交付。');
});

check('机器证据未过时撤回错误通过，补缺后只展示最后一次结论', () => {
  const acc = feed([]);
  acc.beginGoalTurn();
  acc.push({ type: 'message_end', message: { role: 'user', content: '交付完整网站' } });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '<!-- soduwork-delivery-audit:pass -->\n第一次误判完成。' } });
  acc.push({ type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 1 } } });
  acc.rejectAudit();
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '<!-- soduwork-delivery-audit:pass -->\n补齐并复核后的交付。' } });
  acc.revealAudit();
  const visible = acc.snapshot().messages.flatMap((item) => item.blocks || [])
    .map((item) => item.text).filter(Boolean).join('\n');
  assert.doesNotMatch(visible, /第一次误判/);
  assert.match(visible, /补齐并复核后的交付/);
});

check('目标交付完成后，后续普通对话恢复可见且不重新跑旧目标', () => {
  const acc = feed([]);
  acc.beginGoalTurn();
  acc.push({ type: 'message_end', message: { role: 'user', content: '交付完整网站' } });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '首轮实现草稿。' } });
  acc.beginAudit();
  acc.push({ type: 'message_end', message: { role: 'user', content:
    '<soduwork-internal-goal-audit>复核</soduwork-internal-goal-audit>' } });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '<!-- soduwork-delivery-audit:pass -->\n最终交付已验证。' } });
  acc.revealAudit();

  acc.push({ type: 'message_end', message: { role: 'user',
    content: goalQuality.normalPrompt('再告诉我如何使用') } });
  acc.push({ type: 'message_start' });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '打开首页即可使用。' } });
  acc.push({ type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 2 } } });

  const snapshot = acc.snapshot();
  assert.equal(snapshot.messages.at(-2).text, '再告诉我如何使用');
  assert.equal(snapshot.messages.at(-1).blocks[0].text, '打开首页即可使用。');
  assert.match(JSON.stringify(snapshot.messages), /最终交付已验证/);
});


check('隐藏的目标复核消息不会把上一轮工具漂到下一轮回复后面', () => {
  const acc = feed([]);
  acc.beginGoalTurn();
  acc.push({ type: 'message_end', message: { role: 'user', content: '完成一个网站' } });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '内部实施过程' } });
  acc.push({ type: 'message_end', message: { role: 'assistant' } });
  acc.push({ type: 'tool_execution_start', toolCallId: 'old-bash', toolName: 'bash' });
  acc.push({ type: 'tool_execution_end', toolCallId: 'old-bash', toolName: 'bash',
    result: { content: [{ type: 'text', text: 'done' }] } });
  acc.endGoalTurn();
  acc.push({ type: 'message_end', message: { role: 'user', content: '完事了吗' } });
  acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0,
    content: '已经完成。' } });
  acc.push({ type: 'message_end', message: { role: 'assistant' } });

  const snap = acc.snapshot();
  assert.deepEqual(snap.messages.map((item) => item.role), ['user', 'user', 'assistant']);
  assert.equal(snap.tools[0].after, 0);
  assert.ok(snap.tools[0].after < snap.messages.findIndex((item) => item.text === '完事了吗'));
});
check('继续目标的内部控制提示不显示给用户', () => {
  const prompt = goalQuality.continuationPrompt(
    { goal: '交付完整网站', acceptance: '能够打开' }, { kind: 'tools' });
  const snap = feed([
    { type: 'message_end', message: { role: 'user', content: prompt } },
  ]).snapshot();
  assert.equal(snap.messages.length, 0);
});

check('toolResult 那条不进消息列表（工具已经单独收着了）', () => {
  const acc = feed([
    { type: 'message_end', message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'x' }] } },
  ]);
  assert.equal(acc.snapshot().messages.length, 0);
});

check('没见过的事件一律忽略，不许抛（新版 pi 随时会加事件）', () => {
  const acc = stream.create();
  assert.doesNotThrow(() => {
    acc.push({ type: 'some_future_event', whatever: 1 });
    acc.push(null);
    acc.push('不是对象');
  });
});

check('输入附件只回显文件名，不把受管绝对路径暴露到聊天正文', () => {
  const marker = ['请分析截图', '', '<soduwork-input-attachments>',
    JSON.stringify({ files: [{ name: '页面截图.png', path: 'C:/private/.soduwork-inputs/x.png',
      type: 'image/png', size: 128 }] }),
    '</soduwork-input-attachments>'].join(String.fromCharCode(10));
  const snap = feed([
    { type: 'message_end', message: { role: 'user', content: marker } },
  ]).snapshot();
  assert.equal(snap.messages[0].text, '请分析截图');
  assert.deepEqual(snap.messages[0].attachments, [
    { name: '页面截图.png', type: 'image/png', size: 128,
      previewRef: attachmentContract.previewRef('C:/private/.soduwork-inputs/x.png') },
  ]);
  assert.equal(JSON.stringify(snap.messages[0]).includes('C:/private'), false);
  assert.equal(attachmentContract.previewPath(snap.messages[0].attachments[0].previewRef),
    'C:/private/.soduwork-inputs/x.png');
});

check('损坏的 DSML 工具协议被隔离，不进入任何可见消息或状态快照', () => {
  const dump = Array.from({ length: 8 }, (_, index) =>
    '<|DSML|parameter name=' + String.fromCharCode(34) + 'extra' + (index + 63) +
    String.fromCharCode(34) + '>e</|DSML|parameter>').join(String.fromCharCode(10));
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_start' },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_delta', contentIndex: 0, delta: '已完成前置检查。' + String.fromCharCode(10) + dump,
    } },
  ]);
  const snap = acc.snapshot();
  assert.equal(snap.status, 'unreachable');
  assert.match(snap.statusText, /内部工具协议/);
  assert.equal(snap.messages[0].blocks[0].text, '已完成前置检查。');
  assert.doesNotMatch(JSON.stringify(snap), /DSML|extra63/);
  assert.doesNotMatch(JSON.stringify(acc.state), /DSML|extra63/);
  assert.equal(snap.completion.protocolIssue.code, protocolGuard.CODE);
});

check('跨多个流片段的 DSML 起始符不会先闪到聊天区', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_start' },
  ]);
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0,
    delta: '正在继续。' + String.fromCharCode(10) + '< | DS',
  } });
  assert.equal(acc.snapshot().messages[0].blocks[0].text,
    '正在继续。' + String.fromCharCode(10));
  const touched = acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0,
    delta: 'ML | parameter name=' + String.fromCharCode(34) +
      'extra90' + String.fromCharCode(34) + '>e</ | DSML | parameter>',
  } });
  assert.equal(touched.kind, 'protocol-leak');
  assert.equal(acc.snapshot().messages[0].blocks[0].text, '正在继续。');
  assert.doesNotMatch(JSON.stringify(acc.snapshot()), /DSML|extra90/);
});

check('★Pi 退化成连续角色标记时从第一行起缓冲，第 12 行立即隔离', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant' } },
  ]);
  const prefix = '已完成前置操作，正在核对结果。';
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0,
    delta: prefix + '\n' + Array.from({ length: 4 }, () => 'user').join('\n\n'),
  } });
  assert.equal(acc.snapshot().messages[0].blocks[0].text.trim(), prefix,
    '可疑角色标记应先缓冲，不能闪到聊天区');
  const touched = acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0,
    delta: '\n\n' + Array.from({ length: 8 }, () => 'user').join('\n\n'),
  } });
  const snap = acc.snapshot();
  assert.equal(touched.kind, 'protocol-leak');
  assert.equal(snap.status, 'unreachable');
  assert.match(snap.statusText, /重复输出内部角色标记/);
  assert.equal(snap.messages[0].blocks[0].text, prefix);
  assert.doesNotMatch(JSON.stringify(snap.messages), /(?:^|\\n)user(?:\\n|$)/i);
  assert.equal(snap.completion.protocolIssue.code, protocolGuard.REPETITION_CODE);
});

check('代码围栏中的角色标签样例不触发退化输出防护', () => {
  const text = [
    '下面是协议角色示例：',
    '```text',
    ...Array.from({ length: 20 }, () => 'user'),
    '```',
  ].join('\n');
  const inspected = protocolGuard.inspect(text, { final: true });
  assert.equal(inspected.detected, false);
  assert.equal(inspected.text, text);
});

check('Pi 的 system/invoke 私有协议跨流片段时被整体隔离，命令不闪进聊天', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_start' },
  ]);
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0, delta: '先精确读取当前状态。\n<sys',
  } });
  assert.equal(acc.snapshot().messages[0].blocks[0].text, '先精确读取当前状态。\n');
  const touched = acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0,
    delta: 'tem>Use tools</system>\n<invoke name="bash">\n' +
      '<parameter name="command">cd C:/work && node -e "inspect()"</parameter>\n</invoke>',
  } });
  const snap = acc.snapshot();
  assert.equal(touched.kind, 'protocol-leak');
  assert.equal(snap.messages[0].blocks[0].text, '先精确读取当前状态。');
  assert.doesNotMatch(JSON.stringify(snap), /<system>|<invoke|<parameter|node -e/);
  assert.equal(snap.completion.protocolIssue.code, protocolGuard.CODE);
});

check('代码围栏里的 invoke XML 示例仍是正常正文，不被协议隔离误伤', () => {
  const text = [
    '下面只是 XML 示例：',
    '```xml',
    '<invoke name="search">',
    '<parameter name="query">SoduWork</parameter>',
    '</invoke>',
    '```',
  ].join('\n');
  const acc = feed([
    { type: 'message_start' },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0, content: text,
    } },
    { type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 8 } } },
    { type: 'agent_settled' },
  ]);
  assert.equal(acc.snapshot().messages[0].blocks[0].text, text);
  assert.equal(acc.snapshot().completion.protocolIssue, null);
});

check('repeated prospective tool narration is quarantined', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant' } },
  ]);
  const text = [
    'I will read README now.',
    'Let me read README.',
    'Execute read README.',
    'Let me read README.',
    'Execute read README.',
  ].join('\n');
  const touched = acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_end', contentIndex: 0, content: text,
  } });
  const snap = acc.snapshot();
  assert.equal(touched.kind, 'protocol-leak');
  assert.equal(snap.completion.protocolIssue.code, protocolGuard.DEGENERATE_OUTPUT_CODE);
  assert.equal(snap.status, 'unreachable');
  assert.doesNotMatch(JSON.stringify(snap.messages), /Let me read README\\./);
});

check('automatic continuation is hidden and merged into one assistant response', () => {
  const acc = feed([
    { type: 'message_end', message: { role: 'user', content: 'write a complete answer' } },
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0, content: 'first part',
    } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'length' } },
    { type: 'message_end', message: {
      role: 'user', content: outputContinuation.continuationPrompt(1, 'length'),
    } },
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0, content: 'second part',
    } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } },
    { type: 'agent_settled' },
  ]);
  const messages = acc.snapshot().messages;
  assert.equal(messages.length, 2);
  assert.match(messages[1].blocks.map((block) => block.text).join(''), /first part/);
  assert.match(messages[1].blocks.map((block) => block.text).join(''), /second part/);
  assert.doesNotMatch(JSON.stringify(messages), /soduwork-internal-output-continue/);
});
check('runtime stall recovery stays hidden while the resumed answer is visible', () => {
  const prompt = stallRecovery.normalPrompt('finish the website', 'provider stream stalled');
  const acc = feed([
    { type: 'message_end', message: { role: 'user', content: prompt } },
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0, content: 'Resumed from the checkpoint and finished.',
    } },
    { type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 6 } } },
    { type: 'agent_settled' },
  ]);
  const snap = acc.snapshot();
  assert.equal(snap.messages.length, 1);
  assert.equal(snap.messages[0].scope, stream.SCOPES.NORMAL);
  assert.equal(snap.messages[0].blocks[0].text, 'Resumed from the checkpoint and finished.');
  assert.doesNotMatch(JSON.stringify(snap), /soduwork-internal-runtime-recovery/);
});

check('goal stall recovery remains internal and clears the aborted state', () => {
  const prompt = stallRecovery.goalPrompt(goalQuality, {
    objective: 'deliver the website', acceptance: ['homepage opens'],
  }, 'provider stream stalled');
  const acc = feed([
    { type: 'message_end', message: { role: 'user', content: prompt } },
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_delta', contentIndex: 0, delta: 'internal recovery output',
    } },
  ]);
  assert.equal(acc.state.currentScope, stream.SCOPES.GOAL_EXECUTION);
  acc.abort();
  assert.equal(acc.status(), 'aborted');
  acc.recoverRuntime();
  assert.equal(acc.state.aborted, false);
  assert.equal(acc.state.settled, true);
  assert.equal(acc.state.messages[0].done, true);
  assert.doesNotMatch(JSON.stringify(acc.snapshot()), /soduwork-internal-runtime-recovery/);
});

check('普通对话的协议恢复提示隐藏，恢复答复仍按正常对话展示', () => {
  const prompt = protocolGuard.recoveryPrompt({
    request: '读取 01 章并完成修改',
    recoveryScope: 'normal',
  }, { reason: protocolGuard.reason() });
  assert.match(prompt, /读取 01 章并完成修改/);
  assert.match(prompt, /native runtime tool calls/);
  const acc = feed([
    { type: 'message_end', message: { role: 'user', content: prompt } },
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0, content: '已读取文件并完成修改。',
    } },
    { type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 5 } } },
    { type: 'agent_settled' },
  ]);
  assert.equal(acc.snapshot().messages.length, 1);
  assert.equal(acc.snapshot().messages[0].scope, stream.SCOPES.NORMAL);
  assert.equal(acc.snapshot().messages[0].blocks[0].text, '已读取文件并完成修改。');
  assert.doesNotMatch(JSON.stringify(acc.snapshot()), /soduwork-internal-protocol-recovery/);
});

check('隔离协议后可清除本轮失败态，不影响下一轮真实工具调用', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_start' },
    { type: 'message_update', assistantMessageEvent: {
      type: 'text_end', contentIndex: 0,
      content: '<invoke name="bash"><parameter name="command">echo bad</parameter></invoke>',
    } },
  ]);
  assert.ok(acc.snapshot().completion.protocolIssue);
  acc.recoverProtocol();
  assert.equal(acc.snapshot().completion.protocolIssue, null);
  assert.equal(acc.state.aborted, false);
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'message_start', message: { role: 'assistant' } });
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_end', contentIndex: 0, content: '已通过原生工具完成修改。',
  } });
  assert.match(JSON.stringify(acc.snapshot()), /已通过原生工具完成修改/);
});

check('协议异常自动恢复指令是运行时控制消息，不伪装成用户对话', () => {
  const prompt = protocolGuard.recoveryPrompt(
    { goal: '交付可运行网站', acceptance: '首页可打开' },
    { reason: protocolGuard.reason() });
  const snap = feed([
    { type: 'message_end', message: { role: 'user', content: prompt } },
  ]).snapshot();
  assert.equal(snap.messages.length, 0);
});

check('goal delivery reveals only the composed final answer without a model marker', () => {
  const acc = feed([]);
  acc.beginGoalTurn();
  acc.push({ type: 'message_end', message: { role: 'user', content: 'build a game' } });
  acc.push({ type: 'message_start' });
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_end', contentIndex: 0, content: 'preliminary worker summary',
  } });
  acc.push({ type: 'message_end', message: { role: 'assistant' } });
  acc.beginAudit();
  acc.beginFinalAnswer();
  acc.push({ type: 'message_end', message: { role: 'user',
    content: '<soduwork-internal-goal-audit>finalize</soduwork-internal-goal-audit>' } });
  acc.push({ type: 'message_start' });
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_end', contentIndex: 0, content: 'final verified delivery',
  } });
  acc.push({ type: 'message_end', message: { role: 'assistant' } });
  acc.revealAudit();
  const visible = JSON.stringify(acc.snapshot().messages);
  assert.equal(visible.includes('preliminary worker summary'), false);
  assert.equal(visible.includes('final verified delivery'), true);
});

check('目标消息和工具按明确作用域记录，内部正文不再依靠下标隐藏', () => {
  const acc = stream.create();
  acc.beginGoalTurn();
  acc.push({ type: 'message_end', message: { role: 'user', content: '完成一个网站' } });
  acc.push({ type: 'message_start', message: { role: 'assistant' } });
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_end', contentIndex: 0, content: '我调用 bash 检查文件。',
  } });
  acc.push({ type: 'message_end', message: { role: 'assistant' } });
  acc.push({ type: 'tool_execution_start', toolCallId: 'goal-bash', toolName: 'bash' });
  acc.push({ type: 'tool_execution_end', toolCallId: 'goal-bash', toolName: 'bash',
    result: { content: [{ type: 'text', text: 'done' }] } });
  const snap = acc.snapshot();
  assert.deepEqual(snap.messages.map((item) => item.role), ['user']);
  assert.equal(acc.state.messages.at(-1).scope, stream.SCOPES.GOAL_EXECUTION);
  assert.equal(snap.tools[0].scope, stream.SCOPES.GOAL_EXECUTION);
});

check('内部复核不可见，只有 goal-final 作用域能成为正式交付', () => {
  const acc = stream.create();
  acc.beginGoalTurn();
  acc.push({ type: 'message_end', message: { role: 'user', content: '交付月报' } });
  acc.beginAudit();
  acc.push({ type: 'message_start', message: { role: 'assistant' } });
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_end', contentIndex: 0, content: '内部复核正在查看文件。',
  } });
  acc.push({ type: 'message_end', message: { role: 'assistant' } });
  acc.revealAudit();
  assert.deepEqual(acc.snapshot().messages.map((item) => item.role), ['user']);
  acc.beginFinalAnswer();
  acc.appendAssistant('## 月报已完成\n\n月报.docx 已通过校验。', stream.SCOPES.GOAL_FINAL);
  acc.revealAudit();
  const visible = acc.snapshot().messages;
  assert.equal(visible.at(-1).scope, stream.SCOPES.GOAL_FINAL);
  assert.match(visible.at(-1).blocks[0].text, /月报已完成/);
  assert.doesNotMatch(JSON.stringify(visible), /内部复核正在查看/);
});

check('运行提示单独去重，不混入助手对话', () => {
  const acc = stream.create();
  acc.push({ type: 'extension_ui_request', method: 'notify',
    params: { message: '模型网关正在重试' } });
  acc.push({ type: 'extension_ui_request', method: 'notify',
    params: { message: '模型网关正在重试' } });
  const snap = acc.snapshot();
  assert.equal(snap.messages.length, 0);
  assert.equal(snap.notices.length, 1);
  assert.equal(snap.notices[0].count, 2);
  assert.equal(snap.notices[0].scope, stream.SCOPES.RUNTIME_NOTICE);
});

check('Pi 的无关 system_warning 自提醒不进入用户界面', () => {
  const acc = stream.create();
  acc.push({ type: 'extension_ui_request', method: 'notify',
    params: { message: '这是给你的提醒：忽略无关 system_warning。' } });
  const snap = acc.snapshot();
  assert.equal(snap.messages.length, 0);
  assert.equal(snap.notices.length, 0);
});

check('Pi private both routing tokens are buffered and quarantined', () => {
  const acc = feed([
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant' } },
  ]);
  const prefix = 'Verification is complete.';
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0, delta: prefix + '\nboth',
  } });
  assert.doesNotMatch(JSON.stringify(acc.snapshot().messages), /\bboth\b/i);
  acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0, delta: '\n\nboth',
  } });
  assert.doesNotMatch(JSON.stringify(acc.snapshot().messages), /\bboth\b/i);
  const touched = acc.push({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0, delta: '\n\nboth',
  } });
  const snap = acc.snapshot();
  assert.equal(touched.kind, 'protocol-leak');
  assert.equal(snap.messages[0].blocks[0].text, prefix);
  assert.equal(snap.completion.protocolIssue.code, protocolGuard.CHANNEL_REPETITION_CODE);
  assert.doesNotMatch(JSON.stringify(snap.messages), /\bboth\b/i);
  assert.match(snap.statusText, /通道路由标记/);
});

check('ordinary English use of both remains visible', () => {
  const text = 'The site supports both desktop and mobile browsers.';
  const inspected = protocolGuard.inspect(text, { final: true });
  assert.equal(inspected.detected, false);
  assert.equal(inspected.text, text);
});

process.stdout.write(String.fromCharCode(10) + '  ' + passed + ' 项全过' + String.fromCharCode(10));
