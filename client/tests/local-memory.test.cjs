'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const local = require('../main/conversation/local-memory');
const learning = require('../main/conversation/personal-learning');
const { redact } = require('../main/conversation/import-redaction');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-memory-'));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(path.join(root, 'memory', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.soduwork'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'profile.md'), '# 个人偏好\n使用中文回答\n');
  fs.writeFileSync(path.join(root, 'memory', 'nested', 'notes.markdown'), '本地备注\n');
  fs.writeFileSync(path.join(cwd, '.soduwork', 'memory.md'), '# 项目记忆\n保留本地文档\n');
  fs.writeFileSync(path.join(cwd, '.soduwork', 'context.md'), '# 工程上下文\n使用 Node\n');
  fs.writeFileSync(path.join(cwd, '.soduwork', 'delivery.json'), '{}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd, app: { getPath: () => root } };
}

test('list scans personal userData Markdown and direct .soduwork Markdown without Hub', t => {
  const f = fixture(t);
  const all = local.list({ app: f.app, cwd: f.cwd });
  assert.equal(all.ok, true);
  assert.equal(all.items.length, 3);
  assert.deepEqual(all.items.map(item => item.scope).sort(), ['personal', 'project', 'workspace']);
  assert.ok(all.items.every(item => item.source === 'local-markdown'));
  assert.ok(all.items.every(item => !Object.prototype.hasOwnProperty.call(item, 'content')));
  const personal = local.list({ app: f.app, cwd: f.cwd, scope: 'personal' });
  assert.equal(personal.items.length, 1);
  assert.equal(personal.items[0].fileName, 'personal.md');
  assert.match(local.get({ app: f.app, cwd: f.cwd, id: personal.items[0].id }).item.content, /个人偏好/);
  assert.match(local.get({ app: f.app, cwd: f.cwd, id: personal.items[0].id }).item.content, /本地备注/);
  assert.equal(local.list({ app: f.app, cwd: f.cwd, scope: 'project' }).items.length, 1);
  assert.equal(local.list({ app: f.app, cwd: f.cwd, scope: 'workspace' }).items.length, 1);
});

test('get and update are bounded to an existing Markdown document', t => {
  const f = fixture(t);
  const row = local.list({ app: f.app, cwd: f.cwd, scope: 'personal' }).items[0];
  const detail = local.get({ app: f.app, cwd: f.cwd, id: row.id });
  assert.match(detail.item.content, /个人偏好/);
  assert.match(detail.item.content, /本地备注/);
  const next = local.update({ app: f.app, cwd: f.cwd, id: row.id, content: '# 已修改\n只写本地文件\n' });
  assert.equal(next.ok, true);
  assert.equal(next.item.summary, '已修改');
  assert.match(fs.readFileSync(path.join(f.root, 'memory', 'personal.md'), 'utf8'), /只写本地文件/);
  assert.throws(() => local.get({ app: f.app, cwd: f.cwd, id: '../memory/profile.md' }), /标识无效|不存在/);
  assert.throws(() => local.update({ app: f.app, cwd: f.cwd, id: row.id, content: '' }), /大小无效/);
  assert.throws(() => local.update({ app: f.app, cwd: f.cwd, id: row.id, content: 'x'.repeat(local.MAX_PERSONAL_BYTES + 1) }), /个人记忆内容超过 16 MiB/);
});

test('symlinks and non-Markdown files are never surfaced', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.md');
  fs.writeFileSync(outside, 'outside');
  try { fs.symlinkSync(outside, path.join(f.root, 'memory', 'linked.md'), 'file'); } catch (_) {}
  try { fs.symlinkSync(outside, path.join(f.cwd, '.soduwork', 'linked.md'), 'file'); } catch (_) {}
  const rows = local.list({ app: f.app, cwd: f.cwd }).items;
  assert.ok(rows.every(item => item.fileName !== 'linked.md'));
  assert.ok(rows.every(item => item.fileName !== 'delivery.json'));
});

