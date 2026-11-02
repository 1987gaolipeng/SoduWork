'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const titles = require('../main/conversation/titles');
const { openReply } = require('../main/pi-session/open-reply');

test('a real long Pi archive keeps its first title across bounded reopen, follow-up and a saved rename', { timeout:30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-title-stability-'));
  const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  t.after(async () => { await f.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const archive = f.sdk.SessionManager.open(f.resumePath);
  for (let index=0; index<260; index++) archive.appendMessage({role:'user',content:'Later request '+index,timestamp:2000+index});
  const originalBytes = fs.readFileSync(f.resumePath,'utf8');
  const app = {getPath:()=>root};
  await f.open();
  assert.equal(f.handle.historyRow().title,'Create an isolated report');
  assert.ok(f.handle.snapshot().messages.length<=240,'title recovery must not replay the complete transcript');
  assert.equal(openReply(app,f.handle).title,'Create an isolated report');
  assert.equal(fs.readFileSync(f.resumePath,'utf8').startsWith(originalBytes),true,'opening cannot rewrite old transcript bytes');
  assert.equal((await f.handle.send('A different subject in a follow-up',[],{internal:true})).ok,true);
  assert.equal(f.handle.historyRow().title,'Create an isolated report');
  const saved = titles.save(app,f.handle.sessionId,'My stable project name');
  assert.equal(openReply(app,f.handle).title,saved.title);
  f.handle.close(); await f.open();
  assert.equal(f.handle.historyRow().title,'Create an isolated report');
  assert.equal(openReply(app,f.handle).title,saved.title,'explicit name survives another real archive reopen');
});

function sidebarFixture() {
  let owner='owner-a';const events=new Map();
  const box = {children:[],scrollTop:0,classList:{toggle(){}},querySelectorAll:()=>[]};
  const saved = {ok:true,id:'outside-recent',title:'My project',customTitle:'My project',titleUpdatedAt:30};
  const window = {SoduWorkAPI:{taskStorageKey:()=>owner},
    addEventListener(name,fn){events.set(name,fn);},
    soduWorkAPI:{conversationSession:{renameHistory:async()=>saved}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/workspace/workspace-chat-list.js'),'utf8'),{window});
  const ctx = {chatNames:new Map(),chatItems:[],incomingOpened:new Map(),activeChatId:'',MAX_CHAT_ITEMS:50,
    mount(){},root:{querySelector:()=>box,querySelectorAll:()=>[]},pinnedChats:box,chats:box,_empty(){},
    sidebarProjects:{pins:()=>new Set(),remember(){},partition:()=>({pinned:[],recent:[],projects:[]})},renderChats(){}};
  return {ctx,window,api:window.WorkspaceChatList.create(ctx),
    switchOwner(next){owner=next;events.get('soduwork-data-scope-changed')?.();}};
}

test('renaming an open conversation outside the recent list defeats a late automatic history response', async () => {
  const f=sidebarFixture();
  await f.api.renameChat('outside-recent','My project');
  assert.equal(f.api.rememberChatName({id:'outside-recent',title:'Old automatic title'}).title,'My project');
  assert.equal(f.api.rememberChatName({id:'outside-recent',title:'Old saved name',customTitle:'Old saved name',titleUpdatedAt:20}).title,'My project');
  assert.equal(f.api.rememberChatName({id:'outside-recent',title:'Newer name',customTitle:'Newer name',titleUpdatedAt:40}).title,'Newer name');
});

test('an older rename reply cannot overwrite the newer saved header or sidebar name', async () => {
  const f=sidebarFixture(), replies=[], painted=[];
  f.window.soduWorkAPI.conversationSession.renameHistory=()=>new Promise(resolve=>replies.push(resolve));
  f.window.ChatChrome={rename:(id,title)=>painted.push(title)};
  const old=f.api.renameChat('outside-recent','Old explicit name');
  const latest=f.api.renameChat('outside-recent','New explicit name');
  replies[1]({ok:true,title:'New explicit name',customTitle:'New explicit name',titleUpdatedAt:40});await latest;
  replies[0]({ok:true,title:'Old explicit name',customTitle:'Old explicit name',titleUpdatedAt:30});await old;
  assert.equal(f.api.rememberChatName({id:'outside-recent',title:'automatic'}).title,'New explicit name');
  assert.equal(painted.at(-1),'New explicit name');
});

test('a rename reply from the previous account cannot repopulate the current title cache or header', async () => {
  const f=sidebarFixture(),painted=[];let resolve;
  f.window.soduWorkAPI.conversationSession.renameHistory=()=>new Promise(done=>{resolve=done;});
  f.window.ChatChrome={rename:(id,title)=>painted.push(title)};
  const pending=f.api.renameChat('outside-recent','Private previous account title');
  f.switchOwner('owner-b');
  resolve({ok:true,title:'Private previous account title',customTitle:'Private previous account title',titleUpdatedAt:40});
  await pending;
  assert.equal(f.ctx.chatNames.size,0);
  assert.equal(painted.length,0);
});

test('fresh open retains the compact initial header title and later turns never replace an explicit name', async () => {
  const window = {}, failures = [];
  const request = 'Please build this carefully specified site. '.repeat(5);
  const ctx = {window,global:window,Promise,_viewEpoch:1,_sessionOptions:{},_draftKey:'new',_pending:request,
    _collabTasks:new Map(),_awaitBounded:promise=>promise,_isEmptyStalledSnapshot:()=>false,
    _rememberConversationSnapshot(){},_paintBar(){},_render(){},_pullOuts(){},refreshHistory(){},
    _fail:(...args)=>failures.push(args),
    _api:()=>({open:async()=>({ok:true,ref:'fresh-ref',sessionId:'fresh-id',title:'',snapshot:{messages:[]}}),onEvent:()=>()=>{}})};
  ctx.ctx=ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels/panels-chat-chrome.js'),'utf8'),ctx);
  ctx.ChatChrome=window.ChatChrome;
  vm.runInContext(require('./renderer-source.cjs').factoryFunction('chat-session-controller.js','ChatSessionController','_ensureOnce'),ctx);
  ctx.ChatChrome.begin(request);
  assert.equal(await ctx._ensureOnce(undefined,1),true,JSON.stringify(failures));
  assert.equal(ctx.ChatChrome.sessionTitle,request.trim().slice(0,40));
  ctx.ChatChrome.begin('A later unrelated request');
  assert.equal(ctx.ChatChrome.sessionTitle,request.trim().slice(0,40));
  ctx.ChatChrome.rename('fresh-id','User chosen project name');
  ctx.ChatChrome.begin('Another follow-up');
  assert.equal(ctx.ChatChrome.sessionTitle,'User chosen project name');
  ctx.ChatChrome.reset();ctx.ChatChrome.resume('Other conversation');ctx.ChatChrome.identify('other-id');
  ctx.ChatChrome.rename('fresh-id','Late rename from previous conversation');
  assert.equal(ctx.ChatChrome.sessionTitle,'Other conversation');
});

test('original naming skips internal controls, strips runtime envelopes and never visits later receipts', () => {
  const history = require('../main/pi-session/history-state');
  const connector = require('../main/pi-session/connector-context.cjs');
  const continuation = require('../main/pi-session/output-continuation');
  const user = text => ({type:'message',message:{role:'user',content:[{type:'text',text}]}});
  const later = {type:'message',get message(){throw Error('later receipt must not be read');}};
  const entries = [{type:'session_info',name:'Later generated name'},
    user(continuation.MARKER+'\nInternal resume'),user(connector.augment('Original visible request','Internal guide')),later];
  assert.equal(history.originalMessageTitle(entries,[]),'Original visible request');
  assert.equal(history.originalMessageTitle([], [{role:'user',content:'Fallback first request'},later]),'Fallback first request');
  assert.equal(history.originalMessageTitle([],[]),'');
});


test('automatic runtime placeholders recover only from visible user context and preserve meaningful names', () => {
  const { resolve } = require('../main/conversation/automatic-title');
  const connector = require('../main/pi-session/connector-context.cjs');
  const messages = [{role:'assistant',text:'Ignore assistant title'},
    {role:'user',text:connector.augment('Original user request','Private connector details')},
    {role:'user',text:'Later follow-up'}];
  for (const value of ['', 'OpenCode 工作会话', 'Qwen Code 工作会话', '未命名对话'])
    assert.equal(resolve(value, {messages}), 'Original user request');
  for (const value of ['OpenCode 工作会话设计', 'Original custom topic', '需求：制作网页'])
    assert.equal(resolve(value, {messages}), value);
  assert.equal(resolve('OpenCode 工作会话', {messages:[]}), '');
});
