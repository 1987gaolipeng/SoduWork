'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.window = global;
require('../components/panels/panels-chat-tools');
const info = require('../components/panels/chat-workspace-info');
const links = require('../components/panels/chat-output-links');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const file = (relative, extra = {}) => ({ artifactId: relative, relative,
  name: relative.split('/').pop(), size: 20, at: 1200, primary: true, ...extra });
const message = (role, text, at) => ({ role, at, blocks: [{ kind: 'text', text }] });

test('current work excludes other sessions and prior turns in a shared project without removing history', () => {
  const files = [file('other/report.md', { changedInTurn: true }), file('old.md'), file('mine/report.md')];
  const snapshot = { messages: [message('user', 'old task', 100), message('assistant', 'old.md', 200),
    message('user', 'new task', 1000), message('assistant', 'Saved mine/report.md', 1200)], tools: [] };
  assert.deepEqual(info.currentWorkFiles(snapshot, files).map(row => row.relative), ['mine/report.md']);
  assert.equal(links.fileTarget('old.md', files)?.artifactId, 'old.md', 'history stays addressable');
  assert.equal(files.length, 3, 'scope selection must not mutate the trusted index');
});

test('a completed write owns its exact path and never a same-name sibling', () => {
  const files = [file('first/report.md'), file('second/report.md'), file('input.md')];
  const snapshot = { messages: [message('user', 'update second', 1000)], tools: [
    { name: 'write', state: 'done', after: 0, args: { path: 'second/report.md' } },
    { name: 'read', state: 'done', after: 0, args: { path: 'input.md' } },
  ] };
  assert.deepEqual(info.currentWorkFiles(snapshot, files).map(row => row.relative), ['second/report.md']);
});

test('explicit current Markdown screenshots are previewable without promoting their delivery role', () => {
  const screenshot = file('checks/home.png', { primary:false, processEvidence:true, changedInTurn:true });
  const noise = file('checks/other.png', { primary:false, processEvidence:true, changedInTurn:true });
  const snapshot = { messages:[message('user','build website',1000),
    message('assistant','![网站截图](checks/home.png)',1200)] };
  const selected = info.currentWorkFiles(snapshot,[screenshot,noise],'/project');
  assert.deepEqual(selected,[screenshot]);
  assert.equal(selected[0],screenshot, 'preview selection retains the authoritative file object');
  assert.equal(screenshot.primary,false); assert.equal(screenshot.processEvidence,true);
  snapshot.messages.push(message('user','next unrelated task',2000));
  assert.deepEqual(info.currentWorkFiles(snapshot,[screenshot,noise],'/project'),[]);
});

test('explicit screenshot evidence retains exact workspace, ambiguity and task boundaries', () => {
  const evidence = (relative,extra={}) => file(relative,{primary:false,processEvidence:true,...extra});
  const own = evidence('mine/home.png'), other = evidence('other/home.png');
  const current = text => ({messages:[message('user','current task',1000),message('assistant',text,1200)]});
  assert.deepEqual(info.currentWorkFiles(current('[截图](mine/home.png)'),[own,other],'/project'),[own]);
  for(const target of ['home.png','../mine/home.png','/elsewhere/mine/home.png','https://example.test/mine/home.png'])
    assert.deepEqual(info.currentWorkFiles(current('![截图]('+target+')'),[own,other],'/project'),[],target);
  assert.deepEqual(info.currentWorkFiles(current('mine/home.png'),[own],'/project'),[], 'plain process prose does not promote evidence');
  const taskSnapshot=current('[截图](mine/home.png)');taskSnapshot.messages[1].taskId='current';
  const remote=evidence('mine/home.png',{artifactId:'remote',taskId:'current',attachmentId:'shot'});
  assert.deepEqual(info.currentWorkFiles(taskSnapshot,[remote],'/project'),[remote]);
  assert.deepEqual(info.currentWorkFiles(taskSnapshot,[{...remote,taskId:'other'}],'/project'),[], 'another task cannot lend its screenshot');
});

