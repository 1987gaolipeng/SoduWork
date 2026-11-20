'use strict';
// Real Chromium/preload IPC, isolated profile, synthetic observations, no Hub/model calls.
const electron=require('electron');
if(typeof electron==='string') {
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const result=require('node:child_process').spawnSync(electron,[__filename],{env,windowsHide:true,stdio:'inherit',timeout:60000});
  process.exit(result.status ?? 1);
}
const {app,BrowserWindow,ipcMain}=electron;
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-diagnostic-electron-'));
app.setPath('userData',path.join(root,'profile'));
process.env.SODUWORK_REQUIREMENT_DIAGNOSTICS_DIR=path.join(root,'records');
app.disableHardwareAcceleration();
require('../main/requirement-diagnostics.cjs').install({app,ipcMain});
app.whenReady().then(async()=>{
  let win;
  try {
    win=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,sandbox:true}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,done)=>done({cancel:true}));
    await win.loadFile(path.resolve(__dirname,'../desk.html'));
    await win.webContents.executeJavaScript(`RequirementDiagnostics.http(RequirementDiagnostics.emit,
      '/tasks/synthetic-task/conversation-delivery',{turnId:'synthetic-turn'},
      {ok:true,submissionMode:'manual',pendingSubmission:true,files:['PRIVATE-FILENAME.md']},200)`);
    const files=fs.readdirSync(process.env.SODUWORK_REQUIREMENT_DIAGNOSTICS_DIR);
    let rows=[];
    for(let i=0;i<100;i++) {
      rows=fs.readFileSync(path.join(process.env.SODUWORK_REQUIREMENT_DIAGNOSTICS_DIR,files[0]),'utf8').trim().split('\n').map(JSON.parse);
      if(rows.some(row=>row.event==='http.result' && row.pendingSubmission))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(rows.some(row=>row.event==='diagnostics.startup' && row.sourceFingerprint));
    assert.ok(rows.some(row=>row.pendingSubmission && row.effectiveMode==='manual' && row.fileCount===1));
    assert.doesNotMatch(JSON.stringify(rows),/PRIVATE-FILENAME|synthetic-task|synthetic-turn/);
    console.log(JSON.stringify({ok:true,checks:['production desk script','production preload IPC','trusted sender','local redacted file'],output:root}));
    win.destroy();app.exit(0);
  } catch(error) {console.error(error.stack);win?.destroy();app.exit(1);}
});
