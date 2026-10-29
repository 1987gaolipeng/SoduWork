'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron,[__filename,...process.argv.slice(2),'--disable-gpu'],{env,windowsHide:true,stdio:'inherit',timeout:90000});
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage } = electron;
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const args=process.argv.slice(2), cloud=args[args.indexOf('--cloud-root')+1];
if(!args.includes('--cloud-root')||!cloud) throw Error('Explicit --cloud-root required');
const client=path.resolve(__dirname,'..'),web=path.resolve(cloud,'web/public'),root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-knowledge-auto-'));
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const windows=[],writes=[],parses=[],cases=[],report={ok:false,cases,boundary:'Production knowledge H5/dialog/SDK, native Electron bridge and /自动化 draft/validation/create modules. Parse, execution options and schedule HTTP persistence are isolated fixtures; no user schedules or model calls.'};
let host,server,application,holdParse=false,releaseParse,failSave=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const js=(wc,code)=>wc.executeJavaScript(code);
const frame=()=>application.webContents.mainFrame.frames.find(f=>decodeURI(f.url).includes('/资料/index.html'));
const child=code=>frame().executeJavaScript(code);
async function until(check,label){for(let i=0;i<400;i++){if(await check())return;await sleep(20);}throw Error('Timeout: '+label);}
app.whenReady().then(async()=>{
  server=http.createServer(async(req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://fixture').pathname);
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');
    if(req.method==='OPTIONS'){res.end();return;}
    const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(name.startsWith('/fixture/')){
      let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
      if(name==='/fixture/parse'){parses.push(body);if(holdParse)await new Promise(r=>releaseParse=r);return json({title:'AI行业资料日报',note:'收集来源与摘要',acceptanceCriteria:['标明资料来源']});}
      if(name==='/fixture/create'){writes.push(body);if(failSave){res.statusCode=500;return json({reason:'fixture uncertain'});}return json({id:'schedule-'+writes.length,...body});}
    }
    if(name==='/home.html')return res.end('<!doctype html><meta charset="utf-8"><script>localStorage.setItem("mediaops.languagePreference","zh");localStorage.setItem("soduworkToken","fixture-business-token");localStorage.setItem("soduworkAuth",JSON.stringify({user:{id:"fixture-user"},spaces:[{id:"space-a",name:"研发空间"},{id:"space-b",name:"市场空间"}]}));sessionStorage.setItem("soduworkSpaceId","space-a");window.currentSpace="space-a";window.SODUWORK_APP_CONTEXT=()=>({spaceId:currentSpace});</script><script src="/soduwork-app.js"></script><iframe style="border:0;width:100%;height:95vh" src="/资料/index.html"></iframe>');
    const file=path.resolve(web,'.'+name);
    if(!file.startsWith(web+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript; charset=utf-8':name.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const script=name=>'<script src="'+require('node:url').pathToFileURL(path.join(client,'components/panels',name+'.js')).href+'"></script>';
  fs.writeFileSync(path.join(root,'owner.html'),'<meta charset="utf-8"><script>window.ownerScope="fixture-owner";window.SoduWorkAPI={taskStorageKey:()=>ownerScope,taskExecutionOptions:async()=>({substrates:[{key:"local:pi",name:"Pi",available:true}],repos:[]}),parseTaskText:async(text,model,attachments,options)=>{const r=await fetch('+JSON.stringify(origin+'/fixture/parse')+',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,options})});return r.json()},preflightSchedule:async()=>({state:"ready"}),createSchedule:async(body)=>{const r=await fetch('+JSON.stringify(origin+'/fixture/create')+',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw Error("fixture save failed");return r.json()}};window._schmLoad=async()=>[];window.PluginUIHost={assertUse:async(id)=>{const r=await soduWorkAPI.personalPlugins.get(id);if(!r.plugin.enabled)throw Error("Disabled")}};</script>'+['schedule-timing','work-automation-bindings','work-automation-card-state','work-automation-sheet','work-automation-direct','soduwork-app-bridge-host'].map(script).join(''));
  fs.writeFileSync(path.join(root,'composer.html'),'<textarea id="draft">保留草稿</textarea>');
  require('../main/app-settings-store.cjs').configure({app,safeStorage,ownerOf:()=> 'fixture-owner'});
  const body=JSON.parse(fs.readFileSync(path.resolve(cloud,'plugin/soduwork-plugin-draft.json')));body.ui.contributions[0].source.url=origin+'/home.html';
  const personal=require('../main/personal-plugins'),plugin=personal.create(app,body).plugin;
  ipcMain.handle('personal-plugin-get',(_event,id)=>({ok:true,plugin:personal.get(app,id)}));
  require('../main/work-preview').install({app,ipcMain,
    BrowserWindow:Object.assign(function(options){const win=new BrowserWindow(options);windows.push(win);return win;},{fromWebContents:wc=>BrowserWindow.fromWebContents(wc)}),
    WebContentsView:function(options){const view=new WebContentsView(options),load=view.webContents.loadFile.bind(view.webContents);view.webContents.loadFile=(file,options)=>load(path.basename(file)==='desk.html'?path.join(root,'composer.html'):file,options);return view;},shell:{openExternal:async()=>{throw Error('No external opens');}}});
  host=new BrowserWindow({show:false,webPreferences:{preload:path.join(client,'preload.js'),contextIsolation:true,sandbox:true}});
  await host.loadFile(path.join(root,'owner.html'));
  assert.equal(await js(host.webContents,'!!WorkAutomationDirect && !!SoduWorkAppBridgeHost'),true);
  const payload={tabId:'knowledge-auto',url:origin+'/home.html',appBridge:{appId:'plugin:'+plugin.pluginId,contributionId:'ops-cloud-console',origin,version:1,capabilities:body.ui.contributions[0].source.bridge.capabilities}};
  assert.equal((await js(host.webContents,'soduWorkAPI.workPreview.showDetached('+JSON.stringify(payload)+')')).ok,true);
  [,application]=windows[0].contentView.children;
  await until(async()=>!!frame()&&await child('!!window.soduWorkApp?.automation && !!document.getElementById("opsKnowledgeSchedule")'),'knowledge iframe');
  await child('opsKnowledgeSchedule.click();opsKnowledgeScheduleDialog.querySelector("[data-schedule-close]").click()');assert.equal(writes.length,0);
  await child('opsKnowledgeSchedule.click();opsKnowledgeScheduleText.value="每天早上9点采集 AI 行业资料，保留来源"');
  const out=path.resolve(cloud,'_tmp/knowledge-automation');fs.mkdirSync(out,{recursive:true});
  for(const width of [1400,900]){windows[0].setSize(width,850);await sleep(120);assert.equal(await child('(()=>{const r=opsKnowledgeScheduleDialog.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'),true);fs.writeFileSync(path.join(out,'dialog-'+width+'.png'),(await application.webContents.capturePage()).toPNG());}
  holdParse=true;
  await child('opsKnowledgeScheduleDialog.querySelector("form").requestSubmit();opsKnowledgeScheduleDialog.querySelector("form").requestSubmit()');
  await until(()=>!!releaseParse,'parse submitted');assert.equal(parses.length,1);assert.equal(await child('opsKnowledgeScheduleText.disabled'),true);
  holdParse=false;releaseParse();releaseParse=null;
  await until(async()=>await child('opsKnowledgeScheduleDialog.querySelector("[data-schedule-result]").textContent.includes("已创建：")'),'created receipt');
  assert.equal(writes.length,1);assert.equal(writes[0].atHour,9);assert.equal(writes[0].timeZone,'Asia/Shanghai');assert.match(writes[0].note,/space-a/);
  assert.match(parses[0].text,/^\/自动化 /);assert.doesNotMatch(JSON.stringify(writes[0]),/fixture-business-token/);
  assert.equal(await js(host.webContents,'WorkAutomationSheet.hasSurface()'),false);
  cases.push('Knowledge dialog submits requirements and current space through real SDK/IPC; exactly one persisted fixture plan, no confirmation card, retained original text and 09:00 Asia/Shanghai.');
  cases.push('Cancel creates nothing; wide/narrow dialog controls fit viewport and remain accessible.');
  const command={text:'每周一早上8点汇总资料',requestId:'native-dedup',context:{spaceId:'space-a',spaceName:'研发空间'}};
  const receipts=await child('Promise.all([soduWorkApp.automation.create('+JSON.stringify(command)+'),soduWorkApp.automation.create('+JSON.stringify(command)+')])');
  assert.equal(writes.length,2);assert.equal(receipts[0].schedule.id,receipts[1].schedule.id);
  const mismatch=await child('soduWorkApp.automation.create('+JSON.stringify({...command,text:'每天10点汇总资料'})+')');assert.equal(mismatch.ok,false);assert.equal(writes.length,2);
  cases.push('Native operation ID deduplicates concurrent/repeated requests and rejects different content using the same ID.');
  await child('opsKnowledgeScheduleDialog.querySelector("[data-schedule-close]").click();opsKnowledgeSchedule.click();opsKnowledgeScheduleText.value="每天8点采集资料"');
  await js(application.webContents,'currentSpace="space-b"');
  await child('opsKnowledgeScheduleDialog.querySelector("form").requestSubmit()');
  assert.match(await child('opsKnowledgeScheduleDialog.querySelector("[data-schedule-result]").textContent'),/空间或账号已切换/);assert.equal(writes.length,2);
  await child('opsKnowledgeScheduleDialog.querySelector("[data-schedule-close]").click();opsKnowledgeSchedule.click();opsKnowledgeScheduleText.value="每天10点采集资料"');
  failSave=true;await child('opsKnowledgeScheduleDialog.querySelector("form").requestSubmit()');
  await until(async()=>await child('opsKnowledgeScheduleDialog.querySelector("[data-schedule-result]").textContent.includes("尚未确认")'),'uncertain result');
  assert.equal(writes.length,3);assert.equal(await child('opsKnowledgeScheduleDialog.querySelector("[type=submit]").disabled'),true);
  cases.push('Space changed while dialog open is rejected; save transport failure shows uncertain outcome and prevents a blind duplicate.');
  body.version='0.4.7';body.ui.contributions[0].source.bridge.capabilities=body.ui.contributions[0].source.bridge.capabilities.filter(cap=>cap!=='automation.create');personal.create(app,body);
  const denied=await child('soduWorkApp.automation.create('+JSON.stringify({...command,requestId:'disabled-app'})+')');assert.equal(denied.ok,false);assert.equal(writes.length,3);
  cases.push('Revoking direct-create capability in the installed app blocks requests from an already open page.');
  report.ok=true;
}).catch(error=>{report.error=String(error.stack||error);}).finally(async()=>{
  host?.destroy();windows.forEach(win=>{if(!win.isDestroyed())win.destroy();});
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  const out=path.resolve(cloud,'_tmp/knowledge-automation');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);
});
