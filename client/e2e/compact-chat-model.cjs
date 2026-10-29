'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=process.argv[2];
if(!root||!path.isAbsolute(root))throw Error('Absolute evidence directory required');
fs.mkdirSync(root,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-compact-model-')));
const report={ok:false,checks:[],geometry:[]};let win;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(code){for(let i=0;i<80;i++){if(await js(code))return;await delay(40)}throw Error(code)}
async function click(selector){const p=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await delay(100)}
async function hover(selector){const p=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');win.webContents.sendInputEvent({type:'mouseMove',...p});await delay(160)}
function key(keyCode){win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode})}
async function shot(name){await delay(160);fs.writeFileSync(path.join(root,name+'.png'),(await win.webContents.capturePage()).toPNG())}
async function geometry(){return js(`(()=>{const r=s=>{const a=document.querySelector(s).getBoundingClientRect();return{x:a.x,right:a.right,width:a.width,top:a.top,bottom:a.bottom,height:a.height}};const label=document.querySelector('.nmodel-button>span');return{model:r('#nchatModel'),button:r('.nmodel-button'),ring:r('#nchatMeta'),voice:r('#nchatMic'),send:r('#nchatSend'),box:r('.nbox'),labelTruncated:label.scrollWidth>label.clientWidth,font:parseFloat(getComputedStyle(label).fontSize),overflow:document.documentElement.scrollWidth>innerWidth}})()`)}
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1160,height:720,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'fixtures/compact-chat-model.html'));await until('window.fixtureReady');
  // Offscreen windows have no OS focus; emulate page focus without raising a window.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  for(const [width,max] of [[1160,136],[760,136],[600,120],[390,96],[320,96]]){
    win.setSize(width,720);await delay(100);const g=await geometry();report.geometry.push({width,...g});
    assert.ok(g.button.width<=max&&g.model.width<=max,JSON.stringify(g));assert.equal(g.button.height,width<=390?30:32);assert.equal(g.font,13);
    if(width<=390)assert.equal(await js('getComputedStyle(document.querySelector(".nmodel-button>span")).display'),'none');
    else assert.ok(g.labelTruncated);
    assert.ok(!g.overflow);assert.ok(g.ring.right<=g.model.x&&g.model.right<=g.voice.x&&g.voice.right<=g.send.x);
    assert.ok(g.send.right<=g.box.right);assert.equal(await js('document.querySelector(".nmodel-button>span").textContent'),'fixture-coding-large-model');
    assert.match(await js('document.querySelector(".nmodel-button").title'),/fixture-coding-large-model/);
    if(width===1160||width===390)await shot('compact-'+width);
  }
  report.checks.push('Long names truncate with full tooltip; narrow composers use icons; controls do not overlap at 1160–320px');
  win.setSize(1160,720);await delay(100);
  const ringStyle=await js(`(()=>{const ring=document.querySelector('.nctx-ring'),arc=ring.querySelector('.nctx-value');return{width:ring.getBoundingClientRect().width,height:ring.getBoundingClientRect().height,fill:getComputedStyle(arc).fill,cap:getComputedStyle(arc).strokeLinecap,stroke:parseFloat(getComputedStyle(arc).strokeWidth),animation:getComputedStyle(ring).animationName}})()`);
  assert.deepEqual(ringStyle,{width:16,height:16,fill:'none',cap:'round',stroke:1.8,animation:'none'});
  for(const [used,known,level] of [[0,true,''],[28000,true,''],[70000,true,'warm'],[92000,true,'hot'],[28000,false,'']]){
    await js('contextState._snap.contextUsage.input='+used+';contextState._model.contextWindowKnown='+known+';renderContext()');
    assert.equal(await js('document.querySelectorAll(".nctx-value").length'),used?1:0);
    assert.equal(await js('document.querySelector(".nctx-ring").className'),'nctx-ring'+(level?' '+level:''));
    assert.match(await js('document.querySelector(".nctx-pop").textContent'),known?/% 已用/:/估算上限/);
  }
  await js('contextState._snap.contextUsage.input=28000;contextState._model.contextWindowKnown=true;renderContext()');
  await hover('#nchatMeta');
  assert.equal(await js('getComputedStyle(document.querySelector(".nctx-pop")).display'),'grid');
  assert.equal(await js('document.querySelector("#nchatMeta").getAttribute("aria-expanded")'),'true');
  assert.equal(await js('document.querySelector(".nctx-pop").children.length'),4);
  assert.equal(await js('document.querySelector(".nctx-pop").lastElementChild.textContent'),'最近一次上报的上下文用量，含缓存；不含待发送内容');
  assert.equal(await js('document.querySelector("#nchatMeta").hasAttribute("title")||document.querySelector(".nctx-ring").hasAttribute("title")'),false);
  await hover('.nctx-pop');assert.equal(await js('getComputedStyle(document.querySelector(".nctx-pop")).display'),'grid');
  // The four-line hint overlaps the input center; leave to an uncovered region.
  await hover('.fixture-copy');assert.equal(await js('getComputedStyle(document.querySelector(".nctx-pop")).display'),'none');
  await click('.fixture-copy');
  win.webContents.focus();
  await js('document.querySelector("#nchatMeta").focus()');
  assert.equal(await js('getComputedStyle(document.querySelector(".nctx-pop")).display'),'grid',JSON.stringify(await js('({active:document.activeElement.id,focused:document.hasFocus(),state:document.querySelector("#nchatMeta").className})')));
  key('ESC');await delay(80);assert.equal(await js('getComputedStyle(document.querySelector(".nctx-pop")).display'),'none');
  await js('document.querySelector("#nchatMeta").blur()');
  await js('contextState._snap.contextUsage.input=220000;contextState._model.contextWindow=258000;renderContext()');
  for(const width of [320,390,1160]){
    win.setSize(width,720);await delay(100);await hover('.fixture-copy');await hover('#nchatMeta');
    const bounds=await js(`(()=>{const b=document.querySelector('.nctx-pop').getBoundingClientRect(),a=document.querySelector('#nchatMeta').getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,width:b.width,gap:a.top-b.bottom,viewport:innerWidth,centerOffset:(b.left+b.right-a.left-a.right)/2}})()`);
    assert.ok(bounds.left>=11&&bounds.right<=bounds.viewport-11,JSON.stringify(bounds));
    assert.ok(bounds.top>=0&&Math.abs(bounds.gap-8)<1);if(width===1160)assert.ok(Math.abs(bounds.centerOffset)<1);
  }
  assert.equal(await js('document.querySelector(".nctx-percent").textContent'),'85% 已用');
  assert.equal(await js('document.querySelector(".nctx-total").textContent'),'已用 220,000 标记，共 258,000');
  const hintCrop=await js(`(()=>{const b=document.querySelector('.nctx-pop').getBoundingClientRect(),a=document.querySelector('#nchatMeta').getBoundingClientRect(),m=document.querySelector('#nchatModel').getBoundingClientRect();return{x:Math.floor(b.left-12),y:Math.floor(b.top-12),width:Math.ceil(Math.max(b.right,m.right)-b.left+24),height:Math.ceil(a.bottom-b.top+24)}})()`);
  fs.writeFileSync(path.join(root,'context-hover-detail.png'),(await win.webContents.capturePage(hintCrop)).toPNG());
  await hover('.fixture-copy');
  await click('#nchatMeta');assert.equal(await js('getComputedStyle(document.querySelector(".nctx-pop")).display'),'grid');
  await hover('.fixture-copy');assert.equal(await js('getComputedStyle(document.querySelector(".nctx-pop")).display'),'grid');
  await shot('context-detail');await click('.fixture-copy');
  assert.equal(await js('getComputedStyle(document.querySelector(".nctx-pop")).display'),'none');
  await js('contextState._snap.contextUsage.input=28000;contextState._model.contextWindow=100000;renderContext()');
  report.checks.push('four-line hover tooltip with explicit context watermark explanation; pointer can enter card; leave dismisses; keyboard focus/Escape; click pins and outside click closes; 320px viewport clamping; no duplicate native title');
  const ringColors=[];for(const theme of ['azure','warm','minimal','steady']){
    await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
    ringColors.push(await js('getComputedStyle(document.querySelector(".nctx-value")).stroke'));
  }
  assert.equal(new Set(ringColors).size,4);await js('document.documentElement.dataset.theme="azure"');
  report.checks.push('16px transparent SVG ring, rounded arc; zero/unknown have no false arc; threshold colors follow theme; usage detail opens and closes');
  const crop=await js('(()=>{const r=document.querySelector(".nbox").getBoundingClientRect();return{x:Math.floor(r.x-8),y:Math.floor(r.y-8),width:Math.ceil(r.width+16),height:Math.ceil(r.height+16)}})()');
  fs.writeFileSync(path.join(root,'composer-detail.png'),(await win.webContents.capturePage(crop)).toPNG());
  await click('.nmodel-button');await until('document.querySelectorAll("[data-model-name]").length===3');
  assert.ok(await js('document.querySelector(".nmodel-pop").getBoundingClientRect().width>document.querySelector(".nmodel-button").getBoundingClientRect().width'));
  assert.equal(await js('document.querySelector("[data-model-name=long-model] .nmodel-row-copy b").textContent'),'fixture-coding-large-model');
  await shot('model-list');
  await js('const input=document.querySelector(".nmodel-pop input");input.value="Flash";input.dispatchEvent(new Event("input",{bubbles:true}))');
  await until('document.querySelectorAll("[data-model-name]").length===1');
  await click('[data-model-name=vision]');await until('document.querySelector(".nmodel-pop").hidden');
  assert.deepEqual(await js('selected'),[{ref:'isolated-chat',name:'vision'}]);assert.equal(await js('sent.length'),0);
  assert.equal(await js('document.querySelector(".nmodel-button>span").textContent'),'GLM 5.3 Flash');
  report.checks.push('real click opens full-width list; search and model selection work without sending a message');
  await click('.nmodel-button');await until('document.querySelectorAll("[data-model-name]").length===3');key('ESC');
  await until('document.querySelector(".nmodel-pop").hidden');assert.ok(await js('document.activeElement===document.querySelector(".nmodel-button")'));
  const colors=[];for(const theme of ['azure','warm','minimal','steady']){await js('document.documentElement.dataset.theme='+JSON.stringify(theme));await delay(180);colors.push(await js('getComputedStyle(document.querySelector(".nmodel-button")).color'));}
  assert.ok(new Set(colors).size>1);report.checks.push('Escape closes and restores focus; theme colors remain inherited');
  await js('state.selection={name:"short",model:models[2]};controls.render()');assert.ok((await geometry()).button.width<80);
  await js(`window.modelRequests=[];state.adapterId='sample-account';
    soduWorkAPI.conversationSession.runtimes=async()=>({ok:true,runtimes:[{id:'sample-account',modelMode:'account'}]});
    soduWorkAPI.conversationSession.runtimeModels=async id=>{modelRequests.push(id);return{models:[{id:'vendor-model',label:'Vendor model'}]}};
    SoduWorkAPI.myModels=async()=>{throw Error('Account agents must not request shared models')};controls.render()`);
  await click('.nmodel-button');await until('document.querySelector(".nmodel-options").textContent.includes("Vendor model")');
  assert.deepEqual(await js('modelRequests'),['sample-account']);key('ESC');await delay(80);
  await js(`state.adapterId='sample-managed';
    soduWorkAPI.conversationSession.runtimes=async()=>({ok:true,runtimes:[{id:'sample-managed',modelMode:'managed'}]});
    soduWorkAPI.conversationSession.runtimeModels=async()=>{throw Error('Managed agents must not request personal models')};
    SoduWorkAPI.myModels=async()=>{modelRequests.push('company');return{usable:[{name:'team-model',label:'Team model'}]}};controls.render()`);
  await click('.nmodel-button');await until('document.querySelector(".nmodel-options").textContent.includes("Team model")');
  assert.deepEqual(await js('modelRequests'),['sample-account','company']);key('ESC');await delay(80);
  report.checks.push('New account and managed Agent declarations select their own model source without desktop ID allowlists');
  await js('state.ref="";controls.render()');assert.equal(await js('document.querySelector(".nmodel-button").disabled'),false);
  await js('state.runtimeSwitching=true;controls.render()');assert.ok(await js('document.querySelector(".nmodel-button").disabled'));
  await js('state.runtimeSwitching=false;state.cloudHandoff={phase:"preparing"};controls.render()');assert.ok(await js('document.querySelector(".nmodel-button").disabled'));
  await js('state.cloudHandoff.phase="committed";controls.render()');assert.equal(await js('document.querySelector(".nmodel-button").disabled'),false);
  report.checks.push('short names use natural width; pre-session model selection remains available; runtime switching and pending cloud handoff disable selection until committed');
  assert.deepEqual(await js('errors'),[]);assert.deepEqual(await js('notices'),[]);report.ok=true;
}).catch(async e=>{report.error=e.stack;if(win)await shot('failure').catch(()=>{})}).finally(()=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(win)win.destroy();app.exit(report.ok?0:1)});
