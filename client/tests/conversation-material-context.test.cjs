'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const prep = require('../main/conversation/conversation-input-preparation.cjs');
const source = name => fs.readFileSync(path.join(__dirname, '..', 'main', name), 'utf8');
test('ordinary conversation material context distinguishes procedure and data without a plugin', () => {
  const result = prep.promptContext({ text: '按步骤处理数据，只输出汇总表', files: [{ attachmentId: 'steps', name: '操作步骤.md' }, { attachmentId: 'data', name: '原始数据.csv' }], materials: [{ attachmentId: 'steps', status: 'read', text: '步骤一：删除作废行；步骤二：按部门汇总。' }, { attachmentId: 'data', status: 'read', text: '部门,金额\n华东,12' }] });
  assert.equal(result.eligible, true); assert.match(result.prompt, /用户未选择插件/); assert.match(result.prompt, /操作步骤\.md/); assert.match(result.prompt, /候选角色：steps/); assert.match(result.prompt, /原始数据\.csv/); assert.match(result.prompt, /候选角色：data/); assert.match(result.prompt, /只输出汇总表/);
});
test('explicit text and plugin selection remain visible and fallback text is not treated as intent', () => {
  const result = prep.promptContext({ text: '只处理华东，保留空行', fallback: true, plugins: [{ pluginId: 'clean', name: '清洗插件' }], files: [{ name: 'input.csv' }], materials: [{ name: 'input.csv', status: 'read', text: 'row' }] });
  assert.match(result.prompt, /只处理华东，保留空行/); assert.match(result.prompt, /用户已选择插件（不得擅自更换）：清洗插件/); assert.match(result.prompt, /兜底文本/);
});
test('unreadable material is explicit and never presented as understood', () => { const result = prep.promptContext({ files: [{ attachmentId: 'bad', name: '步骤.docx' }], materials: [{ attachmentId: 'bad', status: 'unreadable' }] }); assert.equal(result.status, 'unreadable'); assert.match(result.prompt, /未读取，不得声称已理解正文/); });
test('partial material keeps the preparation result out of the ready state', () => { const result = prep.promptContext({ files: [{ attachmentId: 'partial', name: '数据.csv' }], materials: [{ attachmentId: 'partial', status: 'partial', text: '前半段' }] }); assert.equal(result.status, 'partial'); });
test('prepareSync reads only simple staged text files and preserves metadata for other formats', () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-input-prep-')); const file = path.join(root, '步骤.md'); fs.writeFileSync(file, '步骤一：汇总', 'utf8'); try { const result = prep.prepareSync({ files: [{ attachmentId: 'a', name: '步骤.md', path: file }, { attachmentId: 'b', name: '数据.xlsx', path: path.join(root, '数据.xlsx') }] }); assert.equal(result.rows.length, 2); assert.equal(result.rows[0].status, 'read'); assert.equal(result.rows[1].status, 'unreadable'); } finally { fs.rmSync(root, { recursive: true, force: true }); } });

test('same-name materials without IDs keep one-to-one excerpts', () => {
  const result = prep.promptContext({
    files: [{ name: '资料.txt' }, { name: '资料.txt' }],
    materials: [{ name: '资料.txt', status: 'read', text: '第一份内容' }, { name: '资料.txt', status: 'read', text: '第二份内容' }],
  });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map(row => row.excerpt), ['第一份内容', '第二份内容']);
});
test('async preparation reads staged text before building the shared prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-input-prep-')); const file = path.join(root, '步骤.md');
  fs.writeFileSync(file, '步骤一：按部门汇总', 'utf8');
  try {
    const result = await prep.prepare({ text: '', fallback: true, files: [{ attachmentId: 'a', name: '步骤.md', path: file }] });
    assert.equal(result.status, 'ready'); assert.match(result.prompt, /按部门汇总/); assert.equal(result.materials[0].status, 'read');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Pi and Runner source paths consume the shared material context without requiring a plugin', () => {
  const pi = source(path.join('pi-session', 'session-send.js'));
  const runner = source(path.join('agent-runtime', 'runner-adapter.js'));
  const prepared = source(path.join('agent-runtime', 'prepared-turn.cjs'));
  assert.match(pi, /conversation-input-preparation/);
  assert.match(runner, /conversationInputPreparation\.prepareSync/);
  assert.match(prepared, /conversation-input-preparation/);
  assert.match(runner, /!pluginTurn\.requestedIds\(preparedOptions\)/);
});
