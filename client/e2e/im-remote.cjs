'use strict';
// Synthetic accounts and platform responses; no real IM service or model is contacted.
const electron=require('electron');
if(typeof electron==='string'){
 const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE'])delete env[key];
 require('node:child_process').spawn(electron,[__filename],{env,windowsHide:true,stdio:'inherit'}).on('exit',code=>{process.exitCode=code??1;});
}else{
 const {app,BrowserWindow}=electron,fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-im-ui-')),report={ok:false,checks:[]};
 app.setPath('userData',root);app.setPath('sessionData',root);app.disableHardwareAcceleration();
 let win,timer;const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const page=async(fn,...args)=>win.webContents.executeJavaScript('('+fn.toString()+')('+args.map(x=>JSON.stringify(x)).join(',')+')',true);
 async function wait(fn){for(let i=0;i<80;i++){if(await win.webContents.executeJavaScript('Boolean(('+fn.toString()+')())'))return;await delay(20);}throw Error('UI condition timed out: '+fn);}
 const click=label=>page(label=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent===label&&!x.closest('[hidden]'));if(!b||b.disabled)throw Error('Button unavailable: '+label);b.click();},label);
 app.whenReady().then(async()=>{
  timer=setTimeout(()=>app.exit(1),30000);
  win=new BrowserWindow({show:false,width:900,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true}});
  await win.loadURL('data:text/html,<div id="content"><div class="cap-connections-view"></div></div><div id="modal" hidden></div>');
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'../components/panels/im-remote.js'),'utf8'));
  await page(()=>{
   window.owner='alice';window.available=false;window.calls=[];window.connections=[];
   const record=(name,args)=>{calls.push({name,args});if(args.at(-1).taskScope!==owner)throw Error('wrong scope');};
   window.api={taskStorageKey:()=>owner,im:{
    catalog:async o=>{record('catalog',[o]);return{available,providers:[{id:'telegram',name:'Telegram',fields:[{key:'bot_token',label:'Bot Token',secret:true}]}],connections:structuredClone(connections)};},
    create:async(body,o)=>{record('create',[body,o]);if(window.hold)await new Promise(r=>window.finish=r);const row={id:'fixture',name:body.name,provider:body.provider,enabled:false,credentialsConfigured:true,webhookUrl:'https://example.invalid/callback'};connections.push(row);return structuredClone(row);},
    connect:async(id,o)=>{record('connect',[id,o]);connections[0].enabled=true;return structuredClone(connections[0]);},
    revoke:async(id,o)=>{record('revoke',[id,o]);connections[0].enabled=false;connections[0].credentialsConfigured=false;return{ok:true};},
    targets:async(id,o)=>{record('targets',[id,o]);return{targets:[{taskId:'new',runnerId:'desktop',title:'Not started',started:false,agents:[{id:'pi',name:'Pi',modelPick:true,models:[{name:'synthetic-model',label:'Fixture model'}]}]},{taskId:'task',runnerId:'desktop',title:'My task',runnerName:'My PC',online:false,started:true}]};},
    pair:async(id,body,o)=>{record('pair',[id,body,o]);return{command:'/pair synthetic-code',expiresIn:600};},
    bindings:async(id,o)=>{record('bindings',[id,o]);return{bindings:[{id:'binding',taskId:'task',enabled:true,external:{chat:'mobile'}}]};},
    messages:async(id,o)=>{record('messages',[id,o]);return{messages:[{id:'uncertain',status:'uncertain',detail:'Check original session',createdAt:new Date().toISOString(),outgoing:[]}]};},
    dismiss:async(id,o)=>{record('dismiss',[id,o]);return{ok:true};},unbind:async(id,o)=>{record('unbind',[id,o]);return{ok:true};}
   }};
   window.ctx={editorContext:()=>({api}),isCurrent:()=>true,closeModal:()=>{document.querySelector('#modal').hidden=true;},
    openModal:(title,subtitle,body,footer)=>{const node=document.querySelector('#modal');node.innerHTML='<h2></h2><p></p>'+body+footer;node.querySelector('h2').textContent=title;node.querySelector('p').textContent=subtitle;node.hidden=false;return node;}};
   window.dispose=SoduWorkIMRemote.mount(document.querySelector('#content'),ctx);
  });
  await wait(()=>document.querySelector('.im-remote').textContent.includes('尚未启用'));
  assert.equal(await page(()=>[...document.querySelectorAll('button')].find(x=>x.textContent==='连接机器人').disabled),true);
  await page(()=>{available=true;});await click('刷新');await wait(()=>![...document.querySelectorAll('button')].find(x=>x.textContent==='连接机器人').disabled);
  await click('连接机器人');await page(()=>{document.querySelector('[data-im-credential]').value='synthetic-secret';window.hold=true;});
  await click('保存机器人');await wait(()=>calls.some(x=>x.name==='create'));
  assert.equal(await page(()=>[...document.querySelectorAll('button')].find(x=>x.textContent==='保存机器人').disabled),true);
  await click('关闭');assert.equal(await page(()=>document.querySelector('[data-im-credential]').value),'');
  await page(()=>{finish();hold=false;});await delay(50);assert.equal(await page(()=>document.querySelector('#modal').hidden),true);
  report.checks.push('disabled service, pending form, secret clearing and late response after close');
  await click('刷新');await wait(()=>document.querySelector('.im-connection'));await click('管理');await click('验证并启用机器人');
  await wait(()=>[...document.querySelectorAll('button')].some(x=>x.textContent==='绑定任务'));
  await click('绑定任务');await wait(()=>document.querySelector('[data-im-body] select'));
  assert.equal(await page(()=>document.querySelector('[data-im-body] select').options.length),2);
  assert.match(await page(()=>document.querySelector('[data-im-body] select').textContent),/离线等待/);
  await click('生成一次性配对命令');await wait(()=>document.querySelector('[data-im-body] input')?.value==='/pair synthetic-code');
  const pairing=await page(()=>calls.find(x=>x.name==='pair').args[1]);assert.deepEqual(pairing,{taskId:'task',runnerId:'desktop',allowStart:false});
  await click('关闭');await click('管理');await click('绑定任务');await wait(()=>document.querySelector('[data-im-body] select'));
  await page(()=>{const s=document.querySelector('[data-im-body] select');s.value='1';s.onchange();});
  assert.equal(await page(()=>[...document.querySelectorAll('button')].find(x=>x.textContent==='生成一次性配对命令').disabled),true);
  await page(()=>{const c=document.querySelector('[data-im-start-consent]');c.checked=true;c.onchange();});await click('生成一次性配对命令');
  await wait(()=>calls.filter(x=>x.name==='pair').length===2);
  assert.deepEqual(await page(()=>calls.filter(x=>x.name==='pair')[1].args[1]),{taskId:'new',runnerId:'desktop',allowStart:true,agentId:'pi',model:'synthetic-model'});
  report.checks.push('pairing targets original desktop task and never silently authorizes a start');
  await click('关闭');await click('管理');await click('查看绑定和消息');await wait(()=>[...document.querySelectorAll('button')].some(x=>x.textContent==='我已核对，结束等待'));
  await click('我已核对，结束等待');assert.equal(await page(()=>calls.filter(x=>x.name==='dismiss').length),0);await click('确认已核对');await wait(()=>calls.some(x=>x.name==='dismiss'));
  await wait(()=>[...document.querySelectorAll('button')].some(x=>x.textContent==='解除绑定'));await click('解除绑定');await wait(()=>calls.some(x=>x.name==='unbind'));
  await click('关闭');await click('管理');await click('撤销远程连接');assert.equal(await page(()=>calls.filter(x=>x.name==='revoke').length),0);await click('确认撤销');await wait(()=>calls.some(x=>x.name==='revoke'));
  report.checks.push('uncertain results require an explicit check; revocation and unbinding call scoped APIs');
  await click('关闭');await click('连接机器人');await page(()=>{document.querySelector('[data-im-credential]').value='second-secret';hold=true;});await click('保存机器人');
  await wait(()=>calls.filter(x=>x.name==='create').length===2);await page(()=>{owner='bob';dispatchEvent(new Event('soduwork-data-scope-changed'));});
  assert.equal(await page(()=>document.querySelector('#modal').hidden),true);
  await page(()=>finish());await delay(50);
  assert.equal(await page(()=>document.querySelector('[data-im-credential]').value),'');
  assert.equal(await page(()=>document.querySelector('#modal h2').textContent),'连接远程对话机器人');
  const before=await page(()=>calls.length);await page(()=>{[...document.querySelectorAll('button')].find(x=>x.textContent==='保存机器人').onclick();});await delay(40);assert.equal(await page(()=>calls.length),before);
  await page(()=>dispose());assert.equal(await page(()=>!!document.querySelector('.im-remote')),false);
  report.checks.push('account change rejects late UI updates and subsequent old-account actions');report.ok=true;
 }).catch(error=>{report.error=error.stack||String(error);}).finally(()=>{
  clearTimeout(timer);win?.destroy();const output=path.resolve(__dirname,'../../outputs/im-remote-ui.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);
 });
}
