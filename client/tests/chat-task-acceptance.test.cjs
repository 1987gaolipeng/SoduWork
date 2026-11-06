const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-task-controller.js'), 'utf8');

test('验收会话预填需求、验收标准和相关文件，并保留模式差异', () => {
  const window = {};
  vm.runInNewContext(source, { window });
  const task = {
    title: '检查交付页面',
    note: '确认页面在窄屏下可用',
    criteria: ['无横向滚动', '主要操作可聚焦'],
    // Same-named files remain visible; native preparation owns their immutable identifiers.
    attachments: [
      {id: 'att-screenshot-1', filename: '验收截图.png', size: 128},
      {id: 'att-screenshot-2', filename: '验收截图.png', size: 256},
      {attachmentId: 'att-readme', name: '交付说明.md', size: 512},
      {id: 'process-log', filename: '过程记录.md', role: 'process', size: 88},
      {id: 'old-rework', filename: '返修说明.md', role: 'rework_input', size: 64},
    ],
  };
  const manual = window.ChatTaskController.acceptanceDraft(task, 'manual');
  assert.match(manual, /【验收分析】/);
  assert.match(manual, /检查交付页面/);
  assert.match(manual, /无横向滚动/);
  assert.match(manual, /验收截图\.png/);
  assert.equal((manual.match(/验收截图\.png/g) || []).length, 2);
  assert.doesNotMatch(manual, /att-screenshot-1|att-screenshot-2|附件 ID|128 bytes/);
  assert.doesNotMatch(manual, /old-rework|返修说明\.md/);
  assert.doesNotMatch(manual, /process-log|过程记录\.md/);
  assert.match(manual, /最终由我确认/);
  const auto = window.ChatTaskController.acceptanceDraft(task, 'auto');
  assert.match(auto, /【自动验收】/);
  assert.match(auto, /自动验收约定/);
  assert.match(auto, /交付说明\.md/);
});

test('返修新会话提供基于上一轮交付的修复草稿并保留精确附件身份', () => {
  const window = {};
  vm.runInNewContext(source, { window });
  const draft = window.ChatTaskController.reworkDraft({id: 't-1', title: '修复导出页', attachments: [
    {id:'old', filename:'报告.md', role:'output', sourceRef:'conversation:old', createdAt:'2026-10-17T10:00:00Z', evidenceMeta:{round:1, verification:{state:'passed'}}},
    {id:'new', filename:'报告.md', role:'output', sourceRef:'conversation:new', createdAt:'2026-10-18T10:00:00Z', evidenceMeta:{round:1, verification:{state:'passed'}}},
  ]}, '补充空状态与边界处理');
  assert.match(draft, /修复导出页/);
  assert.match(draft, /补充空状态与边界处理/);
  assert.match(draft, /附件 ID: new/);
  assert.match(draft, /交付批次: conversation:new/);
  assert.doesNotMatch(draft, /附件 ID: old/);
  assert.match(draft, /禁止从头重做/);
});

test('同人验收借用原执行会话时仍以验收上下文发送，不升级普通会话存储', () => {
  assert.match(source, /acceptanceExecutionSession/);
  assert.match(source, /opts\.acceptanceSession \|\| opts\.acceptanceExecutionSession/);
  const session = fs.readFileSync(path.join(__dirname, '../components/panels/chat-session-controller.js'), 'utf8');
  assert.match(session, /acceptanceOnly: true/);
});

test('原执行会话在另一会话完成验收后识别通过与退回终态', () => {
  const window = {};
  vm.runInNewContext(source, { window });
  const resolved = window.ChatTaskController.acceptanceResolution;
  assert.equal(resolved({ reviewedAt: '2026-10-19T01:00:00Z' }, null), true);
  assert.equal(resolved({ status: 'doing', workRouting: { reworkPending: { feedback: '补充边界' } } }, null), true);
  assert.equal(resolved({ status: 'reviewing' }, { approvals: [{ action: 'review', status: 'pending' }] }), false);
  assert.equal(resolved({ status: 'todo' }, { approvals: [{ action: 'review', status: 'rejected' }] }), true);
  // A previous resolved review must not clear a new pending review round.
  assert.equal(resolved({ status: 'reviewing' }, { approvals: [
    { action: 'review', status: 'approved' }, { action: 'review', status: 'pending' },
  ] }), false);
});

test('跨会话终态事件会释放临时验收发送上下文', () => {
  const window = {};
  vm.runInNewContext(source, { window });
  const ctx = {
    _sessionOptions: { acceptanceExecutionSession: true, acceptanceSession: false,
      taskRef: 'task-1', approvalId: 'review-1', acceptanceAttachmentIds: ['att-1'] },
    _activeCollabTaskId: 'task-1',
  };
  const controller = window.ChatTaskController.create(ctx);
  assert.equal(controller._clearFinishedAcceptanceContext('task-1', {reviewedAt: 1}, null), true);
  assert.equal(ctx._sessionOptions.acceptanceExecutionSession, false);
  assert.equal(ctx._sessionOptions.acceptanceSession, false);
  assert.equal(ctx._sessionOptions.approvalId, '');
  assert.equal(ctx._sessionOptions.acceptanceAttachmentIds.length, 0);
});

