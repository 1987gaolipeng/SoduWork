'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, executionSpec, outcome } = require('../main/pi-session/controlled-task-turn');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const { taskPrompt } = require('../main/pi-session/task-turn');

test('controlled task message keeps its timeline anchor when restored from Pi history', () => {
  const stream=require('../main/pi-session/event-stream');
  const acc=stream.create();
  acc.push({type:'message_end',message:{role:'user',taskId:'task-anchor',content:[{type:'text',text:'Task material'}]}});
  assert.equal(acc.snapshot().messages[0].taskId,'task-anchor');
});

test('full task envelope preserves description, notes, checklist, outputs and context', () => {
  const result = taskPrompt({ title: 'T', description: 'description-A', note: 'note-B',
    checklist: [{ text: 'accept-C' }], deliverables: [{ title: 'result-D', description: 'detail-F', format: 'PDF' }],
    contextPackage: { messages: [{ text: 'context-E' }] } });
  for (const marker of ['description-A', 'note-B', 'accept-C', 'result-D', 'context-E', 'detail-F', 'PDF']) assert.ok(result.includes(marker));
  assert.doesNotMatch(result, /\[object Object\]/);
});
test('canonical workflow cannot be downgraded and repository isolation survives', () => {
  assert.throws(() => executionSpec({ workRouting: { selectedStrategy: 'workflow' } }));
  assert.equal(executionSpec({ workflowBindingId: 'binding' }).mode, 'workflow');
  assert.equal(executionSpec({ repoId: 'repo' }).repo.id, 'repo');
  assert.equal(executionSpec({}, { executionContext: { runner: { mode: 'remote' } } }).mode, 'dispatch');
  assert.equal(executionSpec({}, { assigneeType: 'squad', agentId: 'team' }).mode, 'dispatch');
  assert.equal(outcome({ status: 'done' }, 'workflow'), '');
});
test('ordinary messages stay queued across workflow approval, transient failure and retry', async () => {
  let release, reads = 0, dispatched = 0;
  const pause = new Promise(r => { release = r; });
  const q = createTurnQueue(), messages = [], states = [];
  const adapter = create({ task: { id: 't', title: 'Task' }, spec: { mode: 'workflow', context: {}, bindingId: 'b' },
    scope: { conversationId: 'c', turnId: 'turn' }, wait: async () => { await pause; },
    request: async (url, body) => {
      if (body) { dispatched++; assert.equal(body.instruction, 'full material'); return { id: 'r' }; }
      reads++;
      if (reads === 1) return { id: 'r', state: 'waiting_human', nodes: [{ state: 'succeeded' }] };
      if (reads === 2) throw Error('temporary network loss');
      if (reads === 3) return { id: 'r', state: 'failed' };
      return { id: 'r', state: 'succeeded' };
    } });
  const first = q.add({ text: 'full material', options: { taskId: 't', controlled: adapter } });
  q.add({ text: 'ordinary chat', options: {} });
  q.take();
  const running = q.run(first, () => adapter.execute({ appendTaskMessage: (...a) => messages.push(a),
    taskExecutionChanged: s => states.push(s) }, first.text, [{ name: 'input.png' }]));
  await new Promise(r => setImmediate(r));
  assert.equal(q.blocked(), true); assert.equal(q.size(), 1);
  assert.equal(q.view()[0].text, 'ordinary chat');
  release(); await running;
  assert.equal(dispatched, 1); assert.equal(q.blocked(), false);
  assert.equal(messages[0][1], 'full material'); assert.equal(messages[0][2][0].name, 'input.png');
  assert.ok(states.some(s => s.status === 'failed')); assert.ok(states.some(s => s.status === 'waiting'));
  assert.equal(q.state().tasks[0].status, 'completed');
});
test('controlled Runner compares execution ref, not the database record id', async () => {
  const messages=[];
  const adapter=create({task:{id:'t',title:'Runner'},spec:{mode:'dispatch',context:{},agentId:'local:pi'},scope:{},
    request:async(url,body)=>body?{issueId:'runner-ref'}:{id:'database-id',ref:'runner-ref',status:'done',items:[]}});
  const result=await adapter.execute({appendTaskMessage:(...a)=>messages.push(a),taskExecutionChanged:()=>{}},'task',[]);
  assert.equal(result.ok,true);assert.equal(messages.length,2);
});

test('authentication failure pauses a controlled turn instead of polling forever', async () => {
  const states = [], waits = [];
  const adapter = create({ task: { id: 't', title: 'Auth' }, spec: { mode: 'dispatch', context: {}, agentId: 'local:pi' }, scope: {},
    request: async url => {
      if (url.endsWith('/ai-dispatch')) return { ref: 'run-auth' };
      const error = Object.assign(new Error('expired'), { status: 401, authRequired: true });
      throw error;
    }, wait: async () => waits.push(true) });
  const result = await adapter.execute({ appendTaskMessage: () => {}, taskExecutionChanged: state => states.push(state) }, 'task', []);
  assert.equal(result.paused, true);
  assert.equal(result.authRequired, true);
  assert.equal(waits.length, 0);
  assert.equal(states.at(-1).status, 'waiting');
});

test('cancel during dispatch waits for acknowledged stop and preserves squad routing', async () => {
  let release, stopCalls=0, reads=0;
  const starting=new Promise(r=>{release=r;});
  const adapter=create({task:{id:'t',title:'Team'},spec:{mode:'dispatch',context:{},agentId:'team',assigneeType:'squad'},scope:{},
    request:async(url,body)=>{
      if(url.endsWith('/ai-dispatch')) {assert.equal(body.assigneeType,'squad');await starting;return {ref:'r'};}
      if(url.endsWith('/ai-stop')) {stopCalls++;return {ok:true};}
      reads++;assert.equal(stopCalls,1);return {ref:'r',status:'stopped'};
    }});
  const running=adapter.execute({appendTaskMessage:()=>{},taskExecutionChanged:()=>{}},'task',[]);
  await adapter.cancel();assert.equal(stopCalls,0);release();
  assert.equal((await running).cancelled,true);assert.equal(reads,1);
});
