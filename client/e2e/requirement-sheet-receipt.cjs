'use strict';




const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 120000);
  child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
const{app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw Error('Absolute evidence directory required');
fs.mkdirSync(root,{recursive:true});app.setPath('userData',path.join(root,'sheet-receipt-profile'));
const report={ok:false,isolated:true,backend:'controlled fixture; no requirement was created in a live store',scenarios:[]};let win;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({width:1100,height:860,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_request,callback)=>callback({cancel:true}));
  const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
  await win.loadFile(path.join(__dirname,'fixtures/requirement-sheet-receipt.html'));
  const evaluate=s=>win.webContents.executeJavaScript(s,true).catch(e=>{console.error('FAILED SCRIPT >>>',s.slice(0,300));throw e;});
  for(const mode of ['self','human']){
  const scenario={name:(mode==='human'?'真人交办':'自己承办')+' · 已创建回执 · 查看详情',steps:[]};
  report.scenarios.push(scenario);
  await evaluate('openSheet('+JSON.stringify(mode)+')');
  for(let i=0;i<100;i++){if(await evaluate('Boolean(document.querySelector("#wesTaskDraft #cpTitle"))'))break;await wait(50);}
  const opened=await evaluate('(()=>{const l=document.querySelector(".pui-layer[data-plugin-surface=work-entry]");return{l:!!l,zi:l?getComputedStyle(l).zIndex:null,title:document.querySelector("#wesTaskDraft #cpTitle")?.value||""}})()');
  assert.ok(opened.l,'sheet must mount as a pui-layer surface');
  assert.equal(opened.title,'制作一个乡村音乐网页');
  scenario.steps.push({step:'抽屉打开',layer:opened.l,layerZ:opened.zi});
  await evaluate('document.querySelector("#wesTaskDraft #cpCreate").click();document.querySelector("#wesTaskDraft #cpCreate").click()');
  let receipt;
  const receiptSelector=mode==='self'?'.wes-result-dialog[open]':'#wesTaskDraft';
  const buttonSelector=mode==='self'?'.wes-result-dialog[open] .wes-result-secondary':'#wesTaskDraft #cpOpen';
  for(let i=0;i<100;i++){receipt=await evaluate('({text:document.querySelector('+JSON.stringify(receiptSelector)+')?.textContent||"",calls})');if(receipt.text.includes('已创建'))break;await wait(50);}
  assert.match(receipt.text,/已创建/);
  assert.equal(receipt.calls.created.length,1,'double click must not duplicate task');
  assert.equal(receipt.calls.persisted.length,mode==='human'?0:1);
  assert.equal(receipt.calls.assigned.length,mode==='human'?1:0);
  if(mode==='human')assert.match(receipt.text,/已交给 示例成员/);
  if(mode==='self')assert.equal(await evaluate('Boolean(document.querySelector("#workEntryLayer"))'),false,'save-only creation closes the form before showing its success dialog');
  await evaluate('document.querySelector('+JSON.stringify(buttonSelector)+').scrollIntoView({block:"center"})');await wait(180);
  const btn=await evaluate('(()=>{const b=document.querySelector('+JSON.stringify(buttonSelector)+');const r=b.getBoundingClientRect();const point={label:b.textContent.trim(),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};if(!b.contains(document.elementFromPoint(point.x,point.y)))throw Error("Receipt button is covered");return point})()');
  assert.equal(btn.label,'查看详情');
  scenario.steps.push({step:'回执出现',creations:receipt.calls.created.length,button:btn.label});
  /* Ensure the drawer no longer intercepts clicks over the opened details. */
  for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:btn.x,y:btn.y,button:'left',clickCount:1});
  await wait(120);
  const after=await evaluate('(()=>{const sheet=document.querySelector(".pui-layer[data-plugin-surface=work-entry]");const layer=document.getElementById("workEntryLayer");const back=document.querySelector(".rq-detail-backdrop");const title=document.getElementById("rqDetailTitle");const hit=document.elementFromPoint('+btn.x+','+btn.y+');return{sheetGone:!sheet,layerGone:!layer,detail:!!back,hitInsideDetail:Boolean(hit&&hit.closest(".rq-detail-backdrop")),hitTag:hit?hit.tagName:null,title:title?title.textContent:"",details:calls.details.length}})()');
  scenario.after=after;
  assert.ok(after.sheetGone,mode+': entry sheet must close itself before the detail opens');
  assert.ok(after.layerGone,'pui-layer host must be destroyed');
  assert.equal(await evaluate('Boolean(document.querySelector(".wes-result-dialog"))'),false,'the success dialog closes before opening the detail');
  assert.ok(after.detail,'requirement detail must open');
  assert.ok(after.hitInsideDetail,'detail must be the topmost surface at the receipt button point (was hidden under pui-layer before the fix)');
  assert.equal(after.title,'制作一个乡村音乐网页');
  assert.equal(after.details,1);
  scenario.steps.push({step:'查看详情',sheetGone:after.sheetGone,detailOpened:after.detail,hitTest:after.hitTag+'@backdrop',detailTitle:after.title});
  const screenshot=path.join(root,'sheet-receipt-'+mode+'-detail.png');
  fs.writeFileSync(screenshot,(await win.webContents.capturePage()).toPNG());
  scenario.screenshot=screenshot;scenario.success=true;
  }
  report.rendererErrors=errors;assert.deepEqual(errors,[]);report.ok=true;
 }catch(error){report.error=String(error.stack||error)}
 finally{fs.writeFileSync(path.join(root,'sheet-receipt-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1)}
});
}
