'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const importer = require('../main/conversation/codex-import');
const memory = require('../main/conversation/session-memory');
const { openReply } = require('../main/pi-session/open-reply');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const message = (role, content, channel) => ({type:'response_item',payload:{type:'message',role,channel,
  content:[{type:'input_text',text:content}]}});
const rollout = rows => rows.map(row => JSON.stringify(row)).join('\n');

test('Codex rollout imports visible messages, deduplicates mirrors and excludes reasoning/arguments', () => {
  const value = importer.parse(rollout([
    {type:'session_meta',payload:{id:'session-one',cwd:'C:/secret/source'}},
    message('system','SYSTEM-NOT-IMPORTED'), message('developer','DEV-NOT-IMPORTED'),
    message('user','修复导入'),
    {type:'event_msg',payload:{type:'user_message',message:'修复导入'}},
    message('assistant','HIDDEN-THOUGHT','analysis'),
    {type:'event_msg',payload:{type:'agent_reasoning',text:'HIDDEN-THOUGHT'}},
    {type:'response_item',payload:{type:'function_call',name:'exec',call_id:'call1',arguments:'DO-NOT-RUN'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'call1',output:'TOOL-EVIDENCE'}},
    message('assistant','决定：使用统一入口\n下一步：补齐测试','final'),
    {type:'event_msg',payload:{type:'agent_message',message:'决定：使用统一入口\n下一步：补齐测试'}},
    {type:'event_msg',payload:{type:'user_message',message:'还要验证恢复'}},
  ]), 'rollout.jsonl');
  assert.equal(value.sourceSessionId,'session-one');
  assert.deepEqual(value.events.map(e=>e.role), ['user','tool','tool','assistant','user']);
  assert.equal(value.fields.goal,'还要验证恢复');
  assert.equal(value.fields.pending,'下一步：补齐测试');
  assert.equal(value.fields.decisions,'决定：使用统一入口');
  assert.doesNotMatch(JSON.stringify(value), /HIDDEN-THOUGHT|SYSTEM-NOT|DEV-NOT|DO-NOT-RUN|secret\/source/);
  assert.deepEqual(value.events.filter(e=>e.role==='tool').map(e=>e.callId), ['call1','call1']);
});
test('JSON and Markdown exports keep text only, including fenced headings', () => {
  const json = importer.parse(JSON.stringify({sessionId:'export',messages:[
    {role:'user',content:'目标'}, {role:'assistant',content:[{type:'output_text',text:'完成'},
    {type:'input_image',image_url:'https://private.invalid/image?token=secret'}]}]}),'chat.json');
  assert.equal(json.events.length,2);assert.match(json.events[1].text,/附件引用/);
  assert.equal(json.sourceMeta.format,'json'); assert.equal(json.sourceMeta.attachmentCount,1);
  assert.equal(json.sourceMeta.importerVersion,'3');
  assert.deepEqual(json.sourceMeta.security,{instructionsImported:false,commandsExecuted:false,
    attachmentsUploaded:false,credentialsRedacted:true});
  assert.equal(json.safety.commandsExecuted,false);
  assert.equal(json.stats.scanned,2); assert.equal(json.stats.ignored,0);
  assert.doesNotMatch(JSON.stringify(json),/private.invalid/);
  const fence = String.fromCharCode(96).repeat(3);
  const md=importer.parse('# User\n目标\n# Assistant\n'+fence+'\n# User\n只是代码\n'+fence+'\n完成','chat.md');
  assert.equal(md.events.length,2);assert.match(md.events[1].text,/# User/);
});
test('sensitive data is redacted before preview', () => {
  const data=importer.parse(JSON.stringify({messages:[{role:'user',content:
    'api_key="sensitive-value"\nBearer private-token-123456\nhttps://service.invalid/a?token=protected\n'+
    'C:\\Users\\Alice\\Private Folder\\file.md\n/home/alice/a.txt\nsk-1234567890abcdefghijkl'}]}),'chat.json');
  assert.doesNotMatch(JSON.stringify(data),/sensitive-value|private-token|protected|Alice|alice|1234567890abcdef/);
  assert.ok(data.warnings.length);
});
test('invalid files reject; incomplete tail skips; long sessions are bounded', () => {
  assert.throws(()=>importer.parse(Buffer.from([0xff]),'x.jsonl'),/UTF-8/);
  assert.throws(()=>importer.parse('','x.jsonl'),/非空/);
  assert.throws(()=>importer.parse('{}','x.json'),/不支持/);
  assert.throws(()=>importer.parse('broken\n'+JSON.stringify(message('user','hi')),'x.jsonl'),/损坏/);
  assert.throws(()=>importer.parse(rollout([{type:'session_meta',payload:{id:'a'}},
    {type:'session_meta',payload:{id:'b'}},message('user','hi')]),'x.jsonl'),/多个会话/);
  const partial=importer.parse(JSON.stringify(message('user','hi'))+'\n{"broken"','x.jsonl');
  assert.equal(partial.events.length,1);assert.match(partial.warnings.join(''),/末尾/);
  const long=importer.parse(rollout(Array.from({length:2005},(_,i)=>message('user','m'+i))),'x.jsonl');
  assert.equal(long.events.length,2000);assert.equal(long.stats.omitted,5);
});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-memory-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app={getPath:()=>root}, handlers=new Map(), sent=[], dimensionSent=[];
  const file=path.join(root,'rollout.jsonl');
  fs.writeFileSync(file,rollout([message('user','目标'),message('assistant','已完成摘要')]));
  let auth=identity('one');
  const service=memory.install({app,ipcMain:{handle:(k,fn)=>handlers.set(k,fn)},
    BrowserWindow:{fromWebContents:()=>null},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[file]})},
    identityOf:async()=>auth,requestFn:async(_auth,route,method,body)=>{
      sent.push({route,method,body});return {ok:true,item:{id:'memory-one',title:body?.title}};
    },dimensionRequestFn:async(_auth,route,method,body)=>{
      dimensionSent.push({route,method,body});return {ok:true,item:{id:'dimension-one',title:body?.title}};
    }});
  const call=(name,...args)=>handlers.get('session-memory-'+name)({sender:{id:1}},...args);
  return {app,root,file,call,handlers,sent,dimensionSent,service,setAuth:v=>auth=v};
}
const edits={title:'导入',fields:{summary:'已核对'},confirmed:true};
test('preview is local; cancel uploads nothing; confirmation uses immutable evidence and is single-use',async t=>{
  const f=fixture(t);
  const preview=await f.call('preview');assert.equal(preview.ok,true,preview.reason);assert.equal(f.sent.length,0);
  assert.doesNotMatch(JSON.stringify(preview),/soduwork-memory-test-/);
  const unconfirmed=await f.call('confirm',preview.previewId,{...edits,confirmed:false});
  assert.equal(unconfirmed.ok,false);assert.equal(f.sent.length,0);
  const foreign=await f.handlers.get('session-memory-confirm')({sender:{id:2}},preview.previewId,edits);
  assert.equal(foreign.ok,false);
  const accepted=await f.call('confirm',preview.previewId,{...edits,events:[{text:'FORGED'}]});
  assert.equal(accepted.ok,true);assert.equal(f.sent.length,1);assert.doesNotMatch(JSON.stringify(f.sent),/FORGED/);
  assert.equal((await f.call('confirm',preview.previewId,edits)).ok,false);
  const cancel=await f.call('preview');await f.call('cancel',cancel.previewId);
  assert.equal((await f.call('confirm',cancel.previewId,edits)).ok,false);assert.equal(f.sent.length,1);
});
test('account switch blocks preview confirmation and binding; bindings survive restart',async t=>{
  const f=fixture(t), preview=await f.call('preview');
  f.setAuth(identity('two'));
  assert.equal((await f.call('confirm',preview.previewId,edits)).ok,false);assert.equal(f.sent.length,0);
  memory.bind(f.app,'chat-test',identity('one'),['memory-one']);
  assert.deepEqual(memory.binding(f.app,'chat-test',identity('renewed')),['memory-one']);
  assert.throws(()=>memory.binding(f.app,'chat-test',identity('two')),/另一/);
  // Account-scoped memory permits same-account Hub migration.
  assert.deepEqual(memory.binding(f.app,'chat-test',{...identity('one'),hub:'https://other.invalid'}),['memory-one']);
  const data=await memory.context(f.app,identity('one'),{chatId:'chat-test'},async()=>({items:[],prompt:'CONFIRMED'}));
  assert.match(data.prompt,/CONFIRMED$/);
  assert.match(data.prompt,/\u4e0d\u662f\u672c\u8f6e\u6307\u4ee4/);
  const local=fs.readFileSync(path.join(f.root,'session-memory-bindings',fs.readdirSync(path.join(f.root,'session-memory-bindings'))[0]),'utf8');
  assert.doesNotMatch(local,/CONFIRMED|session|token|summary/);
});
test('unselected memory does not contact Hub; deleted memory does not prevent reading old history',async t=>{
  const f=fixture(t), missing=async()=>{throw Object.assign(Error('deleted'),{status:404});};
  assert.equal((await memory.context(f.app,identity('one'),{},()=>{throw Error('unexpected');})).prompt,'');
  await assert.rejects(memory.context(f.app,identity('one'),{memoryIds:['memory-one']},missing),/deleted/);
  memory.bind(f.app,'chat-test',identity('one'),['memory-one']);
  const removed=await memory.context(f.app,identity('one'),{chatId:'chat-test'},missing);
  assert.match(removed.warning,/历史对话保留/);
  await assert.rejects(memory.context(f.app,identity('one'),{chatId:'chat-test'},async()=>{
    throw Object.assign(Error('forbidden'),{status:403});}),/forbidden/);
  assert.throws(()=>memory.ids(['../path']),/无效/);
});