test('a declared script output is current, while a prior journal does not leak into the next turn', () => {
  const files = [file('chart.png'), file('old.md')];
  const journal = { cwd: '/project', capturedAt: 1300, files: [
    { path: 'chart.png', action: 'created', after: { exists: true, size: 20, mtimeMs: 1200 } },
  ] };
  const snapshot = { messages: [message('user', 'generate chart', 1000),
    message('assistant', '交付 chart.png', 1300)], tools: [], fileChanges: journal };
  assert.deepEqual(info.currentWorkFiles(snapshot, files).map(row => row.relative), ['chart.png']);
  snapshot.messages.push(message('user', 'unrelated new work', 2000));
  assert.deepEqual(info.currentWorkFiles(snapshot, files), []);
  assert.equal(info.currentWorkJournal(snapshot), null, 'a new turn must not offer the prior turn diff');
});

test('a shared-folder journal cannot claim another concurrently running conversations files', () => {
  const files = [file('mine.md'), file('other.md', { changedInTurn: true })];
  const snapshot = { messages: [message('user', 'my work', 1000)], tools: [
    { name: 'write', state: 'done', after: 0, args: { path: 'mine.md' } },
  ], fileChanges: { cwd: '/project', capturedAt: 1300, files: files.map(row => ({
    path: row.relative, action: 'created', after: { exists: true, size: 20, mtimeMs: 1200 },
  })) } };
  assert.deepEqual(info.currentWorkFiles(snapshot, files).map(row => row.relative), ['mine.md']);
});

test('restored history uses its latest explicit output instead of all workspace files', () => {
  const snapshot = { messages: [message('user', 'deliver report', 1000),
    message('assistant', '完成：[报告](outputs/report.md)', 1200)], tools: [] };
  assert.deepEqual(info.currentWorkFiles(snapshot, [file('outputs/report.md'), file('another/report.md')])
    .map(row => row.relative), ['outputs/report.md']);
});

test('URI-encoded nested image links own the exact current output without crossing workspace boundaries', () => {
  const files = [file('outputs/海报-2.png'), file('another/海报-2.png'), file('outputs/海报 3.png')];
  const current = text => ({ messages: [message('user', '生成图片', 1000), message('assistant', text, 1200)], tools: [] });
  assert.deepEqual(info.currentWorkFiles(current('[查看图片](outputs/%E6%B5%B7%E6%8A%A5-2.png)'), files, 'C:/Project')
    .map(row => row.relative), ['outputs/海报-2.png']);
  assert.deepEqual(info.currentWorkFiles(current('[查看图片](outputs/%E6%B5%B7%E6%8A%A5%203.png)'), files, 'C:/Project')
    .map(row => row.relative), ['outputs/海报 3.png']);
  for (const target of ['%2e%2e/outputs/%E6%B5%B7%E6%8A%A5-2.png', 'C%3A/Other/outputs/%E6%B5%B7%E6%8A%A5-2.png',
    '%2e%2e%2Foutputs%2F%E6%B5%B7%E6%8A%A5-2.png', '%252e%252e%252Foutputs%252F%E6%B5%B7%E6%8A%A5-2.png',
    'outputs/%E0%A4%A.png']) {
    assert.deepEqual(info.currentWorkFiles(current('[查看图片](' + target + ')'), files, 'C:/Project'), [], target);
  }
  const literalPercent = [file('outputs/image%20result.png'), file('outputs/image result.png')];
  for (const target of ['outputs/image%20result.png', 'outputs/image%2520result.png', 'file:///C:/Project/outputs/image%2520result.png']) {
    assert.deepEqual(info.currentWorkFiles(current('[查看图片](' + target + ')'), literalPercent, 'C:/Project')
      .map(row => row.relative), ['outputs/image%20result.png'], 'decode exactly once: ' + target);
  }
  const malformedLiteral = file('outputs/raw%zz.png');
  assert.deepEqual(info.currentWorkFiles(current('[查看图片](outputs/raw%zz.png)'), [malformedLiteral], 'C:/Project'),
    [malformedLiteral], 'a trusted exact literal percent filename does not require URI decoding');
  for (const target of ['%252e%252e%252Fimage%2520result.png',
    'file%3A%2F%2F%2FC%3A%2FProject%2Foutputs%2Fimage%2520result.png']) {
    assert.deepEqual(info.currentWorkFiles(current('[查看图片](' + target + ')'),
      [file('outputs/image result.png')], 'C:/Project'), [], 'no second decode through basename or file URL: ' + target);
  }
  assert.deepEqual(info.currentWorkFiles(current('[查看图片](raw%zz.png)'), [malformedLiteral], 'C:/Project'),
    [malformedLiteral], 'a literal percent basename keeps its existing trusted lookup');
});

