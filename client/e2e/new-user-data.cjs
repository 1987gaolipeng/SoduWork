'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const evidence=process.argv[2];
if(!evidence||!path.isAbsolute(evidence))throw Error('Absolute evidence directory required');
fs.mkdirSync(evidence,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(evidence,'isolated-profile-')));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const report={ok:false,checks:[],electron:process.versions.electron};let win;
app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({width:1200,height:800,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  const run=s=>win.webContents.executeJavaScript(s,true).catch(error=>{throw Error(error.message+'\nRenderer operation: '+s)});
  await win.loadFile(path.join(__dirname,'fixtures/new-user-data.html'));
  await run('fixtureReady');await wait(120);
  assert.equal(await run('Store.tasks.length'),0);
  assert.equal(await run('document.querySelectorAll(".rq-card").length'),0);
  assert.equal(await run('fixtureCalls.filter(x=>x.method!=="GET").length'),0);
  report.checks.push('fresh user with legacy cached creations: no tasks and no mutations');
  fs.writeFileSync(path.join(evidence,'fresh-actions.png'),(await win.webContents.capturePage()).toPNG());
  await run('document.querySelector("#showRequirements").click()');await wait(120);
  assert.equal(await run('document.querySelectorAll(".rq-card").length'),0);
  fs.writeFileSync(path.join(evidence,'fresh-requirements.png'),(await win.webContents.capturePage()).toPNG());
  assert.ok(await run('(()=>{const a=document.querySelector(".rq-scopes").getBoundingClientRect(),b=document.querySelector(".rq-search").getBoundingClientRect();return a.bottom<=b.top+1||a.right<=b.left+1})()'));
  report.checks.push('requirements page opens with genuine empty state and unobstructed toolbar');
  await run('fixtureTasks=[{id:"shared",title:"团队共享的真实需求",note:"业务需求说明",status:"todo",triageStage:"intake",kind:"requirement",priority:"normal",myRoles:[],canEditRequirement:false,canViewExecution:false,visibility:"organization"}];RequirementsBoard.refresh()');await wait(100);
  assert.equal(await run('document.querySelectorAll(".rq-card").length'),0);
  assert.equal(await run('document.querySelector("[data-rq-scope=actionable]").getAttribute("aria-pressed")'),'true');
  await run('document.querySelector("[data-rq-scope=all]").click()');await wait(100);
  assert.equal(await run('document.querySelectorAll(".rq-card").length'),1);
  report.checks.push('actionable scope excludes unrelated work; all scope retains legitimate company-shared requirements');
  await run('holdTasks=true;void RequirementsBoard.refresh()');await wait(60);
  await run('fixtureIdentity={clientId:"another-install",user:{id:"another-user"}};fixtureTasks=[];SoduWorkAPI.registerClient()');
  assert.equal(await run('document.querySelectorAll(".rq-card").length'),0);
  await run('holdTasks=false;releaseTasks([{id:"stale",title:"不应回填的旧需求",status:"todo",triageStage:"intake"}])');await wait(100);
  assert.equal(await run('document.querySelectorAll(".rq-card").length'),0);
  await run('RequirementsBoard.refresh()');await wait(100);
  assert.equal(await run('document.querySelectorAll(".rq-card").length'),0);
  report.checks.push('identity switch clears cached requirements and ignores late response');
  await run('fixtureTasks=[{id:"assigned",title:"收到同事转办的真实行动项",note:"原始材料说明",status:"todo",myRoles:["assignee"],ownerClientId:"another-install"}];Store.refreshTasks()');
  await run('document.querySelector("#showRequirements").click()');await wait(100);
  assert.equal(await run('document.querySelectorAll(".rq-card").length'),1);
  fs.writeFileSync(path.join(evidence,'assigned-action.png'),(await win.webContents.capturePage()).toPNG());
  report.checks.push('real assignment appears normally after empty first use');
  assert.deepEqual(await run('fixtureErrors'),[]);
  report.ok=true;
 }catch(e){report.error=String(e.stack||e)}
 finally{
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));app.exit(report.ok?0:1);
 }
});
