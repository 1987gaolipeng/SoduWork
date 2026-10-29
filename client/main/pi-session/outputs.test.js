/*
 * Filesystem-only output-discovery regression tests without Electron or networking.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const outputs = require('./outputs');

let ok = 0;
function check(name, fn) {
  try { fn(); ok++; console.log('  PASS  ' + name); }
  catch (e) { console.log('  FAIL  ' + name); throw e; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-outs-'));
const write = (rel, body, mtime) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body || 'x');
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
  return p;
};

const T0 = Date.now() - 60000;          // Session start time.
write('老文件.txt', 'old', T0 - 60000); // File predating the session.
write('方案.md', '# 方案', T0 + 1000);   // File written during this turn.
write('子目录/图.png', 'png', T0 + 2000);
write('skills/task/SKILL.md', 'skill', T0 + 3000);      // Bundled skill content.
write('node_modules/a/b.js', 'js', T0 + 3000);
write('.隐藏', 'h', T0 + 3000);
write('半截.tmp', 't', T0 + 3000);

check('★只算会话开工之后写的（人自己早放那儿的不算 AI 产出）', () => {
  const names = outputs.list(root, T0).map((f) => f.name);
  assert.ok(names.includes('方案.md'), names.join(','));
  assert.ok(!names.includes('老文件.txt'), names.join(','));
});

check('子目录里的也算（AI 常按类别建文件夹）', () => {
  assert.ok(outputs.list(root, T0).map((f) => f.name).includes('图.png'));
});

check('★技能包/依赖/隐藏文件/临时文件都不算产出', () => {
  const names = outputs.list(root, T0).map((f) => f.name);
  ['SKILL.md', 'b.js', '.隐藏', '半截.tmp'].forEach((n) =>
    assert.ok(!names.includes(n), '不该出现 ' + n + '：' + names.join(',')));
});

check('新的排前面（人最关心刚写出来的那份）', () => {
  const list = outputs.list(root, T0);
  assert.equal(list[0].name, '图.png');
});

check('带大小和时间，界面直接能显示', () => {
  const f = outputs.list(root, T0).find((x) => x.name === '方案.md');
  assert.ok(f.size > 0 && f.at > 0 && path.isAbsolute(f.path));
  assert.equal(f.relative, '方案.md');
});

check('大量成果明确标记截断，而不是让人误以为只有 60 个', () => {
  for (let i = 0; i < 61; i++) write('批量/第' + i + '份.txt', String(i), T0 + 4000 + i);
  const got = outputs.scan(root, T0);
  assert.equal(got.files.length, 60);
  assert.equal(got.truncated, true);
  assert.ok(got.files.every((f) => f.relative && !path.isAbsolute(f.relative)));
});

check('★安全闸：只许打开工作目录里的文件', () => {
  assert.equal(outputs.inside(root, path.join(root, '方案.md')), true);
  assert.equal(outputs.inside(root, path.join(root, '子目录', '图.png')), true);
  assert.equal(outputs.inside(root, path.join(root, '..', '别的.txt')), false);
  assert.equal(outputs.inside(root, 'C:\\Windows\\System32\\drivers\\etc\\hosts'), false);
  assert.equal(outputs.inside(root, root), false);        // Reject directories as output files.
  assert.equal(outputs.inside('', path.join(root, 'x')), false);
});

check('★安全闸：拒绝工作目录里指向外部目录的链接', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-outs-external-'));
  const secret = path.join(outside, 'secret.txt');
  const linked = path.join(root, 'linked-outside');
  fs.writeFileSync(secret, 'secret');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal(outputs.inside(root, path.join(linked, 'secret.txt')), false);
  } finally {
    try { fs.unlinkSync(linked); } catch (_) { fs.rmdirSync(linked); }
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

check('产出窗口只在工作区内导航，网页链接交给外部浏览器', () => {
  const insideUrl = pathToFileURL(path.join(root, '方案.md')).href;
  assert.equal(outputs.navigation(root, insideUrl).kind, 'inside');
  assert.equal(outputs.navigation(root, 'https://example.com/docs').kind, 'external');
  assert.equal(outputs.navigation(root, 'javascript:alert(1)').kind, 'blocked');
  assert.equal(outputs.navigation(root,
    pathToFileURL(path.join(root, '..', 'secret.txt')).href).kind, 'blocked');
});

check('没有 cwd 时回空，不抛', () => {
  assert.deepEqual(outputs.list('', 0), []);
  const empty = outputs.scan('', 0);
  assert.deepEqual(empty.files, []);
  assert.equal(empty.truncated, false);
  assert.equal(empty.delivery.schemaVersion, 1);
  assert.equal(empty.delivery.source, 'inferred');
  assert.deepEqual(empty.delivery.items, []);
});

fs.rmSync(root, { recursive: true, force: true });
console.log('\n  ' + ok + ' 项全过');
