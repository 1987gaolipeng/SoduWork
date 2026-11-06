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

test('controlled dispatch retains the selected engine and attributes replayed output to the actual Hub receipt', async () => {
  for (const engine of ['opencode', 'kimi', 'harness2']) {
    const messages = [], calls = []; let page = 0;
    const adapter = create({ task: { id: 'assigned' },
      spec: { mode: 'dispatch', context: {}, agentId: 'runner:device:' + engine }, scope: {}, wait: async () => {},
      request: async (route, body) => {
        calls.push({ route, body });
        if (body) return { ref: 'execution' };
        page++;
        return { ref: 'execution', engine, status: page === 1 ? 'running' : 'done', seq: page, last: page,
          items: Array.from({ length: page }, (_, i) => ({ seq: i + 1, kind: 'say', text: 'Output ' + (i + 1) })) };
      } });
    const result = await adapter.execute({ appendTaskMessage: (...args) => messages.push(args), taskExecutionChanged() {} }, 'request', []);
    assert.equal(result.ok, true);
    assert.equal(calls.filter(call => call.body).length, 1);
    assert.equal(calls[0].body.assigneeId, 'runner:device:' + engine);
    assert.deepEqual(messages.slice(1).map(row => row[1]), ['Output 1', 'Output 2']);
    for (const row of messages.slice(1)) assert.deepEqual(row[6], { agentId: engine, runId: 'execution' });
  }
});

test('requested engines cannot fabricate runtime attribution when Hub metadata is absent or different', async () => {
  for (const engine of [undefined, 'unknown-runtime', 'qwen']) {
    const messages = [];
    const adapter = create({ task: { id: 'assigned' },
      spec: { mode: 'dispatch', context: {}, agentId: 'local:opencode' }, scope: {},
      request: async (route, body) => body ? { ref: 'execution' } : {
        ref: 'execution', engine, status: 'done', seq: 1, items: [{ seq: 1, kind: 'say', text: 'Result' }],
      } });
    await adapter.execute({ appendTaskMessage: (...args) => messages.push(args), taskExecutionChanged() {} }, 'request', []);
    assert.equal(messages[1][6]?.agentId, engine === 'qwen' ? 'qwen' : undefined);
  }
});

test('late engine receipts preserve pending legacy tools and replay cursors across workflow executions', async () => {
  const messages = [], tools = []; let polls = 0;
  const adapter = create({ task: { id: 'workflow' },
    spec: { mode: 'workflow', context: {}, bindingId: 'binding' }, scope: {}, wait: async () => {},
    request: async (route, body) => {
      if (body) return { id: 'workflow-run' };
      if (route === '/plugin-runs/workflow-run') {
        polls++;
        return { id: 'workflow-run', state: polls === 1 ? 'running' : 'succeeded',
          nodes: ['one','two'].map(ref => ({executor:{kind:'ai',ref}})) };
      }
      const ref = new URL('http://fixture' + route).searchParams.get('ref');
      const engine = polls === 1 ? undefined : ref === 'one' ? 'opencode' : 'kimi';
      return { ref, engine, seq: polls === 1 ? 1 : 3, last: polls === 1 ? 1 : 3,
        items: [{seq:1,kind:'do',tool:'read',text:'file'}, ...(polls === 1 ? [] : [
          {seq:2,kind:'out',tool:'read',text:'verified'}, {seq:3,kind:'say',text:ref}])] };
    } });
  assert.equal((await adapter.execute({ appendTaskMessage: (...args) => messages.push(args),
    appendTaskTool: item => tools.push(item), taskExecutionChanged() {} }, 'request', [])).ok, true);
  assert.equal(tools.length,4);
  for (const ref of ['one','two']) {
    const rows=tools.filter(item=>item.toolCallId.includes(':'+ref+':'));
    assert.deepEqual(rows.map(item=>item.type),['tool_execution_start','tool_execution_end']);
    assert.equal(rows[0].toolCallId,rows[1].toolCallId);
    assert.equal(rows[1].sourceAgent.agentId,ref==='one'?'opencode':'kimi');
  }
  assert.deepEqual(messages.slice(1).map(item=>item[6].agentId),['opencode','kimi']);
});

test('ten thousand replayed receipts with transient read failures never duplicate dispatch or output', {timeout:10000}, async t => {
  const messages=[],started=performance.now(); let dispatched=0,reads=0;
  const adapter=create({task:{id:'load'},spec:{mode:'dispatch',agentId:'local:opencode',context:{}},scope:{},
    wait:async()=>{assert.ok(reads<150,'polling must make bounded progress');},request:async(route,body)=>{
      if(body){dispatched++;return{ref:'load-run'};}
      reads++;if(reads%11===0)throw Error('Transient fixture read failure');
      const since=Number(new URL('http://fixture'+route).searchParams.get('since'));
      const last=Math.min(10000,since+100),first=Math.max(1,since-20);
      return{ref:'load-run',engine:'opencode',status:last===10000?'done':'running',last,seq:10000,
        items:Array.from({length:last-first+1},(_,i)=>({seq:first+i,kind:'say',text:'Output '+(first+i)}))};
    }});
  assert.equal((await adapter.execute({appendTaskMessage:(...args)=>messages.push(args),taskExecutionChanged(){}},'request',[])).ok,true);
  assert.equal(dispatched,1);assert.equal(messages.length,10001);
  assert.equal(new Set(messages.slice(1).map(row=>row[1])).size,10000);
  assert.ok(messages.slice(1).every(row=>row[6]?.agentId==='opencode'));
  t.diagnostic(JSON.stringify({receipts:10000,reads,elapsedMs:performance.now()-started}));
});

