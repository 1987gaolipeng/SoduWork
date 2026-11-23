'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('path');
const attachmentFiles = require('../main/attachment-files');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const ticket = 'abcdefghijklmnop.qrstuvwxyz012345.abcdefghi';

test('attachment preview URLs stay inside the active Hub and exact API route', () => {
  const relative = attachmentFiles.parseAttachmentUrl(
    '/api/v1/attachments/12345678?ticket=' + ticket,
    'http://192.0.2.10:8989',
    'preview');
  assert.equal(relative.id, '12345678');
  assert.equal(relative.url,
    'http://192.0.2.10:8989/api/v1/attachments/12345678?ticket=' +
    ticket + '&mode=preview');

  assert.throws(() => attachmentFiles.parseAttachmentUrl(
    'http://evil.example/api/v1/attachments/12345678?ticket=' + ticket,
    'http://192.0.2.10:8989'));
  assert.throws(() => attachmentFiles.parseAttachmentUrl(
    '/api/v1/tasks/12345678?ticket=' + ticket,
    'http://192.0.2.10:8989'));
  assert.throws(() => attachmentFiles.parseAttachmentUrl(
    '/api/v1/attachments/12345678',
    'http://192.0.2.10:8989'));
});

test('only passive document types render inline', () => {
  for (const type of [
    'image/png', 'application/pdf', 'text/plain; charset=utf-8',
    'text/markdown', 'application/json',
  ]) assert.equal(attachmentFiles.isInlinePreview(type), true, type);

  for (const type of [
    'text/html', 'image/svg+xml', 'application/javascript',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]) assert.equal(attachmentFiles.isInlinePreview(type), false, type);
});

test('native Markdown attachment preview renders Chinese punctuation bold without merging spans', () => {
  const source = '**注意：**这里需要先登录。\n\n**步骤一：**打开设置。\n\n这是**重点（必读）**内容。\n\n' +
    '**注意：**先登录，**步骤一：**打开设置。\n\n**结论**：对照。\n\n预算 100~200 元，工期 3~5 天。';
  const html = attachmentFiles.renderMarkdownPreview('中文加粗.md', Buffer.from(source));
  const expected = '<p><strong>注意：</strong>这里需要先登录。</p>\n' +
    '<p><strong>步骤一：</strong>打开设置。</p>\n' +
    '<p>这是<strong>重点（必读）</strong>内容。</p>\n' +
    '<p><strong>注意：</strong>先登录，<strong>步骤一：</strong>打开设置。</p>\n' +
    '<p><strong>结论</strong>：对照。</p>\n' +
    '<p>预算 100~200 元，工期 3~5 天。</p>\n';
  assert.equal(html.match(/<main data-user-content>([\s\S]*)<\/main>/)[1], expected);
});

