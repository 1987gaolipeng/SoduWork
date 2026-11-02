'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-title-switch-'));
  const env = { ...process.env, SODUWORK_TITLE_FIXTURE_ROOT: root };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, '--no-sandbox', '--disable-gpu'],
    { env, windowsHide: true, stdio: 'inherit', timeout: 90000 });
  assertFixturePath(root);
  fs.rmSync(root, {recursive:true,force:true,maxRetries:5});
  process.exit(result.status ?? 1);
  function assertFixturePath(value) {
    if(path.dirname(path.resolve(value))!==path.resolve(os.tmpdir()) || !path.basename(value).startsWith('soduwork-title-switch-'))
      throw Error('Unexpected fixture cleanup path');
  }
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.SODUWORK_TITLE_FIXTURE_ROOT;
if (!root) throw Error('Start this isolated fixture with Node');
const output = path.resolve(__dirname, '../../outputs/conversation-title-switch');
fs.mkdirSync(output, { recursive:true });
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = { ok:false, checks:[], boundary:'Real Electron, production runtime bridge, Runner adapter, Pi SDK/archive, manifest, header and sidebar. Runner RPC and loopback model/auth are isolated fixtures. No user profile, paid model or business writes.' };
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { createRunnerRuntimeAdapter, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const segments = require('../main/conversation/runtime-segments');
const { openReply } = require('../main/pi-session/open-reply');
const sessions = require('../main/pi-session/session');
const runs = new Map();
let bridge, fixture, win;
const identity = { hub:'http://127.0.0.1:9', clientId:'title-fixture', session:Buffer.from(JSON.stringify({
  typ:'device',uid:'title-owner',cid:'title-fixture',iat:Math.floor(Date.now()/1000)-10,
  exp:Math.floor(Date.now()/1000)+3600 })).toString('base64url')+'.'+'a'.repeat(64) };
const runtime = { async rpc(op, input) {
  if (op === 'runtime.detect') return {ok:true,data:{installed:true,state:'ready',accessControl:catalog.runtime('opencode').accessControl}};
  if (op === 'job.dispatch') {
    const ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf','chat:'+input.task.id+':'+input.cli);
    runs.set(ref,{ref,cli:input.cli,taskId:input.task.id,title:input.task.title,workDir:input.ctx.workDir,state:'done',
      items:[{seq:1,kind:'user',text:input.ctx.conversationUserText},{seq:2,kind:'say',text:'已完成短文。'}]});
    return {ok:true,data:{ref}};
  }
  if (op === 'job.session') { const run=runs.get(input.ref);return {ok:true,data:{ref:input.ref,status:'done',round:1,
    seq:run.items.length,items:run.items.filter(item=>item.seq>(input.since||0)).slice(0,input.limit||500)}}; }
  if (op === 'runtime.sessions') return {ok:true,data:{runs:[...runs.values()]}};
  if (op === 'job.stop') return {ok:true,data:{ok:true}};
  throw Error('Unexpected RPC '+op);
} };
function createBridge() {
  return createPiSessionBridge({ app, sessionModule:{...sessions, probe:async()=>({ok:true})},
    runnerAdapters:[createRunnerRuntimeAdapter({app,runtimeSpec:catalog.runtime('opencode'),runnerRuntime:runtime,
      modelConfig:{fetchModel:async()=>({ok:true,model:{id:'fixture-model',name:'fixture-model',key:'fixture',baseUrl:'http://127.0.0.1:9'}})}})] });
}
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function idle(h) { for(let i=0;i<400 && h.snapshot().status!=='idle';i++)await wait(20);assert.equal(h.snapshot().status,'idle'); }
async function send(h,text) { const turn=h.submit(text,[],{});assert.equal(turn.accepted,true);const result=await turn.completion;assert.equal(result.ok,true,result.reason); }
const js = code => win.webContents.executeJavaScript(code,true);
async function project(h, expected, screenshot) {
  const reply=openReply(app,h), row=require('../main/conversation/titles').decorate(app,h.historyRow());
  assert.equal(reply.title,expected);
  await js(`(()=>{const row=${JSON.stringify(row)},reply=${JSON.stringify({title:reply.title,sessionId:reply.sessionId})};
    WorkspaceShell.upsertChat(row); WorkspaceShell.setActiveChat(row.id);
    ChatChrome.resume(reply.title); ChatChrome.identify(reply.sessionId);
    document.querySelector('#runtimeLabel').textContent=${JSON.stringify(h.displayName)};
  })()`);
  const visible=await js(`({header:document.querySelector('#nchatTitle').textContent,
    sidebar:document.querySelector('.ws-chat-row .ws-chat-title')?.textContent,
    headerVisible:(()=>{const e=document.querySelector('#nchatTitle'),r=e.getBoundingClientRect();return e.checkVisibility() && r.width>0 && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e;})(),
    errors:window.errors})`);
  assert.equal(visible.headerVisible,true,'header must be visibly on top');
  assert.equal(visible.header,expected);assert.equal(visible.sidebar,expected);assert.deepEqual(visible.errors,[]);
  if(screenshot){win.webContents.invalidate();await wait(100);fs.writeFileSync(path.join(output,screenshot),(await win.webContents.capturePage()).toPNG());}
}
app.whenReady().then(async()=>{
  fixture=await require('./fixtures/resumed-pi.cjs').create(root);
  win=new BrowserWindow({show:false,width:1180,height:760,webPreferences:{contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'fixtures/sidebar-projects.html'));
  await js(fs.readFileSync(path.join(__dirname,'../components/panels/panels-chat-chrome.js'),'utf8'));
  await js(`(()=>{const link=document.createElement('link');link.rel='stylesheet';link.href='../../components/panels/panels-chat.css';document.head.append(link);
    document.querySelector('#wsCanvas').innerHTML='<div class="nchat">'+ChatChrome.header()+'<div style="padding:32px;color:var(--ink-3)"><p>当前执行底座：<strong id="runtimeLabel"></strong></p><p>底座切换后，左侧会话名称与顶部标题保持一致。</p></div></div>';
    // Real panels mount above the shell; this isolated host uses the stage instead.
    document.querySelector('.ws-stage').style.zIndex='2';
    document.querySelectorAll('img[src]').forEach(img=>{const src=img.getAttribute('src');if(src.startsWith('assets/'))img.src='../../'+src;});
    ChatChrome.bind(document.querySelector('.nchat'),()=>({snapshot:{}}));})()`);
  bridge=createBridge();
  const options={app,identity,cwd:fixture.cwd,ref:'chat-title-fixture',adapterId:'opencode',noExtensions:true,skillDirs:[]};
  let h=(await bridge.open(options)).session;
  const original='写一篇关于雨的短文';
  await send(h,original); const id=h.sessionId;
  await project(h,original,'opencode.png');
  await bridge.dispose();bridge=createBridge();
  h=(await bridge.open({...options,resumePath:id,sessionTitle:original})).session;
  await idle(h);await project(h,original);
  report.checks.push('OpenCode native history restores its original title, including the immediate open reply.');
  assert.equal((await h.selectAgent('pi')).ok,true);
  await project(h,original,'switched-to-pi.png');
  await send(h,'继续完善段落');await project(h,original);
  assert.equal(fixture.requests.length,1,'Pi runs through a real SDK HTTP turn');
  report.checks.push('OpenCode to real Pi SDK switch and follow-up preserve both header and sidebar title.');
  await bridge.dispose();bridge=createBridge();
  h=(await bridge.open({...options,runtimeConversationId:id})).session;
  await project(h,original,'reopened.png');
  report.checks.push('Cold reopen of the switched archive retains one conversation identity and original title.');
  await bridge.dispose();
  const record=segments.read(app,id);await segments.save(app,{...record,title:'OpenCode 工作会话'});
  bridge=createBridge();h=(await bridge.open({...options,runtimeConversationId:id})).session;
  await project(h,original,'legacy-repaired.png');
  require('../main/conversation/titles').save(app,id,'我的短文项目');
  await project(h,'我的短文项目','manual-title.png');
  report.checks.push('Legacy placeholder is repaired from the prefix; an explicit manual title remains authoritative.');
  report.ok=true;
}).catch(error=>{report.error=error.stack;process.exitCode=1;}).finally(async()=>{
  await bridge?.dispose();await fixture?.close();win?.destroy();
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  app.exit(report.ok?0:1);
});
