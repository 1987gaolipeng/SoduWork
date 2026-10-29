'use strict';
// Local production CSS + real management-bar markup; no live client or backend.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const evidence=process.argv[2];
if(!evidence||!path.isAbsolute(evidence))throw Error('Absolute evidence directory required');
fs.mkdirSync(evidence,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-mcp-layout-profile-')));
const report={ok:false,checks:[],geometry:[]};let win;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function click(selector){
  const p=await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});
  await delay(100);
}
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1920,height:860,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const network=[];
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{network.push(details.url);callback({cancel:true})});
  await win.loadFile(path.join(__dirname,'fixtures/mcp-layout.html'));
  assert.equal(await js('window.fixtureReady'),true);
  for(const width of [1920,1440,1160,760,680,390,320]){
    win.setSize(width,860);await delay(100);
    const g=await js(`(()=>{const r=s=>{const b=document.querySelector(s).getBoundingClientRect();return{x:b.x,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}};const c=document.querySelector('.cap-content');return{viewport:innerWidth,narrow:matchMedia('(max-width:680px)').matches,bar:r('.cap-mcp-manage-bar'),title:r('.cap-mcp-manage-bar>div'),section:r('.cap-section'),sectionTitle:r('.cap-section-head'),importButton:r('[data-mcp-import]'),historyButton:r('[data-mcp-submissions]'),overflow:document.documentElement.scrollWidth>innerWidth||c.scrollWidth>c.clientWidth}})()`);
    report.geometry.push({width,...g});
    assert.ok(Math.abs(g.bar.x-g.section.x)<1&&Math.abs(g.bar.right-g.section.right)<1,JSON.stringify(g));
    assert.ok(Math.abs(g.title.x-g.sectionTitle.x)<1,JSON.stringify(g));
    assert.ok(g.bar.width<=1280&&g.bar.bottom<=g.section.top,JSON.stringify(g));
    assert.ok(g.historyButton.right<=g.bar.right&&g.importButton.x>=g.bar.x,JSON.stringify(g));
    assert.ok(g.importButton.right<=g.historyButton.x&&!g.overflow,JSON.stringify(g));
    assert.ok(g.importButton.height>=34&&g.historyButton.height>=34);
    if(g.narrow)assert.ok(g.importButton.top>=g.title.bottom,JSON.stringify(g));
    else assert.ok(g.importButton.x>=g.title.right,JSON.stringify(g));
    if(width===1920||width===390)fs.writeFileSync(path.join(evidence,'mcp-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  report.checks.push('1920–320px: heading and actions share the catalog frame; no overlap or horizontal overflow; narrow-screen actions wrap together');
  const colors=[];
  for(const theme of ['azure','warm','minimal','steady']){
    await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
    const typography=await js(`(()=>{const b=document.querySelector('.cap-mcp-manage-bar'),description=b.querySelector('span'),sample=document.createElement('span');sample.style.cssText='position:absolute;visibility:hidden;color:var(--ink-3);font-family:var(--font-ui)';document.body.append(sample);const result={body:getComputedStyle(description).fontFamily,content:getComputedStyle(sample).fontFamily,button:getComputedStyle(b.querySelector('button')).fontFamily,size:parseFloat(getComputedStyle(description).fontSize),ink:getComputedStyle(description).color,themeInk:getComputedStyle(sample).color};sample.remove();return result})()`);
    assert.equal(typography.body,typography.content);assert.equal(typography.button,typography.body);
    assert.ok(typography.size>=14);assert.equal(typography.ink,typography.themeInk);colors.push(typography.ink);
  }
  report.checks.push('Four themes preserve shared body/button fonts, readable description text and secondary theme colors');
  await js('document.documentElement.dataset.theme="azure"');
  win.setSize(1160,860);await delay(100);
  assert.equal(await js('document.querySelector(".cap-template-section").open'),false);
  await click('.cap-template-section>summary');
  assert.equal(await js('document.querySelector(".cap-template-section").open'),true);
  await click('.cap-template-section>summary');
  assert.equal(await js('document.querySelector(".cap-template-section").open'),false);
  report.checks.push('Trusted templates start collapsed and the native disclosure opens and closes');
  await click('[data-mcp-import]');assert.equal(await js('modalTitles.at(-1)'),'导入 MCP 配置');
  assert.equal(await js('document.querySelector("[data-mcp-import-do]").disabled'),true);
  await js('closeModal()');
  await click('[data-mcp-submissions]');assert.match(await js('modalTitles.at(-1)'),/共享/);
  await js('closeModal()');
  assert.deepEqual(await js('errors'),[]);assert.deepEqual(network,[]);
  report.checks.push('Real import/history buttons still open their dialogs; import remains disabled until validation; no network or business-data writes');
  report.ok=true;
}).catch(error=>{report.error=error.stack}).finally(()=>{
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));if(win&&!win.isDestroyed())win.destroy();app.exit(report.ok?0:1);
});
