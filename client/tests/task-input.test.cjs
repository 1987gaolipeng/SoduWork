const test = require('node:test');
const assert = require('node:assert/strict');
const { attachmentUrl, prepare, request } = require('../main/pi-session/task-input');

test('rework of a dispatched task keeps its Runner workspace even after an old native follow-up', async t => {
 const context = require('../main/conversation/requirement-context');
 const delivery = require('../main/pi-session/task-delivery.cjs');
 t.mock.method(context, 'assertOwner', () => {});
 t.mock.method(delivery, 'capture', () => { throw Error('Must not scan the unrelated native cwd'); });
 for (const previousExecutor of ['dispatch', 'native']) {
  const calls = [], handle = { sessionId: 'chat' };
  const task = { id: 't', status: 'doing', workRouting: {
   executionContext: { agent: { id: 'runner:original:pi' }, runner: { mode: 'local' } },
   conversationTurn: { executor: previousExecutor, conversationId: 'chat', state: 'completed' },
   reworkPending: { feedback: 'Shorten to 100 characters' },
  } };
  t.mock.method(global, 'fetch', async (url, options) => {
   calls.push({ url, body: options.body && JSON.parse(options.body) });
   if (url.endsWith('/tasks/t')) return Response.json(task);
   if (url.includes('/ai-session?')) return Response.json({ ref: 'original-run', canSend: true });
   if (url.endsWith('/conversation-turn')) return Response.json({ turn: { state: 'queued' }, task });
   throw Error('Unexpected request ' + url);
  });
  const input = await prepare({ hub: 'http://fixture' }, 't', 'chat', 'repair', 'Revise',
   { reuseConversation: true, followUp: true }, { handle });
  assert.equal(input.executor, 'dispatch'); assert.ok(input.controlled);
  assert.match(input.text, /Shorten to 100 characters/); assert.deepEqual(input.attachments, []);
  await input.beforeTurn(); await input.afterTurn('completed');
  assert.deepEqual(calls.filter(c => c.body).map(c => [c.body.action, c.body.executor, c.body.continuationRef]),
   [['prepare', 'dispatch', 'original-run'], ['start', 'dispatch', 'original-run'], ['complete', 'dispatch', 'original-run']]);
 }
});

test('offline successful execution keeps its result and replays start then completion after app restart', async t => {
 const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
 const {create} = require('../main/pi-session/start-receipts.cjs');
 const {createTurnQueue} = require('../main/pi-session/turn-queue');
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-offline-completion-'));
 t.after(() => fs.rmSync(root, {recursive: true, force: true}));
 const now = Math.floor(Date.now() / 1000);
 const identity = {hub: 'http://fixture', clientId: 'device',
  session: Buffer.from(JSON.stringify({typ: 'device', uid: 'owner', cid: 'device', iat: now, exp: now + 3600})).toString('base64url') + '.' + 'a'.repeat(64)};
 const calls = []; let online = true, state = 'queued';
 t.mock.method(global, 'fetch', async (url, options) => {
  const body = options?.body && JSON.parse(options.body);
  if (url.endsWith('/tasks/t')) return Response.json({id: 't', title: 'Issue'});
  if (url.endsWith('/attachments')) return Response.json([]);
  if (!online) throw Error('offline');
  if (body) {calls.push(body.action); state = ({start: 'running', complete: 'completed'})[body.action] || state;}
  return Response.json({turn: {state}, task: {id: 't'}});
 });
 const options = {app: {getPath: () => root}, identityOf: async () => identity, request, intervalMs: 0};
 const service = create(options); t.after(() => service.dispose());
 const runtime = {handle: {}, startReceipts: service};
 const input = await prepare(identity, 't', 'chat', 'turn', '', undefined, runtime);
 const queue = createTurnQueue(), item = queue.add({text: 'task', options: {taskId: 't', ...input}});
 const result = await queue.run(queue.take(), async () => {
  online = false; await queue.markStarted(); return {ok: true, output: 'private large result'};
 });
 assert.equal(result.ok, true); assert.equal((await item.completion).ok, true);
 assert.equal(queue.state().tasks[0].status, 'completed'); assert.equal(queue.state().paused, false);
 assert.equal(state, 'running');
 assert.deepEqual(calls, ['prepare', 'start']);
 service.dispose(); online = true;
 const restarted = create(options); t.after(() => restarted.dispose()); await restarted.flush();
 assert.deepEqual(calls, ['prepare', 'start', 'started', 'complete']); assert.equal(state, 'completed');
 assert.equal(fs.readdirSync(path.join(root, 'task-start-receipts')).filter(name => name.endsWith('.json')).length, 0);
});