test('assigned task model failures retain safe actionable diagnostics without rerouting', async () => {
  for (const error of ['404 status code (no body)',
    '模型服务地址或模型不存在（HTTP 404）；请切换可用模型。',
    '404 {"error":{"message":"Bearer private-key https://internal.test"}}']) {
    const messages = [], calls = [];
    const adapter = create({ task: { id: 'assigned-task', createdBy: 'creator', assigneeUserId: 'executor' },
      spec: { mode: 'dispatch', context: {}, agentId: 'runner:executor:pi', model: 'unavailable-model' }, scope: {},
      request: async (url, body) => {
        calls.push({ url, body });
        return body ? { ref: 'assigned-run' } : { ref: 'assigned-run', status: 'failed', error, items: [] };
      } });
    const result = await adapter.execute({ appendTaskMessage: (...a) => messages.push(a), taskExecutionChanged: () => {} }, 'task', []);
    assert.equal(result.ok, false);
    assert.match(result.reason, /HTTP 404/);
    assert.match(result.reason, /切换可用模型/);
    assert.doesNotMatch(result.reason, /private-key|internal\.test|需求执行失败，请检查当前步骤/);
    assert.equal(messages.at(-1)[1], result.reason);
    assert.equal(calls.filter(c => c.body).length, 1);
    assert.equal(calls[0].body.assigneeId, 'runner:executor:pi');
    assert.equal(calls[0].body.model, 'unavailable-model');
  }
});

test('failed task drains all output and retains its actual answer before surfacing the error', async () => {
  const messages = [];
  let reads = 0;
  const adapter = create({ task: { id: 't' }, spec: { mode: 'dispatch', context: {} }, scope: {}, wait: async () => {},
    request: async (url, body) => body ? { ref: 'r' } : {
      ref: 'r', status: 'failed', error: '429 status code (no body)', seq: 2, last: ++reads,
      items: reads === 1 ? [{ seq: 1, kind: 'say', text: 'Existing partial work.' }]
        : [{ seq: 2, kind: 'say', text: 'Preserved final diagnostic.' }],
    } });
  const result = await adapter.execute({ appendTaskMessage: (...a) => messages.push(a), taskExecutionChanged: () => {} }, 'task', []);
  assert.equal(reads, 2);
  assert.match(result.reason, /HTTP 429/);
  assert.match(result.reason, /稍后重试/);
  assert.deepEqual(messages.slice(1).map(m => m[1]), ['Existing partial work.', 'Preserved final diagnostic.']);
});

test('legacy failed receipts keep the fallback and stopped receipts ignore stale errors', async () => {
  for (const status of ['failed', 'stopped', 'done']) {
    const messages = [];
    const adapter = create({ task: { id: 't' }, spec: { mode: 'dispatch', context: {} }, scope: {},
      request: async (url, body) => body ? { ref: 'r' } : { ref: 'r', status, error: status === 'failed' ? '' : '404', items: [] } });
    const result = await adapter.execute({ appendTaskMessage: (...a) => messages.push(a), taskExecutionChanged: () => {} }, 'task', []);
    assert.equal(result.ok, status !== 'failed');
    assert.equal(result.cancelled, status === 'stopped');
    assert.doesNotMatch(messages.at(-1)[1], /HTTP 404/);
    if (status === 'failed') assert.equal(result.reason, '需求执行失败，请检查当前步骤');
    else assert.equal(result.reason, undefined);
  }
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

test('Runner continuation ignores old completion and publishes only its admitted revision', async () => {
  const messages = [], calls = [], key = 'comment:revision-2'; let reads = 0;
  const adapter = create({ task: { id: 't' }, spec: { mode: 'dispatch', continuationRef: 'original' },
    scope: { conversationId: 'chat', turnId: 'repair' }, wait: async () => {},
    request: async (url, body) => {
      calls.push({ url, body });
      if (url.endsWith('/ai-say')) {
        assert.equal(body.expectedRef, 'original');
        assert.equal(body.conversationTurn.conversationId, 'chat');
        assert.match(body.messageId, /^task-/);
        return { ok: true, delivery: 'accepted', admissionKey: key };
      }
      if (url.includes('/ai-status?')) return { done: true };
      assert.match(url, /ai-session\?ref=original/);
      reads++;
      return reads === 1
        ? { ref: 'original', status: 'done', admissionKey: 'dispatch:first', seq: 1, last: 1,
          items: [{ seq: 1, admissionKey: 'dispatch:first', kind: 'say', text: 'Rejected output' }] }
        : { ref: 'original', status: 'running', admissionKey: 'comment:later', seq: 4, last: 4,
          items: [{ seq: 2, admissionKey: key, kind: 'say', text: 'Revised output' },
            { seq: 3, admissionKey: key, kind: 'turn-end', turnState: 'done' },
            { seq: 4, admissionKey: 'comment:later', kind: 'say', text: 'Another turn' }] };
    } });
  const result = await adapter.execute({ appendTaskMessage: (...args) => messages.push(args),
    taskExecutionChanged() {} }, 'Revise', []);
  assert.equal(result.ok, true);
  assert.deepEqual(messages.map(row => row[1]), ['Revise', 'Revised output']);
  assert.equal(reads, 2);
  assert.ok(calls.at(-1).url.endsWith('/ai-status?ref=original'));
  assert.equal(calls.filter(row => row.url.endsWith('/ai-dispatch')).length, 0);
});

test('uncertain continuation retries the same message and immutable attachment bytes', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'feedback.txt'); fs.writeFileSync(file, 'Original feedback');
  const calls = [], scope = { conversationId: 'chat', turnId: 'repair' };
  const continuation = require('../main/pi-session/controlled-task-continuation.cjs').create({
    route: '/tasks/t', ref: 'original', scope, request: async (_, body) => {
      calls.push(body);
      if (calls.length === 1) throw Error('Lost acknowledgement');
      return { delivery: 'accepted', admissionKey: 'comment:one' };
    } });
  await assert.rejects(continuation.start('Revise', [{ path: file, name: 'feedback.txt' }]), /Lost/);
  scope.turnId = 'recovery'; fs.writeFileSync(file, 'Changed local feedback');
  await continuation.start('Revise', [{ path: file, name: 'feedback.txt' }]);
  assert.equal(calls[0].messageId, calls[1].messageId);
  assert.equal(Buffer.from(calls[1].files[0].data, 'base64').toString(), 'Original feedback');
  await assert.rejects(continuation.start('Different instruction', []), /原消息/);
});