test('workspace root symlink is rejected and missing .soduwork is empty', t => {
  const f = fixture(t);
  const missing = path.join(f.root, 'missing');
  assert.deepEqual(local.list({ app: f.app, cwd: missing, scope: 'workspace' }).items, []);
  const outside = path.join(f.root, 'other');
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, path.join(f.cwd, '.soduwork-link'), 'junction');
  } catch (_) {}
  assert.deepEqual(local.list({ app: f.app, cwd: path.join(f.root, 'other'), scope: 'workspace' }).items, []);
});



test('personal memories are account-scoped and create exposes revision metadata', t => {
  const f = fixture(t);
  const first = 'a'.repeat(32), second = 'b'.repeat(32);
  const created = local.createPersonal({ app: f.app, owner: first, title: 'profile', content: '# profile\n' });
  assert.equal(created.ok, true);
  assert.equal(created.item.revision.length, 64);
  assert.equal(path.basename(created.item.filePath), 'personal.md');
  assert.equal(local.list({ app: f.app, owner: first, scope: 'personal' }).items.length, 1);
  assert.equal(local.list({ app: f.app, owner: second, scope: 'personal' }).items.length, 0);
  const metadata = local.metadata({ app: f.app, owner: first, cwd: f.cwd });
  assert.match(metadata.personalDirectory, /accounts/);
  assert.equal(metadata.scopes.session, false);
});

test('unicode personal filenames keep an opaque selectable id across CRUD', t => {
  const f = fixture(t);
  const created = local.createPersonal({ app: f.app, owner: 'e'.repeat(32),
    title: '会议纪要 个人偏好', content: '# 会议纪要\n保留本地 Markdown\n' });
  assert.match(created.item.id, /^personal:[a-f0-9]{48}$/);
  assert.doesNotMatch(created.item.id, /会议|\s/);
  const fetched = local.get({ app: f.app, owner: 'e'.repeat(32), id: created.item.id });
  assert.equal(fetched.item.fileName, 'personal.md');
  const updated = local.update({ app: f.app, owner: 'e'.repeat(32), id: created.item.id,
    content: '# 已修改\n仍可编辑\n' });
  assert.equal(updated.ok, true);
  assert.equal(local.remove({ app: f.app, owner: 'e'.repeat(32), id: created.item.id }).ok, true);
});

test('personal memory is a per-account singleton and repeated create upserts the same row', t => {
  const f = fixture(t);
  const owner = 'f'.repeat(32);
  const first = local.createPersonal({ app: f.app, owner, title: '第一次标题', content: '# 第一份\n' });
  const second = local.createPersonal({ app: f.app, owner, title: '第二次标题', content: '# 第二份\n' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.item.id, first.item.id);
  assert.equal(local.list({ app: f.app, owner, scope: 'personal' }).items.length, 1);
  assert.match(fs.readFileSync(path.join(f.root, 'memory', 'accounts', owner, 'personal.md'), 'utf8'), /第一份/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'memory', 'accounts', owner, 'personal.md'), 'utf8'), /第二份/);
});

test('a single legacy document migrates to personal.md and its old IDs still resolve', t => {
  const f = fixture(t), owner = '1'.repeat(32);
  const root = local.userMemoryRoot(f.app, owner);
  const filename = '会议纪要 个人偏好.md';
  const content = '# 偏好\n  保留缩进与末尾空白  \n';
  fs.writeFileSync(path.join(root, filename), content);
  const oldId = 'personal:' + crypto.createHash('sha256').update('personal\0' + root + '\0' + filename).digest('hex').slice(0, 48);
  const legacyId = 'personal:' + filename;
  const row = local.list({ app: f.app, owner, scope: 'personal' }).items[0];
  assert.equal(row.fileName, 'personal.md');
  assert.equal(fs.readFileSync(path.join(root, filename), 'utf8'), content);
  assert.equal(local.get({ app: f.app, owner, id: oldId }).item.content, content);
  assert.equal(local.get({ app: f.app, owner, id: legacyId }).item.id, row.id);
  assert.equal(local.get({ app: f.app, owner, id: row.id }).item.content, content);
  assert.equal(Object.hasOwn(row, 'aliases'), false);
  const next = local.update({ app: f.app, owner, id: row.id, revision: row.revision, content: '# 修改后\n' });
  assert.equal(next.item.id, row.id);
  assert.throws(() => local.update({ app: f.app, owner, id: row.id, revision: row.revision, content: '# 冲突\n' }), /其他位置修改/);
});

