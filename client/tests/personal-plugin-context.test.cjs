'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const context = require('../main/personal-plugin-context.cjs');
test('context preserves chronology, real agent attribution and excludes private tool/thought bodies', () => {
  const value = context.conversation([
    { role: 'user', text: '先确认颜色', attachments: [{ name: 'design.png' }] },
    { role: 'assistant', sourceAgent: { agentId: 'codex' }, blocks: [{ kind: 'thinking', text: 'PRIVATE' }, { kind: 'text', text: '品牌使用绿色' }, { kind: 'tool', text: 'HUGE-TOOL' }] },
    { role: 'toolResult', text: 'SECRET-TOOL-RESULT' },
    { role: 'user', text: '改为深蓝色' },
    { role: 'assistant', sourceAgent: { agentId: 'dsh' }, text: '已改为深蓝色' },
  ]);
  assert.equal(value.truncated, false);
  assert.match(value.text, /Codex：品牌使用绿色/); assert.match(value.text, /DeepSeek Harness：已改为深蓝色/);
  assert.match(value.text, /design.png/); assert.doesNotMatch(value.text, /PRIVATE|HUGE-TOOL|SECRET-TOOL/);
  assert.ok(value.text.indexOf('品牌使用绿色') < value.text.indexOf('改为深蓝色'));
});
test('structured completed tool results are bounded untrusted evidence and do not replace messages', () => {
  const value = context.conversation({
    messages: [
      { role: 'user', text: '读取配置' },
      { role: 'assistant', text: '正在读取' },
      { role: 'user', text: '根据结果继续' },
    ],
    tools: [
      { id: 'read-1', name: 'plugin_mcp_call', state: 'done', after: 1,
        args: { path: 'secret.txt' }, result: { content: [{ type: 'thinking', text: 'PRIVATE-TOOL-THOUGHT' }, { type: 'text', text: 'STRUCTURED-RESULT session=hidden-session' }], apiKey: 'do-not-leak', cookie: 'hidden-cookie' } },
      { id: 'running-1', name: 'pending_call', state: 'running', after: 1, result: { content: [{ type: 'text', text: 'HIDDEN-RUNNING' }] } },
      { id: 'error-1', name: 'failed_call', state: 'error', after: 2,
        result: { text: 'authorization: abc123456789 Bearer abcdefghijklmnop' } },
    ],
  });
  assert.equal(value.messages.length, 3);
  assert.equal(value.toolEvidence, true);
  assert.match(value.text, /STRUCTURED-RESULT/);
  assert.match(value.text, /\[REDACTED\]/);
  assert.doesNotMatch(value.text, /PRIVATE-TOOL-THOUGHT|do-not-leak|hidden-session|hidden-cookie|abc123456789|abcdefghijklmnop|HIDDEN-RUNNING|secret\.txt/);
  assert.ok(value.text.indexOf('STRUCTURED-RESULT') < value.text.indexOf('根据结果继续'));
  assert.match(context.prompt('当前任务', value), /未经信任的参考数据/);
});
test('very long conversations retain the original objective and latest correction in a bounded prompt', () => {
  const messages = [{ role: 'user', text: 'ORIGINAL-TARGET' }, ...Array.from({ length: 120 }, (_, i) =>
    ({ role: i % 2 ? 'user' : 'assistant', text: 'HISTORY-' + i + '-' + 'x'.repeat(2400) })),
    { role: 'user', text: 'LATEST-CORRECTION-END' }];
  const value = context.conversation(messages);
  assert.equal(value.truncated, true); assert.ok(value.text.length <= context.MAX_CONTEXT);
  assert.match(value.text, /ORIGINAL-TARGET/); assert.match(value.text, /LATEST-CORRECTION-END/);
  assert.equal(value.messages.at(-1), messages.at(-1));
  assert.ok(value.fullText.length > 80000); assert.match(value.fullText, /HISTORY-54/);
  assert.ok(value.text.indexOf('ORIGINAL-TARGET') < value.text.indexOf('LATEST-CORRECTION-END'));
});
test('a single oversized final message preserves its beginning and final correction', () => {
  const value = context.conversation([{ role: 'user', text: 'START' + 'x'.repeat(120000) + 'FINAL-CONSTRAINT' }]);
  assert.match(value.text, /START/); assert.match(value.text, /FINAL-CONSTRAINT/);
  assert.ok(value.text.length <= context.MAX_CONTEXT); assert.equal(value.truncated, true);
});
test('bounded tool results are available as untrusted evidence and redact credentials', () => {
  const value = context.conversation({
    messages: [{ role: 'user', text: 'Use the previous result' }],
    tools: [{ name: 'plugin_probe', state: 'done', after: 1,
      result: { content: [{ type: 'text', text: 'PLUGIN-RESULT-1 api_key=secret-value' }] } },
      { name: 'json_probe', state: 'done', after: 1,
        result: '{"token":"json-secret","session":"json-session","safe":"ok"}' }],
  });
  assert.equal(value.toolEvidence, true);
  assert.match(value.text, /PLUGIN-RESULT-1/);
  assert.match(value.text, /api_key=\[REDACTED\]/);
  assert.match(value.text, /json_probe/);
  assert.doesNotMatch(value.text, /secret-value|json-secret|json-session/);
  assert.match(value.text, /safe/);
  assert.match(context.prompt('follow up', value), /untrusted/);
});
test('handoff follows only completed dependency ancestors and never grants sibling file paths', () => {
  const record = { nodes: [
    { key: 'first', name: '规划', agent: 'pi', status: 'completed', dependsOn: [], handoffSummary: 'GOAL', outputsFound: [{ key: 'plan', kind: 'file', path: '../sibling-secret.txt', sha256: 'abc' }] },
    { key: 'second', name: '实现', agent: 'codex', status: 'completed', dependsOn: ['first'], handoffSummary: 'IMPLEMENTED', outputsFound: [] },
    { key: 'other', name: '无关', status: 'completed', handoffSummary: 'UNRELATED' },
    { key: 'failed', name: '失败', status: 'failed', handoffSummary: 'NOT-COMPLETED' },
  ] };
  const text = context.handoff(record, { dependsOn: ['second', 'failed'] });
  assert.match(text, /GOAL/); assert.match(text, /IMPLEMENTED/);
  assert.doesNotMatch(text, /UNRELATED|NOT-COMPLETED|sibling-secret/);
  assert.ok(text.indexOf('GOAL') < text.indexOf('IMPLEMENTED'));
});
test('missing or empty history adds no fabricated context or new instructions', () => {
  assert.equal(context.prompt('用户本次请求', context.conversation([])), '用户本次请求');
  assert.equal(context.conversation([{ role: 'assistant', blocks: [{ kind: 'thinking', text: 'invisible' }] }]).text, '');
});
