'use strict';
// Real Chromium and production dialog handlers, isolated profile. No business service.
const electron=require('electron');
if(typeof electron==='string'){
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-cloud-dialog-'));
  const env={...process.env};
  for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE'])delete env[key];
  const child=require('node:child_process').spawn(electron,[__filename,root],{env,windowsHide:true,stdio:'inherit'});
  const timer=setTimeout(()=>child.kill(),45000);
  child.on('exit',code=>{
    clearTimeout(timer);process.exitCode=code??1;
    if(path.dirname(path.resolve(root))===path.resolve(os.tmpdir())&&path.basename(root).startsWith('soduwork-cloud-dialog-'))fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
}else{
  const {app,BrowserWindow}=electron,fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
  const {pathToFileURL}=require('node:url');
  const root=process.argv[2];
  const out=path.resolve(__dirname,'../../.local/jiyong-cloud-evidence');fs.mkdirSync(out,{recursive:true});
  app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
  let win;
  const report={ok:false,boundary:'Actual Chromium with production dialog/CSS and DOM actions; isolated profile; no model, cloud write or production deployment.'};
  app.whenReady().then(async()=>{
    const asset=file=>pathToFileURL(path.resolve(__dirname,'..',file)).href;
    fs.writeFileSync(path.join(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8">'+
      ['theme/variables.css','theme/cursor.css','components/panels/panels-capabilities.css','components/panels/panels-apps.css'].map(file=>'<link rel="stylesheet" href="'+asset(file)+'">').join('')+
      '<style>*{box-sizing:border-box}body{margin:0;font:14px "Segoe UI",sans-serif;background:var(--bg-0)}</style>'+
      '<script src="'+asset('components/panels/panels-plugin-builder-entry.js')+'"></script>'+ '<script src="'+asset('components/panels/panels-apps.js')+'"></script>');
    win=new BrowserWindow({show:false,width:1100,height:860,webPreferences:{contextIsolation:true,sandbox:true}});
    await win.loadFile(path.join(root,'index.html'));const js=code=>win.webContents.executeJavaScript(code);
    await js('window.opened=[];window.WorkspaceHost={open:(view,payload)=>opened.push({view,payload})};openAppsCreateDialog()');
    assert.equal(await js('document.querySelectorAll("input[name=appsCreateStorage]").length'),2);
    assert.equal(await js('document.querySelectorAll("input[name=appsCreateStorage]:checked").length'),0);
    await js('document.querySelector("[data-create-category]").click()');
    assert.equal(await js('opened.length'),0,'unselected required storage prevents creation');
    for(const location of ['cloud','local']){
      await js('openAppsCreateDialog();document.querySelector("input[value='+location+']").click()');
      assert.equal(await js('document.querySelectorAll("input[name=appsCreateStorage]:checked").length'),1);
      assert.equal(await js('document.querySelectorAll("[data-create-category]:disabled").length'),0);
      if(location==='cloud'){
        await new Promise(resolve=>setTimeout(resolve,100));
        fs.writeFileSync(path.join(out,'create-cloud-wide.png'),(await win.webContents.capturePage({x:0,y:0,width:1100,height:820},{stayHidden:true,stayAwake:true})).toPNG());
      }
      await js('document.querySelector("[data-create-category=office]").click()');
      const opened=await js('opened.at(-1)');assert.equal(opened.view,'create');
      assert.ok(opened.payload.contextPrompts.some(row=>row.includes('"location":"'+location+'"')));
    }
    await js('openAppsCreateDialog()');
    assert.equal(await js('document.querySelectorAll("input[name=appsCreateStorage]:checked").length'),0,'a new creation requires a fresh choice');
    await js('document.getElementById("appsCreateWebTab").click();document.getElementById("appsCreateGo").click()');
    assert.match((await js('opened.at(-1)')).payload.prefill,/网页类/,'external integration remains available');
    win.setContentSize(430,760);await js('openAppsCreateDialog();document.querySelector("input[value=local]").click()');
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'narrow layout does not overflow horizontally');
    assert.equal(await js('document.querySelector(".appsx-create-storage").scrollWidth<=document.querySelector(".appsx-create-storage").clientWidth'),true);
    fs.writeFileSync(path.join(out,'create-local-narrow.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    report.ok=true;report.checks=['required unselected choice','mutually exclusive radios','both storage prompts','fresh choice on reopen','H5 flow preserved','wide and narrow layout'];
  }).catch(error=>{report.error=String(error.stack||error);}).finally(()=>{
    win?.destroy();fs.writeFileSync(path.join(out,'dialog-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    app.exit(report.ok?0:1);
  });
}
