// Real chat input -> slash router -> plugin surface -> task draft, with isolated API data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const out = process.argv[2];
if (!out || !path.isAbsolute(out)) throw Error('Absolute evidence directory required');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-description-')));
const client = path.resolve(__dirname, '..'), report = { ok: false, checks: [] };
let win;
const delay = ms => new Promise(r => setTimeout(r, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  for (let i=0; i<150; i++) { if (await js(code)) return; await delay(50); }
  throw Error('Timed out: ' + code);
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});
  await delay(100);
}
async function prepare() {
  await js(`NativeChat.reset();openComposePanel({chatId:'task-context-fixture'});`);
  await until(`NativeChat.sessionInfo().sessionId==='task-context-fixture'&&!!document.querySelector('#nchatInput')`);
}
async function submit(text, file) {
  if (file) await js(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['本次选择的材料'],'current.txt',{type:'text/plain'}));const e=document.querySelector('#nchatFile');e.files=transfer.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await js(`(()=>{const e=document.querySelector('#nchatInput');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.focus()})()`);
  const count = await js('fixtureCalls.parsed.length');
  await click('#nchatSend');
  await until(`fixtureCalls.parsed.length>${count}&&!!document.querySelector('#cpNote')`);
  await delay(100);
}
app.whenReady().then(async()=>{
  win = new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(path.join(client,'tests/new-conversation.html'));
  await until(`document.querySelector('#out').textContent.includes('new conversation smoke:')`);
  const smoke = await js(`document.querySelector('#out').textContent`);
  assert.match(smoke,/new conversation smoke: \d+ passed, 0 failed/);
  assert.ok(Number(smoke.match(/(\d+) passed, 0 failed/)[1]) >= 21, 'retain all baseline conversation checks');
  const links=[...fs.readFileSync(path.join(client,'desk.html'),'utf8').matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(m=>pathToFileURL(path.join(client,m[1])).href);
  await js(`Promise.all(${JSON.stringify(links)}.map(href=>new Promise(resolve=>{const e=document.createElement('link');e.rel='stylesheet';e.href=href;e.onload=e.onerror=resolve;document.head.append(e)})))`);
  const scripts=['plugin-ui-host','conversation-attachments','chat-plugin-mention','task-execution-context','task-execution-client','task-priority','compose-selection-position','requirement-fields','panels-compose-submit','panels-compose-draft','work-entry-sheet','panels-chat-work-actions'];
  for (const file of scripts) await js(`new Promise((resolve,reject)=>{const e=document.createElement('script');e.src=${JSON.stringify(pathToFileURL(path.join(client,'components/panels',file+'.js')).href)};e.onload=resolve;e.onerror=reject;document.body.append(e)})`);
  await js(`window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
    window.fixtureCalls={parsed:[],options:[],sent:[]};window.parseFails=false;
    window.fixtureHistory=Array.from({length:12},(_,i)=>i%2?{role:'assistant',blocks:[{kind:'text',text:'历史记录标记 '+i+'：旧报告、旧错误和旧进展。'.repeat(50),done:true}]}:{role:'user',text:'之前的话题 '+i,attachments:[{name:'old-history.pdf',size:8,previewRef:'old-file'}]});
    window.fixtureSnapshot=()=>({status:'idle',messages:fixtureHistory,tools:[],execution:{running:false,queue:[]}});
    Object.assign(soduWorkAPI.conversationSession,{open:async()=>({ok:true,ref:'fixture:task-description',sessionId:'task-context-fixture',snapshot:fixtureSnapshot(),model:{}}),send:async(...args)=>{fixtureCalls.sent.push(args);return{ok:true}}});
    Object.assign(SoduWorkAPI,{parseTaskText:async(text,model,attachments)=>{fixtureCalls.parsed.push({text,attachments});if(parseFails)throw Error('isolated parse failure');return{title:'修复工作目标分析的缺陷',note:text,assignee:'me',checklist:['回归通过']}},
      taskExecutionOptions:async body=>{fixtureCalls.options.push(body);return{substrates:[],workflows:[],repos:[]}},listTeammates:async()=>({mates:[]}),workCatalog:async()=>({scenarios:[]})});
    window.petSay=()=>{};window.fetch=()=>{throw Error('No network allowed in fixture')};
    document.querySelector('#out').hidden=true;
  `);
  const text='【工作目标分析】修复 QA 测试发现的 11 个缺陷，统一前后端口径并回归验证。';
  for (const [command,file,fail] of [['/创建任务',false,false],['/任务',true,false],['/创建任务',false,true]]) {
    await prepare();await js('parseFails='+fail);await submit(command+' '+text,file);
    const state=await js(`({bubble:document.querySelector('.pui-turn-prompt-bubble')?.textContent,note:document.querySelector('#cpNote').value,parsed:fixtureCalls.parsed.at(-1),option:fixtureCalls.options.at(-1),sent:fixtureCalls.sent.length,errors:fixtureErrors})`);
    assert.equal(state.bubble,'/需求 '+text);assert.equal(state.note,text);assert.equal(state.parsed.text,text);assert.equal(state.option.note,text);assert.equal(state.sent,0);assert.deepEqual(state.errors,[]);
    assert.deepEqual(state.parsed.attachments.map(f=>f.name||f.filename),file?['current.txt']:[]);
    report.checks.push({command,file,parseFailure:fail,originalTextPreserved:true,historyCopied:false});

  }
  await prepare();await js('parseFails=false');await submit('/创建任务');
  const bare=await js(`({bubble:document.querySelector('.pui-turn-prompt-bubble')?.textContent||'',parsed:fixtureCalls.parsed.at(-1)})`);
  assert.equal(bare.bubble,'');assert.match(bare.parsed.text,/历史记录标记/);assert.ok(bare.parsed.attachments.some(f=>f.name==='old-history.pdf'));
  report.checks.push('Bare commands can use conversation reference for parsing without echoing it as user-authored text');
  assert.deepEqual(await js('fixtureErrors'),[]);report.ok=true;
}).catch(async error=>{report.error=error.stack;report.rendererErrors=win?await js('window.fixtureErrors').catch(()=>[]):[];if(win)fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG())})
.finally(()=>{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(report.ok?0:1)});