test('scoped memory keys bind session, workspace and sidebar project without leaking raw paths', () => {
  const specs = memory.dimensionSpecs({ cwd: 'C:\\Work\\SoduWork-App', workspaceExplicit: true, sidebarProjectId: 'project-42' }, 'chat-42')
  assert.deepEqual(specs.map((item) => item.scope), ['session', 'workspace', 'project'])
  assert.deepEqual(memory.dimensionSpecs({ cwd: 'C:\\Work\\SoduWork-App', workspaceExplicit: false }, 'chat-scratch').map(item => item.scope), ['session'])
  assert.match(specs[0].key, /^[a-f0-9]{64}$/)
  assert.match(specs[1].key, /^[a-f0-9]{64}$/)
  assert.equal(specs[1].workspaceKey, specs[1].key)
  assert.equal(specs[2].key, 'project-42')
  assert.doesNotMatch(JSON.stringify(specs), /Work|SoduWork-App/)
})
test('automatic digest keeps summary fields bounded and redacts local paths', () => {
  const digest = memory.digestSnapshot({ status: 'idle', messages: [
    { role: 'user', content: '\u8bf7\u4fee\u590d C:\\Users\\Alice\\project' },
    { role: 'assistant', content: [{ type: 'text', text: '\u5df2\u5b8c\u6210 /home/alice/out.md' }] },
  ] }, 'chat-42')
  assert.ok(digest)
  assert.equal(digest.sourceSessionId, 'chat-42')
  assert.doesNotMatch(JSON.stringify(digest), /Alice|alice/)
  assert.ok(digest.fields.summary.length <= 6000)
})
test('automatic digest extracts visible assistant blocks', () => {
  const digest = memory.digestSnapshot({ status: 'idle', messages: [
    { role: 'user', text: '\u8bf7\u5b8c\u6210\u4efb\u52a1' },
    { role: 'assistant', blocks: [
      { kind: 'thinking', text: '\u4e0d\u5e94\u4fdd\u5b58' },
      { kind: 'text', text: '\u5df2\u5b8c\u6210\u7ed3\u679c' },
    ] },
  ] }, 'chat-block');
  assert.ok(digest);
  assert.match(digest.fields.outcomes, /\u5df2\u5b8c\u6210\u7ed3\u679c/);
  assert.doesNotMatch(digest.fields.outcomes, /\u4e0d\u5e94\u4fdd\u5b58/);
});