test('failed writes, deleted files and old task outputs do not become current results', () => {
  const snapshot = { messages: [message('user', 'new work', 1000)], tools: [
    { name: 'write', state: 'error', after: 0, args: { path: 'failed.md' } },
  ] };
  assert.deepEqual(info.currentWorkFiles(snapshot, [file('failed.md'), file('deleted.md', { deleted: true }),
    file('remote.md', { taskId: 'old-task', changedInTurn: true })]), []);
});

test('file changes merge by workspace path, not basename or a suffix in another directory', () => {
  const rows = [file('first/report.md'), file('second/report.md')];
  const change = { path: 'second/report.md', action: 'modified', after: { exists: true, size: 20, mtimeMs: 1200 } };
  const merged = links.mergeFileChanges(rows, { cwd: '/project', files: [change] });
  assert.equal(merged[0].change, undefined);
  assert.equal(merged[1].change, change);
  const missing = links.mergeFileChanges([rows[0]], { cwd: '/project', files: [change] });
  assert.equal(missing.length, 2);
  assert.equal(missing[1].path, '/project/second/report.md');
});

test('workspace file matching preserves POSIX case and understands Windows absolute paths', () => {
  assert.equal(links.workspaceFileTarget('Report.md', [file('report.md')], '/project'), null);
  assert.equal(links.workspaceFileTarget('C:\\Work\\second\\REPORT.md', [file('second/report.md')], 'C:/Work')?.relative, 'second/report.md');
  assert.equal(links.workspaceFileTarget('/outside/second/report.md', [file('second/report.md')], '/project'), null);
  assert.equal(links.workspaceFileTarget('report.md', [file('report.md', { path: '/other/report.md' })], '/project'), null);
  assert.equal(links.workspaceFileTarget('/project/report.md', [file('report.md', { path: '/other/report.md' })], '/project'), null);
});

test('a quoted foreign path cannot claim the only same-name file in this workspace', () => {
  const snapshot = { messages: [message('user', 'current task', 1000),
    message('assistant', '另外一个目录的 /elsewhere/report.md 与 other/report.md 没有修改', 1200)], tools: [] };
  const files = [file('report.md', { path: '/project/report.md' })];
  assert.deepEqual(info.currentWorkFiles(snapshot, files, '/project'), []);
});

test('bare prose and markdown names cannot reclaim a same-name output outside the current workspace', () => {
  const foreign = file('report.md', { artifactId:'foreign', path:'/other/report.md' });
  const local = file('report.md', { artifactId:'local', path:'/project/report.md' });
  for (const text of ['完成：report.md', '完成：[报告](report.md)']) {
    const snapshot = { messages: [message('user', 'current work', 1000), message('assistant', text, 1200)], tools:[] };
    assert.deepEqual(info.currentWorkFiles(snapshot, [foreign], '/project'), [], text);
    assert.deepEqual(info.currentWorkFiles(snapshot, [foreign, local], '/project').map(row => row.artifactId), ['local'], text);
  }
});

test('explicit filesystem root workspaces match absolute writes and file URLs with platform case rules', () => {
  const files = [file('report.md')];
  for (const [cwd, target] of [['/', '/report.md'], ['/', 'file:///report.md'],
    ['C:/', 'c:/Report.md'], ['C:\\', 'file:///c:/Report.md']]) {
    assert.equal(links.workspaceFileTarget(target, files, cwd), files[0], cwd + ' ' + target);
    const snapshot = { messages:[message('user', 'write report', 1000)], tools:[
      {name:'write', state:'done', after:0, args:{path:target}},
    ] };
    assert.deepEqual(info.currentWorkFiles(snapshot, files, cwd).map(row => row.relative), ['report.md']);
  }
  assert.equal(links.workspaceFileTarget('/Report.md', files, '/'), null, 'POSIX roots remain case sensitive');
  assert.equal(links.workspaceFileTarget('D:/report.md', files, 'C:/'), null, 'a different drive stays out of scope');
});