test('deleting the consolidated document does not resurrect legacy sources after reload', t => {
  const f = fixture(t);
  const options = { app: f.app, cwd: f.cwd, scope: 'personal' };
  const row = local.list(options).items[0];
  assert.equal(local.remove({ ...options, id: row.id }).ok, true);
  assert.deepEqual(local.list(options).items, []);
  // Re-require to ensure this behavior comes from local persistent state.
  delete require.cache[require.resolve('../main/conversation/local-memory')];
  const reloaded = require('../main/conversation/local-memory');
  assert.deepEqual(reloaded.list(options).items, []);
  assert.ok(fs.existsSync(path.join(f.root, 'memory', 'profile.md')));
  assert.ok(fs.existsSync(path.join(f.root, 'memory', 'nested', 'notes.markdown')));
  const recreated = reloaded.createPersonal({ app: f.app, content: '# 新偏好\n' });
  assert.equal(recreated.created, true);
  assert.equal(recreated.item.id, row.id);
  assert.equal(reloaded.get({ ...options, id: row.id }).item.content, '# 新偏好\n');
});

test('migration preserves all Unicode content beyond the previous 256 KiB boundary', t => {
  const f = fixture(t), owner = '2'.repeat(32);
  const root = local.userMemoryRoot(f.app, owner);
  const first = '# 早期偏好\n' + '中文内容\n'.repeat(16000) + 'FIRST-END\n';
  const second = '# 后期偏好\n' + '另外一些内容\n'.repeat(16000) + 'SECOND-END\n';
  fs.writeFileSync(path.join(root, 'first.md'), first);
  fs.writeFileSync(path.join(root, 'second.md'), second);
  const row = local.list({ app: f.app, owner, scope: 'personal' }).items[0];
  assert.ok(row.bytes > local.MAX_BYTES);
  const merged = local.get({ app: f.app, owner, id: row.id }).item.content;
  assert.ok(merged.includes(first));
  assert.ok(merged.includes(second));
  assert.equal(fs.readFileSync(path.join(root, 'first.md'), 'utf8'), first);
  assert.equal(fs.readFileSync(path.join(root, 'second.md'), 'utf8'), second);
  assert.equal(local.update({ app: f.app, owner, id: row.id, content: merged + '\n结尾编辑\n' }).ok, true);
});

test('migration repairs an old partial canonical document without losing omitted sources', t => {
  const f = fixture(t), owner = '3'.repeat(32);
  const root = local.userMemoryRoot(f.app, owner);
  fs.writeFileSync(path.join(root, 'first.md'), '第一份完整正文\n');
  fs.writeFileSync(path.join(root, 'second.md'), '第二份完整正文\n');
  fs.writeFileSync(path.join(root, 'personal.md'), '# 个人记忆\n第一份完整正文\n第二份');
  const row = local.list({ app: f.app, owner, scope: 'personal' }).items[0];
  const text = local.get({ app: f.app, owner, id: row.id }).item.content;
  assert.equal(text.match(/第一份完整正文/g).length, 1);
  assert.match(text, /第二份完整正文/);
  assert.equal(local.list({ app: f.app, owner, scope: 'personal' }).items.length, 1);
});

test('migration refuses oversized sources and too many files without hiding or truncating them', t => {
  const f = fixture(t), owner = '4'.repeat(32);
  const root = local.userMemoryRoot(f.app, owner);
  const options = { app: f.app, owner, scope: 'personal' };
  const huge = path.join(root, 'huge.md');
  fs.writeFileSync(huge, 'x'.repeat(local.MAX_PERSONAL_BYTES + 1));
  assert.throws(() => local.list(options), /原文件已保留/);
  assert.equal(fs.statSync(huge).size, local.MAX_PERSONAL_BYTES + 1);
  assert.equal(fs.existsSync(path.join(root, 'personal.md')), false);
  fs.unlinkSync(huge);
  for (let i = 0; i <= local.MAX_FILES; i++) fs.writeFileSync(path.join(root, i + '.md'), '# ' + i);
  assert.throws(() => local.list(options), /旧文件超过/);
  assert.equal(fs.existsSync(path.join(root, 'personal.md')), false);
  assert.equal(fs.readdirSync(root).length, local.MAX_FILES + 1);
});

