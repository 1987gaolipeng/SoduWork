'use strict';

// The whole desk, including its initial navigation and stylesheet order, is
// production code. Only the account, journal rows and runtime responses are fixtures.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, timeout: 90000, windowsHide: true, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, session, net } = electron;
const client = path.resolve(__dirname, '..'), desk = path.join(client, 'desk.html');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-first-send-workspace-'));
const out = path.resolve(process.argv[2] || path.join(profile, 'evidence'));
const failedText = '帮我整理一次代码审查的检查步骤。', uncertainText = '列出排查本地构建失败时需要收集的信息。';
const laterDraft = '补充一下，我想先看依赖检查这一步。';
const rows = [
  { intentId: 'first-editable', attemptId: 'first-editable', sessionId: 'editable-history', adapterId: 'kimi', title: '整理代码审查步骤',
    text: failedText, status: 'failed', reason: 'Runner is not running', canAttachFailed: true, canRestoreText: true, at: Date.now() },
  { intentId: 'first-unknown', attemptId: 'first-unknown', sessionId: 'uncertain-history', adapterId: 'kimi', title: '排查本地构建失败',
    text: uncertainText, status: 'uncertain', reason: '暂时无法确认执行底座是否收到消息，请先查看原会话。', at: Date.now() - 1000 },
  { intentId:'first-no-session',attemptId:'first-no-session',title:'整理更新说明',text:'请帮我列出写版本更新说明需要的信息。',
    status:'uncertain',reason:'暂时无法确认执行底座是否收到消息。',at:Date.now()-2000 },
  { intentId:'first-starter',attemptId:'first-starter',title:'整理测试用例',text:'请帮我整理验证文件导入功能的测试用例。',
    status:'failed',reason:'执行底座尚未启动。',canRestoreText:true,
    draftOptions:{adapterId:'kimi',modelName:'GLM-5',accessMode:'standard',workspaceLabel:'工作区'},at:Date.now()-3000 },
];
rows.push({ intentId:'first-cold-file',attemptId:'first-cold-file',sessionId:'cold-file-history',adapterId:'kimi',
  title:'校验附件',text:'核对附件的内容。',attachmentNames:['report.pdf'],status:'failed',reason:'执行底座不可用。',
  canAttachFailed:true,canRestoreText:false,at:Date.now()-4000 });
