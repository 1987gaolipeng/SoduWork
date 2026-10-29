'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const vm=require('node:vm'), fs=require('node:fs'), path=require('node:path');
function helpers(){
  const c=vm.createContext({window:{}});
  for(const f of ['task-execution-context','task-execution-client'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/'+f+'.js'),'utf8'),c);
  return c.window;
}
const options={defaultModel:'chat-default',substrates:[{key:'local:qwen',cli:'qwen',available:true},{key:'local:pi',cli:'pi',available:false}],
  repos:[{id:'general',projectId:'project',name:'通用工程'}],workflows:[{bindingId:'flow',name:'开发工作流'}]};
test('direct selection drops stale workflow without losing repo, agent or model',()=>{
  const h=helpers(),c=h.TaskExecutionContext.normalize(options,{strategy:'direct',agentId:'local:qwen',workflowId:'flow',workflow:{bindingId:'stale'},repoId:'general',model:'my-model'});
  assert.equal(c.plugin,null);assert.equal(c.repo.id,'general');assert.equal(c.agent.id,'local:qwen');assert.equal(c.model,'my-model');
  assert.equal(h.TaskExecutionContext.payload(c).bindingId,undefined);
});
test('workflow does not inherit the ordinary chat model as an override',()=>{
  const h=helpers(),c=h.TaskExecutionContext.normalize(options,{strategy:'workflow',workflowId:'flow'});
  assert.equal(c.plugin.bindingId,'flow');assert.equal(c.model,'');assert.equal(Object.keys(h.TaskExecutionContext.execution(c)).length,0);
});
test('explicit workflow model override remains supported',()=>{
  const h=helpers(),c=h.TaskExecutionContext.normalize(options,{strategy:'workflow',workflowId:'flow',model:'explicit'});
  assert.equal(h.TaskExecutionContext.execution(c).model,'explicit');
});
test('AI node selection skips manual and script entry nodes',()=>{
  const h=helpers(),f={workflow:[{type:'human_review'},{type:'script'}, {key:'draft',name:'整理需求',type:'ai',route:{agentSource:'plugin',agentKind:'local:codex',model:'node-model'}},
    {key:'review',type:'ai_review',route:{agentSource:'plugin',agentKind:'local:pi'}}]};
  assert.equal(h.TaskExecutionClient.firstAINode(f).key,'draft');assert.match(h.TaskExecutionClient.nodeAgentLabel(f),/codex.*node-model/);
});
test('single project-configured AI is not mistaken for a free runtime choice',()=>{
  const h=helpers();assert.match(h.TaskExecutionClient.nodeAgentLabel({workflow:{nodes:[{type:'ai',key:'one',route:{agentSource:'project',agentKind:'local:qwen'}}]}}),/qwen/);
  assert.equal(h.TaskExecutionClient.nodeAgentLabel({workflow:[{type:'ai',route:{agentSource:'runtime',agentKind:'local:pi'}}]}),'');
});
test('agent choices preserve every available AI type and explain unavailable ones',()=>{
  const h=helpers(),all=h.TaskExecutionClient.substrates({...options,recommendation:{workflowRequired:true}},true);
  assert.equal(all.length,2);assert.equal(h.TaskExecutionClient.pickAgent(options,all).id,'local:qwen');
  assert.equal(h.TaskExecutionClient.isAvailable(all[1]),false);
});
test('multi-Agent automatic routing does not require one Agent to cover every node',()=>{
  const c=vm.createContext({window:{}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/panels-forward-plugin.js'),'utf8'),c);
  const flow={runnable:true,workflow:[{type:'ai',route:{agentSource:'runtime',runtime:['browser']}},{type:'ai',route:{agentSource:'runtime',runtime:['repository']}}]};
  const o={substrates:[{key:'local:pi',available:true,capabilitySets:[['browser']]},{key:'local:codex',available:true,capabilitySets:[['repository']]}]};
  const choices=c._fwpSubstrates(o,flow);
  assert.equal(choices.length,1);assert.equal(choices[0].value,'');assert.equal(c._fwpReady(flow,o),true);
  o.substrates[1].available=false;assert.equal(c._fwpReady(flow,o),false);
});