test('attachment ticket is limited to the authorized Hub and resource', () => {
 const identity = { hub: 'http://127.0.0.1:9080' };
 assert.equal(attachmentUrl(identity, { id:'a', url:'/api/v1/attachments/a?ticket=short-lived&mode=preview' }),
   'http://127.0.0.1:9080/api/v1/attachments/a?ticket=short-lived');
 for (const url of ['https://evil.test/api/v1/attachments/a?ticket=x',
   '/api/v1/attachments/other?ticket=x', '/api/v1/attachments/a', '//evil.test/']) {
   assert.throws(() => attachmentUrl(identity, { id:'a', url }));
 }
});

test('native receipts distinguish queue admission, actual start and a fresh retry scope', async t => {
 const {create} = require('../main/pi-session/start-receipts.cjs');
 const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-start-boundary-'));
 t.after(() => fs.rmSync(root, {recursive: true, force: true}));
 const now = Math.floor(Date.now() / 1000);
 const identity = {hub:'http://fixture',clientId:'device',session:Buffer.from(JSON.stringify(
  {typ:'device',uid:'owner',cid:'device',iat:now,exp:now+3600})).toString('base64url')+'.'+'a'.repeat(64)};
 const calls = [];
 t.mock.method(global,'fetch',async (url,options) => {
  if (url.endsWith('/tasks/t')) return Response.json({id:'t',title:'Task'});
  if (url.endsWith('/attachments')) return Response.json([]);
  const body=JSON.parse(options.body); calls.push(body);
  return Response.json({turn:{state:'queued'},task:{id:'t'}});
 });
 const receipts=create({app:{getPath:()=>root},identityOf:async()=>identity,request,intervalMs:0});
 t.after(()=>receipts.dispose());
 const input=await prepare(identity,'t','chat','first','',{}, {startReceipts:receipts});
 await input.beforeTurn();
 assert.deepEqual(calls.map(row=>row.action),['prepare','start']);
 await input.afterTurn('stopped');
 assert.deepEqual(calls.map(row=>row.action),['prepare','start','cancel']);
 await input.beforeRetry();
 const retry=calls.at(-1).turnId;
 assert.notEqual(retry,'first'); assert.match(retry,/^recovery-/);
 await input.beforeTurn(); await input.onStarted(); await input.afterTurn('completed');
 const retryCalls=calls.filter(row=>row.turnId===retry);
 assert.deepEqual(retryCalls.map(row=>row.action),['prepare','start','started','complete']);
 assert.ok(retryCalls.every(row=>row.conversationId==='chat'&&row.executor==='native'));
});

test('controlled execution never writes a native receipt or invents an actual-start callback', async t => {
 t.mock.method(global,'fetch',async (url,options) => {
  if (url.endsWith('/attachments')) return Response.json([]);
  if (options?.body) return Response.json({turn:{state:'queued'},task:{id:'t'}});
  return Response.json({id:'t',title:'Task'});
 });
 const input=await prepare({hub:'http://fixture'},'t','chat','turn','',{agentId:'runner:r'},
  {startReceipts:{forTask(){throw Error('controlled receipt cannot use native transport');}}});
 assert.equal(input.executor,'dispatch'); assert.equal(input.onStarted,undefined);
});

