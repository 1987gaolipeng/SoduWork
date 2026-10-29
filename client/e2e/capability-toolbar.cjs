'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const evidence=process.argv[2];
if(!evidence||!path.isAbsolute(evidence))throw Error('Absolute evidence directory required');
fs.mkdirSync(evidence,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-toolbar-profile-')));
const report={ok:false,checks:[],geometry:[]};let win;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(code){for(let i=0;i<100;i++){if(await js(code))return;await delay(30)}throw Error('Timeout: '+code)}
async function click(selector){
  const p=await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await delay(45);
}
async function select(tab){await click('[data-cap-tab="'+tab+'"]');await until('document.querySelector(".cap-tab.on").dataset.capTab==='+JSON.stringify(tab));if(tab==='skills')await until('!document.querySelector("#capSkillRefresh").disabled');await delay(150)}
async function shot(name){
  const crop=await js(`(()=>{const r=document.querySelector('.cap-toolbar-inner').getBoundingClientRect();return{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height+100)}})()`);
  const capture=await win.webContents.capturePage(crop);
  fs.writeFileSync(path.join(evidence,name+'.png'),capture.resize({width:Math.min(1100,crop.width)}).toPNG());
}
async function geometry(){return js(`(()=>{const r=s=>{const b=document.querySelector(s).getBoundingClientRect();return{x:b.x,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}};return{viewport:innerWidth,rail:r('.cap-toolbar-inner'),tabs:r('.cap-tabs'),search:r('.cap-search'),actions:r('.cap-actions'),active:r('.cap-tab.on'),overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('.cap-actions .btn-mini')].map(el=>({id:el.id,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,overflow:el.scrollWidth>el.clientWidth}))}})()`)}
async function styles(){return js(`(()=>{const take=(s,props)=>{const c=getComputedStyle(document.querySelector(s));return Object.fromEntries(props.map(p=>[p,c[p]]))};return{tabs:take('.cap-tabs',['backgroundColor','borderRadius','padding','borderColor']),active:take('.cap-tab.on',['backgroundColor','borderRadius','fontSize','fontFamily','boxShadow','height']),badge:take('.cap-tab.on i',['backgroundColor','color','borderRadius']),search:take('.cap-search input',['backgroundColor','height','borderRadius']),toolbar:take('.cap-toolbar',['backgroundColor'])}})()`)}
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1920,height:780,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const network=[];win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{network.push(details.url);callback({cancel:true})});
  await win.loadFile(path.join(__dirname,'fixtures/capability-toolbar.html'));
  await until('document.querySelectorAll("[data-cap-tab]").length===4');
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  for(const width of [1920,1280,1160,1024,760,680,390,320]){
    win.setSize(width,780);await delay(120);await select('plugins');const baseline=await styles();const original=await geometry();
    for(const tab of ['plugins','connections','skills','market']){
      await select(tab);assert.deepEqual(await styles(),baseline,'Shared styles differ on '+tab+' at '+width);
      const g=await geometry();report.geometry.push({width,tab,...g});
      assert.ok(Math.abs(g.rail.height-original.rail.height)<1,'Toolbar jumps: '+JSON.stringify(g));
      assert.ok(!g.overflow&&g.tabs.x>=0&&g.actions.right<=g.rail.right+1,JSON.stringify(g));
      assert.ok(g.active.x>=g.tabs.x&&g.active.right<=g.tabs.right+1,'Selected tab hidden: '+JSON.stringify(g));
      const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
      assert.ok(!overlap(g.tabs,g.search)&&!overlap(g.tabs,g.actions)&&!overlap(g.search,g.actions),JSON.stringify(g));
      assert.ok(g.buttons.every(b=>b.height===36&&!b.overflow),JSON.stringify(g));
      assert.equal(await js('document.querySelectorAll(".cap-tab[aria-pressed=true]").length'),1);
      if(tab==='skills'&&(width===1920||width===760||width===390))await shot('skills-'+width);
    }
  }
  report.checks.push('Eight viewport sizes × five real tab switches: identical segmented styles, stable toolbar height, no collisions; selected tab remains visible');
  win.setSize(1160,780);await delay(100);
  const themeColors=[];
  for(const theme of ['azure','warm','minimal','steady']){
    await js('document.documentElement.dataset.theme='+JSON.stringify(theme));await select('plugins');const baseline=await styles();themeColors.push(baseline.badge.color);
    for(const tab of ['connections','skills','market']){await select(tab);assert.deepEqual(await styles(),baseline)}
  }
  assert.ok(new Set(themeColors).size>1);report.checks.push('Four themes: shared selected surface, count badge, fonts and search appearance across all tabs');
  await js('document.documentElement.dataset.theme="azure"');await select('skills');
  const before=await geometry(),calls=await js('refreshCalls');await js('holdRefresh=true');await click('#capSkillRefresh');
  assert.equal(await js('document.querySelector("#capSkillRefresh").disabled'),true);
  assert.equal(await js('document.querySelector("#capSkillRefresh").getAttribute("aria-busy")'),'true');
  assert.equal(await js('document.querySelector("#capSkillRefresh span").textContent'),'正在刷新');
  const during=await geometry();assert.equal(during.rail.height,before.rail.height);assert.deepEqual(during.actions,before.actions);
  const inline=await js(`(()=>{const b=document.querySelector('#capSkillRefresh'),s=b.querySelector('svg').getBoundingClientRect(),t=b.querySelector('span').getBoundingClientRect();return{s:{right:s.right,center:s.top+s.height/2},t:{left:t.left,center:t.top+t.height/2}}})()`);
  assert.ok(inline.s.right<inline.t.left&&Math.abs(inline.s.center-inline.t.center)<1);
  await click('#capSkillRefresh');assert.equal(await js('refreshCalls'),calls+1);await shot('refreshing');
  await js('finishRefresh()');await until('!document.querySelector("#capSkillRefresh").disabled');
  assert.equal(await js('document.querySelector("#capSkillRefresh span").textContent'),'刷新本机');
  await js('failRefresh=true');await click('#capSkillRefresh');await until('!document.querySelector("#capSkillRefresh").disabled');
  assert.ok(await js('notices.some(t=>t.includes("模拟本机"))'));await js('failRefresh=false');
  report.checks.push('Real Skill sync: icon and label stay inline; refreshing state is stable and disabled; failure restores retry without layout shift');
  await js('document.querySelector("[data-cap-tab=plugins]").focus()');
  for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Tab'});
  await until('document.activeElement.dataset.capTab==="connections"');
  assert.equal(await js('getComputedStyle(document.querySelector("[data-cap-tab=connections]")).outlineStyle'),'solid');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await until('document.querySelector(".cap-tab.on").dataset.capTab==="connections"');
  assert.equal(await js('document.activeElement.dataset.capTab'),'connections');
  await click('#capAddButton');await until('!!document.querySelector("#capMcpName")');
  assert.equal(await js('document.querySelector("#capModalLayer").hidden'),false);
  assert.equal(await js('document.querySelector("#capAddMenu").hidden'),true);await click('#capModalClose');
  await select('skills');await click('#capAddButton');
  assert.equal(await js('document.querySelector("#capAddMenu").hidden'),false);
  assert.deepEqual(await js('[...document.querySelectorAll("#capAddMenu [data-cap-add]")].map(b=>b.dataset.capAdd)'),['skill-create','skill-import']);await click('#capAddButton');
  await select('skills');await js('holdRefresh=true');await click('#capSkillRefresh');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await js('getComputedStyle(document.querySelector("#capSkillRefresh svg")).animationName'),'none');await js('finishRefresh()');
  await until('!document.querySelector("#capSkillRefresh").disabled');
  assert.deepEqual(await js('errors'),[]);assert.equal(await js('writes'),0);assert.deepEqual(network,[]);
  report.checks.push('Keyboard focus survives switching; Connections opens the real connection editor; Skills offers only create/import; reduced-motion honored; no external requests or business-data writes');
  await js('closeCapabilityPanel()');report.ok=true;
}).catch(error=>{report.error=error.stack}).finally(()=>{
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  if(win&&!win.isDestroyed())win.destroy();app.exit(report.ok?0:1);
});
