'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { File } = require('node:buffer');
const source = name => fs.readFileSync(path.resolve(__dirname, '../components/panels', name), 'utf8');
function fixture(options = {}) {
  let scopeId = 'alice', resolveShare;
  const calls = [];
  const files = options.files || [{ artifactId: 'report', name: '工作目标分析-缺陷报告.md', at: 7 }];
  const api = { outputs: async ref => { calls.push(['outputs', ref]); return { ok: true, artifacts: files }; },
    artifactAction: async (...args) => {
      calls.push(args);
      if (options.delay) await new Promise(resolve => { resolveShare = resolve; });
      return options.failure ? { ok: false, reason: '文件已移动' } : { ok: true, name: files.find(f => f.artifactId === args[1]).name,
        data: Buffer.from('# 缺陷报告\n尾项：修复导出错误').toString('base64'), at: options.changed ? 8 : 7 };
    } };
  const scope = { File, Blob, Uint8Array, atob, window: {}, console: { error() {} } };
  scope.window.SoduWorkAPI = { taskStorageKey: () => scopeId };
  vm.createContext(scope); vm.runInContext(source('chat-work-intent.js'), scope);
  const ctx = { _ref: 'conversation-a', _viewEpoch: 1, _api: () => api,
    _snap: { messages: options.messages || [{ role: 'assistant', blocks: [{ kind: 'text', text: '已生成 [缺陷报告](工作目标分析-缺陷报告.md)，请核对。' }] }] } };
  const intent = scope.window.ChatWorkIntent.create(ctx);
  return { ctx, calls, intent, switchAccount() { scopeId = 'bob'; }, release: () => resolveShare?.() };
}
test('明确指代最近成果时带入原件与完整文本，不收其他历史文件', async () => {
  const f = fixture({ files: [{ artifactId: 'old', name: '历史报告.md', at: 7 }, { artifactId: 'report', name: '工作目标分析-缺陷报告.md', at: 7 }] });
  const result = await f.intent._workConversationContext('把这个缺陷文档转给高示例成员修复', { includeFiles: true });
  assert.equal(result.files?.length, 1);
  assert.equal(result.files[0].name, '工作目标分析-缺陷报告.md');
  assert.equal(await result.files[0].text(), '# 缺陷报告\n尾项：修复导出错误');
  assert.match(result.attachments[0].text, /尾项：修复导出错误/);
  assert.deepEqual(f.calls.filter(row => row[2] === 'share'), [['conversation-a', 'report', 'share']]);
});
test('明确文件名可消歧，不借同名文件的任意路径读取', async () => {
  const f = fixture({ files: [{ artifactId: 'one', name: '缺陷.md', relative: '旧版/缺陷.md', at: 7 },
    { artifactId: 'two', name: '缺陷.md', relative: '本轮/缺陷.md', at: 7 }] });
  await assert.rejects(f.intent._workConversationContext('把这个缺陷文档转交', { includeFiles: true }), /多份|明确|找到/);
  assert.equal(f.calls.some(row => row[2] === 'share'), false);
  const result = await f.intent._workConversationContext('把本轮/缺陷.md转交修复', { includeFiles: true });
  assert.equal(result.files.length, 1);
  assert.equal(f.calls.at(-1)[1], 'two');
});
test('成果读取失败和版本变化保留错误，不能伪装成附件已带入', async () => {
  for (const options of [{ failure: true }, { changed: true }]) {
    const f = fixture(options);
    await assert.rejects(f.intent._workConversationContext('把这个缺陷文档转交修复', { includeFiles: true }), /移动|更新/);
  }
});
test('换会话或账号后，迟到的成果读取不得进入新草稿', async () => {
  for (const account of [false, true]) {
    const f = fixture({ delay: true });
    const pending = f.intent._workConversationContext('把这个缺陷文档转交修复', { includeFiles: true });
    await new Promise(resolve => setImmediate(resolve));
    if (account) f.switchAccount(); else f.ctx._ref = 'conversation-b';
    f.release();
    await assert.rejects(pending, /切换/);
  }
});
test('普通参考讨论不自动收集会话成果', async () => {
  const f = fixture();
  const result = await f.intent._workConversationContext('按上面的方案安排执行');
  assert.equal(result.files, undefined); assert.equal(f.calls.length, 0);
});
test('本次手动添加的文档优先，不被历史同名成果替换', async () => {
  const f = fixture();
  const result = await f.intent._workConversationContext('把这个缺陷文档转交修复', { includeFiles: true,
    currentAttachments: [{ name: '手动确认的文档.pdf', mode: 'document' }] });
  assert.equal(result.files, undefined); assert.equal(f.calls.length, 0);
});