function executionReviewFixture(bind) {
  const task = { id: 'review-task', title: 'Review delivery', status: 'reviewing',
    ownerClientId: 'device', workRouting: { conversationTurn: { conversationId: 'execution-chat' } } };
  const input = { value: '', dispatchEvent() {} }, calls = [];
  const handle = { sessionId: 'execution-chat', taskIds: [] };
  const window = { SoduWorkAPI: { getTask: async () => task, taskStorageKey: () => 'current-owner' } };
  vm.runInNewContext(source, { window, SoduWorkAPI: window.SoduWorkAPI, setTimeout: () => 1,
    Event: class Event { constructor(type) { this.type = type; } } });
  const ctx = { _collabTasks: new Map([[task.id, { taskId: task.id, task }]]), _collabStarts: new Set(),
    _sessionId: handle.sessionId, _ref: 'native-ref', _viewEpoch: 1, _taskOpenSeq: 0, _collabPollTimer: 1,
    _collaborationTaskId: task.id, _collaborationTask: task, _boundFromServer: true,
    _snap: { status: 'idle', messages: [] }, _sessionOptions: { adapterId: 'pi' },
    _render() {}, _mount: () => ({ querySelector: () => input }),
    _api: () => ({ bindTask: async (ref, id, title) => {
      calls.push({ ref, id, title });
      const result = bind ? await bind() : { ok: true };
      if (result?.ok) handle.taskIds = [id];
      return result;
    } }) };
  const controller = window.ChatTaskController.create(ctx);
  return { ctx, input, handle, task, calls, window,
    open: (mode = 'manual') => controller._openTask(task.id, task.title, { task, source: 'acceptance',
      acceptanceExecutionSession: true, acceptanceMode: mode, approvalId: 'pending-review' }) };
}

test('reused review confirms the native task binding even when the renderer already shows the requirement', async () => {
  for (const mode of ['manual', 'auto']) {
    const f = executionReviewFixture();
    assert.equal(await f.open(mode), true);
    const turn = await require('../main/pi-session/acceptance-turn').prepare({
      identity: { clientId: 'device' }, taskId: f.task.id, runtime: { handle: { ...f.handle, cwd: __dirname } },
      requested: { acceptanceExecutionSession: true, acceptanceMode: mode },
      request: async () => ({ task: f.task, canDecide: true, approvalId: 'pending-review',
        artifactVersionId: 'artifact-1', requirementVersion: 1, criteria: [{ id: 'c1', label: 'Delivery works' }] }),
    });
    await turn.beforeTurn();
    assert.equal(turn.acceptanceOnly, true);
    assert.deepEqual(f.calls, [{ ref: 'native-ref', id: f.task.id, title: f.task.title }]);
    assert.equal(f.ctx._sessionOptions.acceptanceMode, mode);
    assert.match(f.input.value, mode === 'auto' ? /自动验收/ : /验收分析/);
  }
});

test('reviewing another requirement in the same open conversation cannot reuse a stale binding flag', async () => {
  const f = executionReviewFixture();
  f.ctx._collaborationTaskId = 'another-task';
  f.ctx._ensure = async () => true;
  assert.equal(await f.open(), true);
  assert.deepEqual(f.handle.taskIds, [f.task.id]);
  assert.equal(f.ctx._sessionOptions.acceptanceExecutionSession, true);
  assert.match(f.input.value, /验收分析/);
});

test('reused review waits for binding and preserves a failed draft until binding can be retried', async () => {
  let resolve;
  const f = executionReviewFixture(() => new Promise(done => { resolve = done; }));
  f.input.value = 'Reviewer draft';
  const pending = f.open();
  await new Promise(setImmediate);
  assert.equal(f.ctx._taskOpenPending, true);
  assert.equal(f.ctx._sessionOptions.acceptanceExecutionSession, undefined);
  assert.equal(f.input.value, 'Reviewer draft');
  resolve({ ok: false, reason: 'Binding storage unavailable' });
  assert.equal(await pending, false);
  assert.match(f.ctx._taskOpenError, /Binding storage unavailable/);
  assert.equal(f.ctx._sessionOptions.acceptanceExecutionSession, undefined);
  const retry = f.open();
  await new Promise(setImmediate);
  resolve({ ok: true });
  assert.equal(await retry, true);
  assert.equal(f.input.value, 'Reviewer draft');
});

test('late binding cannot activate review after navigation, account changes or a newer open', async () => {
  for (const change of ['navigation', 'account', 'newer-open']) {
    let resolve;
    const f = executionReviewFixture(() => new Promise(done => { resolve = done; }));
    const pending = f.open();
    await new Promise(setImmediate);
    if (change === 'navigation') { f.ctx._viewEpoch++; f.ctx._sessionId = 'another-chat'; }
    if (change === 'account') f.window.SoduWorkAPI.taskStorageKey = () => 'another-owner';
    if (change === 'newer-open') f.ctx._taskOpenSeq++;
    resolve({ ok: true });
    assert.equal(await pending, false, change);
    assert.equal(f.ctx._sessionOptions.acceptanceExecutionSession, undefined, change);
    assert.equal(f.input.value, '', change);
  }
});
