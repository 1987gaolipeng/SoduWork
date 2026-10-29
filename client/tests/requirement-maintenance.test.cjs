'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const R = require('../core/requirements.js');
const TaskSync = require('../core/task-sync.js');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const delegated = {id: 'delegated', title: '委托同事整理客户周报', origin: 'dispatch',
  ownerClientId: 'coworker-device', status: 'todo', readOnly: true,
  canEditRequirement: true, canDeleteRequirement: true, canArchiveRequirement: true,
  maintenanceBlocked: false, myRoles: ['creator'], requirementVersion: 3};
function view() {
  const ctx = {Requirements: R, SoduWorkAPI: {clientId: 'my-device'}};
  ctx.window = ctx; vm.runInNewContext(source('components/requirements/requirements-view.js'), ctx);
  return ctx.RequirementsView;
}

test('禁止归档删除的阶段不显示操作，归档项可直接删除', () => {
  const cases = [
    [{status: 'todo', triageStage: 'intake'}, true],
    [{status: 'todo', triageStage: 'clarifying'}, true],
    [{status: 'todo', triageStage: 'ready'}, true],
    [{status: 'done', reviewedAt: 1}, true],
    [{status: 'doing'}, false], [{status: 'paused'}, false],
    [{status: 'done', reviewedAt: null}, false],
    [{status: 'todo', requirementStage: 'reviewing'}, false],
    [{status: 'cancel'}, false], [{status: 'todo', archivedAt: 123}, false],
    [{status: 'doing', archivedAt: 123}, false],
  ];
  for (const [fields, allowed] of cases) {
    const task = {...delegated, ...fields};
    for (const action of ['archive', 'delete']) {
      const result = R.maintenance(task, action);
      const expected = allowed || (action === 'delete' && R.stage(task) === 'closed');
      assert.equal(result.visible, expected, JSON.stringify({fields, action}));
      assert.equal(result.disabled, !expected, JSON.stringify({fields, action}));
      if (!expected) assert.match(result.reason, /收集箱.*待开始.*已完成/);
      const selector = action === 'delete' ? 'delete' : 'maintain';
      if (!expected && !(action === 'archive' && R.stage(task) === 'closed')) {
        assert.doesNotMatch(view().actions(task, {}), new RegExp('data-rq-' + selector + '="delegated"'));
      }
    }
  }
  assert.equal(R.maintenance({...delegated, archivedAt: 123}, 'restore').disabled, false);
});

test('收集箱和待开始仅创建人可维护，已验收和已归档保留原维护授权', () => {
  for (const triageStage of ['intake', 'clarifying', 'ready']) {
    for (const myRoles of [[], ['requester'], ['assignee'], ['executor'], ['creator'], ['creator', 'requester']]) {
      const task = {...delegated, triageStage, myRoles};
      for (const action of ['archive', 'delete']) {
        assert.equal(R.maintenance(task, action).visible, myRoles.includes('creator'), JSON.stringify({triageStage, myRoles, action}));
      }
    }
  }
  for (const myRoles of [['requester'], ['assignee'], ['executor']]) {
    assert.equal(R.canArchive({...delegated, myRoles, status: 'done', reviewedAt: 1}), true);
    assert.equal(R.canDelete({...delegated, myRoles, archivedAt: 1}), true);
  }
  assert.equal(R.canDelete({...delegated, archivedAt: 1, canDeleteRequirement: false}), false);
  assert.equal(R.canDelete({...delegated, myRoles: undefined}), true, '旧响应缺角色时以显式Hub维护权限为准');
});

test('真实Hub派发数据以维护权限为准，跨设备、只读执行状态不隐藏删除', () => {
  for (const task of [delegated, {...delegated, ownerClientId: null, origin: 'integration'}]) {
    assert.equal(R.canDelete(task, 'my-device'), true);
    assert.deepEqual(R.maintenance(task, 'delete'), {visible: true, disabled: false, reason: ''});
    assert.match(view().actions(task, {}), /data-rq-delete="delegated"/);
  }
  for (const task of [{...delegated, canDeleteRequirement: false}, {id: 'old', readOnly: false},
    {...delegated, canDeleteRequirement: undefined, canEditRequirement: false}]) {
    assert.equal(R.canDelete(task, 'my-device'), false);
    assert.equal(R.maintenance(task, 'delete').visible, false);
  }
});

test('未结束流程隐藏归档删除，Hub已结束事实不被陈旧AI状态覆盖', () => {
  const reason = '关联流程尚未结束，请先结束流程再操作';
  for (const status of ['todo', 'doing', 'paused', 'done', 'cancel']) {
    const task = {...delegated, status, maintenanceBlocked: true, maintenanceBlockReason: reason};
    for (const action of ['delete', 'archive', 'restore']) {
      assert.deepEqual(R.maintenance(task, action), {visible: action === 'restore', disabled: true, reason});
    }
    const html = view().actions(task, {});
    assert.doesNotMatch(html, /data-rq-delete="delegated"/);
    if (R.stage(task) === 'closed') assert.match(html, /data-rq-maintain="delegated"[^>]*disabled/);
    else assert.doesNotMatch(html, /data-rq-maintain="delegated"/);
  }
  assert.equal(R.canDelete({...delegated, ai: {state: 'running'}}), true);
  assert.equal(R.canArchive({...delegated, status: 'doing', ai: {state: 'running'}}), false);
  assert.equal(R.canDelete({...delegated, maintenanceBlocked: undefined,
    workRouting: {conversationTurn: {state: 'waiting'}}}), false);
});

test('归档视图只有与我相关和全部，旧已创建/待处理偏好自动回到与我相关', () => {
  assert.deepEqual(Object.keys(R.scopeOptions('archived')), ['related', 'all']);
  assert.deepEqual(Object.keys(R.scopeOptions('active')), ['related', 'actionable', 'created', 'all']);
  for (const scope of ['actionable', 'created', 'unknown']) {
    assert.equal(R.viewSettings({archive: 'archived', scope}).scope, 'related');
  }
  assert.equal(R.viewSettings({archive: 'archived', scope: 'all'}).scope, 'all');
  assert.equal(R.viewSettings({archive: 'active', scope: 'created'}).scope, 'created');
});

test('definition tags are editable only before execution while maintenance remains independent', () => {
  for (const status of ['todo', 'doing', 'paused', 'done', 'cancel']) {
    assert.deepEqual(R.editPatch({...delegated, status, tags: []}, {tags: ['客户反馈']}), status === 'todo' ? {tags: ['客户反馈']} : {});
  }
  assert.deepEqual(R.editPatch({...delegated, status: 'doing', tags: []},
    {tags: ['客户反馈'], title: '修改执行目标', note: '修改说明', acceptanceCriteria: ['修改标准'], assigneeUserId: 'other'}),
  {});
  assert.deepEqual(R.editPatch({...delegated, canEditRequirement: false, tags: []}, {tags: ['客户反馈']}), {});
});

test('维护权限和禁用原因跟随Hub快照透传，但不会被客户端写回', () => {
  const task = {...delegated, maintenanceBlocked: true, maintenanceBlockReason: '正在等待审批'};
  const visible = TaskSync.applyOperations([task], [{id: task.id, kind: 'patch', data: {title: '更新标题'}}])[0];
  for (const key of ['canDeleteRequirement', 'canArchiveRequirement', 'maintenanceBlocked', 'maintenanceBlockReason']) {
    assert.equal(visible[key], task[key]);
    assert.equal(Object.hasOwn(TaskSync.taskPayload(task), key), false);
  }
});