test('migration failures preserve every source and do not report partial success', t => {
  const f = fixture(t);
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(f.root, 'memory', 'personal.md')) throw Object.assign(Error('write denied'), { code: 'EACCES' });
    return originalRename(from, to);
  });
  assert.throws(() => local.list({ app: f.app, scope: 'personal' }), /write denied/);
  assert.match(fs.readFileSync(path.join(f.root, 'memory', 'profile.md'), 'utf8'), /个人偏好/);
  assert.equal(fs.existsSync(path.join(f.root, 'memory', 'personal.md')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'memory', '.personal-state.json')), false);
});

test('install resolves the active account for every operation without accepting a renderer owner', async t => {
  const f = fixture(t);
  let owner = '5'.repeat(32);
  const api = local.install(f.app, () => owner);
  const created = await api.create({ content: '# 甲用户偏好\n', owner: '6'.repeat(32) });
  owner = '6'.repeat(32);
  assert.deepEqual((await api.list({ scope: 'personal', owner: '5'.repeat(32) })).items, []);
  await assert.rejects(api.get({ id: created.item.id }), /不存在/);
  const second = await api.create({ content: '# 乙用户偏好\n' });
  assert.notEqual(second.item.id, created.item.id);
  owner = '5'.repeat(32);
  assert.match((await api.get({ id: created.item.id })).item.content, /甲用户偏好/);
});

test('digest never overwrites a manually edited workspace document', t => {
  const f = fixture(t);
  const file = path.join(f.cwd, '.soduwork', 'soduwork-project-memory.md');
  fs.writeFileSync(file, '# manual\nkeep-manual\n');
  const result = local.saveDigest({ app: f.app, cwd: f.cwd, digest: { title: 'auto', fields: { summary: 'automatic' } }, scopes: [{ scope: 'project', key: 'p1' }] });
  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(file, 'utf8'), /keep-manual/);
  assert.ok(fs.existsSync(path.join(f.cwd, '.soduwork', 'soduwork-project-memory-auto.md')));
});

test('local digest and explicit selection stay on the owner and never require Hub storage', t => {
  const f = fixture(t);
  const owner = 'c'.repeat(32), other = 'd'.repeat(32);
  const personal = local.createPersonal({ app: f.app, owner, title: 'my-notes', content: '# 我的本地记忆\n仅本人可见\n' });
  const selected = local.contextIds({ app: f.app, owner, cwd: f.cwd, ids: [personal.item.id] });
  assert.equal(selected.items.length, 1);
  assert.match(selected.prompt, /仅本人可见/);
  assert.equal(local.contextIds({ app: f.app, owner: other, cwd: f.cwd, ids: [personal.item.id] }).items.length, 0);
  const sessionKey = 'session-key-for-owner';
  const saved = local.saveDigest({ app: f.app, owner, cwd: f.cwd,
    digest: { title: '会话摘要', sourceHash: 'digest-1', fields: { summary: '本地摘要' } },
    scopes: [{ scope: 'session', key: sessionKey }, { scope: 'project', key: 'project-1' }] });
  assert.equal(saved.saved.length, 2);
  assert.equal(local.contextIds({ app: f.app, owner, cwd: f.cwd, ids: [sessionKey] }).items.length, 1);
  assert.equal(local.contextIds({ app: f.app, owner: other, cwd: f.cwd, ids: [sessionKey] }).items.length, 0);
  assert.ok(fs.existsSync(path.join(f.cwd, '.soduwork', 'soduwork-project-memory.md')));
});

test('context includes existing custom Markdown in each local scope', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, '.soduwork', 'decisions.md'), '# Decisions\nUse local files\n');
  const project = local.context({ app: f.app, cwd: f.cwd, scopes: [{ scope: 'project', key: 'project-1' }] });
  assert.match(project.prompt, /Use local files/);
});