test('offline cancellation before the runtime starts replays only cancellation after restart', async t => {
 const {create}=require('../main/pi-session/start-receipts.cjs');
 const {createTurnQueue}=require('../main/pi-session/turn-queue');
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-cancel-receipt-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const now=Math.floor(Date.now()/1000);
 const identity={hub:'http://fixture',clientId:'device',session:Buffer.from(JSON.stringify(
  {typ:'device',uid:'owner',cid:'device',iat:now,exp:now+3600})).toString('base64url')+'.'+'a'.repeat(64)};
 let online=true;const actions=[];
 t.mock.method(global,'fetch',async(url,options)=>{
  if(url.endsWith('/tasks/t'))return Response.json({id:'t',title:'Task'});
  if(url.endsWith('/attachments'))return Response.json([]);
  if(!online)throw Error('offline');
  actions.push(JSON.parse(options.body).action);
  return Response.json({turn:{state:'queued'},task:{id:'t'}});
 });
 const settings={app:{getPath:()=>root},identityOf:async()=>identity,request,intervalMs:0};
 const service=create(settings);t.after(()=>service.dispose());
 const input=await prepare(identity,'t','chat','turn','',{}, {startReceipts:service});
 const queue=createTurnQueue(),item=queue.add({text:'Task',options:{taskId:'t',...input}});
 const result=await queue.run(queue.take(),async()=>{online=false;return{ok:true,cancelled:true,manualStop:true};});
 assert.equal(result.ok,true);assert.equal((await item.completion).ok,true);
 const dir=path.join(root,'task-start-receipts'), files=fs.readdirSync(dir).filter(name=>name.endsWith('.json'));
 assert.equal(files.length,1);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,files[0]),'utf8')).steps,[{action:'cancel'}]);
 service.dispose();online=true;
 const restarted=create(settings);t.after(()=>restarted.dispose());await restarted.flush();
 assert.deepEqual(actions,['prepare','start','cancel']);
 assert.equal(fs.readdirSync(dir).filter(name=>name.endsWith('.json')).length,0);
});

test('task preparation preserves all files and uses signed downloads before reserving a turn', async () => {
 const oldFetch=global.fetch, calls=[];
 global.fetch=async (url,options) => {
   calls.push({url,options});
   if(url.endsWith('/tasks/t')) return Response.json({id:'t',title:'Review',note:'Keep my context'});
   if(url.endsWith('/tasks/t/attachments')) return Response.json([
     {id:'a',filename:'input.txt',contentType:'text/plain',url:'/api/v1/attachments/a?ticket=one'},
     {id:'b',filename:'image.png',contentType:'image/png',url:'/api/v1/attachments/b?ticket=two'}]);
   if(url.includes('/attachments/')) {
     assert.equal(options.headers,undefined);
     assert.equal(options.redirect,'error');
     return new Response('file contents');
   }
   return Response.json({turn:{state:'queued'},task:{id:'t',title:'Review',note:'Keep my context'}});
 };
 try {
   const input=await prepare({hub:'http://127.0.0.1:9080',session:'test-only'},'t','chat','turn');
   assert.deepEqual(input.attachments.map(f=>f.name),['input.txt','image.png']);
   assert.match(input.text,/Keep my context/);
   assert.equal(calls.at(-1).url,'http://127.0.0.1:9080/api/v1/tasks/t/conversation-turn');
   assert.equal(input.attachments[0].data.toString(),'file contents');
 } finally {global.fetch=oldFetch;}
});

