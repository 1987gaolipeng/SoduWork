'use strict';
/*
 * Resumed output and draft discovery uses the original conversation time even without a
 * native resume path, preserving outputs across later-day reopening.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const stream = require('../main/pi-session/event-stream');
const candidates = require('../main/pi-session/plugin-draft-candidates');
const DAY = 24 * 60 * 60 * 1000;

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-output-window-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

/*
 * Supply the same new-session and resumed-session time boundaries chosen by session-open.
 */
function open(root, options = {}) {
  const startedAt = options.startedAt || Date.now();
  const acc = stream.create();
  return require('../main/pi-session/session-handle').create({
    ref: 'ref-a', effectiveCwd: root, goal: {}, taskBinding: { taskIds: [], taskBindings: [] },
    shared: { stream, attachmentContract: require('../main/pi-session/attachment-contract'),
      messageTime: require('../main/conversation/message-time') },
    turnQueue: { active: () => null },
    prep: { model: { id: 'model-a' } },
    piSession: { sessionId: 'session-a', sessionManager: { getEntries: () => [], getHeader: () => ({}) },
      agent: { state: { messages: [] } } },
    acc, handle: { fileChanges: null }, run: { startedAt: 0 },
    startedAt, pluginOutputSince: options.pluginOutputSince ?? startedAt,
    opts: options.opts || {},
    _snapshot: () => acc.snapshot(), _emit() {}, persistPluginSelection() {},
  });
}

/* Create an older plugin draft after session start but before today's reopening. */
function draft(root) {
  const file = path.join(root, 'soduwork-plugin-draft.json');
  fs.writeFileSync(file, JSON.stringify({ template: 'workflow', name: 'Page workshop',
    description: 'Build a page', instructions: 'Follow the workflow.' }));
  const seconds = (Date.now() - 3 * DAY) / 1000;
  fs.utimesSync(file, seconds, seconds);
}

test('续聊既有会话（无本地原生存档路径）仍看得见此前的产出与安装卡片', t => {
  const root = workspace(t), now = Date.now(), sessionSince = now - 5 * DAY;
  draft(root);
  const resumed = open(root, { startedAt: now, pluginOutputSince: sessionSince,
    opts: { resumedConversation: true } });
  const snapshot = resumed.outputSnapshot();
  assert.equal(resumed.outputSince, sessionSince, '扫描窗口必须取会话自身的时间');
  assert.ok(snapshot.files.some(file => file.name === 'soduwork-plugin-draft.json'),
    '跨天之前写下的产出不能因为重新打开对话而消失');
  assert.ok(candidates.collect(root, snapshot).some(row => row.pluginDraft),
    '插件草稿必须重新给出「检查并安装」候选');
});

test('带原生存档路径的恢复保持原有全量语义', t => {
  const root = workspace(t);
  draft(root);
  const resumed = open(root, { pluginOutputSince: Date.now() - 5 * DAY,
    opts: { resumePath: path.join(root, 'archive.jsonl') } });
  assert.equal(resumed.outputSince, 0, '有原生存档时沿用既有行为');
  assert.ok(candidates.collect(root, resumed.outputSnapshot()).some(row => row.pluginDraft));
});

test('全新会话不从工作目录里认领旧产出', t => {
  const root = workspace(t), now = Date.now();
  draft(root);
  const fresh = open(root, { startedAt: now, pluginOutputSince: now, opts: {} });
  const snapshot = fresh.outputSnapshot();
  assert.equal(fresh.outputSince, now, '新会话自开工时刻算起');
  assert.ok(!snapshot.files.some(file => file.name === 'soduwork-plugin-draft.json'),
    '新会话的窗口自开工时刻算起，历史文件不得混入本轮成果');
  assert.equal(candidates.collect(root, snapshot).some(row => row.pluginDraft), false,
    '新会话不得凭旧文件给出安装卡片');
});

test('主进程确实把“续聊既有会话”这一事实传给了会话打开', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
  assert.match(source, /resumedConversation: Boolean\(resume && !work\.bootstrap\)/);
  const opened = fs.readFileSync(path.join(__dirname, '../main/pi-session/session-open.js'), 'utf8');
  assert.match(opened, /opts\.resumedConversation \|\| opts\.resumePath/);
});

test('输入暂存目录保持原位置，附件仍走相对路径', () => {
  const ipc = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
  /*
   * Keep attachment staging inside cwd so model context uses relative paths instead of
   * exposing managed absolute paths.
   */
  assert.match(ipc, /'temp', ref, '\.soduwork-inputs'/);
  assert.doesNotMatch(ipc, /'temp', '\.soduwork-inputs', ref/);
});

