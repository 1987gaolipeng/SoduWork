const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const { taskPrompt, resultState } = require('../main/pi-session/task-turn');
test('issue start receipt waits for runtime acknowledgement and precedes terminal receipt', async () => {
  const q = createTurnQueue(), seen = [];
  q.add({ text: 'requirement', options: {taskId: 'issue', beforeTurn: () => seen.push('admitted'),
    onStarted: () => seen.push('started'), afterTurn: () => seen.push('complete')} });
  await q.run(q.take(), async () => {
    assert.deepEqual(seen, ['admitted']);
    await Promise.all([q.markStarted(), q.markStarted()]);
    return {ok: true};
  });
  assert.deepEqual(seen, ['admitted', 'started', 'complete']);
});
test('Pi agent_start is wired to the active task actual-start receipt', async () => {
  const queue = createTurnQueue(); let starts = 0;
  queue.add({text: 'issue', options: {onStarted: () => starts++}});
  const ctx = {turnQueue: queue, run: {toolIds: new Set()}, acc: {push: () => null}, _emit() {},
    shared: {runControl: {observeEvent() {}}, toolGuard: {}, messageTime: {stampPiEvent() {}},
      mediaArtifacts: {fromToolEvent: () => null}}};
  const events = require('../main/pi-session/session-events').create(ctx);
  await queue.run(queue.take(), async () => {
    events.onPiEvent({type: 'message_start'});
    assert.equal(starts, 0);
    events.onPiEvent({type: 'agent_start'});
    await Promise.resolve();
    assert.equal(starts, 1);
    return {ok: true};
  });
  assert.equal(starts, 1);
});
test('preflight failure, queued cancellation and controlled admission never report native start', async () => {
  for (const mode of ['preflight', 'cancel', 'controlled']) {
    const q = createTurnQueue(); let starts = 0;
    const item = q.add({text: 'issue', options: {taskId: 'issue', onStarted: () => starts++,
      controlled: mode === 'controlled' ? {} : null}});
    if (mode === 'cancel') q.cancel(item.id);
    else await q.run(q.take(), async () => {
      if (mode === 'preflight') throw Error('model unavailable');
      await q.markStarted(); return {ok: true};
    });
    assert.equal(starts, 0, mode);
  }
});
test('a failed start receipt retries before completion without duplicating successful starts', async () => {
  const q = createTurnQueue(); let starts = 0; const order = [];
  q.add({text: 'issue', options: {onStarted: () => {if (++starts === 1) throw Error('offline'); order.push('started');},
    afterTurn: () => order.push('complete')}});
  await q.run(q.take(), async () => {await q.markStarted(); return {ok: true};});
  assert.equal(starts, 2); assert.deepEqual(order, ['started', 'complete']);
});
test('task envelope preserves goal, criteria and user supplement', () => {
 const prompt = taskPrompt({title:'报告',note:'分析附件',acceptanceCriteria:['标准一','标准二'],outputRequirements:'HTML'},'额外说明');
 for(const value of ['报告','分析附件','标准一','标准二','HTML','额外说明']) assert.ok(prompt.includes(value));
 assert.match(prompt,/逐条重读以上验收标准/);
 assert.match(prompt,/可复核证据/);
 assert.match(prompt,/不得仅凭自述宣布完成/);
});

test('task prompt retains the exact original note and supplemental instruction', () => {
 const raw = '  /需求 #1\r\n' + '正文'.repeat(800) + '\n  ';
 const extra = '  追加约束\r\n保持CSV  ';
 const prompt = taskPrompt({ title: 'Fixture', note: raw }, extra);
 assert.ok(prompt.includes('需求内容\n' + raw));
 assert.ok(prompt.includes('补充说明\n' + extra));
});