test('completed revision retries delivery reconciliation without dispatching another execution', async () => {
  const scope = { conversationId: 'chat', turnId: 'revision' }, sends = [];
  let reconciliations = 0;
  const adapter = create({ task: { id: 't' }, spec: { mode: 'dispatch', continuationRef: 'original' }, scope,
    request: async (url, body) => {
      if (url.endsWith('/ai-say')) {
        sends.push(body); return { delivery: 'accepted', admissionKey: 'comment:revision' };
      }
      if (url.includes('/ai-status?')) {
        if (++reconciliations === 1) throw Error('Delivery temporarily unavailable');
        return { done: true };
      }
      assert.match(url, /ai-session\?ref=original/);
      return { ref: 'original', status: 'done', admissionKey: 'comment:revision', seq: 2, last: 2,
        items: [{ seq: 1, kind: 'say', text: 'Revised file', admissionKey: 'comment:revision' },
          { seq: 2, kind: 'turn-end', turnState: 'done', admissionKey: 'comment:revision' }] };
    } });
  const handle = { appendTaskMessage() {}, taskExecutionChanged() {} };
  await assert.rejects(adapter.execute(handle, 'Revise', []), /Delivery temporarily unavailable/);
  scope.turnId = 'delivery-recovery';
  assert.equal((await adapter.execute(handle, 'Revise', [])).ok, true);
  assert.equal(reconciliations, 2);
  assert.equal(sends.length, 2);
  assert.equal(sends[0].messageId, sends[1].messageId);
});

test('delivery retry rebinds an accepted message while failed execution retry creates a new send', async () => {
  const calls = [], scope = { conversationId: 'chat', turnId: 'first' };
  const continuation = require('../main/pi-session/controlled-task-continuation.cjs').create({
    route: '/tasks/t', ref: 'original', scope, request: async (_, body) => {
      calls.push(body);
      return { delivery: 'accepted', admissionKey: 'comment:' + body.messageId };
    } });
  const first = await continuation.start('Revise', []);
  continuation.items({ items: [{ kind: 'turn-end', turnState: 'done', admissionKey: first.admissionKey }] });
  scope.turnId = 'delivery-recovery';
  const restored = await continuation.start('Revise', []);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].messageId, calls[1].messageId);
  assert.equal(calls[1].conversationTurn.turnId, 'delivery-recovery');
  assert.equal(restored.admissionKey, first.admissionKey);

  const failedScope = { conversationId: 'chat', turnId: 'failed' };
  const failed = require('../main/pi-session/controlled-task-continuation.cjs').create({
    route: '/tasks/t', ref: 'original', scope: failedScope, request: async (_, body) => {
      calls.push(body); return { delivery: 'accepted', admissionKey: 'comment:' + body.messageId };
    } });
  const error = await failed.start('Revise', []);
  assert.equal(failed.status({ status: 'failed', admissionKey: error.admissionKey }), 'failed');
  failedScope.turnId = 'execution-retry';
  const retried = await failed.start('Revise', []);
  assert.notEqual(retried.admissionKey, error.admissionKey);
  assert.notEqual(calls[2].messageId, calls[3].messageId);
  assert.equal(failed.status({ status: 'running', admissionKey: retried.admissionKey }), 'running');
});