test('Pi indexes identical names in each conversation delivery directory while editing one project', async t => {
  const root = workspace(t);
  const workspaces = require('../main/conversation/delivery-workspace.cjs');
  const start = Date.now() - 1000;
  const a = workspaces.allocate(root), b = workspaces.allocate(root);
  assert.notEqual(a.key, b.key);
  assert.equal(fs.existsSync(a.draftRoot), false);
  fs.writeFileSync(path.join(root, 'report.md'), 'shared project');
  for (const [assignment, content] of [[a, 'first report'], [b, 'second report']]) {
    workspaces.ensure(root, assignment);
    fs.writeFileSync(path.join(assignment.draftRoot, 'report.md'), content);
  }
  for (const [assignment, content] of [[a, 'first report'], [b, 'second report']]) {
    const options = { startedAt: start, opts: { deliveryWorkspace: workspaces.resolve(root, assignment.key) } };
    const pi = open(root, options);
    assert.equal(pi.cwd, root);
    const output = await pi.outputSnapshotAsync();
    assert.deepEqual(output.files.map(row => row.relative), ['report.md']);
    assert.equal(fs.readFileSync(output.files[0].path, 'utf8'), content);
    assert.deepEqual(pi.outputSnapshot().files, output.files);
  }
});

test('delivery namespaces reject a forged key, a sibling root and a replaced directory', t => {
  const cwd = workspace(t);
  const workspaces = require('../main/conversation/delivery-workspace.cjs');
  const a = workspaces.allocate(cwd), b = workspaces.allocate(cwd);
  assert.throws(() => workspaces.resolve(cwd, '../private'));
  assert.throws(() => workspaces.root(cwd, { ...a, draftRoot: b.draftRoot }));
  workspaces.ensure(cwd, b);
  fs.symlinkSync(b.draftRoot, a.draftRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => workspaces.root(cwd, a));
});

test('private turn receipts include verified browser evidence, skipping other hidden files', async t => {
  const cwd = workspace(t), spaces = require('../main/conversation/delivery-workspace.cjs');
  const journal = require('../main/conversation/file-change-journal');
  const assignment = spaces.allocate(cwd);
  const before = await spaces.deliverySnapshot(cwd, assignment, journal.snapshot);
  const folder = path.join(spaces.ensure(cwd, assignment), '.soduwork', 'evidence');
  fs.mkdirSync(folder, { recursive: true });
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  fs.writeFileSync(path.join(folder, 'preview.png'), png);
  fs.writeFileSync(path.join(folder, 'invalid.png'), 'not a raster');
  fs.writeFileSync(path.join(folder, 'other.txt'), 'not a screenshot');
  const after = await spaces.deliverySnapshot(cwd, assignment, journal.snapshot);
  const changes = spaces.changes(before, after, 'turn');
  assert.deepEqual(changes.files.map(file => file.path), ['.soduwork/evidence/preview.png']);
  assert.equal(changes.files[0].after.hash, require('node:crypto').createHash('sha256').update(png).digest('hex'));
  assert.deepEqual((await journal.snapshot(assignment.draftRoot)).files, {});
});

test('private capture reports incomplete or oversized receipts without retrying the turn or leaking error text', async () => {
  const { freezeTurn } = require('../main/conversation/delivery-workspace.cjs');
  const warnings = [], captures = [];
  const handle = { deliveryWorkspace: {}, async captureArtifactTurn(value) { captures.push(value); } };
  const messages = [{ role: 'user' }];
  const report = value => warnings.push(value);
  await freezeTurn(handle, null, messages, report);
  await freezeTurn(handle, { truncated: true, files: [] }, messages, report);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(message => message.includes('未能完整核对')));
  assert.equal(captures.length, 0);
  const mixed = { files: [{ after: { hash: 'meta:100:999' } }, { after: { hash: 'a'.repeat(64) } }] };
  await freezeTurn(handle, mixed, messages, report);
  assert.deepEqual(captures, [mixed]);
  assert.match(warnings.at(-1), /1 个文件超过 32 MiB/);
  handle.captureArtifactTurn = () => { throw Error('/private/path/secret'); };
  await freezeTurn(handle, { files: [mixed.files[1]] }, messages, report);
  assert.doesNotMatch(warnings.at(-1), /secret/);
  assert.match(warnings.at(-1), /归档失败/);
});

test('a changed project alias cannot rebind a conversation delivery directory', t => {
  const dir = workspace(t), spaces = require('../main/conversation/delivery-workspace.cjs');
  const a = path.join(dir, 'a'), b = path.join(dir, 'b'), alias = path.join(dir, 'alias');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(a, alias, type);
  const scope = spaces.allocate(alias);
  assert.equal(scope.projectRoot, fs.realpathSync.native(a));
  fs.unlinkSync(alias);
  fs.symlinkSync(b, alias, type);
  assert.throws(() => spaces.root(alias, scope));
});
