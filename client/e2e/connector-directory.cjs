'use strict';
const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const out=path.resolve(__dirname,'../../outputs/connector-layout-20261017');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
const report={ok:false,checks:[]};let win;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=source=>win.webContents.executeJavaScript(source,true);
const page=(fn,...args)=>js('('+fn.toString()+')('+args.map(value=>JSON.stringify(value)).join(',')+')');
async function wait(source){
 for(let i=0;i<120;i++){if(await js(source))return;await delay(30);}
 throw Error('Timeout '+source);
}
async function click(selector){
 await page(selector=>document.querySelector(selector).scrollIntoView({block:'center'}),selector);
 const point=await page(selector=>{
  const el=document.querySelector(selector),r=el.getBoundingClientRect();
  const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
  return{x,y,visible:r.width>0&&r.height>0,hit:el.contains(document.elementFromPoint(x,y))};
 },selector);
 assert.ok(point.visible&&point.hit,'点击目标必须可见且没有被遮挡：'+selector+' '+JSON.stringify(point));
 win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});
 for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:point.x,y:point.y});
 await delay(60);
}
async function fill(selector,value){
 await page((selector,value)=>{const el=document.querySelector(selector);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},selector,value);
}
const count=()=>js('document.querySelectorAll("[data-connection-key]").length');
const modalClosed=()=>js('!document.querySelector("#capModalLayer")||document.querySelector("#capModalLayer").hidden');
async function shot(name){await delay(160);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function checkGeometry(width,columns){
 win.setContentSize(width,780);await delay(80);
 const geometry=await page(()=>{
  const mine=document.querySelector('[data-my-connections]'),common=document.querySelector('[data-connector-library]');
  const grid=el=>({columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,
   fits:el.scrollWidth<=el.clientWidth+1,ownScroll:el.scrollHeight>el.clientHeight+1&&/auto|scroll/.test(getComputedStyle(el).overflowY),
   cards:[...el.children].filter(x=>!x.hidden).map(x=>{const r=x.getBoundingClientRect();return{left:r.left,right:r.right};})});
  const scrollParents=[];
  for(let el=common.parentElement;el;el=el.parentElement){
   if(el.scrollHeight>el.clientHeight+1&&/auto|scroll/.test(getComputedStyle(el).overflowY))scrollParents.push(el.id||el.className);
  }
  return{width:innerWidth,documentWidth:document.documentElement.scrollWidth,mine:grid(mine),common:grid(common),scrollParents,
   ordered:mine.getBoundingClientRect().bottom<=common.getBoundingClientRect().top,
   noSeparateSearch:!document.querySelector('[data-connector-search]')};
 });
 assert.equal(geometry.mine.columns,columns,JSON.stringify(geometry));
 assert.equal(geometry.common.columns,columns,JSON.stringify(geometry));
 assert.ok(geometry.ordered&&geometry.noSeparateSearch,JSON.stringify(geometry));
 assert.ok(geometry.documentWidth<=geometry.width+1,JSON.stringify(geometry));
 for(const grid of [geometry.mine,geometry.common]){
  assert.ok(grid.fits&&!grid.ownScroll,JSON.stringify(geometry));
  assert.ok(grid.cards.every(card=>card.left>=0&&card.right<=geometry.width+1),JSON.stringify(geometry));
 }
 assert.deepEqual(geometry.scrollParents,['capContent'],'两区应共用页面滚动，不增加内嵌滚动：'+JSON.stringify(geometry));
 await page(()=>{document.querySelector('#capContent').scrollTo({top:0,behavior:'instant'});});
 if(width===1180||width===390)await shot('connections-'+(width===1180?'wide':'narrow'));
 await click('#capAddButton');
 assert.equal(await modalClosed(),true,'添加连接应定位页面常用区，不另开目录弹层');
 await wait('document.querySelector("[data-connector-library]").getBoundingClientRect().top<innerHeight&&document.querySelector("#capContent").scrollTop>0');
 const located=await page(()=>{const content=document.querySelector('#capContent');const grid=document.querySelector('[data-connector-library]').getBoundingClientRect();return{scroll:content.scrollTop,top:grid.top,bottom:grid.bottom,height:innerHeight};});
 assert.ok(located.scroll>0&&located.top<located.height&&located.bottom>0,JSON.stringify(located));
 if(width===1180||width===390)await shot('catalog-'+(width===1180?'wide':'narrow'));
 report.checks.push('两区共用页面滚动且同步 '+columns+' 列：'+width+'px');
}
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 await win.loadFile(path.join(__dirname,'fixtures/connector-directory.html'));
 await wait('document.querySelector("[data-cap-tab=connections]")');await click('[data-cap-tab=connections]');
 await wait('document.querySelectorAll("[data-connection-key]").length===5&&document.querySelectorAll(".connector-library-card").length===55');
 const initial=await page(()=>({titles:[...document.querySelectorAll('#myConnectorsHeading,#commonConnectorsHeading')].map(el=>el.textContent.trim()),
  initialAuth:!!document.querySelector('[data-connection-key="native:dingtalk"]'),duplicateFeishu:!!document.querySelector('[data-connection-key^="personal:soduwork-feishu-"]'),
  count:document.querySelector('[data-my-connection-count]').textContent}));
 assert.equal(initial.initialAuth,false);assert.equal(initial.duplicateFeishu,false);assert.equal(initial.count,'5');
 assert.ok(initial.titles[0].startsWith('我的连接器')&&initial.titles[1].startsWith('常用连接器'),JSON.stringify(initial));
 assert.equal(await modalClosed(),true);
 report.checks.push('页面直接展示我的连接器与常用连接器，原生和企业来源正确且飞书去重');
 await fill('#capSearch','Figma');
 assert.equal(await count(),1);assert.equal(await js('document.querySelectorAll(".connector-library-card:not([hidden])").length'),1);
 assert.equal(await js('document.querySelector("[data-template=connector-figma] .connector-library-action").textContent'),'已添加 · 管理');
 await click('[data-template=connector-figma]');await wait('document.querySelector("#capMcpName")');
 assert.equal(await js('document.querySelector("#capMcpName").value'),'Figma 工作账号');
 await click('#capModalBody details summary');await click('#capMcpAnother');
 await wait('document.querySelector("#capMcpName").value==="Figma"');
 assert.equal(await js('document.querySelector("[data-connector-field=FIGMA_TOKEN]").value'),'');
 await click('#capModalCancel');
 assert.equal(await modalClosed(),true);
 report.checks.push('顶部统一搜索两区，已有账号直接管理且能新增第二个账号');
 await fill('#capSearch','not-a-product');
 assert.equal(await count(),0);assert.equal(await js('document.querySelector("[data-library-empty]").hidden'),false);
 assert.equal(await js('document.querySelector("[data-connections-empty]").hidden'),false);
 await fill('#capSearch','');await wait('document.querySelectorAll("[data-connection-key]").length===5');
 report.checks.push('搜索空结果分别提示，清空后两区恢复');
 await js('failSelection=true');await click('[data-company-connect="company-2"]');
 await wait('document.querySelector("[data-company-connect=\\"company-2\\"] .connector-library-action").textContent.includes("重试")');
 assert.equal(await js('selectionWrites'),1);
 await js('failSelection=false;holdSelection=true');await click('[data-company-connect="company-2"]');
 await js('document.querySelector("[data-company-connect=\\"company-2\\"]").click()');
 await wait('!!finishSelection');assert.equal(await js('selectionWrites'),2);
 await js('holdSelection=false;finishSelection()');
 await wait('document.querySelector("[data-company-connect=\\"company-2\\"] .connector-library-action").textContent==="已添加 · 管理"');
 assert.equal(await js('connectionData.enabledCompany.filter(x=>x==="CRM").length'),1);assert.equal(await count(),6);
 report.checks.push('企业添加失败可原位重试，重复点击不增加写入或重复连接');
 await js('window.beforeRow=document.querySelector("[data-connection-key=\\"personal:figma-1\\"]");window.beforeCatalog=document.querySelector("[data-template=connector-figma]")');
 await click('[data-connection-key="personal:figma-1"] summary');await click('[data-toggle-mcp="figma-1"]');
 await wait('connectionData.personal.find(x=>x.id==="figma-1").enabled');
 assert.equal(await js('beforeRow===document.querySelector("[data-connection-key=\\"personal:figma-1\\"]")&&beforeCatalog===document.querySelector("[data-template=connector-figma]")'),true);
 report.checks.push('启停仅更新原卡片状态，不重建任一目录');
 await click('[data-connection-manage="native:wecom"]');await wait('document.querySelector("[data-native-disconnect]")');
 await click('[data-native-disconnect]');
 assert.equal(await js('document.querySelector("[data-connection-key=\\"native:wecom\\"] .connector-state").textContent'),'已断开');
 assert.equal(await count(),6);assert.equal(await js('document.querySelector("[data-platform-connect=wecom] .connector-library-action").textContent'),'已添加 · 管理');
 report.checks.push('原生账号断开后保留在我的连接器，常用卡片状态同步');
 await click('[data-connector-import]');await wait('document.querySelector("[data-mcp-file]")');await click('#capModalClose');
 report.checks.push('常用连接器区域可直接导入配置');
 for(const [width,columns] of [[1180,3],[760,2],[390,1]])await checkGeometry(width,columns);
 // Compare against the original card HTML and shared CSS rather than treating new thresholds as the baseline design.
 win.webContents.sendInputEvent({type:'mouseMove',x:1,y:1});
 report.legacyStyle=[];
 for(const theme of ['azure','warm','minimal','steady']){
  await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
  const styles=await page(()=>{
   const reference=document.createElement('section');reference.className='cap-section cap-template-section';
   reference.style.cssText='position:absolute;left:-10000px;top:0;width:340px;pointer-events:none';
   reference.innerHTML='<button class="cap-template cap-mcp-card"><span class="cap-card-icon cap-plugin-brand cap-ability-icon icon-mcp"><img class="cap-connector-product-icon" src="assets/connector-brands/figma.svg"></span><span class="cap-template-copy"><b>Figma</b><span>读取设计文件、查看项目与评论</span><em>只读 · 待配置</em></span></button>';
   document.querySelector('#capContent').append(reference);
   const pick=(el,keys)=>{const style=getComputedStyle(el);return Object.fromEntries(keys.map(key=>[key,style[key]]));};
   const inspect=el=>({
    card:pick(el,['display','alignItems','columnGap','minHeight','paddingTop','paddingBottom','paddingLeft','borderTopWidth','borderTopStyle','borderTopColor','borderRadius','backgroundColor']),
    icon:pick(el.querySelector('.cap-ability-icon'),['width','height','flexBasis','borderRadius','backgroundColor']),
    title:pick(el.querySelector('.cap-template-copy>b'),['fontSize','fontWeight','lineHeight','color','marginBottom']),
    description:pick(el.querySelector('.cap-template-copy>span'),['fontSize','fontWeight','lineHeight','color','display','webkitLineClamp']),
    meta:pick(el.querySelector('.cap-template-copy>em'),['fontSize','fontWeight','lineHeight','marginTop']),
    copy:pick(el.querySelector('.cap-template-copy'),['display','flex','webkitLineClamp'])
   });
   const result={reference:inspect(reference.firstElementChild),mine:inspect(document.querySelector('[data-connection-key="personal:figma-1"]')),common:inspect(document.querySelector('[data-template="connector-figma"]'))};
   reference.remove();return result;
  });
  assert.deepEqual(styles.common,styles.reference,'常用区应复用旧卡原样式：'+theme);
  assert.deepEqual(styles.mine,styles.reference,'我的区应复用旧卡原样式：'+theme);
  assert.equal(styles.reference.card.minHeight,'104px');
  assert.equal(styles.reference.title.fontSize,'15px');assert.equal(styles.reference.description.fontSize,'13px');
  report.legacyStyle.push({theme,...styles.reference});
 }
 report.checks.push('四种皮肤的两区卡片均与原常用卡实际样式一致：104px、原图标及原字体');
 await click('[data-connector-custom]');await wait('document.querySelector("#capMcpQuickConfig")');await click('#capModalCancel');
 report.checks.push('连接地址方式仍可直接创建');
 win.setContentSize(1180,850);await delay(80);
 await js('connectionData.personal.push({id:"readonly-1",name:"Managed storage",templateKey:"readonly-template",description:"Built-in storage",enabled:true,builtIn:true,canEdit:false});catalog.mcpTemplates.push({key:"readonly-template",name:"Managed storage",description:"Built-in storage"});openCapabilityPanel()');
 await wait('document.querySelectorAll("[data-connection-key]").length===7');
 await fill('#capSearch','Managed storage');await click('[data-template="readonly-template"]');
 await wait('document.querySelector("[data-readonly-toggle]")');assert.equal(await js('!!document.querySelector("#capMcpSave")'),false);
 await click('[data-readonly-toggle]');await wait('connectionData.personal.find(x=>x.id==="readonly-1").enabled===false');await click('#capModalClose');
 report.checks.push('系统维护的连接器可管理启停，不进入不允许保存的编辑器');
 await fill('#capSearch','Figma');await click('[data-template=connector-figma]');await wait('document.querySelector("#capMcpName")');
 await click('#capModalBody details summary');await click('#capMcpAnother');await wait('document.querySelector("#capMcpName").value==="Figma"');
 await fill('[data-connector-field=FIGMA_TOKEN]','fixture-token-not-real');
 await click('#capModalBody details summary');await fill('#capMcpName','Figma 第二账号');await click('#capMcpSave');
 await wait('document.querySelector("#capModalLayer").hidden&&document.querySelectorAll("[data-connection-key]").length===2');
 assert.deepEqual(await js('requests.slice(-3).map(x=>x.action)'),['preflight','probe','save']);
 assert.equal(await js('saved.at(-1).enabled'),true);assert.equal(await js('saved.at(-1).name'),'Figma 第二账号');
 await fill('#capSearch','');assert.equal(await count(),8);
 assert.equal(await js('document.querySelector("[data-template=connector-figma] .connector-library-action").textContent'),'已添加 · 管理');
 report.checks.push('新账号完成预检、探测与保存后同步回流两区，原有连接不被替换');
 await click('[data-template=connector-figma]');await wait('document.querySelectorAll(".connector-account-choice").length===2');
 await click('.connector-account-choice');await wait('document.querySelector("#capMcpName").value==="Figma 工作账号"');
 await click('#capModalCancel');report.checks.push('多个账号可选择管理，原有账号仍可访问');
 assert.deepEqual(await js('errors'),[]);report.ok=true;
}catch(error){
 report.error=error.stack;if(win){report.runtimeErrors=await js('errors');await shot('failure');}
}finally{
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));app.exit(report.ok?0:1);
}});