test('Chinese prose absolute paths and file URLs retain precise output ownership on restored history', () => {
  const files = [file('报告.md')];
  for (const text of ['完成：C:/Project/报告.md', '完成：[报告](file:///C:/Project/%E6%8A%A5%E5%91%8A.md)']) {
    const snapshot = { messages: [message('user', 'current task', 1000), message('assistant', text, 1200)], tools: [] };
    assert.deepEqual(info.currentWorkFiles(snapshot, files, 'C:/Project').map(row => row.relative), ['报告.md'], text);
  }
  assert.equal(links.workspaceFileTarget('file:///C:/Project/%E6%8A%A5%E5%91%8A.md', files, 'C:/Project'), files[0]);
});

test('two conversations explicitly sharing a folder see only their own current work', () => {
  const files = [file('first/report.md'), file('second/report.md')];
  const one = { messages: [message('user', 'first report', 1000)], tools: [
    { name: 'write', state: 'done', after: 0, args: { path: 'C:/Project/first/report.md' } }] };
  const two = { messages: [message('user', 'second report', 1100)], tools: [
    { name: 'write', state: 'done', after: 0, args: { path: 'C:/Project/second/report.md' } }] };
  assert.deepEqual(info.currentWorkFiles(one, files, 'C:/Project').map(row => row.relative), ['first/report.md']);
  assert.deepEqual(info.currentWorkFiles(two, files, 'C:/Project').map(row => row.relative), ['second/report.md']);
});

test('the current task can expose a trusted remote result while another task remains historical', () => {
  const snapshot = { messages: [message('user', 'previous task', 100),
    { ...message('assistant', 'complete', 200), taskId: 'earlier' },
    { ...message('user', 'current task', 1000), taskId: 'current' }], tools: [] };
  const files = [file('old.pdf', { taskId: 'earlier' }), file('current.pdf', { taskId: 'current' })];
  assert.deepEqual(info.currentWorkFiles(snapshot, files).map(row => row.relative), ['current.pdf']);
  files[1].path = '/remote/current.pdf';
  assert.deepEqual(info.currentWorkFiles(snapshot, files, '/local').map(row => row.relative), ['current.pdf'],
    'explicit current-task ownership retains a trusted remote result outside the local cwd');
});

test('the real workbench sends scoped summary rows and never auto-opens another conversations newer output', () => {
  const node = () => ({ dataset: {}, setAttribute() {}, classList: { toggle() {}, remove() {} } });
  const nodes = { '.ncw': node(), '.ncw-tabs': node(), '.ncw-body': node() };
  const root = { ...node(), querySelector: selector => nodes[selector] || null, addEventListener() {} };
  let summary;
  const sandbox = { console, URL, document: { activeElement: null },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    ChatChrome: { workbenchState(value) { summary = value; } },
    ChatWorkspaceSplit: { DEFAULT: 0.5, set() {}, bind: () => ({ dispose() {} }) } };
  sandbox.window = sandbox; vm.createContext(sandbox);
  for (const name of ['chat-output-links', 'chat-dom-patch', 'panels-chat-tools', 'chat-workspace-info',
    'chat-workspace-controls', 'panels-chat-workspace']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8'), sandbox);
  }
  const wb = sandbox.ChatWorkbench;
  wb.bind(root, () => ({ ref: 'first', cwd: '/project', intent: {} }));
  const files = [file('other.md', { changedInTurn: true }), file('mine.md')];
  wb.render(root, { messages: [message('user', 'my work', 1000),
    message('assistant', 'mine.md', 1200)], tools: [] }, files);
  assert.deepEqual(Array.from(summary.summary.files, row => row.path), ['mine.md']);
  assert.equal(summary.count, 1);
  assert.equal(wb.state().open, false, 'a newer file from another chat must not open the preview either');
  wb.render(root, { messages: [message('user', 'my next work', 2000)], tools: [] }, files);
  assert.equal(summary.summary.files.length, 0, 'the summary clears at the next work boundary');
  assert.equal(wb.openOutput('mine.md'), true, 'the history output is still addressable after the summary clears');
  wb.render(root, { messages: [message('user', 'restored work', 3000)], tools: [
    { name: 'write', state: 'done', after: 0, args: { path: '/project/mine.md' } },
  ] }, files);
  assert.deepEqual(Array.from(summary.summary.files, row => row.path), ['mine.md'],
    'restored conversations resolve absolute tool paths from the actual opened cwd, without an intent cwd or journal');
});
