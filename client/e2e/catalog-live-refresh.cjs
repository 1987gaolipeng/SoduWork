 'use strict';
// Real Electron/preload/IPC/cache/pickers. Deterministic installation and model HTTP service;
// no packages are installed and no paid model request is sent.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron,[__filename],{env,windowsHide:true,stdio:'inherit'}).on('exit',code=>{process.exitCode=code??1;});
} else {
  const {app,BrowserWindow,WebContentsView,ipcMain,webContents,protocol}=electron;
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
  const {pathToFileURL,fileURLToPath}=require('node:url'),assert=require('node:assert/strict');
  const root=path.resolve(__dirname,'..'),out=path.resolve(root,'../outputs/runtime-catalog-refresh/e2e');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-catalog-refresh-'));
  app.setPath('userData',profile); app.disableHardwareAcceleration();
  fs.mkdirSync(out,{recursive:true});
  let installed=false,version='1.2.3',jobStarted=false,models=[{name:'chosen',label:'Chosen model'}],modelInvalidations=0;
  const report={ok:false,boundary:'Production preload, catalog invalidation, availability cache, management, homepage and chat controls in real Electron windows and WebContentsView. Installation and model service responses are fixtures.',checks:[],errors:[]};
  const server=http.createServer((req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','application/json');
    let data;
    if(req.url==='/models')data={usable:models,defaultModels:{pi:models[0].name,opencode:models[0].name}};
    else if(req.url==='/install'){jobStarted=true;data={jobId:'install-opencode'};}
    else if(req.url==='/job'){installed=true;data={state:'done',ok:true,lines:['Installed fixture']};}
    else data={modelCount:models.length,agents:[{key:'opencode',name:'OpenCode',installed,state:installed?'ready':'missing',version}],
      machines:[{runnerId:'local',scope:'current-instance',env:{ok:true},agents:[{key:'opencode',name:'OpenCode',installed,state:installed?'ready':'missing',version}]}]};
    res.end(JSON.stringify(data));
  });
  const adapter=(id,detect)=>({id,displayName:id,capabilities:[],detect,createSession:async()=>{throw Error('No execution expected');}});
  const bridge=require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({adapter:adapter('pi',async()=>({ok:true})),
    runnerAdapters:[adapter('opencode',async()=>installed?{ok:true,version,state:'ready'}:{ok:false,state:'missing'})],
    sessionModule:{open:async()=>{},probe:async()=>({ok:true})}});
  const changes=require('../main/agent-runtime/catalog-changes.cjs').create({session:bridge,
    contents:()=>webContents.getAllWebContents(),invalidateModels:()=>{modelInvalidations++;require('../main/pi-session/model-config').invalidate();}});
   ipcMain.on('soduwork-work-broadcast',(event,kind)=>changes.receive(event,kind));
  ipcMain.handle('pi-session-runtimes',(_event,options)=>bridge.availableRuntimes(app,options));
  ipcMain.handle('pi-session-conversation-runtimes',(_event,_ref,options)=>bridge.availableRuntimes(app,options));
  ipcMain.handle('pi-session-probe',(_event,id)=>({ok:id==='pi'||installed,version}));
  let selected=[], selectGate=null;
  ipcMain.handle('pi-session-select-agent',async (_event,ref,id)=>{if(selectGate)await selectGate;selected.push([ref,id]);return {ok:true,adapterId:id,displayName:id};});
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const js=(wc,code)=>wc.executeJavaScript(code,true);
  async function until(wc,code){for(let i=0;i<150;i++){if(await js(wc,code))return;await delay(40);}throw Error('Timeout: '+code);}
  const views=[];let owner,settings;
  app.whenReady().then(async()=>{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    const assets=['agent-brand','work-composer','chat-runtime-picker','chat-composer-controls','panels-compose-runtime','panels-compose-model-picker','panels-agents'];
    const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><base href="${pathToFileURL(root+path.sep).href}">
      <link rel="stylesheet" href="theme/variables.css"><link rel="stylesheet" href="components/panels/work-composer.css"><link rel="stylesheet" href="components/panels/panels-chat.css"><link rel="stylesheet" href="components/panels/chat-session-controls.css">
      <style>body{margin:24px;font:14px sans-serif}.home{position:relative;margin:40px 0 220px}main{position:relative;margin-top:160px}#cpRuntimePop{position:relative;display:block}.cp-modelwrap{position:relative}#cpRuntimeRows{max-height:180px}#agPanel:not(.show){display:none}</style>
      <div class="home"><h2>New conversation</h2><textarea id="homeDraft">Keep homepage draft</textarea><div id="homeRuntime"></div>
      <div class="cp-modelwrap"><button id="cpModelBtn"><span id="cpModelName"></span></button><div id="cpModelPop" class="cp-modelpop"></div></div></div>
      <main><h2>Existing conversation</h2><div id="nchatQueue"></div><div id="old"></div></main>
      ${assets.map(name=>'<script src="components/panels/'+name+'.js"></script>').join('')}
      <script>
      window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      const get=route=>fetch(${JSON.stringify(origin)}+route).then(r=>r.json());
      window.esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');window.petSay=()=>{};
      window.SoduWorkAPI={taskStorageKey:()=> 'fixture/owner',myModels:()=>get('/models'),localAgentSetup:()=>get('/setup'),agentInstall:()=>get('/install'),agentJob:()=>get('/job')};
      document.querySelector('#homeRuntime').innerHTML=ComposeRuntime.controls('');
      ComposeRuntime.bind(document.querySelector('.home'),{api:()=>soduWorkAPI.conversationSession,refresh:()=>ComposeModelPicker.refresh()});
      ComposeModelPicker.bind({api:()=>soduWorkAPI.conversationSession});
      WorkComposer.upgradeChat(document.querySelector('#old'));
      window.state={ref:'same-conversation',adapterId:'pi',displayName:'Pi',selection:{name:'chosen',model:{id:'chosen',label:'Chosen model'}}};
      window.controls=ChatComposerControls.create(document.querySelector('main'),{state:()=>state,say:petSay,
        runtimeSelected:r=>{state.adapterId=r.adapterId;state.displayName=r.displayName;controls.render();},modelSelected:s=>{state.selection=s;controls.render();}});
      controls.render();document.querySelector('#nchatInput').value='Keep conversation draft';window.fixtureReady=true;
      </script></html>`;
    // Keep the production trusted desk URL and preload; only substitute the QA page body.
    protocol.handle('file',request=>{
      const file=fileURLToPath(request.url);
      if(path.resolve(file)===path.join(root,'desk.html'))return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
      const type=path.extname(file)==='.js'?'text/javascript':path.extname(file)==='.css'?'text/css':path.extname(file)==='.svg'?'image/svg+xml':path.extname(file)==='.png'?'image/png':undefined;
      return new Response(fs.readFileSync(file),{headers:type?{'Content-Type':type}:{}});
    });
    const preferences={preload:path.join(root,'preload.js'),contextIsolation:true,sandbox:false,nodeIntegration:false,backgroundThrottling:false};
    owner=new BrowserWindow({show:false,width:1100,height:1000,webPreferences:{...preferences,offscreen:true}});
    settings=new BrowserWindow({show:false,width:1100,height:1000,webPreferences:{...preferences,offscreen:true}});
    const embedded=new WebContentsView({webPreferences:preferences});owner.contentView.addChildView(embedded);embedded.setBounds({x:0,y:0,width:1000,height:900});
    views.push(settings.webContents,owner.webContents,embedded.webContents);
    for(const wc of views){await wc.loadFile(path.join(root,'desk.html'));await until(wc,'window.fixtureReady');await until(wc,'ComposeRuntime.catalog().length===1 && ComposeModelPicker.value().modelName==="chosen"');
      await js(wc,'document.querySelector("#nchatRuntime").click();void 0');await until(wc,'document.querySelector(".nchat-runtime-pop [data-runtime=pi]")');}
    await js(settings.webContents,'openAgentsPanel();void 0');await until(settings.webContents,'document.querySelector("[data-ainstall]")');
    await js(settings.webContents,'document.querySelector("[data-ainstall]").click();closeAgentsPanel();void 0');
    await until(settings.webContents,'Object.values(_agJobs).some(job=>job.state==="done")');
    await js(settings.webContents,'document.querySelector("#nchatRuntime").click();void 0');
    for(const wc of views){await until(wc,'ComposeRuntime.catalog().some(row=>row.id==="opencode") && document.querySelector(".nchat-runtime-pop [data-runtime=opencode]")');
      assert.match(await js(wc,'document.querySelector(".nchat-runtime-pop").textContent'),/1\.2\.3/);
      assert.equal(await js(wc,'document.querySelector("#nchatInput").value'),'Keep conversation draft');}
    assert.equal(jobStarted,true);report.checks.push('Install completion after leaving management reaches sender, other window and WebContentsView; newly ready Agent and version appear');
    for(const wc of views){await js(wc,'document.querySelector("#nchatRuntime").click();document.querySelector("#nchatModel>button").click();void 0');await until(wc,'document.querySelector("[data-model-name=chosen]")');
      await js(wc,'let q=document.querySelector(".nmodel-pop input");q.value="model";q.dispatchEvent(new Event("input",{bubbles:true}));q.focus();void 0');}
    models=[{name:'chosen',label:'Renamed model'},{name:'added',label:'Added model'}];
    await js(settings.webContents,'soduWorkAPI.broadcast("models");void 0');
    for(const wc of views){await until(wc,'document.querySelector("[data-model-name=added]") && ComposeModelPicker.label()==="Renamed model"');
      assert.equal(await js(wc,'document.querySelector(".nmodel-pop input").value'),'model');
      assert.equal(await js(wc,'state.selection.name'),'chosen');assert.equal(await js(wc,'ComposeModelPicker.value().modelName'),'chosen');
      assert.equal(await js(wc,'document.querySelector("#nchatModel>button span").textContent'),'Renamed model');
      assert.equal(await js(wc,'document.querySelector("#homeDraft").value'),'Keep homepage draft');}
    assert.ok(modelInvalidations>=2);report.checks.push('Model changes refresh open lists and labels in all views while preserving explicit selection, search and both drafts');
    // Repeated notifications are fenced; removing an Agent updates discovery without changing an active conversation.
    installed=false;await js(settings.webContents,'soduWorkAPI.broadcast("agent-runtimes-changed");void 0');
    for(const wc of views){await until(wc,'ComposeRuntime.catalog().length===1');assert.equal(await js(wc,'state.ref'),'same-conversation');assert.deepEqual(await js(wc,'errors'),[]);}
    report.checks.push('Removal and repeated notification preserve conversation identity; no renderer errors');
    assert.deepEqual(selected,[],'catalog refresh must never select an Agent');
    await delay(200);fs.writeFileSync(path.join(out,'updated-model-picker.png'),(await settings.webContents.capturePage()).toPNG());
    assert.deepEqual(selected,[],'refresh alone does not change the selected runtime');
    installed=true;version='2.0.0';await js(settings.webContents,'soduWorkAPI.broadcast("agent-runtimes-changed");void 0');
    const wc=owner.webContents;
    await until(wc,'ComposeRuntime.catalog().some(row=>row.id==="opencode")');
    await js(wc,'document.querySelector("#nchatModel>button").click();document.querySelector("#nchatRuntime").click();void 0');
    await until(wc,'document.querySelector(".nchat-runtime-pop [data-runtime=opencode]")');
    assert.match(await js(wc,'document.querySelector(".nchat-runtime-pop").textContent'),/2\.0\.0/);
    let releaseSelection;selectGate=new Promise(resolve=>{releaseSelection=resolve;});
    await js(wc,'document.querySelector(".nchat-runtime-pop [data-runtime=opencode]").click();void 0');
    await js(settings.webContents,'soduWorkAPI.broadcast("models");void 0');await delay(80);releaseSelection();
    await until(wc,'state.adapterId==="opencode"');
    assert.deepEqual(selected,[['same-conversation','opencode']]);
    assert.equal(await js(wc,'document.querySelector("#nchatInput").value'),'Keep conversation draft');
    report.checks.push('Updated installed version is selectable through production IPC; concurrent catalog change preserves pending selection, conversation identity and draft');
    report.ok=true;
  }).catch(async error=>{report.errors.push(String(error.stack||error));report.diagnostics={installed,jobStarted,modelInvalidations,views:await Promise.all(views.map(wc=>js(wc,'({catalog:ComposeRuntime.catalog(),errors,popupHidden:document.querySelector(".nchat-runtime-pop").hidden,popup:document.querySelector(".nchat-runtime-pop").textContent,jobs:typeof _agJobs!=="undefined"?_agJobs:null})').catch(e=>String(e))))};}).finally(async()=>{
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    for(const wc of views)if(!wc.isDestroyed())wc.close();server.close();await bridge.dispose();app.exit(report.ok?0:1);
  });
}
