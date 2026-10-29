'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stream = require('../main/pi-session/event-stream');
const task = require('../main/conversation/task-message-stream.cjs');
const live = require('../main/conversation/task-live-output');
const pi = require('../main/conversation/pi-workflow-output.cjs');
const sourceAgent = { agentId: 'dsh', nodeKey: 'build', runId: 'run' };
function fixture() {
  const acc = stream.create(), saved = [];
  let fail = false;
  const messages = task.create(acc.state, row => { if (fail) throw Error('disk'); saved.push(row); });
  const handle = { taskMessageStreaming: true,
    appendTaskRuntimeEvent(item, id) {
      if (item.kind === 'task-stream-end') messages.finish(item.streamPrefix);
      else messages.apply(item, id);
    }, appendTaskMessage() { assert.fail('stream must reuse its row'); }, appendTaskTool() {} };
  return { acc, saved, messages, fail: value => { fail = value; }, output: live.create(handle, '', {coalesceText:true,sourceAgent}) };
}
test('node text is visible before completion, updates one row and persists only once', () => {
  const f=fixture();
  const first={seq:1,kind:'say',text:'Hello',streamId:'a',delta:true};
  f.output.consume('node1',[first]);
  assert.equal(f.acc.snapshot().messages[0].blocks[0].text,'Hello');
  assert.equal(f.acc.snapshot().messages[0].done,false);assert.equal(f.saved.length,0);
  f.output.consume('node1',[first,{seq:2,kind:'say',text:' world',streamId:'a',delta:true}]);
  assert.equal(f.acc.snapshot().messages.length,1);assert.equal(f.saved.length,0);
  f.output.consume('node1',[{seq:3,kind:'say',text:'',streamId:'a',done:true,delta:true}]);
  f.output.finish('node1');f.output.finish('node1');
  assert.equal(f.saved.length,1);assert.equal(f.saved[0].text,'Hello world');
  assert.deepEqual(f.acc.snapshot().messages[0].sourceAgent,sourceAgent);
  assert.equal(f.output.lastText('node1'),'Hello world');
});
test('failed final persistence leaves partial text retryable without duplicate content', () => {
  const f=fixture();f.output.consume('node',[{seq:1,kind:'say',text:'Hi',streamId:'a',delta:true}]);
  f.fail(true);assert.throws(()=>f.output.consume('node',[{seq:2,kind:'say',text:'Hi there',streamId:'a',done:true}]),/disk/);
  assert.equal(f.acc.snapshot().messages[0].done,false);
  f.fail(false);f.output.consume('node',[{seq:2,kind:'say',text:'Hi there',streamId:'a',done:true}]);
  assert.equal(f.saved.length,1);assert.equal(f.saved[0].text,'Hi there');
});
test('node completion folds real reasoning and persists text for ordinary history replay', () => {
  const f=fixture();
  f.output.consume('a',[{seq:1,kind:'thinking',text:'Reviewing',streamId:'thought',done:false},
    {seq:2,kind:'say',text:'Result',streamId:'answer',delta:true}]);
  f.output.consume('b',[{seq:1,kind:'say',text:'Next',streamId:'answer',delta:true}]);
  f.output.finish('a');
  assert.deepEqual(f.acc.snapshot().messages.map(m=>m.done),[true,true,false]);
  const native=f.saved.map(row=>task.nativeMessage(row,{api:'openai-completions',provider:'fixture',id:'fixture'}));
  const restored=stream.create();
  require('../main/pi-session/history-seed').seed(restored,{state:{messages:native},
    sessionManager:{getEntries:()=>native.map(message=>({type:'message',message}))}});
  assert.deepEqual(restored.snapshot().messages.map(m=>m.blocks[0].text),['Reviewing','Result']);
  assert.ok(restored.snapshot().messages.every(m=>m.sourceAgent.agentId==='dsh'));
  const reopened=task.create(restored.state,()=>assert.fail('duplicate archive'));
  reopened.apply({kind:'text',streamId:'a:1:1:answer',text:'Result',done:true,sourceAgent},'');
  assert.equal(restored.snapshot().messages.length,2);
});
test('Pi exposes partial thoughts and text then tools in their original order', () => {
  const p=pi.create(text=>String(text).replaceAll('secret','[hidden]'));
  const message={role:'assistant',done:false,blocks:[{kind:'thinking',text:'Consider secret',done:false}]};
  let rows=p.project({messages:[message],tools:[]});
  assert.equal(rows[0].kind,'thinking');assert.equal(rows[0].done,false);assert.match(rows[0].text,/hidden/);
  assert.equal(p.project({messages:[message],tools:[]}).length,0);
  message.blocks[0].done=true;message.blocks.push({kind:'text',text:'I will write',done:true});message.done=true;
  rows=p.project({messages:[message],tools:[{id:'write',name:'write',after:0,state:'running',args:{path:'proof.txt'}}]});
  assert.deepEqual(rows.map(r=>r.kind),['thinking','say','do']);
  rows=p.project({messages:[message],tools:[{id:'write',name:'write',after:0,state:'done',result:'written'}]});
  assert.deepEqual(rows.map(r=>r.kind),['out']);
});
test('Pi argument preparation becomes a real tool only after execution starts', () => {
  const p=pi.create(x=>x),row={id:'w',name:'write',after:0,state:'running',phase:'preparing',args:{path:'a.txt'}};
  assert.equal(p.project({messages:[],tools:[row]})[0].kind,'tool-preparing');
  assert.equal(p.project({messages:[],tools:[row]}).length,0);
  delete row.phase;assert.equal(p.project({messages:[],tools:[row]})[0].kind,'do');
});

test('native reasoning ids reused across continuation segments remain distinct', () => {
  const f=fixture();
  f.output.consume('a',[{seq:1,kind:'thinking',text:'First',streamId:'thought',seg:1,done:true},
    {seq:2,kind:'thinking',text:'Second',streamId:'thought',seg:2,done:false}]);
  assert.deepEqual(f.acc.snapshot().messages.map(m=>m.blocks[0].text),['First','Second']);
  assert.deepEqual(f.acc.snapshot().messages.map(m=>m.done),[true,false]);
  f.output.finish('a');assert.equal(f.saved.length,2);
});