test('native Markdown preview preserves code, escaped stars and passive document boundaries', () => {
  const source = [
    '`**注意：**这里`',
    '```markdown\n这是**重点（必读）**内容。\n```',
    String.raw`\*\*注意：\*\*这里。`,
    '[说明](https://example.test/**path** "**注意：**这里")',
    '[危险链接](javascript:alert)',
    '<script>alert("**注意：**这里")</script>',
    '![**注意：**这里](https://example.test/image.png)',
  ].join('\n\n');
  const html = attachmentFiles.renderMarkdownPreview('安全预览.md', Buffer.from(source));
  assert.match(html, /<code>\*\*注意：\*\*这里<\/code>/);
  assert.match(html, /<pre><code class="language-markdown">这是\*\*重点（必读）\*\*内容。\n<\/code><\/pre>/);
  assert.match(html, /<p>\*\*注意：\*\*这里。<\/p>/);
  assert.match(html, /href="https:\/\/example.test\/\*\*path\*\*" title="\*\*注意：\*\*这里" rel="noreferrer noopener">说明<\/a>/);
  assert.doesNotMatch(html, /<(?:script|img)\b|href="javascript:|<strong>/);
  assert.match(html, /&lt;script&gt;/);
});

test('download filenames cannot escape their selected destination', () => {
  assert.equal(attachmentFiles.safeFilename('CON.txt', 'safe.txt'), 'safe.txt');
  assert.equal(attachmentFiles.safeFilename('../../report?.docx', 'safe.txt'), 'report_.docx');
  assert.equal(attachmentFiles.safeFilename('result. ', 'safe.txt'), 'result');
});

test('filename truncation keeps the final extension and the existing length limit', () => {
  for (const extension of ['.docx', '.md', '.gz', '.PNG']) {
    const result = attachmentFiles.safeFilename('a'.repeat(180) + extension, 'safe.txt');
    assert.equal(result.length, 180);
    assert.ok(result.endsWith(extension));
  }
  const boundary = 'a'.repeat(175) + '.docx';
  assert.equal(attachmentFiles.safeFilename(boundary, 'safe.txt'), boundary);
  assert.equal(attachmentFiles.safeFilename('a'.repeat(200), 'safe.txt'), 'a'.repeat(180));
  assert.equal(attachmentFiles.safeFilename('a.' + 'b'.repeat(200), 'safe.txt').length, 180);
});

test('filename truncation bounds UTF-8 bytes without splitting Unicode characters', () => {
  for (const [stem, extension] of [
    ['报告'.repeat(50), '.docx'], ['😀'.repeat(90), '.xlsx'],
    ['报'.repeat(80), '.说明'], ['😀'.repeat(90), ''],
  ]) {
    const result = attachmentFiles.safeFilename(stem + extension, 'safe.txt');
    assert.ok(Buffer.byteLength(result, 'utf8') <= 180);
    assert.ok(result.length <= 180);
    assert.ok(result.isWellFormed());
    assert.ok(result.endsWith(extension));
    assert.ok(stem.startsWith(extension ? result.slice(0, -extension.length) : result));
  }
  const boundary = '报'.repeat(58) + '.docx';
  assert.equal(attachmentFiles.safeFilename(boundary, 'safe.txt'), boundary);
  const longExtension = attachmentFiles.safeFilename('a.' + '😀'.repeat(100), 'safe.txt');
  assert.ok(Buffer.byteLength(longExtension, 'utf8') <= 180);
  assert.ok(longExtension.isWellFormed());
});

test('renderer exposes narrow native preview and explicit download commands', () => {
  const main = read('main.js');
  const preload = read('preload.js');
  const detail = read('components', 'requirements', 'requirements-detail.js');
  assert.match(main, /attachment-files/);
  assert.match(main, /_attachmentFiles\.install/);
  assert.match(preload, /attachment-preview/);
  assert.match(preload, /attachment-download/);
  assert.match(detail, /ConversationAttachments\.openTaskAttachment/);
  assert.match(detail, /soduWorkAPI\.downloadAttachment/);
  assert.match(detail, /data-rq-download/);
  assert.match(detail, /deleteAttachment\(id\)/);
  assert.doesNotMatch(detail, /openExternal\(file\.url\)/);
});

test('task success and pinned conversation regressions stay closed', () => {
  const success = read('components', 'panels', 'panels-compose-submit.js');
  const shell = read('components', 'workspace', 'workspace-shell.css');
  assert.match(success, /ctx\.id\s*\?\s*'<button class="cp-primary" id="cpOpen">/);
  assert.match(shell, /\.ws-pinned\{flex:0 0 auto/);
  assert.match(shell, /\.ws-pinned \.ws-list-body\{[^}]*min-height:32px/);
  assert.doesNotMatch(shell, /\.ws-pinned \.ws-list-body\{[^}]*max-height/); // uses the shared upper scrollport
});

test('participant tracking copies never masquerade as assigned todos', () => {
  const store = read('core', 'store.js');
  assert.match(store, /incomingActionable=incoming&&!incoming\.readOnly/);
  assert.match(store, /incomingRoles\.includes\('executor'\)\|\|incomingRoles\.includes\('assignee'\)/);
  const R = require('../core/requirements.js');
  const shared = {id: 'shared', readOnly: true, canViewExecution: false,
    status: 'todo', myRoles: ['requester'], creatorName: 'Requester', executionDeviceName: 'Device'};
  assert.equal(R.inScope(shared, 'all'), true);
  assert.equal(R.inScope(shared, 'created'), true);
  assert.equal(R.inScope(shared, 'actionable'), false);
  assert.deepEqual(R.owner(shared), {kind: 'unassigned', name: '待安排'});
  assert.deepEqual(R.owner({...shared, assigneeName: 'Colleague'}), {kind: 'person', name: 'Colleague'});
  assert.deepEqual(R.owner({...shared, ai: {name: 'Pi'}}), {kind: 'agent', name: 'Pi'});
});
