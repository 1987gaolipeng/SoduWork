const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../core/task-sync.js');

test('保存回执更新真实字段并保留待后台刷新的匹配展示状态', () => {
  const previous = { id: 't', title: 'Old', status: 'doing', reviewedAt: null,
    ownerClientId: 'd', assigneeUserId: 'u', assigneeName: 'Alice', executionDeviceName: 'Desktop',
    requirementStage: 'reviewing', ai: {state: 'running'}, maintenanceBlocked: true,
    maintenanceBlockReason: 'Running', canEditRequirement: true };
  const receipt = { id: 't', title: 'Saved', status: 'doing', reviewedAt: null,
    ownerClientId: 'd', assigneeUserId: 'u', requirementStage: 'executing',
    canViewExecution: true, canEditRequirement: false, projectionPending: true };
  const result = sync.mergeSaveReceipt(previous, receipt);
  assert.equal(result.title, 'Saved');
  assert.equal(result.canEditRequirement, false);
  assert.equal(result.assigneeName, 'Alice');
  assert.equal(result.executionDeviceName, 'Desktop');
  assert.equal(result.requirementStage, 'reviewing');
  assert.deepEqual(result.ai, {state: 'running'});
  assert.equal(result.maintenanceBlocked, true);
  assert.equal(result.projectionPending, undefined);
  assert.equal(receipt.projectionPending, true);
  const full = {id: 't', title: 'Full', maintenanceBlocked: false};
  assert.deepEqual(sync.mergeSaveReceipt(result, full), full);
});

test('精简回执不恢复旧私有字段、权限或已变更人员的展示名', () => {
  const previous = { id: 't', status: 'doing', ownerClientId: 'old', assigneeUserId: 'old-user',
    assigneeName: 'Old user', executionDeviceName: 'Old device', note: 'Private',
    ai: {state: 'running'}, workRouting: {private: true}, canViewExecution: true,
    canDeleteRequirement: true, requirementStage: 'reviewing' };
  const receipt = { id: 't', title: 'Public', status: 'todo', ownerClientId: 'new',
    assigneeUserId: 'new-user', canViewExecution: false, canDeleteRequirement: false,
    requirementStage: 'intake', projectionPending: true };
  const result = sync.mergeSaveReceipt(previous, receipt);
  for (const key of ['ai', 'workRouting', 'note', 'assigneeName', 'executionDeviceName']) {
    assert.equal(result[key], undefined, key);
  }
  assert.equal(result.canDeleteRequirement, false);
  assert.equal(result.requirementStage, 'intake');
});

test('保存准备阶段的变化不能被旧展示阶段覆盖', () => {
  const previous = {id:'t', status:'todo', triageStage:'intake', requirementStage:'intake'};
  const receipt = {id:'t', status:'todo', triageStage:'ready', requirementStage:'ready', projectionPending:true};
  assert.equal(sync.mergeSaveReceipt(previous, receipt).requirementStage, 'ready');
});

test('只生成真实变化的字段，不把服务端专属字段写回', () => {
  const before = { id: 't1', title: '旧', status: 'todo', artifactUrl: '/a.zip', tags: [] };
  const after = { ...before, title: '新' };
  assert.deepEqual(sync.diffTask(before, after), { title: '新' });
});

test('空日期与 null 视为同一值，避免无限重复提交', () => {
  assert.deepEqual(sync.diffTask({ due: null }, { due: '' }), {});
});

test('创建载荷只包含客户端可写字段', () => {
  const payload = sync.taskPayload({ id: 't1', title: '任务', ownerClientId: 'x', artifactUrl: 'secret' });
  assert.equal(payload.title, '任务');
  assert.equal(payload.status, 'todo');
  assert.equal(payload.ownerClientId, undefined);
  assert.equal(payload.artifactUrl, undefined);
});

test('未发送的创建与后续修改合并为一次幂等 PUT', () => {
  const merged = sync.mergeOperation(
    { id: 't1', kind: 'put', data: { title: '旧', status: 'todo' } },
    { id: 't1', kind: 'patch', data: { title: '新' } }
  );
  assert.equal(merged.kind, 'put');
  assert.deepEqual(merged.data, { title: '新', status: 'todo' });
});