test('验收分析会话只带入需求上下文和附件，不创建执行回执', async t => {
 const calls = [];
 t.mock.method(global, 'fetch', async (url, options = {}) => {
   calls.push({ url: String(url), options });
   if (String(url).endsWith('/tasks/t')) return Response.json({ id: 't', title: '验收任务', note: '检查交付结果' });
   if (String(url).endsWith('/tasks/t/acceptance-context')) return Response.json({
     task: { id: 't', title: '验收任务', note: '检查交付结果' },
     approvalId: 'review', artifactVersionId: 'v1', requirementVersion: 1,
     canDecide: true,
     criteria: [{ id: 'c', label: '检查交付结果' }], attachmentIds: ['a'],
   });
   if (String(url).endsWith('/tasks/t/attachments')) return Response.json([
     { id: 'a', filename: '结果.md', contentType: 'text/markdown', url: '/api/v1/attachments/a?ticket=review' },
   ]);
   if (String(url).includes('/attachments/')) return new Response('delivery evidence');
   throw new Error('验收分析不应调用 conversation-turn');
 });
 const input = await prepare({ hub: 'http://fixture' }, 't', 'chat', 'turn', '请帮我分析是否满足验收标准',
   { acceptanceOnly: true });
 assert.equal(input.acceptanceOnly, true);
 assert.match(input.text, /检查交付结果/);
 assert.match(input.text, /请帮我分析是否满足验收标准/);
 assert.equal(input.attachments[0].name, '结果.md');
 assert.equal(input.attachments[0].data.toString(), 'delivery evidence');
 assert.ok(calls.every(call => !call.url.includes('/conversation-turn')));
});

test('failed attachment download never reserves or starts the task', async () => {
 const oldFetch=global.fetch, calls=[];
 global.fetch=async url => {
   calls.push(url);
   if(url.endsWith('/tasks/t')) return Response.json({id:'t'});
   if(url.endsWith('/attachments')) return Response.json([{id:'a',url:'/api/v1/attachments/a?ticket=expired'}]);
   return new Response('',{status:401});
 };
 try {
   await assert.rejects(prepare({hub:'http://127.0.0.1:9080'},'t','chat','turn'),/附件未能读取/);
   assert.ok(calls.every(url=>!url.includes('conversation-turn')));
 } finally {global.fetch=oldFetch;}
});

test('native task model including default is carried to the queue while controlled models stay with their executor', async t => {
 t.mock.method(global, 'fetch', async url => {
  if (url.endsWith('/tasks/t')) return Response.json({id:'t',executionContext:{model:'saved-model'}});
  if (url.endsWith('/attachments')) return Response.json([]);
  return Response.json({turn:{state:'queued'}});
 });
 for (const requested of [{model:''}, {model:'explicit'}, {}]) {
  const input = await prepare({hub:'http://fixture'},'t','chat','turn','',requested);
  assert.equal(input.modelName, requested.model === undefined ? 'saved-model' : requested.model);
 }
 const remote = await prepare({hub:'http://fixture'},'t','chat','turn','',{agentId:'runner:r:qwen',model:'remote-model'});
 assert.equal(remote.executor,'dispatch'); assert.equal(remote.modelName,undefined);
});

test('a queued turn renews an expired session only as the same account', async t => {
 const fixture=require('./helpers/platform-session-fixture.cjs'), auth=require('../main/device-auth-request');
 const identity={...fixture.identity('expired'),secret:'test-only'}, renewed=fixture.sessions().renewed, calls=[];
 auth.setIdentityRefresher(async()=>({...identity,session:renewed}));
 t.after(()=>auth.setIdentityRefresher(null));
 t.mock.method(global,'fetch',async(url,options)=>{
  calls.push({url,...options});
  return calls.length===1 ? new Response('',{status:401}) : Response.json({ok:true});
 });
 assert.equal((await request(identity,'/tasks/t/conversation-turn',{action:'start'})).ok,true);
 assert.equal(calls.length,2);
 assert.equal(calls[0].headers.Authorization,'Device '+identity.session);
 assert.equal(calls[1].headers.Authorization,'Device '+renewed);
 assert.equal(calls[1].headers['X-Soduwork-Secret'],undefined);
 assert.equal(calls[1].method,'POST'); assert.equal(calls[1].body,calls[0].body);
});

