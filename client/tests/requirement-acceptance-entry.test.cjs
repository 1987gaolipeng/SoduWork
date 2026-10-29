'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Requirements = require('../core/requirements.js');
function fixture() {
  const window = {Requirements, __teamCap:{meId:'me'}, ChatTaskController:{isPickableTask:task=>task.status==='todo'}};
  for (const file of ['panels/task-trace-approval.js','requirements/requirements-view.js'])
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components',file),'utf8'),{window});
  const state = {...Requirements.defaults,limits:{}};
  return {view:window.RequirementsView,state};
}
test('待验收卡片只保留详情验收入口，其他状态保留原操作', () => {
  const f=fixture(), pending={id:'t',title:'作文',status:'done',createdBy:'me'};
  const reviewContext = {approvals:new Map([['t',{id:'r',action:'review',status:'pending'}]])};
  const board = f.view.board([pending],f.state,reviewContext);
  assert.match(board,/data-rq-open="t"/);
  assert.match(board,/核对成果并选择验收方式/);
  assert.doesNotMatch(board,/data-rq-acceptance/);
  const decided = f.view.board([pending], f.state, {
    approvals: new Map([['t', {...reviewContext.approvals.get('t'), myDecision: {decision: 'approve'}}]])
  });
  assert.doesNotMatch(decided, /rq-card-decision/);
  assert.doesNotMatch(f.view.actions(pending,{}),/data-rq-acceptance|交给 SoduWork/);
  for(const task of [{...pending,status:'todo'},{...pending,status:'doing'},{...pending,reviewedAt:1},{...pending,archivedAt:1},{...pending,canViewExecution:false},{...pending,createdBy:'other'}]) {
    assert.doesNotMatch(f.view.board([task],f.state,{}),/data-rq-acceptance/);
    assert.doesNotMatch(f.view.actions(task,{}),/data-rq-acceptance/);
  }
  assert.match(f.view.actions({...pending,status:'todo'},{}),/data-rq-assign/);
  assert.match(f.view.board([{...pending,createdBy:'other'}],f.state,reviewContext),/data-rq-open="t"/);
  assert.doesNotMatch(f.view.actions(pending,{waiting:new Map([['t',['其他验收人']]])}),/data-rq-acceptance/);
});
