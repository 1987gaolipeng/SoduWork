'use strict';
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const output=process.argv[2];if(!output||!path.isAbsolute(output))throw Error('Absolute evidence directory required');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-schedule-actions-')));
let win;const report={ok:false,checks:[],screenshots:[]},delay=ms=>new Promise(r=>setTimeout(r,ms));
const js=c=>win.webContents.executeJavaScript(c,true);
async function until(c){for(let i=0;i<100;i++){if(await js(c))return;await delay(40);}throw Error('Timeout: '+c);}
async function shot(name,selector){
 const rect=selector?await js('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()'):undefined;
 await delay(100);const f=path.join(output,name+'.png');fs.writeFileSync(f,(await win.webContents.capturePage(rect)).toPNG());report.screenshots.push(f);
}
async function click(selector){
 const p=await js('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await delay(100);
}
// Read protected Windows source through Node before handing it to the renderer.
function inlineFixture(file){
 const dir=path.dirname(file);
 const css=(file,seen=new Set())=>{if(seen.has(file))return '';seen.add(file);return fs.readFileSync(file,'utf8').replace(/@import\s+["']([^"']+)["'];/g,(_,p)=>css(path.resolve(path.dirname(file),p),seen));};
 return fs.readFileSync(file,'utf8')
  .replace(/<link rel="stylesheet" href="([^"]+)">/g,(_,p)=>'<style>'+css(path.resolve(dir,p))+'</style>')
  .replace(/<script src="([^"]+)"><\/script>/g,(_,p)=>'<script>'+fs.readFileSync(path.resolve(dir,p),'utf8').replace(/<\/script/gi,'<\\/script')+'</script>');
}
const sel=act=>'.sch-item[data-sid="schedule-0"] [data-act="'+act+'"]';
async function templateSurface(){
 return js(`(()=>{const e=document.querySelector('.sch-recipes button'),s=getComputedStyle(e),r=e.getBoundingClientRect();return{
   border:s.borderTopColor,background:s.backgroundColor,outline:s.outlineColor,outlineWidth:s.outlineWidth,
   focused:e.matches(':focus-visible'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};})()`);
}
async function verifyThemeSurface(theme){
 win.webContents.sendInputEvent({type:'mouseMove',x:1,y:1});await js('document.activeElement.blur()');await delay(180);
 const m=await js(`(()=>{const panel=document.querySelector('#schPanel'),probe=document.createElement('i');
   probe.style.cssText='position:fixed;left:-10000px;visibility:hidden';panel.append(probe);
   const resolve=value=>{probe.style.color=value;return getComputedStyle(probe).color;};
   const token=name=>resolve('var('+name+')');
   const color=selector=>getComputedStyle(panel.querySelector(selector)).color;
   const bg=selector=>getComputedStyle(panel.querySelector(selector)).backgroundColor;
   const result={paper:token('--bg-0'),accent:token('--accent'),accentHover:token('--accent-hover'),soft:token('--accent-soft'),enabledInk:resolve('color-mix(in srgb,var(--accent) 60%,var(--ink))'),
     panel:getComputedStyle(panel).backgroundColor,heading:bg('.ws-page-head'),body:bg('.sch-body'),bodyImage:getComputedStyle(panel.querySelector('.sch-body')).backgroundImage,
     cards:[...panel.querySelectorAll('.sch-item')].map(e=>getComputedStyle(e).backgroundColor),
     create:bg('.sch-create-trigger'),icons:[...panel.querySelectorAll('.sch-recipes button > i')].map(e=>({color:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor})),
     run:color('.sch-icon-action[data-act=run]'),runBg:bg('.sch-icon-action[data-act=run]'),
     enabled:color('.sch-i-state.is-enabled'),enabledBg:bg('.sch-i-state.is-enabled')};probe.remove();return result;})()`);
 assert.equal(m.panel,m.paper,theme+' workspace panel uses theme paper');assert.equal(m.body,m.paper,theme+' content uses theme paper');assert.equal(m.heading,m.paper,theme+' title uses the same paper');
 assert.equal(m.bodyImage,'none',theme+' content has no independent grey gradient');assert.ok(m.cards.every(color=>color===m.paper));
 assert.equal(m.create,m.accent,theme+' create follows accent');assert.equal(m.run,m.accent,theme+' run follows accent');assert.equal(m.runBg,m.soft);
 assert.equal(m.icons.length,4);assert.ok(m.icons.every(icon=>icon.color===m.accent&&icon.bg===m.soft),theme+' all templates follow accent');
 assert.equal(m.enabled,m.enabledInk,theme+' enabled badge combines accent and readable ink');assert.equal(m.enabledBg,m.soft);
 const normal=await templateSurface();
 const p=await js('(()=>{const r=document.querySelector(".sch-recipes button").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 win.webContents.sendInputEvent({type:'mouseMove',...p});await delay(180);
 const hover=await templateSurface();assert.notEqual(hover.border,normal.border,theme+' hover changes border');assert.deepEqual(hover.rect,normal.rect,theme+' hover does not shift template');
 win.webContents.sendInputEvent({type:'mouseMove',x:1,y:1});
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'TAB'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'TAB'});await delay(30);
 await js('document.querySelector(".sch-recipes button").focus()');await delay(180);
 const focus=await templateSurface();assert.equal(focus.focused,true);assert.notEqual(focus.border,normal.border,theme+' keyboard focus changes border');
 assert.equal(focus.outlineWidth,'2px');assert.equal(focus.outline,m.accent);assert.deepEqual(focus.rect,normal.rect,theme+' focus does not shift template');
 await js('document.activeElement.blur()');await delay(180);
 (report.themes||=[]).push({theme,...m,template:{normal,hover,focus}});
 if(theme==='azure'||theme==='ruby')await shot('theme-'+theme);
}
app.whenReady().then(async()=>{
 win=new BrowserWindow({show:false,width:1600,height:950,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const requests=[];win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(r,cb)=>{requests.push(r.url);cb({cancel:true});});
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(inlineFixture(path.join(__dirname,'fixtures/schedule-card-actions.html'))));await until('document.querySelectorAll(".sch-icon-action").length===16');
 win.webContents.debugger.attach('1.3');
 await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
 const colors=[];
 for(const theme of ['azure','ruby','minimal','steady','warm']){
  await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
  for(const width of [1600,900,390]){
   win.setSize(width,950);await delay(100);
   const m=await js(`(()=>{const ops=[...document.querySelectorAll('.sch-i-ops')],buttons=ops.flatMap(e=>[...e.querySelectorAll('button')]);return{
    labels:buttons.every(e=>e.title&&e.getAttribute('aria-label')&&e.type==='button'),text:buttons.map(e=>e.textContent.trim()).join(''),
    sizes:buttons.map(e=>[e.getBoundingClientRect().width,e.getBoundingClientRect().height]),
    overflow:ops.some(e=>{const r=e.getBoundingClientRect(),p=e.closest('.sch-item').getBoundingClientRect();return r.left<p.left||r.right>p.right+1||r.bottom>p.bottom+1}),
    pageOverflow:document.documentElement.scrollWidth>innerWidth};})()`);
   assert.equal(m.labels,true);assert.equal(m.text,'');assert.ok(m.sizes.every(s=>s[0]===32&&s[1]===32));assert.equal(m.overflow,false);assert.equal(m.pageOverflow,false);
   if(width===1600)await verifyThemeSurface(theme);
   if(theme==='azure'){await shot('toolbar-'+width);if(width===1600)await shot('card-detail','.sch-item');}
  }
  colors.push(await js('getComputedStyle(document.querySelector(".sch-icon-action[data-act=run]")).backgroundColor'));
 }
 assert.equal(new Set(colors).size,5);
 report.checks.push('Four named icon buttons, fixed 32px geometry, five themes and 1600/900/390px widths without overflow');
 report.checks.push('Production workspace CSS order: five themes share paper backgrounds; create, template, run and enabled states follow theme tokens; hover/focus borders change without layout movement');
 const readClient=name=>fs.readFileSync(path.resolve(__dirname,'..',name),'utf8');
 for(const name of JSON.parse(readClient('core/locales/manifest.json')))await js(readClient('core/locales/'+name));
 for(const name of ['core/i18n-dom.js','core/i18n.js'])await js(readClient(name));
 await js(`window.compactSavedRows=rows.slice();window.compactOriginalAgents=_schAgents.slice();
   _schAgents.push({id:'long-agent',name:'Codex Harness — Research and Engineering'});
   const cases=[
     {...rows[0],id:'weekly-layout',every:'weekly',weekday:3,assigneeId:'long-agent',note:'核对行业变化、原材料供应、市场需求以及需要持续关注的问题，形成结构清晰且有来源依据的分析报告。'.repeat(5)},
     {...rows[0],id:'hourly-layout',every:'hourly',atMinute:30,assigneeId:'pi'},
     {...rows[0],id:'project-layout',repoId:'retained-project',flow:true,requiredCapabilities:['browser'],personalPluginKey:'retained-personal-plugin'},
     {...rows[0],id:'enterprise-layout',pluginBindingId:'retained-binding',pluginProjectId:'',repoId:'retained-project',flow:true}
   ];
   document.querySelector('.sch-list').innerHTML=cases.map(_schCardHtml).join('');`);
 for(const lang of ['en-US','zh-CN']){
   await js('SoduWorkI18n.setLocale('+JSON.stringify(lang)+')');await delay(100);
   for(const width of [1600,900,390,320]){
     win.setSize(width,950);await delay(100);
     const layout=await js(`(()=>{const cards=[...document.querySelectorAll('.sch-item')];return {
       hourlyTime:document.querySelector("[data-sid=hourly-layout] .sch-i-when i").textContent,
       pageOverflow:document.documentElement.scrollWidth>innerWidth,
       templateFonts:[...document.querySelectorAll('.sch-recipes button')].map(e=>[parseFloat(getComputedStyle(e.querySelector('b')).fontSize),parseFloat(getComputedStyle(e.querySelector('small')).fontSize)]),
       headerFits:cards.every(card=>{const h=card.querySelector('.sch-i-head').getBoundingClientRect();return [...card.querySelector('.sch-i-head').children].every(e=>{const r=e.getBoundingClientRect();return r.left>=h.left-1&&r.right<=h.right+1&&r.top>=h.top-1&&r.bottom<=h.bottom+1;});}),
       executorInHeader:cards.every(card=>!!card.querySelector('.sch-i-head .sch-i-executor')),
       emptyMeta:cards.slice(0,2).some(card=>card.querySelector('.sch-i-meta')),
       project:cards[2].querySelector('.sch-i-project').textContent,
       method:cards[2].querySelector('.sch-i-assignment .sch-i-method').textContent,
       longName:cards[0].querySelector('.sch-i-executor').getAttribute('aria-label'),
       descriptionLines:getComputedStyle(cards[0].querySelector('.sch-i-note')).webkitLineClamp,
       cardHeight:cards[0].getBoundingClientRect().height,
     };})()`);
     assert.equal(layout.pageOverflow,false);assert.equal(layout.headerFits,true,JSON.stringify({lang,width,layout}));assert.equal(layout.executorInHeader,true);
     assert.equal(layout.hourlyTime,lang==='en-US'?'30 min':'30 分');
     assert.equal(layout.emptyMeta,false);assert.ok(layout.templateFonts.every(([title,body])=>title>=16&&body>=14));
     assert.equal(layout.project,'retained-project');assert.equal(layout.method,'retained-personal-plugin');
     assert.equal(layout.longName,'Codex Harness — Research and Engineering');assert.equal(layout.descriptionLines,'2');
     if(width===1600)assert.ok(layout.cardHeight<300,'long-description cards should remain compact');
     if(width===1600||width===320)await shot('compact-'+lang+'-'+width);
     if(width===320)await shot('weekly-'+lang+'-'+width,'[data-sid=weekly-layout]');
   }
 }
 win.setSize(900,950);await click('[data-sid="weekly-layout"] summary');
 assert.equal(await js('document.querySelector("[data-sid=weekly-layout] details").open'),true);
 assert.equal(await js('getComputedStyle(document.querySelector("[data-sid=weekly-layout] .sch-i-note")).webkitLineClamp'),'none');
 report.checks.push('16px/14px template text, inline executors, two-line expandable descriptions, metadata retained, and Chinese/English weekly/hourly schedules fit 1600/900/390/320px');
 await js('SoduWorkI18n.setLocale("zh-CN");rows=compactSavedRows;_schAgents=compactOriginalAgents;openSchedulePanel()');
 await until('document.querySelectorAll(".sch-icon-action").length===16&&!!document.querySelector("[data-sid=schedule-0]")');
 win.setSize(1600,950);await js('document.documentElement.dataset.theme="azure"');await delay(100);
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'TAB'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'TAB'});await delay(50);
 await js('document.querySelector('+JSON.stringify(sel('runs'))+').focus()');
 assert.equal(await js('getComputedStyle(document.activeElement).outlineStyle'),'solid',await js('JSON.stringify({focus:document.hasFocus(),visible:document.activeElement.matches(":focus-visible"),element:document.activeElement.outerHTML})'));
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'ENTER'});win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'ENTER'});
 await until('document.querySelector("#schRunLayer").classList.contains("show")');
 assert.equal(await js('calls.history.at(-1)'),'schedule-0');
 await click('.sch-run-close');
 await until('document.activeElement.matches(".sch-item[data-sid=\\"schedule-0\\"] [data-act=runs]")');
 await click(sel('edit'));await until('document.querySelector("#schTitle")?.value===rows[0].title');
 await click('.sch-editor-close');await until('document.activeElement.matches(".sch-item[data-sid=\\"schedule-0\\"] [data-act=edit]")');
 report.checks.push('Execution history opens by keyboard; editing opens the matching schedule; drawer close restores the correct icon focus');
 await click(sel('del'));assert.equal(await js('calls.deleted.length'),0);assert.equal(await js('document.querySelectorAll(".sch-confirm").length'),1);
 await click('.sch-confirm [data-c=no]');assert.equal(await js('calls.deleted.length'),0);
 report.checks.push('Delete icon still requires the original in-card confirmation; cancel does not delete');
 const before=await js('document.querySelector('+JSON.stringify(sel('run'))+').getBoundingClientRect().width');
 await click(sel('run'));await until('!!window.releaseRun');
 assert.equal(await js('calls.runs.length'),1);
 assert.equal(await js('document.querySelector('+JSON.stringify(sel('run'))+').disabled'),true);
 assert.equal(await js('document.querySelector('+JSON.stringify(sel('run'))+').getBoundingClientRect().width'),before);
 assert.equal(await js('document.querySelector('+JSON.stringify(sel('run'))+').getAttribute("aria-busy")'),'true');
 await js('document.querySelector('+JSON.stringify(sel('run'))+').click()');assert.equal(await js('calls.runs.length'),1);
 await shot('submitting');
 await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 assert.equal(await js('getComputedStyle(document.querySelector(".sch-icon-action[aria-busy=true] svg")).animationName'),'none');
 await js('releaseRun({waitingForDevice:true})');await until('document.querySelector("#schRunLayer").classList.contains("show")&&!document.querySelector(".sch-icon-action:disabled")');
 assert.equal(await js('document.querySelector('+JSON.stringify(sel('run'))+').textContent'),'');await click('.sch-run-close');
 await click(sel('run'));await js('rejectRun(new Error("隔离测试：请求未成功"))');
 await until('notice.includes("没派出去")&&!document.querySelector(".sch-icon-action:disabled")');
 assert.equal(await js('document.querySelector('+JSON.stringify(sel('run'))+').querySelectorAll("svg").length'),1);
 report.checks.push('Pending run uses an accessible same-size spinner, duplicate clicks are blocked, success/failure restore the play icon, reduced motion stops rotation');
 await click('.sch-run-close');
 await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true});
 await until('matchMedia("(pointer:coarse)").matches');
 assert.equal(await js('document.querySelector(".sch-icon-action").getBoundingClientRect().width'),44);
 report.checks.push('Touch input enlarges each icon hit target to 44px');
 win.webContents.debugger.detach();
 assert.deepEqual(await js('errors'),[]);assert.deepEqual(requests,[]);
 report.ok=true;
}).catch(async e=>{report.error=e.stack;if(win){report.uiErrors=await js('window.errors||[]').catch(()=>[]);await shot('failure').catch(()=>{});}})
.finally(()=>{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(win)win.destroy();app.exit(report.ok?0:1);});