test('a queued turn cannot start as a different account after the same device is rebound', async t => {
 const fixture=require('./helpers/platform-session-fixture.cjs'), auth=require('../main/device-auth-request');
 const identity={...fixture.identity('expired'),secret:'test-only'}, calls=[];
 auth.setIdentityRefresher(async()=>({...identity,session:fixture.sessions().two}));
 t.after(()=>auth.setIdentityRefresher(null));
 t.mock.method(global,'fetch',async(url,options)=>{
  calls.push({url,...options}); return new Response('',{status:401});
 });
 await assert.rejects(request(identity,'/tasks/t/conversation-turn',{action:'start'}),error=>error.code==='AUTH_REQUIRED');
 assert.equal(calls.length,1,'a different account cannot receive the queued task start');
 assert.equal(calls[0].headers.Authorization,'Device '+identity.session);
 assert.equal(calls[0].headers['X-Soduwork-Secret'],undefined);
});

test('request exposes structured authentication failures without retrying forever', async () => {
 const oldFetch = global.fetch;
 global.fetch = async () => new Response(JSON.stringify({ detail: 'expired' }), {
   status: 401, headers: { 'content-type': 'application/json' },
 });
 try {
   await assert.rejects(request({ hub: 'http://127.0.0.1:9080' }, '/tasks/t'), error => {
     assert.equal(error.status, 401);
     assert.equal(error.code, 'AUTH_REQUIRED');
     assert.equal(error.authRequired, true);
     assert.equal(error.retryable, false);
     return true;
   });
 } finally { global.fetch = oldFetch; }
});

test('model recovery refreshes only the receipt attempt, retaining original task text and attachments', async t => {
 const calls=[];
 t.mock.method(global,'fetch',async(url,options)=>{
  calls.push({url,body:options.body&&JSON.parse(options.body)});
  if(url.endsWith('/tasks/t'))return Response.json({id:'t',title:'T',description:'Original task context'});
  if(url.endsWith('/attachments'))return Response.json([{id:'image',filename:'input.png',url:'/api/v1/attachments/image?ticket=one'}]);
  if(url.includes('/attachments/image?'))return new Response('original image bytes');
  return Response.json({turn:{state:'queued'}});
 });
 const input=await prepare({hub:'http://fixture'},'t','chat','first-turn');
 await input.beforeTurn();await input.afterTurn('failed');
 const downloads=calls.filter(c=>c.url.includes('/attachments')).length;
 await input.beforeRetry();await input.beforeTurn();await input.afterTurn('completed');
 assert.equal(calls.filter(c=>c.url.includes('/attachments')).length,downloads);
 assert.match(input.text,/Original task context/);assert.equal(input.attachments[0].data.toString(),'original image bytes');
 const turns=calls.filter(c=>c.body).map(c=>c.body);
 assert.deepEqual(turns.map(c=>c.action),['prepare','start','fail','prepare','start','complete']);
 assert.equal(turns[0].turnId,'first-turn');assert.match(turns[3].turnId,/^recovery-/);
 assert.ok(turns.slice(3).every(c=>c.turnId===turns[3].turnId&&c.conversationId==='chat'&&c.executor==='native'));
});