test('task prompt retains the exact original note and supplemental instruction', () => {
 const raw = '  /需求 #1\r\n' + '正文'.repeat(800) + '\n  ';
 const extra = '  追加约束\r\n保持CSV  ';
 const prompt = taskPrompt({ title: 'Fixture', note: raw }, extra);
 assert.ok(prompt.includes('需求内容\n' + raw));
 assert.ok(prompt.includes('补充说明\n' + extra));
});
test('one queue orders ordinary messages and tasks and waits for the receipt', async () => {
 const q=createTurnQueue(); const seen=[];
 let release;
 const a=q.add({text:'A',options:{taskId:'a',taskTitle:'任务A',beforeTurn:()=>seen.push('start'),
   afterTurn:()=>new Promise(r=>{release=r;})}});
 const b=q.add({text:'普通对话'});
 const pending=q.run(q.take(),async()=>{seen.push('send');return {ok:true};});
 await new Promise(r=>setImmediate(r));
 assert.equal(q.blocked(),true); assert.equal(q.view()[0].id,b.id);
 // Reject duplicate requirement submissions with null rather than substituting an earlier turn receipt.
 assert.equal(q.add({text:'duplicate',options:{taskId:'a'}}),null);
 assert.equal(q.view().length,1);
 release(); await pending;
 assert.equal(q.blocked(),false); assert.deepEqual(seen,['start','send']);
 assert.equal(q.state().tasks[0].status,'completed');
 await q.run(q.take(),async()=>({ok:true}));
 assert.equal(q.state().activeTaskId,''); assert.equal(q.size(),0);
});
test('failure, stop and wait retain later messages until explicit resume', async () => {
 for(const result of [{ok:false},{ok:true,paused:true},{ok:true,recovering:true},
   {ok:true,snapshot:{pendingUi:{id:'ask'}}},
   {ok:true,snapshot:{execution:{quality:{phase:'blocked'}}}}]) {
   const q=createTurnQueue();q.add({text:'first',options:{taskId:'t'}});q.add({text:'later'});
   await q.run(q.take(),async()=>result);
   assert.equal(q.blocked(),true); assert.equal(q.view()[0].text,'later');
   assert.notEqual(resultState(result),'completed'); q.resume(); assert.equal(q.blocked(),false);
 }
});
test('task receipt failure blocks advancement instead of claiming success', async () => {
 const q=createTurnQueue(); const item=q.add({text:'t',options:{taskId:'t',afterTurn:()=>{throw Error('receipt offline');}}});
 await q.run(q.take(),async()=>({ok:true}));
 assert.equal((await item.completion).ok,false);assert.equal(q.state().tasks[0].status,'failed');
 assert.equal(q.state().paused,true);
});
test('edit and reorder affect only unsent messages, cancellation preserves neighbours', async () => {
 const q=createTurnQueue();const a=q.add({text:'A'}),b=q.add({text:'B',attachments:[{name:'diagram.png'}],options:{taskId:'b'}});
 assert.equal(q.move(b.id,-1),true);assert.equal(q.edit(b.id,'B updated'),true);
 assert.deepEqual(q.view().map(x=>x.text),['B updated','A']);
 assert.equal(q.view()[0].taskId,'b');assert.equal(q.view()[0].attachments[0],'diagram.png');
 q.cancel(b.id);assert.equal((await b.completion).cancelled,true);assert.equal(q.view()[0].id,a.id);
 assert.equal(q.edit('missing','no'),false);
});
test('explicit retry goes before later tasks and releases only the queue pause', async () => {
 const q=createTurnQueue();
 q.add({text:'failed',options:{taskId:'a'}});q.add({text:'later',options:{taskId:'b'}});
 await q.run(q.take(),async()=>({ok:false}));
 const retry=q.add({text:'retry',options:{taskId:'a',retry:true}});
 assert.equal(q.view()[0].id,retry.id);assert.equal(q.state().paused,false);
});

test('a fresh idle submission releases only a stale automatic pause', async () => {
 const q=createTurnQueue();
 q.add({text:'failed'});
 await q.run(q.take(),async()=>({ok:false}));
 assert.equal(q.state().paused,true);
 assert.equal(q.resetIfIdle(),true);
 assert.equal(q.state().paused,false);

 q.add({text:'failed again'});
 await q.run(q.take(),async()=>({ok:false}));
 q.add({text:'must remain queued'});
 assert.equal(q.resetIfIdle(),false);
 assert.equal(q.state().paused,true);
 q.resume();
 q.pause('explicit stop');
 assert.equal(q.resetIfIdle(),false);
 assert.equal(q.state().reason,'explicit stop');
});

test('manual stop is a terminal boundary and leaves later input ready', async () => {
 const q=createTurnQueue();const active=q.add({text:'running',options:{taskId:'t'}});q.add({text:'later'});
 const completion=q.run(q.take(),async()=>{q.stopActive();throw Error('This operation was aborted.');});
 const result=await completion;
 assert.deepEqual(result,{ok:true,cancelled:true,manualStop:true});
 assert.deepEqual(await active.completion,result);
 assert.equal(q.blocked(),false);assert.equal(q.view()[0].text,'later');
 assert.equal(q.state().tasks[0].status,'stopped');
});

test('contract: queue rejections never emit on a null item and surface a readable reason', () => {
 const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'pi-session', 'session.js'), 'utf8');
 // Guard null queue results before publishing events.
 assert.match(source, /if \(item && options\?\.announceQueued !== false\) _emit\(\{ kind: 'turn-queued', queueId: item\.id \}\);/);
 // Every enqueue caller translates null into an explicit readable rejection.
 assert.match(source, /if \(!item\) return \{ accepted: false, result: \{ ok: false,/);
 assert.match(source, /if \(!item\) return \{ ok: false, reason: '这条需求已有一轮在执行或排队中/);
 assert.match(source, /if \(!item\) return \{ ok: false, reason: '这条需求已有一轮在执行或排队中，请先处理当前轮次再恢复' \};/);
});