test('automatic dimension memory persists on session.on and backfills resumed conversations', async t => {
  const f = fixture(t);
  const events = [];
  const session = {
    sessionId: 'chat-auto', ui: {},
    snapshot: () => ({ status: 'idle', messages: [
      { role: 'user', content: 'Build the report' },
      { role: 'assistant', content: [{ type: 'text', text: 'Report completed' }] },
    ] }),
    on(fn) { events.push(fn); return () => {}; },
    close() {},
  };
  await f.service.attach(session, identity('one'), { ids: [], items: [], scopes: [] }, [],
    { cwd: 'C:\\Work\\SoduWork', workspaceExplicit: true, sidebarProjectId: 'project-42' });
  assert.equal(events.length, 1, 'Pi handle.on must install the memory listener');
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(f.dimensionSent.length, 3, 'resumed conversation backfills all three dimensions');
  events[0]({ kind: 'turn-finished' });
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(f.dimensionSent.length, 6, 'settled turns upsert all three dimensions');
});

test('memory disposer stays private and an opened session reply is structured-cloneable', async t => {
  const f = fixture(t);
  let disposed = 0;
  const session = {
    sessionId: 'chat-clone', ui: {},
    snapshot: () => ({ status: 'idle', messages: [] }),
    uiSnapshot: () => ({ status: 'idle', messages: [] }),
    subscribe(fn) { this.listener = fn; return () => { disposed += 1; this.listener = fn; }; },
    historyRow: () => ({ id: 'chat-clone', title: 'Clone check' }),
  };
  await f.service.attach(session, identity('one'), { ids: [], items: [], scopes: [] }, [],
    { cwd: 'C:\\Work\\SoduWork', workspaceExplicit: true, sidebarProjectId: 'project-42' });
  assert.equal(typeof session.ui.memorySubscription, 'function');
  assert.equal(Object.keys(session.ui).includes('memorySubscription'), false);
  const reply = openReply(f.app, session);
  assert.equal('memorySubscription' in reply, false);
  assert.doesNotThrow(() => structuredClone(reply));
  session.ui.memorySubscription();
  assert.equal(disposed, 1);
});

test('expired device session does not block opening an archived conversation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-memory-expired-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await memory.context({ getPath: () => root },
    { hub: 'http://127.0.0.1:9080', clientId: 'client-without-session' },
    { chatId: 'archived-chat', cwd: path.join(root, 'workspace') });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.scopes, []);
});