const report = { screenshots: [], opened: [], sends: [], errors: [] };
const read = file => fs.readFileSync(path.join(client, file), 'utf8');
function configure(data) {
  const api = window.soduWorkAPI.conversationSession;
  Object.assign(window.SoduWorkAPI, {hubBase:()=> 'https://workspace.invalid',
    clientAuthSnapshot:()=>({state:'active',clientId:'fixture-device',user:{id:'fixture-user'}})});
  window.validation = { opened: [], sends: [] };
  window.fixtureData.myModels = { usable: [{name:'GLM-5',label:'GLM-5',providerName:'本地模型'}], defaultModel:'GLM-5' };
  const support = { supported:true, modes:['standard','readonly','full'], schema:'soduwork.access-policy/v1' };
  const runtimes = [{id:'kimi',displayName:'Kimi Code',modelMode:'managed',accessControl:support}];
  api.runtimes = async () => ({ ok:true, runtimes, availableRuntimes:runtimes, missing:[] });
  api.probe = async () => ({ ok:true, accessControl:support });
  window.validation.discarded = [];
  api.discardFirstSend = async (id, attempt) => {
    const index = data.findIndex(row => row.intentId === id && row.attemptId === attempt && row.status === 'failed' && !row.sessionId);
    if (index < 0) return {ok:false};
    data.splice(index,1); validation.discarded.push(id); return {ok:true};
  };
  api.firstSends = async () => ({ok:true,rows:structuredClone(data)});
  api.history = async () => ({ok:true,chats:data.filter(row=>row.sessionId).map(row => ({id:row.sessionId,title:row.title,adapterId:'kimi',at:row.at,count:1}))});
  api.openApplication = async () => ({ok:true,handled:false});
  const snapshot = row => ({ status: 'unreachable', statusText: row.reason, messages: [{role:'user',text:row.text,sentAt:row.at}],
    tools:[], activePlugins:[], accessPolicy:{mode:'standard'}, accessControl:support, modelSelection:{name:'GLM-5',label:'GLM-5'},
    execution: {location:'local',recoveryRequired:row.status==='uncertain',terminalConfirmed:row.status==='failed',
      turnQueue:{pending:[],paused:row.status==='uncertain',reason:row.reason}},
    completion:{reason:'error',error:row.reason} });
  api.open = async options => {
    validation.opened.push(options.chatId || 'new');
    const row = data.find(item => item.sessionId === options.chatId);
    if (!row) return {ok:false,notFound:true,reason:'会话不存在'};
    return {ok:true,ref:row.sessionId,sessionId:row.sessionId,title:row.title,adapterId:'kimi',displayName:'Kimi Code',
      cwd:'D:/workspace',workspaceName:'工作区',mode:'full',accessControl:support,
      model:{id:'GLM-5',name:'GLM-5',label:'GLM-5'},snapshot:snapshot(row)};
  };
  api.snapshot = async ref => ({ok:true,snapshot:snapshot(data.find(row => row.sessionId===ref))});
  for (const name of ['send','startFirstSend','retryFirstSend','retryFirstSendInPlace','dismissFirstSend']) {
    api[name] = async () => { validation.sends.push(name); throw Error('Unexpected ' + name + ' on sidebar navigation'); };
  }
  window.validation.corrected = [];
  api.retryFirstSendInPlace = async (id, attempt, ref, text) => {
    validation.corrected.push({id, attempt, ref, text}); return {ok:true,accepted:true};
  };
}
app.setPath('userData', profile);
app.disableHardwareAcceleration();
let win;
const js = source => win.webContents.executeJavaScript(source,true);
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(source) {
  for (let n=0; n<220; n++) { if (await js('Boolean(' + source + ')')) return; await delay(35); }
  throw Error('Timed out: ' + source);
}
async function click(selector) {
  await until('document.querySelector(' + JSON.stringify(selector) + ')?.checkVisibility()');
  const point = await js(`(async()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});
    await new Promise(resolve=>requestAnimationFrame(resolve));const r=node.getBoundingClientRect();
    const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!node.contains(document.elementFromPoint(x,y)))throw Error('Occluded control');return{x,y};})()`);
  for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
}
async function shoot(name) {
  await js('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
  win.webContents.invalidate(); await delay(200);
  const file=path.join(out,name+'.png'); fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());
  report.screenshots.push(file);
}
app.whenReady().then(async () => {
  fs.mkdirSync(out,{recursive:true});
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']}, (_r,cb)=>cb({cancel:true}));
  session.defaultSession.protocol.handle('file',request => {
    if (path.resolve(require('node:url').fileURLToPath(request.url.split('?')[0])) !== desk)
      return net.fetch(request.url,{bypassCustomProtocolHandlers:true});
    const html=read('desk.html').replace('<head>','<head><script>'+read('e2e/fixtures/page-audit-api.js')+'</script>')
      .replace('<script src="desk-boot.js"></script>', '<script>fixtureInstallApi();('+configure.toString()+')('+
        JSON.stringify(rows).replace(/</g,'\\u003c')+');</script><script src="desk-boot.js"></script>');
    return new Response(html,{headers:{'Content-Type':'text/html;charset=utf-8'}});
  });
  win=new BrowserWindow({show:false,width:1440,height:940,useContentSize:true,
    webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
  await win.loadFile(desk,{query:{panel:'workspace',view:'create'}});
  await until('fixtureReady && WorkspaceHost.view==="create" && document.querySelector("#cpInput")');
  await js("SoduWorkI18n.setLocale('zh-CN'); WorkspaceShell.refreshConversationHistory(); void 0");
  const button=id=>'.ws-chat[data-first-send="'+id+'"]', edit=button(rows[0].intentId), unknown=button(rows[1].intentId);
  await click(edit);
  await until('NativeChat.sessionInfo()?.sessionId==="editable-history" && document.querySelector("#nchatInput")?.value === '+JSON.stringify(failedText));
  await shoot('01-failed-original-conversation');
  await click('#nchatInput');
  await js('document.getElementById("nchatInput").select()');
  await win.webContents.insertText(laterDraft);
  await click(unknown);
  await until('NativeChat.sessionInfo()?.sessionId==="uncertain-history" && document.querySelector("#cpChat")?.innerText.includes('+JSON.stringify(uncertainText)+')');
  assert.equal(await js('[...document.querySelectorAll("#cpChat button")].some(node=>node.checkVisibility() && /移除发送记录|重试发送|编辑后发送/.test(node.textContent))'),false);
  await shoot('02-uncertain-original-conversation');
  await click(button(rows[2].intentId));
  await until('document.querySelector("#cpChat [data-first-send-record]")?.textContent.includes('+JSON.stringify(rows[2].text)+')');
  assert.equal(await js('document.querySelectorAll("#cpChat [data-first-send-record] button").length'),0);
  assert.equal(await js('document.querySelector("#cpChat [data-first-send-record] [role=status]").textContent'),'尚未收到这条消息的发送回执。');
  await shoot('03-uncertain-record');
  await click(button(rows[3].intentId));
  await until('document.querySelector("#nchatInput")?.value === '+JSON.stringify(rows[3].text));
  assert.equal(await js('NativeChat.hasSession()'),false);
  const labels = '({permission:document.querySelector("#nchatModeName")?.textContent,model:document.querySelector("#nchatModel .nmodel-button span")?.textContent,runtime:document.querySelector("#nchatRuntimeName")?.textContent})';
  await until(labels + '.permission === "默认权限"');
  report.draftControls = await js(labels);
  assert.deepEqual(report.draftControls,{permission:'默认权限',model:'GLM-5',runtime:'Kimi Code'});
  await shoot('04-failed-before-allocation');
  await click(edit);
  await until('document.querySelector("#nchatInput")?.value === '+JSON.stringify(laterDraft));
  // A cold refusal with missing inputs still has an ordinary, navigable session.
  const cold = rows[4];
  await click(button(cold.intentId));
  await until('NativeChat.sessionInfo()?.sessionId==="cold-file-history" && document.querySelector("#nchatInput")?.checkVisibility()');
  assert.equal(await js('document.querySelector("#nchatInput").value'), '');
  assert.equal(await js('validation.opened.at(-1)'), cold.sessionId);
  assert.deepEqual(await js('validation.corrected'), []);
  await click('#nchatInput'); await win.webContents.insertText('改为只整理文字。');
  await click('#nchatSend');
  await until('validation.corrected.length === 1');
  assert.deepEqual(await js('validation.corrected[0]'), {
    id:cold.intentId,attempt:cold.attemptId,ref:cold.sessionId,text:'改为只整理文字。',
  });
  // Discard the unallocated draft from its sidebar action; cancel is a no-op.
  await click(button(rows[3].intentId));
  await until('document.querySelector("#cpChat [data-first-send-draft-id]")?.dataset.firstSendDraftId === "first-starter"');
  const discard = '.ws-chat-row:has(' + button(rows[3].intentId) + ') .ws-first-send-discard';
  // Hover exposes the row actions for a real mouse click.
  const point = await js('(()=>{const r=document.querySelector('+JSON.stringify(button(rows[3].intentId))+').getBoundingClientRect();return {x:Math.round(r.x+10),y:Math.round(r.y+r.height/2)}})()');
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  await js('window.confirm=()=>false; void 0');
  await click(discard); assert.deepEqual(await js('validation.discarded'),[]);
  await js('window.confirm=()=>true; void 0');
  await click(discard);
  await until('validation.discarded.length===1 && !document.querySelector('+JSON.stringify(button(rows[3].intentId))+')');
  await until('document.querySelector("#cpInput")?.checkVisibility()');
  assert.equal(await js('document.querySelector('+JSON.stringify('.ws-chat-row:has('+unknown+') .ws-first-send-discard')+').hidden'),true);
  Object.assign(report,await js('validation'));
  assert.deepEqual(report.sends,[]); assert.equal(report.opened.includes('new'),false);
  const styleOrder=await js('[...document.querySelectorAll("link[rel=stylesheet]")].map(n=>n.getAttribute("href"))');
  const expected=[...read('desk.html').matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map(match=>match[1]);
  assert.deepEqual(styleOrder.slice(0, expected.length),expected);
  report.errors=await js('fixtureErrors'); assert.deepEqual(report.errors,[]);
  report.ok=true;
}).catch(async error=>{
  report.error=String(error.stack||error);
  if (win && !win.isDestroyed()) {
    report.body=await js('document.body.innerText.slice(-1800)').catch(()=>'');
    report.errors=await js('fixtureErrors').catch(()=>[]);
    await shoot('diagnostic').catch(()=>{});
  }
}).finally(()=>{
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));win?.destroy();app.exit(report.ok?0:1);
});
