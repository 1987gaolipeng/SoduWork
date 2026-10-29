'use strict';
// Production workbench components; fresh offscreen profile, fixture records, no hub/Agent calls.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const output=process.argv[2];
if(!output||!path.isAbsolute(output))throw Error('Pass an absolute evidence directory');
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-team-empty-')));
const report={ok:false,checks:[],layouts:[],screenshots:[]};let win;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(code){for(let i=0;i<100;i++){if(await js(code))return;await wait(40);}throw Error('Timeout: '+code);}
async function shot(name){await wait(100);const file=path.join(output,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());report.screenshots.push(file);}
async function click(selector){
  const point=await js('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await wait(80);
}
async function layout(width,height,stacked,inset=0){
  win.setSize(width,height);await js('document.querySelector("#aiDeskPanel").style.left='+JSON.stringify(inset+'px'));await wait(100);
  const result=await js(`(()=>{
    const q=s=>document.querySelector(s),r=e=>e.getBoundingClientRect(),empty=q('.aio-flow-empty'),content=q('.aio-empty-content');
    const elements=[empty,...empty.querySelectorAll('*')],intro=r(q('.aio-empty-intro')),guide=r(q('.aio-empty-guide')),er=r(empty),cr=r(content);
    const text=elements.filter(e=>[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));
    return {stacked:guide.top>=intro.bottom-1,overflow:elements.filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).display!=='inline').map(e=>e.className),
      pageOverflow:document.documentElement.scrollWidth>innerWidth,
      centered:Math.abs((cr.left+cr.right)-(er.left+er.right))<2,
      tiny:text.filter(e=>parseFloat(getComputedStyle(e).fontSize)<12).map(e=>e.className),
      images:elements.flatMap(e=>['','::before','::after'].map(p=>getComputedStyle(e,p||null).backgroundImage)).filter(v=>v!=='none'),
      width:cr.width,titleFont:getComputedStyle(q('#aioEmptyTitle')).fontSize,
      mainBackground:getComputedStyle(q('.aio-work-list')).backgroundColor,emptyBackground:getComputedStyle(empty).backgroundColor};
  })()`);
  assert.equal(result.stacked,stacked,JSON.stringify({width,inset,result}));
  assert.deepEqual(result.overflow,[]);assert.deepEqual(result.tiny,[]);assert.deepEqual(result.images,[]);
  assert.equal(result.pageOverflow,false);assert.equal(result.centered,true);assert.ok(result.width<=900.5);
  assert.equal(result.mainBackground,result.emptyBackground);
  report.layouts.push({width,height,inset,...result});
}
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  report.blockedNetwork=[];
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,cb)=>{report.blockedNetwork.push(request.url);cb({cancel:true});});
  await win.loadFile(path.join(__dirname,'fixtures/ai-team-empty.html'));
  await until('!!document.querySelector(".aio-empty-primary")');
  await until('[...document.querySelectorAll(".aio-agent-avatar img")].every(img=>img.complete&&img.naturalWidth>0)');
  assert.equal(await js('document.querySelector("#aioEmptyTitle").textContent'),'从第一项工作开始');
  assert.equal(await js('document.querySelectorAll(".aio-work-item").length'),0);
  assert.equal(await js('document.querySelectorAll(".aio-empty-guide li").length'),3);
  assert.equal(await js('!!document.querySelector(".aio-empty-connection")'),false);
  for(const [width,height,stacked] of [[1600,1000,false],[1100,900,false],[760,900,true],[390,844,true]]){
    await layout(width,height,stacked);await shot('empty-'+width);
  }
  await layout(1100,900,true,380);await shot('sidebar-constrained');
  await layout(390,440,true);
  await click('[data-office-new-chat]');
  assert.deepEqual(await js('navigations.at(-1)'),{view:'create',options:{newSession:true}});
  report.checks.push('Pure-color empty state, no gradients or undersized text; centered content and reachable action at wide, narrow, short and sidebar-constrained sizes');
  await layout(1100,900,false);
  const backgrounds=[];
  for(const theme of ['azure','ruby','minimal','steady','warm']){
    await js('document.documentElement.dataset.theme='+JSON.stringify(theme));await layout(1100,900,false);
    backgrounds.push(await js('getComputedStyle(document.querySelector(".aio-flow-empty")).backgroundColor'));
    assert.equal(await js('getComputedStyle(document.querySelector(".aio-empty-intro p")).fontFamily===getComputedStyle(document.querySelector(".aio-office")).fontFamily'),true);
    await shot('theme-'+theme);
  }
  assert.ok(new Set(backgrounds).size>=3);
  for(const scale of [.88,1.2]){
    await js('document.documentElement.style.setProperty("--font-scale",'+JSON.stringify(String(scale))+')');
    await layout(390,844,true);
  }
  report.checks.push('Five themes use their own solid surfaces and product fonts; small and large global type scales retain a 12px floor without overflow');
  await js('document.documentElement.style.removeProperty("--font-scale");document.documentElement.dataset.theme="azure"');
  await layout(1100,900,false);
  await click('[data-open-task-center]');
  assert.deepEqual(await js('navigations.at(-1)'),{view:'history'});
  await js('window.savedIntro=document.querySelector(".aio-flow-empty");document.querySelector("[data-office-new-chat]").focus();_renderDesks();_renderDesks()');
  assert.equal(await js('savedIntro===document.querySelector(".aio-flow-empty")&&document.activeElement.matches("[data-office-new-chat]")'),true);
  const count=await js('navigations.length');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'ENTER'});
  win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'ENTER'});
  await until('navigations.length==='+String(count+1));
  assert.deepEqual(await js('navigations.at(-1)'),{view:'create',options:{newSession:true}});
  report.checks.push('New conversation and action-item entries route once through existing APIs; keyboard focus survives unchanged data refresh');
  await js('setFixture("offline")');
  assert.equal(await js('document.querySelector(".aio-empty-connection").textContent.includes("还没有在线 Agent")'),true);
  assert.equal(await js('document.querySelector(".aio-flow-empty").textContent.includes("已经就绪")'),false);
  await click('.aio-empty-connection [data-open-agents]');
  assert.deepEqual(await js('navigations.at(-1)'),{view:'agents'});
  await shot('offline');
  await js('setFixture("new")');
  assert.equal(await js('!!document.querySelector(".aio-empty-connection")'),false);
  report.checks.push('Disconnected users receive truthful connection guidance; Agent management works and the hint disappears after connecting');
  await js('setFixture("done")');
  assert.equal(await js('document.querySelector("#aioEmptyTitle").textContent'),'没有进行中的需求');
  assert.equal(await js('document.querySelectorAll(".aio-delivery-item").length'),1);
  assert.equal(await js('document.querySelector("#aioDeliveryContent").hidden'),true);
  assert.equal(await js('document.querySelector("#aioDeliveryToggle").getAttribute("aria-expanded")'),'false');
  await click('#aioDeliveryToggle');
  assert.equal(await js('document.querySelector("#aioDeliveryContent").hidden'),false);
  await js('_deskData.tasks[0].title="更新后的交付";_renderDesks();_renderDesks()');
  assert.equal(await js('document.querySelector("#aioDeliveryContent").hidden'),false);
  assert.equal(await js('document.activeElement.id'),'aioDeliveryToggle');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'SPACE'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'SPACE'});
  await until('document.querySelector("#aioDeliveryContent").hidden');
  await click('#aioDeliveryToggle');
  await click('.aio-delivery-item');
  assert.equal((await js('navigations.at(-1)')).id,'delivered-1');
  report.checks.push('Recent deliveries default to collapsed; mouse and keyboard toggle them, real data refresh preserves the choice and focus, and delivery navigation remains available');
  await js('setFixture("active")');
  assert.equal(await js('!!document.querySelector(".aio-flow-empty")'),false);
  await click('[data-ros="codex"]');
  assert.equal(await js('document.querySelector("#aioEmptyTitle").textContent'),'这个席位暂时没有需求');
  await click('[data-office-overview]');
  assert.equal(await js('document.querySelectorAll(".aio-work-item").length'),1);
  await click('[data-office-phase="attention"]');
  assert.equal(await js('!!document.querySelector(".aio-filter-empty")&&!document.querySelector(".aio-flow-empty")'),true);
  await click('.aio-filter-empty [data-office-phase="all"]');
  await click('.aio-work-item');
  assert.equal((await js('navigations.at(-1)')).id,'active-1');
  report.checks.push('New user, delivered-only, empty Agent selection and filtered empty states stay distinct; existing task and delivery navigation is unchanged');
  // Isolated visual records exercise real renderer, themes, translation and events.
  await js(`_deskData.tasks=[
    {id:'compact-1',title:'整理本周项目进展与交付材料',phase:'running',deskKey:'pi',cli:'Pi',agent:'Pi',lastAction:'正在整理材料'},
    {id:'compact-2',title:'确认产品方案与验收标准',phase:'waiting',deskKey:'codex',cli:'Codex',agent:'Codex',workflow:{waitingOn:['负责人']}},
    {id:'compact-3',title:'生成分析报告与演示文稿',phase:'failed',deskKey:'pi',cli:'OpenCode',agent:'OpenCode',workflow:{error:'需要补充资料后继续'}},
    {id:'compact-4',title:'核对项目需求、素材与最终交付说明，检查长标题的两行排版和详情入口',phase:'dispatching',deskKey:'codex',cli:'Qwen',agent:'Qwen Code',lastAction:'等待执行'},
    {id:'compact-done',title:'本周团队简报',phase:'done',deskKey:'pi',cli:'Pi',agent:'Pi',artifacts:2}
  ]; _dkPick='__all__';_dkPhase='all';_dkOfficeDeliveriesOpen=false;_renderDesks()`);
  for(const locale of ['zh-CN','en-US']){
    await js('SoduWorkI18n.setLocale('+JSON.stringify(locale)+',{persist:false,broadcast:false})');
    await until('document.querySelector("#aioDeliveryTitle").textContent==='+JSON.stringify(locale==='en-US'?'Recent deliveries':'最近交付'));
    assert.equal(await js('document.querySelector("[data-office-enter-task=compact-1] h3").textContent'),'整理本周项目进展与交付材料');
    for(const [width,height,inset] of [[1600,1000,0],[1100,800,0],[920,800,320],[390,844,0]]){
      win.setSize(width,height);await js('document.querySelector("#aiDeskPanel").style.left='+JSON.stringify(inset+'px'));await wait(100);
      const result=await js(`(()=>{
        const cards=[...document.querySelectorAll('.aio-work-item')],rect=e=>e.getBoundingClientRect();
        return {heights:cards.map(e=>rect(e).height),icon:rect(cards[0].querySelector('.aio-work-bot')).width,
          overflow:document.documentElement.scrollWidth>innerWidth,
          clipped:cards.flatMap(c=>[...c.querySelectorAll('header,h3,.aio-work-footer,.aio-work-open')].filter(e=>rect(e).right>rect(c).right+.5||rect(e).bottom>rect(c).bottom+.5).map(e=>e.className)),
          tiny:cards.flatMap(c=>[...c.querySelectorAll('*')].filter(e=>[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(e).fontSize)<12).map(e=>e.className)),
          filterOverflow:[...document.querySelectorAll('.aio-office-filters button')].some(e=>e.scrollWidth>e.clientWidth+1),
          deliveryVisible:document.querySelector('#aioDeliveryContent').getBoundingClientRect().height>0};
      })()`);
      assert.equal(result.overflow,false);assert.equal(result.filterOverflow,false);assert.deepEqual(result.clipped,[]);assert.deepEqual(result.tiny,[]);
      assert.ok(result.heights.every(h=>h>=145&&h<180),JSON.stringify(result));assert.equal(result.icon,28);assert.equal(result.deliveryVisible,false);
      report.layouts.push({locale,width,height,inset,...result});await shot('compact-'+locale+'-'+width);
    }
    await click('#aioDeliveryToggle');
    await js('_deskData.tasks[0].lastAction="AI 执行";_renderDesks()');
    await until('document.querySelector("#aioDeliveryTitle").textContent==='+JSON.stringify(locale==='en-US'?'Recent deliveries':'最近交付'));
    assert.equal(await js('document.querySelector("#aioDeliveryContent").hidden'),false);
    await click('.aio-delivery-item');assert.equal((await js('navigations.at(-1)')).id,'compact-done');
    await click('#aioDeliveryToggle');
  }
  win.setSize(1600,1000);await js('SoduWorkI18n.setLocale("zh-CN",{persist:false,broadcast:false});document.documentElement.dataset.theme="ruby"');
  await shot('compact-theme-ruby');
  await js('document.documentElement.dataset.theme="azure"');
  report.checks.push('Compact task cards preserve readable text and action targets in Chinese/English at desktop, narrow and sidebar-constrained widths; locale changes and data refresh preserve delivery expansion');
  assert.deepEqual(await js('errors'),[]);
  await win.loadFile(path.join(__dirname,'../tests/render-skip.html'));
  await until('document.querySelector("#out").textContent.includes("render skip smoke:")');
  report.renderSmoke=await js('document.querySelector("#out").textContent');
  assert.match(report.renderSmoke,/0 failed/);
  report.checks.push('Existing production renderer smoke remains green, including state changes, empty roster and no needless DOM reconstruction');
  assert.deepEqual(report.blockedNetwork,[]);
  report.ok=true;
}).catch(async error=>{report.error=error.stack;if(win){report.uiErrors=await js('window.errors||[]').catch(()=>[]);await shot('failure').catch(()=>{});}})
.finally(()=>{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,checks:report.checks,error:report.error,uiErrors:report.uiErrors,output}));if(win)win.destroy();app.exit(report.ok?0:1);});
