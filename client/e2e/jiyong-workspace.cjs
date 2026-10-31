'use strict';
const electron=require('electron'), fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(typeof electron==='string') {
  const root=path.resolve(path.join(process.env.SODUWORK_JIYONG_EVIDENCE || require('node:os').tmpdir(),'soduwork-jiyong-native-'+Date.now()));fs.mkdirSync(root,{recursive:true});
  const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE'])delete env[key];
  const r=require('node:child_process').spawnSync(electron,[__filename,root],{env,windowsHide:true,encoding:'utf8',timeout:90000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)console.error(r.error);process.exit(r.status|| (r.error?1:0));
} else {
  const {app,BrowserWindow,WebContentsView,ipcMain}=electron,root=process.argv[2],windows=[];
  app.on('web-contents-created',(_e,wc)=>wc.on('console-message',(_e,...args)=>{console.log('PAGE',...args);}));
  app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
  const personal=require('../main/personal-plugins'),data=require('../main/jiyong-data.cjs'),report={ok:false,scope:'Real Electron windows and SQLite workers; isolated account; no paid model or actual scheduled task.'};
  let host;const js=(wc,code)=>wc.executeJavaScript(code);
  async function until(check){for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,30));}throw Error('native page not ready');}
  app.whenReady().then(async()=>{
    require('../main/app-settings-store.cjs').configure({app,safeStorage:electron.safeStorage,ownerOf:()=> 'fixture/account'});
    const examples=await require('../scripts/create-jiyong-examples.cjs').create({out:path.join(root,'source'),profile:app.getPath('userData')});
    const base=personal.get(app,examples[0].pluginId).localDraft;
    const installed=examples.map(e=>personal.get(app,e.pluginId));
    for(let n=2;n<4;n++)installed.push(personal.create(app,{...base,key:'jiyong-perf-'+n,name:'多窗口验证 '+n}).plugin);
    fs.writeFileSync(path.join(root,'host.html'),'<!doctype html><title>Native fixture</title>');
    fs.writeFileSync(path.join(root,'composer.html'),'<!doctype html><textarea></textarea><script>window.received=[];</script>');
    require('../main/work-preview').install({app,ipcMain,BrowserWindow:Object.assign(function(o){const w=new BrowserWindow(o);windows.push(w);return w;},{fromWebContents:wc=>BrowserWindow.fromWebContents(wc)}),WebContentsView:function(o){const v=new WebContentsView(o),load=v.webContents.loadFile.bind(v.webContents);v.webContents.loadFile=(f,o)=>load(path.basename(f)==='desk.html'?path.join(root,'composer.html'):f,o);return v;},shell:{openExternal:async()=>{throw Error('Unexpected navigation');}}});
    host=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,sandbox:true}});await host.loadFile(path.join(root,'host.html'));
    const source=fs.readFileSync(path.resolve(__dirname,'../components/panels/panels-capabilities.js'),'utf8').replace(/\r\n/g,'\n');const start=source.indexOf('tryPlugin: async function (item) {')+'tryPlugin: '.length,end=source.indexOf('\n      },\n    };',start)+'\n      }'.length,trial=source.slice(start,end);
    await js(host.webContents,fs.readFileSync(path.resolve(__dirname,'../components/panels/plugin-ui-host.js'),'utf8'));
    await js(host.webContents,'soduWorkAPI.workPreviewAppHost.onRequest(r=>soduWorkAPI.workPreviewAppHost.respond(r.id,{ok:true,appId:r.appId}));void 0');
    const pages=[],started=Date.now();
    for(const p of installed){const r=await js(host.webContents,'(async()=>{const closeModal=()=>{};return ('+trial+')('+JSON.stringify(p)+')})()');assert.equal(r.detached,true);const w=windows.at(-1),wc=w.contentView.children[1].webContents;await until(()=>js(wc,'document.getElementById("status")?.textContent.startsWith("已读取")')).catch(async e=>{throw Error(e.message+': '+await js(wc,'document.body.innerText'))});pages.push({w,wc});}
    report.openFourMs=Date.now()-started;report.workersOpen=data.diagnostics();report.processesOpen=app.getAppMetrics().map(p=>({type:p.type,workingSetKB:p.memory.workingSetSize}));
    await js(pages[0].wc,'document.getElementById("text").value="窗口关闭后仍可跨即用读取";document.getElementById("new").requestSubmit()');
    await until(()=>js(pages[0].wc,'document.querySelectorAll(".note").length===1'));
    const shared=await js(pages[1].wc,'soduWorkApp.data.list({appId:'+JSON.stringify(installed[0].pluginId)+',collection:"notes"})');assert.equal(shared.items[0].value.title,'窗口关闭后仍可跨即用读取');
    await js(pages[0].wc,'document.getElementById("settings").click()');await until(()=>js(pages[0].wc,'document.getElementById("preferences").open'));
    await js(pages[0].wc,'document.getElementById("nickname").value="原生验收";document.getElementById("appearance").value="dark";document.getElementById("save-settings").click()');await until(()=>js(pages[0].wc,'!document.getElementById("preferences").open'));
    assert.equal((await js(pages[0].wc,'soduWorkApp.settings.get()')).values.nickname,'原生验收');
    // Capture only after the updated view paints; Chromium can transiently
    // reject an occluded view with UnknownVizError under concurrent workloads.
    pages[0].w.show();pages[0].w.focus();pages[0].wc.invalidate();
    report.captureState={visible:pages[0].w.isVisible(),minimized:pages[0].w.isMinimized(),bounds:pages[0].w.getBounds(),view:pages[0].w.contentView.children[1].getBounds()};
    await new Promise(r=>setTimeout(r,150));
    let shot;
    for(let attempt=0;attempt<3;attempt++) {
      try {shot=await pages[0].wc.capturePage();break;}
      catch(error) {if(attempt===2 || !String(error.message).includes('UnknownVizError'))throw error;await new Promise(r=>setTimeout(r,100));}
    }
    assert.ok(!shot.isEmpty(),'native screenshot contains pixels');
    fs.writeFileSync(path.join(root,'notes-dark.png'),shot.toPNG());
    const latencies=[];for(let n=0;n<30;n++){const start=performance.now();const r=await js(pages[1].wc,'soduWorkApp.data.get({appId:'+JSON.stringify(installed[0].pluginId)+',collection:"notes",id:'+JSON.stringify(shared.items[0].id)+'})');assert.ok(r.item);latencies.push(performance.now()-start);}latencies.sort((a,b)=>a-b);report.readRoundTripMs={p50:latencies[15],p95:latencies[28]};
    for(const p of pages)p.w.destroy();
    const background=require('../main/app-conversation-connection.cjs').context(app,installed[0].pluginId).connection;
    const reply=await background.invoke({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'data_list',arguments:{collection:'notes'}}});assert.equal(JSON.parse(reply.result.content[0].text).items.length,1);
    await new Promise(r=>setTimeout(r,31500));report.workersAfterClose=data.diagnostics();assert.equal(report.workersAfterClose.activeWorkers,0);
    report.processesAfterClose=app.getAppMetrics().map(p=>({type:p.type,workingSetKB:p.memory.workingSetSize}));
    const current=await require('../main/jiyong-data-access.cjs').request({app},{pluginId:installed[0].pluginId,origin:require('../core/plugin-package-page.cjs').origin(installed[0].pluginId)},installed[0],'data.list',{collection:'notes'});assert.equal(current.items.length,1);
    report.ok=true;report.checks=['four actual app windows','real form save','cross-app SDK read','custom settings persisted','headless MCP after all windows close','idle worker release','reopen SQLite without data loss'];
  }).catch(e=>report.error=String(e.stack||e)).finally(async()=>{await data.close();host?.destroy();for(const w of windows)if(!w.isDestroyed())w.destroy();fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);});
}