test('redaction covers CJK credential keys while keeping account names readable', () => {
  assert.equal(redact('密码是admin123'), '密码是[凭据已隐藏]');
  assert.equal(redact('密码：admin123'), '密码：[凭据已隐藏]');
  assert.equal(redact('登录密码为 abc123!'), '登录密码为 [凭据已隐藏]');
  assert.equal(redact('管理员密码为 abc123'), '管理员密码为 [凭据已隐藏]');
  assert.equal(redact('平台口令=xyz99'), '平台口令=[凭据已隐藏]');
  // Preserve ordinary prose and low-sensitivity account names; credential matching requires an assignment separator.
  assert.equal(redact('忘记密码了'), '忘记密码了');
  assert.equal(redact('密码策略已更新'), '密码策略已更新');
  assert.equal(redact('账号 sample.user'), '账号 sample.user');
  assert.equal(redact('password=abc123def456'), 'password=[凭据已隐藏]');
});

test('generated session files redact credentials before they reach the injection context', t => {
  const f = fixture(t), owner = '9'.repeat(32);
  const saved = local.saveDigest({ app: f.app, owner, cwd: f.cwd,
    digest: { title: '平台配置', completed: true, fields: { summary: '配置了平台', outcomes: '写入时记录 密码是admin123' } },
    scopes: [{ scope: 'session', key: 'session-redact-1' }] });
  assert.equal(saved.saved.length, 1);
  const file = path.join(f.root, 'memory', 'accounts', owner, 'sessions',
    crypto.createHash('sha256').update('session-redact-1').digest('hex') + '.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /admin123/);
  assert.match(text, /\[凭据已隐藏\]/);
  const ctx = local.contextIds({ app: f.app, owner, ids: ['session-redact-1'] });
  assert.doesNotMatch(ctx.prompt, /admin123/);
});

test('routine digests with identical content modulo dates are not duplicated into personal memory', t => {
  const f = fixture(t), owner = '7'.repeat(32);
  const root = local.userMemoryRoot(f.app, owner);
  const write = (file, content, mode) => fs.writeFileSync(file, content, { mode: mode || 0o600 });
  const digestA = { title: '每日日报', completed: true, fields: { goal: '生成每日 GitHub 日报', outcomes: '完成 2026-10-20 10:30' } };
  const digestB = { title: '每日日报', completed: true, fields: { goal: '生成每日 GitHub 日报', outcomes: '完成 2026-10-21 11:45' } };
  const digestC = { title: '另一次工作', completed: true, fields: { goal: '修复登录缺陷', outcomes: '已修复并验证通过' } };
  learning.reconcile({ root, write, digest: digestA, key: 'session-a', backfill: true });
  const afterA = fs.readFileSync(path.join(root, 'personal.md'), 'utf8');
  assert.equal((afterA.match(/soduwork-work-memory:/g) || []).length, 1);
  learning.reconcile({ root, write, digest: digestB, key: 'session-b', backfill: true });
  const afterB = fs.readFileSync(path.join(root, 'personal.md'), 'utf8');
  assert.equal((afterB.match(/soduwork-work-memory:/g) || []).length, 1, '例行摘要不重复累积');
  learning.reconcile({ root, write, digest: digestC, key: 'session-c', backfill: true });
  const afterC = fs.readFileSync(path.join(root, 'personal.md'), 'utf8');
  assert.equal((afterC.match(/soduwork-work-memory:/g) || []).length, 2);
  assert.match(afterC, /修复登录缺陷/);
});

test('context injection cuts at memory block boundaries instead of mid-block', t => {
  const blockEnd = '<!-- /soduwork-work-memory -->';
  const block = '<!-- soduwork-work-memory:' + 'a'.repeat(64) + ' -->\n## 会话记录\n\n**结果**\n'
    + '内容'.repeat(200) + '\n\n' + blockEnd;
  const content = '# 手写区\n长期有效的知识\n\n' + block + '\n\n' + block + '\n\n';
  const sliced = local.blockAwareSlice(content, 600);
  assert.ok(sliced.endsWith(blockEnd));
  assert.ok(sliced.startsWith('# 手写区'));
  const opens = (sliced.match(/<!-- soduwork-work-memory:/g) || []).length;
  const closes = (sliced.match(/<!-- \/soduwork-work-memory -->/g) || []).length;
  assert.equal(opens, closes);
  assert.ok(sliced.length < content.length);
  assert.equal(local.blockAwareSlice('短内容', 600), '短内容');
});