test('明确文件名不存在时不能回退到最近回复中的另一份文档', async () => {
  const f = fixture();
  await assert.rejects(f.intent._workConversationContext('把不存在.md转给高示例成员修复', { includeFiles: true }), /没有找到|不存在|明确/);
  assert.equal(f.calls.some(row => row[2] === 'share'), false);
});

test('文件名子串、不同路径与备份后缀不能冒充指定的文档', async () => {
  for (const instruction of ['把新缺陷.md转交修复', '把不存在目录/缺陷.md转交修复', '把缺陷.md.bak转交修复']) {
    const f = fixture({ files: [{ artifactId: 'old', name: '缺陷.md', relative: '旧版/缺陷.md', at: 7 }],
      messages: [{ role: 'assistant', blocks: [{ kind: 'text', text: '已生成 旧版/缺陷.md' }] }] });
    await assert.rejects(f.intent._workConversationContext(instruction, { includeFiles: true }), /没有找到|不存在|明确/);
    assert.equal(f.calls.some(row => row[2] === 'share'), false, instruction);
  }
});

test('完整文件名和绝对路径可直接指定，保留中文名称及空格', async () => {
  for (const instruction of ['把新缺陷.md转交修复', '把“本轮 缺陷.md”转交修复', '把 C:\\成果\\新缺陷.md 转交修复']) {
    const selected = instruction.includes('本轮') ? '本轮 缺陷.md' : '新缺陷.md';
    const f = fixture({ files: [{ artifactId: 'old', name: '缺陷.md', at: 7 },
      { artifactId: 'wanted', name: selected, path: 'C:/成果/' + selected, at: 7 }] });
    const result = await f.intent._workConversationContext(instruction, { includeFiles: true });
    assert.equal(result.files.length, 1); assert.equal(result.files[0].name, selected);
    assert.equal(f.calls.at(-1)[1], 'wanted');
  }
});

test('中文顿号分隔的明确多份文件保持完整选择', async () => {
  const f = fixture({ files: [{ artifactId: 'one', name: '缺陷.md', at: 7 }, { artifactId: 'two', name: '新缺陷.md', at: 7 }] });
  const result = await f.intent._workConversationContext('把这些文档：缺陷.md、新缺陷.md转交修复', { includeFiles: true });
  assert.deepEqual(Array.from(result.files, file => file.name), ['缺陷.md', '新缺陷.md']);
});

test('多份明确引用中有缺失文件时整体提示，不能悄悄漏掉其中一份', async () => {
  const f = fixture({ files: [{ artifactId: 'one', name: '存在.md', at: 7 }] });
  await assert.rejects(f.intent._workConversationContext('把这些文档：存在.md、不存在.md转交修复', { includeFiles: true }), /没有找到|未找到|明确/);
  assert.equal(f.calls.some(row => row[2] === 'share'), false);
});

test('手动附件同样不能用名称子串或部分匹配吞掉其他明确引用', async () => {
  for (const instruction of ['把新缺陷.md转交修复', '把“新 缺陷.md”转交修复', '把这些文档：缺陷.md、不存在.md转交修复']) {
    const f = fixture({ files: [] });
    await assert.rejects(f.intent._workConversationContext(instruction, { includeFiles: true,
      currentAttachments: [{ name: '缺陷.md' }] }), /没有找到|未找到|明确/);
  }
});

test('明确多份引用全部手动附上时保留原件，不重复读取历史成果', async () => {
  const f = fixture();
  const result = await f.intent._workConversationContext('📎 把这些文档：缺陷.md、本轮 缺陷.md转交修复', { includeFiles: true,
    currentAttachments: [{ name: '缺陷.md' }, { name: '本轮 缺陷.md' }] });
  assert.equal(result.files, undefined); assert.equal(f.calls.length, 0);
});

test('多份措辞不能消除同名路径歧义，未知引号文件不能匹配名称尾部', async () => {
  const files = [{ artifactId: 'one', name: '缺陷.md', relative: '旧版/缺陷.md', at: 7 },
    { artifactId: 'two', name: '缺陷.md', relative: '本轮/缺陷.md', at: 7 }];
  for (const instruction of ['把这些文档：缺陷.md转交修复', '把上面这些缺陷文档转交修复', '把“新 缺陷.md”转交修复']) {
    const f = fixture({ files, messages: [{ role: 'assistant', blocks: [{ kind: 'text', text: '已生成 缺陷.md' }] }] });
    await assert.rejects(f.intent._workConversationContext(instruction, { includeFiles: true }), /同名|明确/);
    assert.equal(f.calls.some(row => row[2] === 'share'), false);
  }
});