test('follow-up turn keeps the user words, skips task attachments and still runs the receipt cycle', async t => {
 const calls=[];
 t.mock.method(global,'fetch',async(url,options)=>{
  calls.push({url:String(url),body:options&&options.body?JSON.parse(options.body):null});
  if(url.endsWith('/tasks/t'))return Response.json({id:'t',title:'T',note:'Old requirement body'});
  if(url.includes('/conversation-turn'))return Response.json({turn:{state:'queued'},task:{id:'t'}});
  return Response.json({});
 });
 const input=await prepare({hub:'http://fixture',clientId:'d',session:
   Buffer.from(JSON.stringify({typ:'device',uid:'u',cid:'d',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64)},
  't','chat','follow-turn','把作文换成 md 重新交付', {reuseConversation:true, followUp:true},
  {handle:{sessionId:'chat'},app:{getPath:()=>require('node:os').tmpdir()}});
 assert.equal(input.text,'把作文换成 md 重新交付');
 assert.ok(!input.text.includes('Old requirement body'));
 assert.deepEqual(input.attachments,[]);
 assert.ok(calls.every(c=>!c.url.includes('/attachments')), 'follow-up must not download task attachments');
 await input.beforeTurn();await input.afterTurn('completed');
 const turns=calls.filter(c=>c.body).map(c=>c.body);
 assert.deepEqual(turns.map(c=>c.action),['prepare','start','complete']);
 assert.ok(turns.every(c=>c.executor==='native'&&c.turnId==='follow-turn'&&c.conversationId==='chat'));
});

test('follow-up on a finished requirement still sends, only without the receipt', async t => {
 const { EventEmitter } = require('node:events');
 const calls=[];
 t.mock.method(global,'fetch',async(url,options)=>{
  calls.push({url:String(url),body:options&&options.body?JSON.parse(options.body):null});
  if(url.endsWith('/tasks/t'))return Response.json({id:'t',title:'T',status:'done'});
  if(url.includes('/conversation-turn'))return new Response(JSON.stringify({detail:'需求已经结束'}),{status:409});
  return Response.json({});
 });
 const identity={hub:'http://fixture',clientId:'d',session:
   Buffer.from(JSON.stringify({typ:'device',uid:'u',cid:'d',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64)};
 await assert.rejects(prepare(identity,'t','chat','follow-2','谢谢',
  {reuseConversation:true, followUp:true}, {handle:{sessionId:'chat'},app:{getPath:()=>require('node:os').tmpdir()}}), /需求已经结束/);
});

test('rework turn carries the rejection feedback in the input, plain follow-up stays clean', async t => {
 const taskRow = { id:'t', title:'T', note:'Old requirement body' };
 t.mock.method(global,'fetch',async(url)=>{
  if(url.endsWith('/tasks/t'))return Response.json(taskRow);
  if(url.includes('/conversation-turn'))return Response.json({turn:{state:'queued'},task:{id:'t'}});
  return Response.json({});
 });
 const identity={hub:'http://fixture',clientId:'d',session:
   Buffer.from(JSON.stringify({typ:'device',uid:'u',cid:'d',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64)};
 const runtime={handle:{sessionId:'chat'},app:{getPath:()=>require('node:os').tmpdir()}};
 // Include original rejection feedback when rework is pending.
 taskRow.workRouting={reworkPending:{feedback:'AI味过于强烈，不够直白。',actor:'王振义',error:'这个本地会话已经不在了'}};
 const rework=await prepare(identity,'t','chat','rework-turn','帮我修复',
  {reuseConversation:true, followUp:true}, runtime);
 assert.ok(rework.text.startsWith('帮我修复'),'用户原话在前');
 assert.match(rework.text,/AI味过于强烈，不够直白。/);
 assert.match(rework.text,/王振义/);
 assert.match(rework.text,/返修/);
 // Preserve ordinary follow-up text without unrelated rework instructions.
 taskRow.workRouting={};
 const plain=await prepare(identity,'t','chat','follow-turn','再精炼一点',
  {reuseConversation:true, followUp:true}, runtime);
 assert.equal(plain.text,'再精炼一点');
 // Include feedback on full taskPrompt resubmission as well as follow-ups.
 taskRow.workRouting={reworkPending:{feedback:'AI味过于强烈，不够直白。',actor:'王振义'}};
 const full=await prepare(identity,'t','chat','full-turn','', {});
 assert.match(full.text,/验收打回意见（王振义/);
 assert.match(full.text,/AI味过于强烈，不够直白。/);
});

test('new rework session loads only the latest delivery batch and preserves attachment IDs', async t => {
 const taskRow = {id:'t', title:'T', note:'原需求', ownerClientId:'d', workRouting:{reworkPending:{feedback:'只修正文，不要从头重做。',actor:'验收人'}}};
 const calls=[];
 t.mock.method(global,'fetch',async(url,options)=>{
  const value=String(url); calls.push(value);
  if(value.endsWith('/tasks/t')) return Response.json(taskRow);
  if(value.endsWith('/attachments')) return Response.json([
    {id:'brief',filename:'需求素材.md',size:3,url:'/api/v1/attachments/brief?ticket=brief',role:'input',createdAt:50},
    {id:'old',filename:'交付说明.md',size:3,url:'/api/v1/attachments/old?ticket=old',role:'output',sourceRef:'conversation:old',createdAt:100,evidenceMeta:{round:2}},
    {id:'old-rework',filename:'返修资料.md',size:3,url:'/api/v1/attachments/old-rework?ticket=old-rework',role:'rework_input',sourceRef:'task-rework:old',createdAt:200,evidenceMeta:{round:3}},
    {id:'new-v1',filename:'交付说明.md',size:3,url:'/api/v1/attachments/new-v1?ticket=new-v1',role:'output',sourceRef:'conversation:new',createdAt:300,evidenceMeta:{round:1}},
    {id:'new-v2',filename:'交付说明.md',size:3,url:'/api/v1/attachments/new-v2?ticket=new-v2',role:'output',sourceRef:'conversation:new',createdAt:400,evidenceMeta:{round:2}},
    {id:'new-proof',filename:'验收证据.json',size:3,url:'/api/v1/attachments/new-proof?ticket=new-proof',role:'verification',sourceRef:'conversation:new',createdAt:400,evidenceMeta:{round:2}},
  ]);
  if(value.includes('/attachments/brief?')) return new Response('brief');
  if(value.includes('/attachments/old?')) return new Response('old');
  if(value.includes('/attachments/new-v1?')) return new Response('new-v1');
  if(value.includes('/attachments/new-v2?')) return new Response('new-v2');
  if(value.includes('/attachments/new-proof?')) return new Response('new-proof');
  if(value.includes('/attachments/old-rework?')) return new Response('old-rework');
  if(value.includes('/conversation-turn')) return Response.json({turn:{state:'queued'},task:taskRow});
  return Response.json({});
 });
 const identity={hub:'http://fixture',clientId:'d',session:
   Buffer.from(JSON.stringify({typ:'device',uid:'u',cid:'d',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64)};
 const input=await prepare(identity,'t','new-chat','rework-new','请继续修复',
   {followUp:false, reworkSession:true},
   {handle:{sessionId:'new-chat'},app:{getPath:()=>require('node:os').tmpdir()}});
 assert.match(input.text,/只修正文，不要从头重做。/);
 assert.deepEqual(input.attachments.map(file=>file.attachmentId),['brief','new-v2','new-proof']);
 assert.deepEqual(input.attachments.map(file=>file.data.toString()),['brief','new-v2','new-proof']);
 assert.ok(calls.some(value => value.includes('/attachments/brief?')));
 assert.ok(calls.some(value => value.includes('/attachments/new-v2?')));
 assert.ok(calls.some(value => value.includes('/attachments/new-proof?')));
 assert.ok(!calls.some(value => value.includes('/attachments/old?')));
 assert.ok(!calls.some(value => value.includes('/attachments/old-rework?')));
 const attachments=require('../main/pi-session/attachments');
 const staged=await attachments.stage(require('node:os').tmpdir(),input.attachments,{stagingDir:require('node:os').tmpdir() + '/soduwork-rework-test'});
 const prompt=attachments.prompt(staged.files);
 assert.match(prompt,/new-v2/); assert.match(prompt,/new-proof/); assert.match(prompt,/附件 ID: new-v2/);
 assert.match(prompt,/需求素材\.md/); assert.match(prompt,/交付说明\.md/); assert.match(prompt,/验收证据\.json/);
 assert.doesNotMatch(prompt,/old-rework/);
});

test('reopened native task continues the original running receipt without preparing a duplicate', async t => {
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-original-recovery-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const calls=[], turn={state:'running',executor:'native',conversationId:'chat',turnId:'interrupted'};
 let task={id:'t',status:'doing',ownerClientId:'d',workRouting:{conversationTurn:turn}};
 t.mock.method(global,'fetch',async(url,options)=>{
   const body=options?.body?JSON.parse(options.body):null;calls.push({url:String(url),body});
   return Response.json(body?{turn,task}:task);
 });
 const identity={hub:'http://fixture',clientId:'d',session:
   Buffer.from(JSON.stringify({typ:'device',uid:'u',cid:'d',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64)};
 let claimed=0,released=0;
 const runtime={handle:{sessionId:'chat',cwd:root,adapterId:'pi',taskIds:['t'],claimInterruptedTask:async id=>{assert.equal(id,'t');claimed++;return 'claim-token';},releaseInterruptedTask:async(id,token)=>{assert.equal(id,'t');assert.equal(token,'claim-token');released++;}},app:{getPath:()=>root}};
 const input=await prepare(identity,'t','chat','new-send','继续',{reuseConversation:true,followUp:true},runtime);
 assert.equal(claimed,1);assert.equal(input.text,'继续');assert.equal(calls.filter(c=>c.body).length,0);
 await input.beforeTurn();await input.afterTurn('completed');
 assert.deepEqual(calls.filter(c=>c.body).map(c=>[c.body.action,c.body.turnId]),[['complete','interrupted']]);
 task={...task,workRouting:{conversationTurn:{...turn,turnId:'someone-else'}}};
 await assert.rejects(input.beforeTurn(),/状态已变化/);assert.equal(released,1);
});
test('interrupted task claims require a restored, bound, idle session and cannot be taken twice', () => {
 const ctx={shared:{},prep:{model:'fixture'},acc:{state:{messages:[]}},opts:{resumePath:'archive'},piSession:{sessionId:'chat'},
  taskBinding:{taskIds:['t'],taskBindings:[]},goal:{},taskExecutions:new Map(),
  turnQueue:{size:()=>0,active:()=>null}};
 ctx.handle=require('../main/pi-session/session-handle').create(ctx);
 assert.equal(ctx.handle.claimInterruptedTask('other'),null);
 ctx.inFlight=true;assert.equal(ctx.handle.claimInterruptedTask('t'),null);ctx.inFlight=false;
 ctx.opts.resumePath='';assert.equal(ctx.handle.claimInterruptedTask('t'),null);ctx.opts.resumePath='archive';
 ctx.taskExecutions.set('t',{});assert.equal(ctx.handle.claimInterruptedTask('t'),null);ctx.taskExecutions.clear();
 const token=ctx.handle.claimInterruptedTask('t');assert.equal(typeof token,'string');
 assert.equal(ctx.handle.claimInterruptedTask('t'),null);assert.equal(ctx.handle.releaseInterruptedTask('t','stale'),false);assert.equal(ctx.handle.releaseInterruptedTask('t',token),true);
 assert.equal(typeof ctx.handle.claimInterruptedTask('t'),'string');
});

test('recovery never claims another conversation, remote executor, or a live local task', async t => {
 const identity={hub:'http://fixture',clientId:'d',session:
  Buffer.from(JSON.stringify({typ:'device',uid:'u',cid:'d',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64)};
 let turn,claims=0;
 t.mock.method(global,'fetch',async(url,options)=>{
  if(options?.body)return Response.json({detail:'需求已在执行'},{status:409});
  return Response.json({id:'t',status:'doing',workRouting:{conversationTurn:turn}});
 });
 for(const patch of [{conversationId:'other'},{executor:'workflow'},{}]){
  turn={state:'running',executor:'native',conversationId:'chat',turnId:'old',...patch};
  const runtime={handle:{sessionId:'chat',claimInterruptedTask:()=>{claims++;return null;}},app:{getPath:()=>require('node:os').tmpdir()}};
  await assert.rejects(prepare(identity,'t','chat','new','继续',{reuseConversation:true,followUp:true},runtime),/需求已在执行/);
 }
 assert.equal(claims,1);
});
