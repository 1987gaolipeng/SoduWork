'use strict';
// Real renderer -> production preload/IPC -> local HTTP -> native Chromium.
// All files, profiles and web services belong to this fixture.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron,[__filename],{env,windowsHide:true,stdio:'inherit'});
  const timer=setTimeout(()=>{child.kill();process.exitCode=1;},60000);
  child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
} else {
  const {app,BrowserWindow,WebContentsView,ipcMain}=electron;
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
  const {pathToFileURL}=require('node:url');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-delivery-workbench-'));
  const out=path.resolve(__dirname,'../../outputs/delivery-workbench-20261014');fs.mkdirSync(out,{recursive:true});
  app.setPath('userData',path.join(root,'profile'));app.on('window-all-closed',()=>{});
  const cwd=path.join(root,'work');fs.mkdirSync(cwd);
  for(const [name,content] of Object.entries({
    'demo.html':'<!doctype html><title>Standalone result</title><link rel="stylesheet" href="style.css"><h1>静态网页成果</h1><script src="app.js"></script>',
    'style.css':'h1{color:rgb(20,90,70)}', 'app.js':'document.body.dataset.ready="yes";',
    'report.md':'# Standalone report\n\nUsable content, not a diff.',
    'source.html':'<!doctype html><h1>Source file</h1>'
  })) fs.writeFileSync(path.join(cwd,name),content);
  fs.mkdirSync(path.join(cwd,'.soduwork'));fs.writeFileSync(path.join(cwd,'.soduwork/delivery.json'),JSON.stringify({schemaVersion:1,deliverables:[{path:'demo.html'},{path:'report.md'}]}));
  const outputs=require('../main/pi-session/outputs'),runtime=require('../main/conversation/artifact-runtime');
  const handle={cwd,sessionId:'fixture',snapshot:()=>({status:'idle'}),outputSnapshot:()=>outputs.scan(cwd,0,1)};
  require('../main/agent-runtime/pi-session-bridge').get=ref=>ref==='fixture'?handle:null;
  const views=[],report={ok:false,cases:[],errors:[]};let win,server;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const js=code=>win.webContents.executeJavaScript(code,true);
  async function until(fn,label){for(let i=0;i<160;i++){if(await fn())return;await sleep(40);}throw Error('Timed out: '+label);}
  const active=()=>views.filter(v=>!v.webContents.isDestroyed()).at(-1)?.webContents;
  app.whenReady().then(async()=>{
    require('../main/pi-session/artifact-ipc').install({app,ipcMain,BrowserWindow,session:{get:ref=>ref==='fixture'?handle:null},workDir:()=>root});
    require('../main/work-preview').install({ipcMain,BrowserWindow,
      WebContentsView:function(options){const view=new WebContentsView(options);views.push(view);return view;},
      shell:{openExternal:async()=>{throw Error('No external navigation');}}});
    server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><title>Running application</title><h1>运行中的应用</h1><button onclick="this.textContent=\'已交互\'">测试交互</button>');});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
    const client=path.resolve(__dirname,'..');const href=file=>pathToFileURL(path.join(client,file)).href;
    const css=['theme/variables.css','components/panels/panels-chat.css','components/panels/code-workbench.css'];
    const scripts=['components/panels/chat-output-links.js','components/panels/chat-dom-patch.js', 'components/panels/panels-chat-tools.js','components/panels/chat-workspace-info.js','components/panels/chat-workspace-split.js','components/panels/chat-workspace-controls.js', 'components/panels/panels-chat-workspace.js'];
    const fixture=path.join(root,'host.html');
    fs.writeFileSync(fixture,'<!doctype html><meta charset="utf-8">'+css.map(f=>'<link rel="stylesheet" href="'+href(f)+'">').join('')+
      '<style>body{margin:0;font-family:Segoe UI,sans-serif}.nchat{height:100vh}.nchat-stage{height:100%;display:flex}.nchat-main{flex:1;min-width:0;padding:20px}</style><main class="nchat" id="chat"><div class="nchat-stage"><section class="nchat-main">成果预览测试</section></div></main>'+scripts.map(f=>'<script src="'+href(f)+'"></script>').join(''));
    win=new BrowserWindow({show:false,width:1280,height:860,webPreferences:{preload:path.join(client,'preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    win.webContents.on('console-message',(_e,level,msg)=>{if(level>=3)report.errors.push(msg);});
    await win.loadFile(fixture);
    const files=runtime.decorate('fixture',{items:runtime.snapshot(handle).items});
    const web=files.find(f=>f.name==='demo.html');assert.ok(web);
    // The shared workspace index includes historical files; auto-preview requires
    // a real current-turn delivery, as the production conversation provides.
    await js(`window.files=${JSON.stringify(files)};window.currentRef='fixture';window.errors=[];addEventListener('error',e=>errors.push(e.message));ChatWorkbench.bind(chat,()=>({ref:currentRef,cwd:${JSON.stringify(cwd)}}));ChatWorkbench.render(chat,{messages:[{role:'user',text:'Create the demo'},{role:'assistant',blocks:[{kind:'text',text:'[Open demo](demo.html)'}]}]},files);void 0;`);
    await until(()=>active()?.getTitle()==='Standalone result','standalone HTML in native browser');
    assert.match(active().getURL(),/^http:\/\/127\.0\.0\.1:\d+\/demo\.html/);
    const content=await active().executeJavaScript('({ready:document.body.dataset.ready,color:getComputedStyle(document.querySelector("h1")).color})');
    assert.equal(content.ready,'yes');assert.equal(content.color,'rgb(20, 90, 70)');
    assert.equal(await js('Boolean(document.querySelector(".CodeMirror"))'),false);
    report.cases.push('Standalone HTML opens via local HTTP in native right browser; CSS/JS actually load');
    await js(`window.snapshot={messages:[{role:'user',text:'Run the app'}],tools:[{id:'live',name:'bash',state:'running',after:0,args:{command:'npm run dev'},partial:'Local: ${url}/'}]};ChatWorkbench.render(chat,snapshot,files);void 0;`);
    await until(()=>active()?.getTitle()==='Running application','live app priority');
    assert.equal(active().getURL(),url+'/');await active().executeJavaScript('document.querySelector("button").click()');
    assert.equal(await active().executeJavaScript('document.querySelector("button").textContent'),'已交互');
    report.cases.push('Running app takes priority over static HTML; real page interaction works');
    await js(`ChatWorkbench.openOutput(${JSON.stringify(web.artifactId)});void 0;`);
    await until(()=>views.some(v=>!v.webContents.isDestroyed()&&v.webContents.getTitle()==='Standalone result'),'manual file preview');
    const manual=await js('document.querySelector("[data-wb-tab][aria-selected=true]")?.dataset.wbTab');
    await js('files=files.map(f=>({...f,at:f.at+1}));ChatWorkbench.render(chat,{...snapshot,tools:[{...snapshot.tools[0],id:"live-next"}]},files);void 0;');
    assert.equal(await js('document.querySelector("[data-wb-tab][aria-selected=true]")?.dataset.wbTab'),manual);
    report.cases.push('Background file/service updates preserve the tab explicitly chosen by the user');
    await js('document.querySelector("[data-wb-close]").click();ChatWorkbench.render(chat,{...snapshot,tools:[{...snapshot.tools[0],id:"third"}]},files.map(f=>({...f,at:f.at+2})));void 0;');
    assert.equal(await js('ChatWorkbench.state().open'),false);
    report.cases.push('Closing the right panel is respected during later background updates');
    await js(`window.pendingFile={artifactId:'pending-cloud',taskId:'cloud-task',attachmentId:'remote-html',cloudPending:true,kind:'website',name:'remote.html',primary:true};files.push(pendingFile);ChatWorkbench.render(chat,snapshot,files);window.originalMaterialize=ChatOutputLinks.materialize;ChatOutputLinks.materialize=()=>new Promise(r=>window.finishCloud=r);ChatWorkbench.openOutput('pending-cloud');ChatWorkbench.openLink('${url}/manual');void 0;`);
    const userTab=await js('document.querySelector("[data-wb-tab][aria-selected=true]")?.dataset.wbTab');
    await js(`finishCloud(files.find(f=>f.artifactId===${JSON.stringify(web.artifactId)}));void 0;`);await sleep(120);
    assert.equal(await js('document.querySelector("[data-wb-tab][aria-selected=true]")?.dataset.wbTab'),userTab);
    await js('ChatOutputLinks.materialize=originalMaterialize;void 0;');
    report.cases.push('A late cloud download cannot take focus away from the page selected while it was loading');
    await js(`ChatWorkbench.openOutput(${JSON.stringify(web.artifactId)});void 0;`);await sleep(160);
    fs.writeFileSync(path.join(out,'preview.png'),(await win.webContents.capturePage()).toPNG());
    assert.deepEqual(await js('errors'),[]);assert.deepEqual(report.errors,[]);report.ok=true;
  }).catch(async error=>{report.error=String(error.stack||error);report.debug=win&&!win.isDestroyed()?await js('({state:ChatWorkbench.state(),files,html:document.querySelector(".ncw")?.outerHTML,errors})').catch(()=>null):null;report.views=views.filter(v=>!v.webContents.isDestroyed()).map(v=>({url:v.webContents.getURL(),title:v.webContents.getTitle()}));}).finally(()=>{
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    win?.destroy();server?.close();runtime.dispose?.();app.exit(report.ok?0:1);
  });
}
