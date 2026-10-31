'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron,[__filename],{env,windowsHide:true,stdio:'inherit'});
  const timer=setTimeout(()=>child.kill(),45000);
  child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
} else {
  const {app,BrowserWindow,WebContentsView,ipcMain,safeStorage}=electron;
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-market-session-'));
  app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
  const windows=[],servers=[],requests=[],report={ok:false,cases:[],boundary:'Real isolated Electron app preload/SDK and settings store, two loopback origins. Hub fixture rejects legacy device secrets and sends no CORS headers. No business login, model, production writes or user profiles.'};
  let host,origin,hub,session='fixture-session',installed=true,renewals=0;
  const pluginId='market-session-fixture',caps=['settings.read','settings.write'];
  const listen=async handler=>{const server=http.createServer(handler);servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+server.address().port;};
  const js=(wc,code)=>wc.executeJavaScript(code,true);
  const ready=async wc=>{for(let i=0;i<200;i++){if(!wc.isLoading())return;await new Promise(r=>setTimeout(r,20));}throw Error('Page did not load');};
  app.whenReady().then(async()=>{
    origin=await listen((req,res)=>{res.setHeader('Content-Type',req.url==='/sdk.js'?'application/javascript':'text/html');res.end(req.url==='/sdk.js'?fs.readFileSync(path.resolve(__dirname,'../sdk/soduwork-app.js')):'<!doctype html><title>Market app</title><script src="/sdk.js"></script>');});
    const plugin=()=>({pluginId,installed,enabled:true,permissions:{canUse:true},ui:{contributions:[{id:'app',slot:'workspace.navigation',source:{type:'external',url:origin+'/',bridge:{version:1,capabilities:caps}}}]}});
    hub=await listen((req,res)=>{const accepted=req.headers.authorization==='Device '+session;requests.push({accepted,legacy:!!req.headers['soduwork-secret']});res.writeHead(accepted?200:401,{'Content-Type':'application/json'});res.end(JSON.stringify(accepted?{items:[plugin()]}:{detail:'Device session required'}));});
    const identityOf=()=>({hub,clientId:'fixture-device',secret:'fixture-secret'});
    const authenticatedIdentityOf=async()=>{renewals++;return {...identityOf(),session};};
    const denied=await require('../main/app-installed-remote.cjs').get({app,identityOf},pluginId).then(()=>false,error=>error.message.includes('HTTP 401'));
    assert.equal(denied,true);assert.equal(requests.at(-1).legacy,true);
    fs.writeFileSync(path.join(root,'host.html'),'<!doctype html><title>Host</title>');
    fs.writeFileSync(path.join(root,'composer.html'),'<!doctype html><textarea></textarea>');
    require('../main/app-settings-store.cjs').configure({app,safeStorage,ownerOf:()=> 'fixture-account'});
    require('../main/work-preview').install({app,ipcMain,identityOf,authenticatedIdentityOf,
      BrowserWindow:Object.assign(function(options){const win=new BrowserWindow(options);windows.push(win);return win;},{fromWebContents:wc=>BrowserWindow.fromWebContents(wc)}),
      WebContentsView:function(options){const view=new WebContentsView(options),load=view.webContents.loadFile.bind(view.webContents);view.webContents.loadFile=(file,opts)=>load(path.basename(file)==='desk.html'?path.join(root,'composer.html'):file,opts);return view;},shell:{openExternal:async()=>{}}});
    host=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,sandbox:true}});
    await host.loadFile(path.join(root,'host.html'));
    const opened=await js(host.webContents,'soduWorkAPI.workPreview.showDetached('+JSON.stringify({tabId:'market-app',label:'Market app',url:origin+'/',appBridge:{appId:'plugin:'+pluginId,contributionId:'app',origin,version:1,capabilities:caps}})+')');
    assert.equal(opened.ok,true);
    const page=windows[0].contentView.children[1].webContents;await ready(page);
    assert.equal((await js(page,'soduWorkApp.settings.update({values:{ukey:"fixture-app-key"},secretKeys:["ukey"]})')).ok,true);
    assert.equal((await js(page,'soduWorkApp.settings.get({keys:["ukey"],includeSecrets:true})')).values.ukey,'fixture-app-key');
    session='fixture-renewed-session';page.reload();await ready(page);
    assert.equal((await js(page,'soduWorkApp.settings.get({keys:["ukey"],includeSecrets:true})')).values.ukey,'fixture-app-key');
    assert.ok(renewals>=3);assert.ok(requests.slice(1).every(row=>row.accepted&&!row.legacy));
    installed=false;
    assert.equal((await js(page,'soduWorkApp.settings.update({values:{ukey:"denied"}})')).ok,false);
    assert.equal(require('../main/app-settings-store.cjs').get({pluginId,origin},{keys:['ukey'],includeSecrets:true}).values.ukey,'fixture-app-key');
    report.cases.push('Legacy-secret catalog request returns HTTP 401; the production H5/native settings bridge obtains a device session and successfully reads/writes settings across separate origins without CORS headers.');
    report.cases.push('Reload and renewed session retain saved settings; revoked installation still denies writes and preserves prior data.');report.ok=true;
  }).catch(error=>{report.error=String(error.stack||error);}).finally(async()=>{host?.destroy();for(const win of windows)if(!win.isDestroyed())win.destroy();for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}console.log(JSON.stringify(report));app.exit(report.ok?0:1);});
}
