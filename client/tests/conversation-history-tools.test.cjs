const test = require('node:test');
const assert = require('node:assert/strict');

const session = require('../main/pi-session/session');
const eventStream = require('../main/pi-session/event-stream');
const goalFinalizer = require('../main/conversation/goal-finalizer');
const goalQuality = require('../main/conversation/goal-quality');

test('history replay restores tool arguments from the assistant tool call', () => {
  const id = 'tool-history-1';
  const acc = eventStream.create();
  const seeded = session._seed(acc, {
    state: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Build the site' }] },
        {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            id,
            name: 'bash',
            arguments: { command: 'cd C:/workspace/site && npm run build' },
          }],
        },
        {
          role: 'toolResult',
          toolCallId: id,
          toolName: 'bash',
          content: [{ type: 'text', text: 'build complete' }],
          isError: false,
        },
      ],
    },
  });

  assert.equal(seeded, 2);
  const tool = acc.snapshot().tools[0];
  assert.equal(tool.name, 'bash');
  assert.equal(tool.args.command, 'cd C:/workspace/site && npm run build');
  assert.equal(tool.result, 'build complete');
});

function finalEntry(rendered) {
  return {
    type: 'custom', customType: goalFinalizer.ENTRY_TYPE,
    data: {
      structured: {
        schemaVersion: 1, title: '正式交付', summary: '已完成真实交付。',
        deliverables: [], verification: ['内容已核验'], limitations: [],
      },
      rendered,
      source: 'model',
    },
  };
}

test('scoped goal history hides worker and review prose after restart', () => {
  const entries = [
    { type: 'custom', customType: session.SCOPE_ENTRY_TYPE,
      data: { scope: eventStream.SCOPES.GOAL_EXECUTION } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '创建交付物' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '我调用 bash 开始实施' }] } },
    { type: 'custom', customType: session.SCOPE_ENTRY_TYPE,
      data: { scope: eventStream.SCOPES.GOAL_REVIEW } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '内部复核与补缺' }] } },
    finalEntry('## 正式交付\n\n已完成真实交付。\n\n### 验证\n- 内容已核验'),
    { type: 'custom', customType: session.SCOPE_ENTRY_TYPE,
      data: { scope: eventStream.SCOPES.NORMAL } },
    { type: 'message', message: { role: 'user',
      content: [{ type: 'text', text: goalQuality.normalPrompt('再解释一句') }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '这是后续正常回答' }] } },
  ];
  const acc = eventStream.create();
  session._seed(acc, {
    state: { messages: entries.filter((item) => item.type === 'message').map((item) => item.message) },
    sessionManager: { getEntries: () => entries },
  }, { internalGoal: true });
  const snap = acc.snapshot();
  const text = snap.messages.map((item) => [item.text || '',
    ...item.blocks.map((block) => block.text)].join('')).join('\n');
  assert.doesNotMatch(text, /调用 bash|内部复核/);
  assert.match(text, /正式交付/);
  assert.match(text, /再解释一句/);
  assert.match(text, /后续正常回答/);
  assert.deepEqual(snap.messages.map((item) => item.scope),
    ['normal', 'goal-final', 'normal', 'normal']);
});

test('legacy goal history uses the stored final as its only assistant delivery', () => {
  const entries = [
    { type: 'custom', customType: 'soduwork.goal', data: { intent: 'goal' } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '完成目标' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '先查看文件' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '内部首轮草稿' }] } },
    finalEntry('## 唯一正式结果\n\n目标已完成。\n\n### 验证\n- 已核验'),
  ];
  const acc = eventStream.create();
  session._seed(acc, {
    state: { messages: entries.filter((item) => item.type === 'message').map((item) => item.message) },
    sessionManager: { getEntries: () => entries },
  }, { internalGoal: true });
  const snap = acc.snapshot();
  const assistants = snap.messages.filter((item) => item.role === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].scope, 'goal-final');
  assert.match(assistants[0].blocks[0].text, /唯一正式结果/);
  assert.doesNotMatch(JSON.stringify(snap), /先查看文件|内部首轮草稿/);
});
test('history replay quarantines Pi private invoke prose without reopening a live failure', () => {
  const acc = eventStream.create();
  session._seed(acc, {
    state: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '读取文件并完善内容' }] },
        { role: 'assistant', content: [{ type: 'text',
          text: '先核对现状。\n<system>Use tools</system>\n' +
            '<invoke name="bash"><parameter name="command">node -e "inspect()"</parameter></invoke>' }] },
      ],
    },
  });

  const snap = acc.snapshot();
  assert.equal(snap.completion.protocolIssue, null);
  assert.notEqual(snap.status, 'unreachable');
  assert.doesNotMatch(JSON.stringify(snap), /<system>|<invoke|<parameter|node -e/);
  assert.match(JSON.stringify(snap), /读取文件并完善内容/);
});

test('history replay removes Pi role-label degeneration without poisoning the session', () => {
  const acc = eventStream.create();
  session._seed(acc, {
    state: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '继续完成浏览器验证' }] },
        { role: 'assistant', content: [{ type: 'text',
          text: '已打开页面，正在核对结果。\n' +
            Array.from({ length: 30 }, () => 'user').join('\n\n') +
            '\n这段异常后的文字也不能作为可信结果。' }] },
      ],
    },
  });

  const snap = acc.snapshot();
  const assistant = snap.messages.find((item) => item.role === 'assistant');
  assert.equal(snap.completion.protocolIssue, null);
  assert.notEqual(snap.status, 'unreachable');
  assert.equal(assistant.blocks[0].text, '已打开页面，正在核对结果。');
  assert.doesNotMatch(JSON.stringify(assistant), /异常后的文字|(?:^|\\n)user(?:\\n|$)/i);
});

test('history replay removes Pi both-channel degeneration without poisoning the session', () => {
  const acc = eventStream.create();
  session._seed(acc, {
    state: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '继续完成 3D 生产线' }] },
        { role: 'assistant', content: [{ type: 'text',
          text: '主体功能已完成，正在核验。\n' +
            Array.from({ length: 20 }, () => 'both').join('\n\n') +
            '\n异常后的文字不能作为可信结果。' }] },
      ],
    },
  });

  const snap = acc.snapshot();
  const assistant = snap.messages.find((item) => item.role === 'assistant');
  assert.equal(snap.completion.protocolIssue, null);
  assert.notEqual(snap.status, 'unreachable');
  assert.equal(assistant.blocks[0].text, '主体功能已完成，正在核验。');
  assert.doesNotMatch(JSON.stringify(assistant), /异常后的文字|\bboth\b/i);
});


test('long history replay only seeds a bounded UI tail while keeping the latest messages', () => {
  const entries = [];
  for (let i = 0; i < 500; i += 1) {
    entries.push({ type: 'message', message: {
      role: 'user', content: [{ type: 'text', text: 'old-user-' + i }],
    }});
    entries.push({ type: 'message', message: {
      role: 'assistant', content: [{ type: 'text', text: 'old-assistant-' + i }],
    }});
  }
  const acc = eventStream.create();
  const seeded = session._seed(acc, {
    state: { messages: entries.map((item) => item.message) },
    sessionManager: { getEntries: () => entries },
  }, { maxMessages: 80 });
  const snap = acc.snapshot();
  const text = JSON.stringify(snap);
  assert.equal(seeded, 80);
  assert.match(text, /old-user-460/);
  assert.match(text, /old-assistant-499/);
  assert.doesNotMatch(text, /old-user-0/);
  assert.doesNotMatch(text, /old-assistant-100/);
});
