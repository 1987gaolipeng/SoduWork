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