test('尚未上送的任务被删除时不产生无意义远端操作', () => {
  const merged = sync.mergeOperation(
    { id: 't1', kind: 'put', data: { title: '临时任务' } },
    { id: 't1', kind: 'delete' }
  );
  assert.equal(merged, null);
});

test('多次修改合并，删除优先于旧修改', () => {
  const changed = sync.mergeOperation(
    { id: 't1', kind: 'patch', data: { title: 'A' } },
    { id: 't1', kind: 'patch', data: { note: 'B' } }
  );
  assert.deepEqual(changed.data, { title: 'A', note: 'B' });
  assert.equal(sync.mergeOperation(changed, { id: 't1', kind: 'delete' }).kind, 'delete');
});

test('启动时只叠加显式待提交操作，不合并任意本地历史任务', () => {
  const rows = sync.applyOperations(
    [{ id: 'server', title: '服务端任务', status: 'todo' }],
    [{ id: 'offline', kind: 'put', data: { title: '离线新建', status: 'todo' } }]
  );
  assert.deepEqual(rows.map((x) => x.id), ['offline', 'server']);
  assert.equal(rows.some((x) => x.id === 'stale-local'), false);
});

test('显式删除只影响指定任务', () => {
  const rows = sync.applyOperations(
    [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    [{ id: 'a', kind: 'delete' }]
  );
  assert.deepEqual(rows.map((x) => x.id), ['b']);
});

test('queued patch is rebuilt when a field is changed back', () => {
  const server = { id: 't1', title: 'Original', note: 'Base', status: 'todo' };
  const queued = { id: 't1', kind: 'patch', data: { title: 'Draft', note: 'Changed' } };
  const desired = sync.reconcileOperation(queued, server,
    { ...server, title: 'Original', note: 'Changed' });
  assert.deepEqual(desired, { kind: 'patch', data: { note: 'Changed' } });
  assert.equal(sync.reconcileOperation(desired, server, { ...server }), null);
});

test('queued create always carries the latest complete local state', () => {
  const queued = { id: 't1', kind: 'put', data: { title: 'First', status: 'todo' } };
  const desired = sync.reconcileOperation(queued, null,
    { id: 't1', title: 'Latest', note: 'Saved', status: 'doing', handler: 'me' });
  assert.equal(desired.kind, 'put');
  assert.equal(desired.data.title, 'Latest');
  assert.equal(desired.data.note, 'Saved');
  assert.equal(desired.data.status, 'doing');
});

test('identical intent keeps the in-flight operation stable', () => {
  assert.equal(sync.sameIntent(
    { kind: 'patch', data: { title: 'A' }, token: 'old', blocked: 'HTTP 409', sentAt: 123 },
    { kind: 'patch', data: { title: 'A' }, token: 'new' }
  ), true);
  assert.equal(sync.sameIntent(
    { kind: 'patch', data: { title: 'A' } },
    { kind: 'patch', data: { title: 'B' } }
  ), false);
});

test('an in-flight patch gets a compensation when the user changes back', () => {
  const compensation = sync.compensatingPatch(
    { kind: 'patch', data: { title: 'Draft', due: 1893456000000 } },
    { title: 'Original', due: null, status: 'todo', handler: 'me' }
  );
  assert.deepEqual(compensation,
    { kind: 'patch', data: { title: 'Original', due: null } });
});
test('离线任务保留工作场景和交付标准快照', () => {
  const routing = {
    schemaVersion: 1,
    scenarioKey: 'research-analysis',
    outputContract: { kind: 'evidence-report', acceptance: ['来源可追溯'] }
  };
  const payload = sync.taskPayload({
    title: '行业研究', status: 'todo',
    workScenarioKey: 'research-analysis',
    workScenarioName: '调研与研究',
    workRouting: routing
  });
  assert.equal(payload.workScenarioKey, 'research-analysis');
  assert.equal(payload.workScenarioName, '调研与研究');
  assert.deepEqual(payload.workRouting, routing);
  payload.workRouting.outputContract.kind = 'changed-locally';
  assert.equal(routing.outputContract.kind, 'evidence-report');
});
