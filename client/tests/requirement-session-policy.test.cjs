'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../core/requirement-session-context');
test('project matching never equates names or sidebar-only project folders',()=>{
  assert.equal(policy.relation({projectName:'官网'},{projectName:'官网'}),'unbound');
  assert.equal(policy.relation({projectId:'p'},{projectId:'project-uuid'}),'unbound');
  assert.equal(policy.relation({projectId:'p',repoId:'a'},{projectId:'p',repoId:'b'}),'other');
  assert.equal(policy.relation({projectId:'p',repoId:'a'},{projectId:'p',repoId:'a'}),'repo');
});
test('path display comparison handles Windows and keeps POSIX case sensitivity',()=>{
  assert.equal(policy.relation({repo:{path:'C:\\Code\\Site\\'}},{cwd:'c:/code/site'}),'repo');
  assert.equal(policy.relation({repo:{path:'/Code/site'}},{cwd:'/code/site'}),'other');
});
test('recommendations include completed project sessions but never overwrite explicit scope',()=>{
  const task={id:'new',projectId:'p',repoId:'r'};
  const rows=[{id:'done',projectId:'p',repoId:'r',status:'done',at:1},
    {id:'wrong',requirementContext:{projectId:'other',repoId:'r'},at:3},
    {id:'archived',projectId:'p',repoId:'r',archivedAt:1}, {id:'unbound',at:4}];
  const found=policy.candidates(task,rows,null,id=>id==='wrong'?{tasks:[task]}:null);
  assert.deepEqual(found.map(row=>row.sessionId),['done']);
});
test('saved remote/workflow/Agent/model choices are not silently replaced',()=>{
  const current={sessionId:'c',adapterId:'pi',model:'chosen',projectId:'p'};
  for(const config of [{workflowId:'workflow'},{runner:{mode:'remote'}},{assigneeType:'squad'},
    {agent:{id:'local:qwen'}},{model:'different'}]){
    assert.ok(policy.compatibility({projectId:'p',executionContext:config},current));
  }
  assert.equal(policy.compatibility({projectId:'p',executionContext:{agent:{id:'local:pi'},model:'chosen'}},current),'');
});
test('authoritative active receipt remains bound to its own conversation',()=>{
  const task={workRouting:{conversationTurn:{conversationId:'old',state:'queued'}}};
  assert.ok(policy.compatibility(task,{sessionId:'new'}));
  assert.equal(policy.compatibility(task,{sessionId:'old'}),'');
  task.workRouting.conversationTurn.state='cancelled';
  assert.equal(policy.compatibility(task,{sessionId:'new'}),'');
});
