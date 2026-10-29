'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 120000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else if (process.argv.includes('--file-open-secondary')) {
  const { app } = electron, path = require('node:path'), os = require('node:os');
  const fileOpen = require('../main/file-open.cjs');
  const profile = process.argv[process.argv.indexOf('--file-open-profile') + 1];
  if (!profile || path.dirname(path.dirname(profile)) !== os.tmpdir() ||
      !path.basename(path.dirname(profile)).startsWith('soduwork-file-open-e2e-')) {
    throw Error('Secondary process requires the isolated fixture profile');
  }
  app.setPath('userData', profile);
  const locked = app.requestSingleInstanceLock(fileOpen.instanceData(process.argv, process.cwd(), app.isPackaged));
  if (locked) app.exit(42); else app.quit();
} else {
  const {app,BrowserWindow,WebContentsView,ipcMain,net}=electron;
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
  const {pathToFileURL}=require('node:url'),assert=require('node:assert/strict');
  const client=path.resolve(__dirname,'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-file-open-e2e-'));
  const out=path.resolve(client,'../outputs/file-open-20261014');fs.mkdirSync(out,{recursive:true});
  const fileOpen=require('../main/file-open.cjs');
  app.setPath('userData',path.join(root,'profile'));app.on('window-all-closed',()=>{});
  assert.equal(app.requestSingleInstanceLock(fileOpen.instanceData(process.argv,process.cwd(),app.isPackaged)),true);
  let win,fixture,broker,active,reopenJob=null,readinessOrder='auth-first';
  const handles=new Map(),views=[],results=[],previewCalls=[],report={ok:false,cases:[],secondInstances:[],boundary:'Real Electron second-instance transport, file broker, production preload, composer/NativeChat, attachment staging, Pi SDK and local streaming model fixture, native original-file preview. Authentication and workspace readiness use isolated fixture events. OS registration is checked separately; no installed client or external model used.'};
  const read=file=>fs.readFileSync(path.join(client,file),'utf8'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const js=code=>win.webContents.executeJavaScript(code,true);
  async function until(fn,label){for(let i=0;i<400;i++){if(await fn())return;await sleep(35);}throw Error('Timed out: '+label);}
  const currentView=()=>views.find(v=>v.webContents&&!v.webContents.isDestroyed()&&v.getVisible());
  const publish=(_w,h,event,snapshot)=>win.webContents.send('pi-session-event',{ref:h.ref,...event,snapshot:snapshot||h.uiSnapshot()});
  app.on('second-instance',(_event,argv,cwd,data)=>{
    const files=fileOpen.instanceFiles(argv,cwd,app.isPackaged,data);
    report.secondInstances.push({structured:data?.soduworkOpenFiles?.version===1,
      legacyFileCount:fileOpen.commandFiles(argv,cwd,app.isPackaged).length,
      files:files.map(file=>path.basename(file))});
    broker.enqueue(files);
  });
  async function secondInstance(file){
    const count=report.secondInstances.length,env={...process.env};
    for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE'])delete env[key];
    const status=await new Promise((resolve,reject)=>{
      const child=require('node:child_process').spawn(process.execPath,[__filename,'--file-open-secondary',
        '--file-open-profile',app.getPath('userData'),'--soduwork-open-file',file],{env,windowsHide:true,stdio:'ignore'});
      const timer=setTimeout(()=>{child.kill();reject(Error('Secondary process timed out'));},15000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);resolve(code);});
    });
    assert.equal(status,0,'second process exits after handing the file to the existing instance');
    await until(()=>report.secondInstances.length===count+1,'real second-instance event');
    assert.deepEqual(report.secondInstances.at(-1).files,[path.basename(file)]);
    assert.equal(report.secondInstances.at(-1).structured,true);
  }
  function installSend(){
    const source=read('main/pi-session/ipc.js');
    const ctx=vm.createContext({app,BrowserWindow,path,Promise,Date,
      require:require('node:module').createRequire(path.join(client,'main/pi-session/ipc.js')),
      _cloudHandoff:{guard:()=>false},updateWorkloads:{guard:()=>({ok:true})},session:{get:ref=>handles.get(ref)},
      sendIdentityOf:async()=>({}),identityOf:async()=>({}),memories:{assertOwner(){}},pluginDebug:{guard:()=>null},
      workDir:()=>root,attachments:require('../main/pi-session/attachments'),_publish:publish,_scheduleRelease(){}});
    vm.runInContext(source.slice(source.indexOf('function _contextSnapshot('),source.indexOf('function _send('))+'\n'+
      source.slice(source.indexOf('  async function sendConversation('),source.indexOf("  ipcMain.handle('pi-session-send',")),ctx);
    ipcMain.handle('pi-session-send',(_e,ref,text,files,options)=>ctx.sendConversation(ref,text,files,options,p=>p.then(r=>results.push(r))));
  }
  app.whenReady().then(async()=>{
    fixture=await require('./fixtures/resumed-pi.cjs').create(root);
    const web=path.join(fixture.cwd,'中文 页面 & one.html');
    fs.writeFileSync(web,'<!doctype html><title>Opened original</title><link rel="stylesheet" href="style.css"><h1>Before</h1><script type="module" src="app.js"></script>');
    fs.writeFileSync(path.join(fixture.cwd,'style.css'),'h1{color:rgb(20,90,70)}');
    fs.writeFileSync(path.join(fixture.cwd,'app.js'),'import {ready} from "./module.mjs";const data=await fetch("./data.json").then(r=>r.json());document.body.dataset.ready=ready&&data.ok?"yes":"no";');
    fs.writeFileSync(path.join(fixture.cwd,'module.mjs'),'export const ready=true;');
    fs.writeFileSync(path.join(fixture.cwd,'data.json'),'{"ok":true}');
    const archive=path.join(root,'input.data');fs.writeFileSync(archive,'Attachment fixture bytes');
    const bridge=require('../main/agent-runtime/pi-session-bridge');bridge.get=ref=>handles.get(ref);
    ipcMain.handle('pi-session-open',async(_e,opts)=>{
      if(opts.chatId){active=[...handles.values()].find(h=>h.sessionId===opts.chatId);}
      else {active=await fixture.open({cwd:opts.cwd||path.join(root,'work-'+handles.size),resumePath:undefined});
        handles.set(active.ref,active);active.ui={mode:'full',capabilities:[],inputAttachments:[]};
        const opened=active;opened.on(e=>publish(null,opened,e,opened.uiSnapshot()));}
      return {ok:true,ref:active.ref,sessionId:active.sessionId,snapshot:active.uiSnapshot()};
    });
    ipcMain.handle('pi-session-snapshot',(_e,ref)=>({ok:true,snapshot:handles.get(ref)?.uiSnapshot()}));
    for(const [name,value] of Object.entries({'pi-session-release':{ok:true},'pi-session-history':{ok:true,chats:[]},
      'pi-session-history-rename':{ok:true},'pi-session-capabilities':{ok:true,skills:[]},'conversation-capabilities':{ok:true,skills:[]},
      'pi-session-runtime-models':{ok:true,items:[]},'pi-session-workdir':{ok:true,dir:root},'pi-session-probe':{ok:true},
      'pi-session-mode':{ok:true},'pi-session-runtimes':{ok:true,items:[]}}))ipcMain.handle(name,()=>value);
    installSend();
    require('../main/pi-session/artifact-ipc').install({app,ipcMain,BrowserWindow,session:{get:ref=>handles.get(ref)},workDir:()=>root});
    require('../main/work-preview').install({ipcMain:{on:ipcMain.on.bind(ipcMain),handle(name,handler){ipcMain.handle(name,async(...args)=>{const result=await handler(...args);if(name==='work-preview-show')previewCalls.push({input:args[1],result});return result;});}},BrowserWindow,WebContentsView:function(o){const v=new WebContentsView(o);views.push(v);return v;},shell:{openExternal:async()=>{throw Error('external disabled')}}});
    function createWorkspace(){win=new BrowserWindow({show:false,width:1320,height:860,webPreferences:{preload:path.join(client,'preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});}
    createWorkspace();
    const origin=pathToFileURL(path.join(client,'desk.html')).href;
    function revealWorkspace(){
      if(win&&!win.isDestroyed())return;
      createWorkspace();
      reopenJob=(async()=>{
        await win.loadURL(origin);
        await until(()=>js('Boolean(window.fixtureReady&&window.openComposePanel)'),'recreated composer');
        const before=handles.size;
        if(readinessOrder==='auth-first'){
          await js('authReady=true;dispatchEvent(new Event("soduwork-device-auth"));void 0;');
          await sleep(100);assert.equal(handles.size,before,'restored authentication waits for workspace readiness');
          await js('dispatchEvent(new Event("soduwork-workspace-ready"));void 0;');
        }else{
          await js('dispatchEvent(new Event("soduwork-workspace-ready"));void 0;');
          await sleep(100);assert.equal(handles.size,before,'recreated workspace waits for delayed authentication');
          await js('authReady=true;dispatchEvent(new Event("soduwork-device-auth"));void 0;');
        }
      })();
    }
    broker=fileOpen.create({app,ipcMain,getWorkspace:()=>win,revealWorkspace,identityOf:async()=>({id:'fixture'}),ownerOf:()=> 'fixture'});
    broker.fromCommand(['electron',__filename,'--soduwork-open-file',web],root);
    const source=path.join(__dirname,'fixtures/workbench-annotations.html');
    let html=fs.readFileSync(source,'utf8').replace('<meta charset="utf-8">','<meta charset="utf-8"><base href="'+pathToFileURL(path.dirname(source)+path.sep).href+'">')
      .replace('<div id="cpChat"></div>','');
    html=html.replace('</html>',[
      '<script src="../../components/panels/compose-candidate-navigation.js"></script>',
      '<script src="../../components/panels/panels-compose-skills.js"></script>',
      '<script src="../../components/panels/panels-compose-capabilities.js"></script>',
      '<script src="../../components/panels/compose-surface.js"></script>',
      '<script src="../../components/panels/panels-compose.js"></script>',
      '<script>window.authReady=false;SoduWorkAPI.clientAuthSnapshot=()=>({state:authReady?"active":"pending"});window.WorkspaceHost={open:(_view,payload)=>openComposePanel(payload)};</script>',
      '<script src="../../components/workspace/file-open.js"></script></html>'
    ].join(''));
    await win.webContents.session.protocol.handle('file',request=>request.url===origin?new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}):net.fetch(request.url,{bypassCustomProtocolHandlers:true}));
    await win.loadURL(origin);await until(()=>js('Boolean(window.fixtureReady&&window.openComposePanel)'), 'production composer');
    await js('NativeChat.rememberDraft("new","unrelated unsent draft");void 0;');
    await js('window.previewOutputs=[];const renderWorkbench=ChatWorkbench.render;ChatWorkbench.render=function(root,snapshot,files){previewOutputs=files;return renderWorkbench(root,snapshot,files)};void 0;');
    await js('dispatchEvent(new Event("soduwork-workspace-ready"));void 0;');await sleep(100);
    assert.equal(handles.size,0,'login gates the file queue');
    await js('authReady=true;dispatchEvent(new Event("soduwork-device-auth"));void 0;');
    await until(()=>currentView()?.webContents.getTitle()==='Opened original','original HTML preview');
    assert.match(currentView().webContents.getURL(),/^http:\/\/127\.0\.0\.1:\d+\//);
    assert.equal(fixture.requests.length,0,'opening does not run a model');
    assert.equal(await js('document.querySelector("#nchatInput").value'),'');
    assert.equal(await js('NativeChat.getDraft("new")'),'unrelated unsent draft');
    assert.equal(await js('document.querySelector("#nchatAtts").textContent.includes("中文 页面 & one.html")'),true);
    await until(()=>currentView()?.webContents.executeJavaScript('document.body.dataset.ready==="yes"'),'relative module imports and fetch');
    const content=await currentView().webContents.executeJavaScript('({ready:document.body.dataset.ready,color:getComputedStyle(document.querySelector("h1")).color})');
    assert.deepEqual(content,{ready:'yes',color:'rgb(20, 90, 70)'});
    report.cases.push('Queued OS file waits for login, opens a new composer/session and previews original HTML with relative CSS/JS without sending a prompt');
    const first=active.sessionId;
    const next='<!doctype html><title>Edited original</title><h1>After conversation edit</h1>';
    fixture.reply(body=>body.messages.at(-1).role==='tool'?{text:'The selected page was updated.'}:{tool:'write',args:{path:web,content:next}});
    await js('document.querySelector("#nchatInput").value="Update the selected HTML page";document.querySelector("#nchatSend").click();void 0;');
    await until(()=>results.length===1,'conversation edit');assert.equal(results[0].ok,true,results[0].reason);
    assert.equal(fs.readFileSync(web,'utf8'),next);
    await until(()=>currentView()?.webContents.getTitle()==='Edited original','preview refresh after real file edit');
    assert.match(currentView().webContents.getURL(),/^http:\/\/127\.0\.0\.1:\d+\//);
    assert.equal(await js('document.querySelectorAll("[data-wb-tab]").length'),1,'the updated artifact reuses the original input tab');
    report.cases.push('Composer send uses production attachment staging and Pi SDK; the real write tool edits the original and refreshes the same native preview tab');
    broker.fromCommand(['electron',__filename,'--soduwork-open-file',archive],root);
    await until(()=>handles.size===2 && js('document.querySelector("#nchatAtts")?.textContent.includes("input.data")'),'unsupported attachment ready');
    assert.notEqual(active.sessionId,first);assert.equal(fixture.requests.length,2);
    assert.equal(await js('ChatWorkbench.state().open'),false);
    const second=active.sessionId;
    await js(`openComposePanel({chatId:${JSON.stringify(first)}});void 0;`);
    await until(()=>js(`NativeChat.sessionInfo().sessionId===${JSON.stringify(first)}`),'previous conversation');
    await js(`openComposePanel({chatId:${JSON.stringify(second)}});void 0;`);
    await until(()=>js('document.querySelector("#nchatAtts")?.textContent.includes("input.data")'),'attachment draft restored');
    fs.unlinkSync(archive);fixture.reply(()=>({text:'Attachment received.'}));
    await js('document.querySelector("#nchatInput").value="Read the attached material";document.querySelector("#nchatSend").click();void 0;');
    await until(()=>results.length===2,'attachment send');assert.equal(results[1].ok,true,results[1].reason);
    assert.ok(fixture.requests.at(-1).messages.some(m=>JSON.stringify(m).includes('input.data')));
    report.cases.push('Unsupported file becomes a staged, removable attachment in a separate chat; navigation preserves its draft and deleting its source does not break sending');
    broker.fromCommand(['electron',__filename,'--soduwork-open-file',path.join(root,'missing.pdf')],root);
    await until(()=>js('Boolean(document.querySelector(".file-open-notice[data-native-preview-overlay]"))'),'missing-file notice');
    assert.equal(handles.size,2,'unreadable file does not create an empty session');
    await js('document.querySelector(".file-open-notice button:last-child").click();void 0;');
    report.cases.push('A missing hot-opened file reports a dismissible error without losing the active conversation');
    for(const order of ['already-open','auth-first','ready-first']){
      await until(()=>js('soduWorkAPI.fileOpen.list().then(r=>r.ok&&r.items.length===0)'),'previous file request acknowledged');
      const before=handles.size,previous=active.sessionId,requests=fixture.requests.length;
      if(order!=='already-open'){
        report.rendererErrors=await js('errors');assert.deepEqual(report.rendererErrors,[]);
        win.destroy();assert.equal(win.isDestroyed(),true);readinessOrder=order;
      }
      await secondInstance(web);
      if(order!=='already-open'){
        assert.ok(reopenJob,'file request recreated the closed workspace');
        await reopenJob;reopenJob=null;
      }
      await until(()=>handles.size===before+1&&currentView()?.webContents.getTitle()==='Edited original','second-instance new conversation and preview');
      assert.notEqual(active.sessionId,previous);
      assert.match(currentView().webContents.getURL(),/^http:\/\/127\.0\.0\.1:\d+\//);
      assert.equal(await js('document.querySelector("#nchatAtts").textContent.includes("中文 页面 & one.html")'),true);
      assert.equal(await js('document.querySelector("#nchatInput").value'),'');
      assert.equal(fixture.requests.length,requests,'reopening never sends a model request');
      report.cases.push('Real second-instance '+order+': same HTML opens a distinct conversation, removable attachment and HTTP preview');
    }
    assert.equal(report.secondInstances.length,3);
    fs.writeFileSync(path.join(out,'file-open.png'),(await win.webContents.capturePage()).toPNG());
    report.rendererErrors=await js('errors');assert.deepEqual(report.rendererErrors,[]);report.ok=true;
  }).catch(async error=>{report.error=String(error.stack||error);report.previewCalls=previewCalls;report.views=views.filter(v=>v.webContents&&!v.webContents.isDestroyed()).map(v=>({url:v.webContents.getURL(),title:v.webContents.getTitle(),visible:v.getVisible()}));report.debug=win&&!win.isDestroyed()?await js('({errors:window.errors,notices:window.notices,outputs:window.previewOutputs,html:document.body.innerHTML.slice(-16000)})').catch(()=>null):null;}).finally(async()=>{
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,cases:report.cases,error:report.error,debugErrors:report.debug?.errors,notices:report.debug?.notices}));
    win?.destroy();for(const h of handles.values())h.close();await fixture?.close();app.exit(report.ok?0:1);
  });
}
