'use strict';
// Exercise real production DOM, native clicks and CSS in an isolated Electron profile.
const electron=require('electron');
if(typeof electron==='string'){
  const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE'])delete env[key];
  const result=require('node:child_process').spawnSync(electron,[__filename,'--force-device-scale-factor=1'],{env,windowsHide:true,stdio:'inherit',timeout:120000});process.exit(result.status??1);
}
const {app,BrowserWindow}=electron,fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const client=path.resolve(__dirname,'..'),output=path.resolve(process.env.SODUWORK_DELIVERY_REVIEW_OUTPUT || path.join(client,'../outputs/delivery-review-20261031/ui'));fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-delivery-review-')));app.disableHardwareAcceleration();
const report={ok:false,checks:[],boundary:'Isolated Electron with production components; no installed-client configuration or model calls'};
let win;
app.whenReady().then(async()=>{try{
  win=new BrowserWindow({show:false,width:1200,height:960,webPreferences:{sandbox:true,contextIsolation:true,offscreen:true}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_r,done)=>done({cancel:true}));
  const js=source=>win.webContents.executeJavaScript(source,true);
  const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
  const click=async selector=>{const point=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});await pause();};
  const disclosure=selector=>js(`(()=>{const d=document.querySelector(${JSON.stringify(selector)}),s=d.querySelector('summary'),b=s.getBoundingClientRect(),r=d.getBoundingClientRect();
    const rows=[...d.querySelectorAll('li,.noutput-library-row')],visible=rows.filter(n=>n.checkVisibility());
    return {open:d.open,label:s.innerText.trim(),centerOffset:Math.abs(b.x+b.width/2-r.x-r.width/2),
      belowFiles:visible.every(n=>b.top>=n.getBoundingClientRect().bottom),visible:visible.length}})()`);
  await win.loadFile(path.join(__dirname,'fixtures/requirements-board.html'));
  const styles=[...fs.readFileSync(path.join(client,'desk.html'),'utf8').matchAll(/<link\b[^>]*href="([^"]+\.css)"/g)].map(m=>m[1]);
  await js(`Promise.all(${JSON.stringify(styles.map(p=>pathToFileURL(path.join(client,p)).href))}.map(href=>new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=link.onerror=resolve;document.head.append(link)})))`);
  for(const file of ['components/panels/chat-deliveries.js','components/panels/chat-output-links.js','components/panels/library-transfer.js','components/panels/chat-acceptance-results.js'])await js(fs.readFileSync(path.join(client,file),'utf8'));
  await js(`window.uiErrors=[];addEventListener('error',e=>uiErrors.push(e.message));document.body.innerHTML='<main class="nchat" style="width:780px;margin:24px auto"><div id="fixture"></div></main>';
    window.files=Array.from({length:5},(_,i)=>({artifactId:'art'+i,name:'deliverable-'+i+'.md',relative:'deliverable-'+i+'.md',primary:true,changedInTurn:true,kind:'document',size:120}));
    window.snapshot={status:'idle'};window.paint=()=>{document.querySelector('#fixture').innerHTML=ChatOutputLinks.decorate('<div class="nmsg ai" data-delivery-current="true" data-delivery-final="true" data-chat-node="message:1"><div class="nmd">完成交付</div></div>',files,'chat',snapshot)};paint();void 0;`);
  assert.equal(await js(`document.querySelectorAll('[data-delivery-file-list]>ul>li').length`),3);
  assert.equal(await js(`document.querySelector('.ndelivery-more').open`),false);
  assert.equal(await js(`document.querySelectorAll('.ndelivery-more li').length`),2);
  assert.ok((await js(`document.querySelector('[data-delivery-title]').textContent`)).endsWith('.zip'));
  assert.equal((await disclosure('.ndelivery-more')).label,'更多');
  assert.ok((await disclosure('.ndelivery-more')).centerOffset<2);
  await click('.ndelivery-more>summary');
  assert.deepEqual(await disclosure('.ndelivery-more'),{open:true,label:'收起',centerOffset:0,belowFiles:true,visible:2});
  await js(`ChatDeliveries.decorate(document.querySelector('#fixture'),files,'chat',snapshot);void 0;`);
  assert.equal((await disclosure('.ndelivery-more')).open,true,'Refreshing the same delivery preserves expansion');
  fs.writeFileSync(path.join(output,'delivery-files-expanded.png'),(await win.webContents.capturePage()).toPNG());
  await click('.ndelivery-more>summary');
  assert.equal((await disclosure('.ndelivery-more')).visible,0);
  assert.equal((await disclosure('.ndelivery-more')).label,'更多');
  fs.writeFileSync(path.join(output,'delivery-files.png'),(await win.webContents.capturePage()).toPNG());
  report.checks.push('Multi-file delivery shows an archive and exactly three loose files; native click expands and collapses the remaining two');
  const literalName = '<img src=x onerror="window.fileNameExecuted=true">.md';
  await js(`files=files.map((f,i)=>i===0?{...f,name:${JSON.stringify(literalName)},relative:${JSON.stringify(literalName)}}:f);paint();void 0;`);
  assert.equal(await js(`document.querySelector('[data-delivery-file-list] [data-user-content]').textContent`),literalName);
  await click('.ndelivery-more>summary');
  await js(`ChatDeliveries.hydrate(document.querySelector('#fixture'),{api:{},ref:'chat',snapshot:{...snapshot,deliverySync:{
    artifactVersions:files.map(f=>({id:f.artifactId,size:f.size})),manifest:{files:[...files.map(f=>({path:f.relative,size:f.size})),{path:${JSON.stringify(literalName + '.css')},size:80}]}}}});void 0;`);
  assert.equal(await js(`document.querySelectorAll('[data-delivery-file-list] li').length`),6);
  assert.equal(await js(`document.querySelector('.ndelivery-supporting [data-user-content]').textContent`),literalName+'.css');
  assert.equal((await disclosure('.ndelivery-more')).open,true);
  assert.equal(await js(`!!window.fileNameExecuted||!!document.querySelector('[data-delivery-file-list] img,[data-delivery-file-list] [onerror]')`),false);
  report.checks.push('Initial filenames and refreshed manifest paths remain literal text; refreshing packaged dependencies preserves expansion');
   await js(`window.shot={artifactId:'shot',name:'verify.png',relative:'.soduwork/evidence/verify.png',kind:'image',processEvidence:true,primary:false};
    const result=ChatAcceptanceResults.create({esc:String},{rich:String,invalidate(){}}).html('【验收分析结果】<p>验证截图：<button data-open-app="shot">verify.png</button></p>','3:0');
    document.querySelector('#fixture').innerHTML=ChatOutputLinks.decorate('<div class="nmsg ai" data-delivery-current="false" data-delivery-final="true" data-chat-node="message:3">'+result+'</div>',[shot],'review-chat',{status:'idle'});void 0;`);
  assert.equal(await js(`document.querySelectorAll('.nacceptance-result [data-acceptance-evidence] .noutput-image').length`),1);
  assert.equal(await js(`document.querySelectorAll('.nmsg>.noutput-image').length`),0);
  assert.equal(await js(`document.querySelector('.noutput-image').checkVisibility()`),false);
  assert.equal(await js(`document.querySelector('.nacceptance-result').tagName`),'SECTION');
  await click('[data-acceptance-evidence]>summary');assert.equal(await js(`document.querySelector('.noutput-image').checkVisibility()`),true);
  await click('[data-acceptance-evidence]>summary');assert.equal(await js(`document.querySelector('.noutput-image').checkVisibility()`),false);
  fs.writeFileSync(path.join(output,'collapsed-review.png'),(await win.webContents.capturePage()).toPNG());
  report.checks.push('The review result stays expanded while its optional evidence remains inside an independently collapsible group');
  await js(`files=files.map((f,i)=>({...f,taskId:'task',attachmentId:'attachment-'+i,role:'output'}));document.querySelector('#fixture').innerHTML='<div class="nmsg ai" data-delivery-current="true" data-delivery-final="true" data-output-task="task"><div class="nmd">已完成</div></div>';LibraryTransfer.decorateOutputs(document.querySelector('#fixture'),files,'task-chat',{status:'idle'});void 0;`);
  assert.equal(await js(`document.querySelectorAll('.noutput-library-bundle').length`),1);
  assert.equal(await js(`document.querySelectorAll('.noutput-library>.noutput-library-row').length`),3);
  assert.equal(await js(`document.querySelector('.noutput-library-more').open`),false);
  assert.ok((await disclosure('.noutput-library-more')).centerOffset<2);
  await click('.noutput-library-more>summary');
  let expanded=await disclosure('.noutput-library-more');
  assert.equal(expanded.open,true);assert.equal(expanded.label,'收起');assert.ok(expanded.belowFiles);assert.equal(expanded.visible,2);
  await js(`files=files.map((f,i)=>i===4?{...f,name:'updated-deliverable.md'}:f);LibraryTransfer.decorateOutputs(document.querySelector('#fixture'),files,'task-chat',{status:'idle'});void 0;`);
  assert.equal((await disclosure('.noutput-library-more')).open,true,'Refreshing file metadata preserves expansion');
  await click('.noutput-library-more>summary');assert.equal((await disclosure('.noutput-library-more')).visible,0);
  win.webContents.focus();
  await js(`document.querySelector('.noutput-library-more>summary').focus();void 0;`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});await pause();
  assert.equal((await disclosure('.noutput-library-more')).open,true,'Enter expands the focused disclosure');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});await pause();
  assert.equal((await disclosure('.noutput-library-more')).open,false,'Enter collapses the focused disclosure');
  for(const count of [3,4,20]){
    await js(`files=Array.from({length:${count}},(_,i)=>({artifactId:'list-'+i,name:'file-'+i+'.md',relative:'file-'+i+'.md',primary:true,changedInTurn:true,kind:'document',size:120,taskId:'task',attachmentId:'list-'+i,role:'output'}));
      document.querySelector('main').style.width='320px';document.querySelector('#fixture').innerHTML='<div class="nmsg ai" data-delivery-current="true" data-delivery-final="true" data-output-task="task"></div>';
      LibraryTransfer.decorateOutputs(document.querySelector('#fixture'),files,'task-chat',{status:'idle'});void 0;`);
    assert.equal(await js(`document.querySelectorAll('.noutput-library>.noutput-library-row').length`),3);
    assert.equal(await js(`!!document.querySelector('.noutput-library-more')`),count>3);
    if(count>3){
      await click('.noutput-library-more>summary');expanded=await disclosure('.noutput-library-more');
      assert.equal(expanded.visible,count-3);assert.ok(expanded.belowFiles);assert.ok(expanded.centerOffset<2);
      fs.writeFileSync(path.join(output,'files-'+count+'-expanded.png'),(await win.webContents.capturePage()).toPNG());
      await click('.noutput-library-more>summary');assert.equal((await disclosure('.noutput-library-more')).visible,0);
    }
  }
  report.checks.push('Local and task file lists use centered More and bottom Collapse controls; metadata refresh, keyboard input, three/four/twenty files and a narrow layout preserve the expected behavior');
  for (const remote of [false, true]) {
    await js(`files=['index.html','style.css','script.js','delivery.ZIP','readme.md'].map((name,i)=>({artifactId:'ordered-'+i,
      name,relative:name,primary:true,changedInTurn:true,kind:i===3?'archive':'document',size:120,
      ${remote ? "taskId:'ordered-task',attachmentId:'ordered-'+i,role:'output'," : ''}}));
      document.querySelector('#fixture').innerHTML='<div class="nmsg ai" data-delivery-current="true" data-delivery-final="true" ${remote ? 'data-output-task="ordered-task"' : ''}></div>';
      ${remote ? "LibraryTransfer.decorateOutputs(document.querySelector('#fixture'),files,'ordered-chat',{status:'idle'});" : "ChatDeliveries.decorate(document.querySelector('#fixture'),files,'ordered-chat',{status:'idle'});"}void 0;`);
    const selector = remote ? '.noutput-library-row .noutput-library-name' : '[data-delivery-file-list] li [data-user-content]';
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).textContent`),'delivery.ZIP');
    const toggle = remote ? '.noutput-library-more' : '.ndelivery-more';
    await click(toggle+'>summary');
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).textContent`),'delivery.ZIP');
    await click(toggle+'>summary');
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).textContent`),'delivery.ZIP');
  }
  report.checks.push('Local and remote archive outputs stay first even when discovered last and after expanding or collapsing files');
  assert.deepEqual(await js('uiErrors'),[]);report.ok=true;
}catch(error){report.error=error.stack;if(win)fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());}
finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);}});
