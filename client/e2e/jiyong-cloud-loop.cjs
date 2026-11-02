'use strict';
// Page -> real preload/IPC -> real HTTP/device auth -> PostgreSQL -> page.
// Each phase is a fresh Electron process/profile, not a cache masquerading as another device.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const electron=require('electron'),accountsFile=process.argv[2];
if(typeof electron==='string'){
  const root=path.dirname(accountsFile),phases=['write','second-device','other-account','reopen-upgraded'];
  for(const phase of phases){
    const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE','NODE_TEST_CONTEXT'])delete env[key];
    const result=require('node:child_process').spawnSync(electron,[__filename,accountsFile,phase],{env,windowsHide:true,encoding:'utf8',timeout:90000});
    const reportFile=path.join(root,phase+'.json');
    const report=fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile,'utf8')):null;
    if(result.status!==0||result.error)throw Error(phase+' failed: '+String(report?.error||result.error||result.stderr||result.stdout));
    assert.equal(report?.ok,true,JSON.stringify(report));
    console.log(JSON.stringify(report));
  }
}else{
  const {app,BrowserWindow,WebContentsView,ipcMain}=electron,phase=process.argv[3],root=path.dirname(accountsFile);
  const accounts=JSON.parse(fs.readFileSync(accountsFile,'utf8')),identity=accounts[phase==='other-account'?'other':phase==='second-device'?'a2':'a1'];
  app.setPath('userData',path.join(root,'native-profiles',phase));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
  let host,content;const windows=[],report={ok:false,phase,checks:[],boundary:'Real isolated Electron/HTTP/device session/PostgreSQL; no production account or model.'};
  const personal=require('../main/personal-plugins'),store=require('../main/app-settings-store.cjs');
  const sdk=fs.readFileSync(path.resolve(__dirname,'../sdk/soduwork-app.js'));
  const initial={schemaVersion:1,migrations:[{version:1,seed:[{collection:'notes',id:'welcome',value:{title:'Example',status:'example'}}]}]};
  const html='<!doctype html><meta charset="utf-8"><title>Cloud notes</title><input id="title"><button id="save">Save</button><p id="status"></p><div id="rows"></div><script src="soduwork-app.js"></script><script src="app.js"></script>';
  const script=`async function reload(){const p=await soduWorkApp.data.list({collection:'notes',limit:100});if(!p.ok)throw Error(p.reason);window.rows=p.items;document.getElementById('rows').textContent=p.items.map(x=>x.id+':'+x.value.title).join(' | ');document.getElementById('status').textContent='ready';}document.getElementById('save').onclick=async()=>{try{const r=await soduWorkApp.data.get({collection:'notes',id:'note_user'});if(!r.ok)throw Error(r.reason);const saved=await soduWorkApp.data.batch({collection:'notes',operations:[{id:'note_user',expectedRevision:r.revision,value:{title:document.getElementById('title').value,status:'open'}}]});if(!saved.ok)throw Error(saved.reason);await reload();}catch(e){document.getElementById('status').textContent=e.message;}};reload().catch(e=>document.getElementById('status').textContent=e.message);`;
  function body(upgraded=false){
    const initialization=structuredClone(initial);
    if(upgraded)initialization.migrations.push({version:2,seed:[{collection:'notes',id:'upgrade_sample',value:{title:'Upgrade',status:'example'}}]});
    return {template:'app',key:'cloud-loop-notes',name:'Cloud notes',author:'SoduWork test',version:upgraded?'0.2.0':'0.1.0',description:'Isolated cloud loop',instructions:'Read/write the authorized data tools and verify stored results.',
      jiyong:{version:1,storage:{location:'cloud'},parameters:[],collections:[{key:'notes',indexes:['status']}],initialization:{script:'assets/data-init.json'},mcp:{server:'soduwork-jiyong',bindings:[]}},
      mcpServers:['soduwork-jiyong'],entrypoints:{automation:true},
      ui:{contributions:[{id:'main',title:'Notes',slot:'workspace.navigation',source:{type:'package',entry:'ui/index.html',bridge:{version:1,capabilities:['data.read','data.write','mcp.connect']}}}]},
      resources:[['ui/index.html','ui',html],['ui/app.js','ui',script],['ui/soduwork-app.js','ui',sdk],['assets/data-init.json','asset',JSON.stringify(initialization)]].map(([file,kind,bytes])=>({path:file,kind,encoding:'base64',content:Buffer.from(bytes).toString('base64')}))};
  }
  const js=(wc,code)=>wc.executeJavaScript(code),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(check,label){for(let n=0;n<150;n++){if(await check())return;await pause(40);}throw Error('Timeout: '+label);}
  async function install(candidate){
    const result=await js(host.webContents,'soduWorkAPI.personalPlugins.create('+JSON.stringify(candidate)+')');
    assert.equal(result.ok,true,result.reason||'cloud installation failed');assert.equal(result.initialization.state,'ready');
    report.checks.push('real install and cloud initialization '+candidate.version);return result.plugin;
  }
  async function open(installed){
    content=null;
    const result=await js(host.webContents,'soduWorkAPI.workPreview.showDetached('+JSON.stringify({tabId:'cloud-'+Date.now(),label:'Cloud notes',package:{pluginId:installed.pluginId,contributionId:'main'}})+')');
    assert.equal(result.ok,true,JSON.stringify(result));assert.ok(content);
    await until(()=>js(content,'document.getElementById("status")?.textContent==="ready"'),'cloud page readback');
  }
  function closePages(){for(const win of windows)if(!win.isDestroyed())win.destroy();}
  app.whenReady().then(async()=>{
    store.configure({app,safeStorage:electron.safeStorage,ownerOf:()=>identity.hub+'/'+identity.userId});
    const deps={app,ipcMain,dialog:{},safeStorage:electron.safeStorage,identityOf:async()=>identity,authenticatedIdentityOf:async()=>identity};
    personal.install(deps);
    require('../main/work-preview').install({...deps,
      BrowserWindow:Object.assign(function(options){const win=new BrowserWindow({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}});win.show=()=>{};windows.push(win);return win;},{fromWebContents:wc=>BrowserWindow.fromWebContents(wc)}),
      WebContentsView:function(options){const view=new WebContentsView({...options,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}});if(path.basename(options.webPreferences?.preload||'')==='work-preview-app-preload.cjs')content=view.webContents;const load=view.webContents.loadFile.bind(view.webContents);view.webContents.loadFile=(file,opts)=>load(path.basename(file)==='desk.html'?path.join(root,'composer.html'):file,opts);return view;},
      shell:{openExternal:async()=>{throw Error('Unexpected external navigation');}}});
    fs.writeFileSync(path.join(root,'host-'+phase+'.html'),'<!doctype html><title>Cloud loop host</title>');fs.writeFileSync(path.join(root,'composer.html'),'<!doctype html><p>Isolated composer; no model calls</p>');
    host=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,sandbox:true}});
    await host.loadFile(path.join(root,'host-'+phase+'.html'));
    let installed=await install(body(phase==='reopen-upgraded'));
    await open(installed);
    if(phase==='write'){
      await js(content,'document.getElementById("title").value="云端真实闭环";document.getElementById("save").click()');
      await until(()=>js(content,'window.rows?.some(r=>r.id==="note_user"&&r.value.title==="云端真实闭环")'),'business write and page readback');
      const asset=await js(content,'soduWorkApp.data.assetPut({name:"e2e.svg",type:"image/svg+xml",data:new TextEncoder().encode("<svg/>")})');assert.equal(asset.ok,true);
      assert.equal((await js(content,'soduWorkApp.data.batch('+JSON.stringify({collection:'notes',operations:[{id:'asset_ref',expectedRevision:0,value:{title:'Asset',assetId:asset.asset.id}}]})+')')).ok,true);
      closePages();
      const connection=require('../main/jiyong-hosted-connection.cjs').context(app,installed.pluginId).connection;
      const reply=await connection.invoke({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'data_batch',arguments:{collection:'notes',operations:[{id:'after_close',expectedRevision:0,value:{title:'Headless write',status:'open'}}]}}});
      assert.equal(reply.result.isError,undefined,JSON.stringify(reply));
      report.checks.push('page SDK -> native IPC -> authenticated HTTP -> PostgreSQL -> page','asset put','headless MCP writes after window close');
    }else if(phase==='other-account'){
      const rows=await js(content,'window.rows');assert.equal(rows.length,1);assert.equal(rows[0].id,'welcome');
      const denied=await fetch(identity.hub+'/api/v1/jiyong/status',{headers:{Authorization:'Device invalid-fixture-session'}});assert.equal(denied.status,401);
      report.checks.push('other account has separate database','invalid device session rejected by real auth dependency');
    }else{
      const rows=await js(content,'window.rows');assert.ok(rows.some(r=>r.id==='note_user'&&r.value.title==='云端真实闭环'));assert.ok(rows.some(r=>r.id==='after_close'));
      const ref=rows.find(r=>r.id==='asset_ref'),asset=await js(content,'soduWorkApp.data.assetGet('+JSON.stringify({id:ref.value.assetId})+').then(r=>{if(!r.ok)throw Error(r.reason);return new TextDecoder().decode(r.data)})');assert.equal(asset,'<svg/>');
      report.checks.push('fresh process/profile reads same account cloud data','cloud asset hash and readback');
      if(phase==='second-device'){
        closePages();installed=await install(body(true));await open(installed);
        const upgraded=await js(content,'window.rows');assert.ok(upgraded.some(r=>r.id==='upgrade_sample'));assert.ok(upgraded.some(r=>r.id==='note_user'&&r.value.title==='云端真实闭环'));
        report.checks.push('append migration upgrade preserves user data');
      }else assert.ok(rows.some(r=>r.id==='upgrade_sample'));
    }
    assert.equal(fs.existsSync(path.join(app.getPath('userData'),'jiyong-data')),false,'no local SQLite fallback');
    report.checks.push('no local business database created');report.ok=true;
  }).catch(error=>{report.error=String(error.stack||error);}).finally(async()=>{
    closePages();host?.destroy();await require('../main/jiyong-data.cjs').close();
    fs.writeFileSync(path.join(root,phase+'.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);
  });
}
