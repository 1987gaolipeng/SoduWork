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
