'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {env, windowsHide:true, stdio:'inherit', timeout:120000});
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/requirements-fixed-create');
fs.mkdirSync(output, {recursive:true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-fixed-create-')));
app.disableHardwareAcceleration();
const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8').matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
  .map(match => pathToFileURL(path.join(client, match[1])).href);
const report = {ok:false, cases:[], errors:[], boundary:'Native wheel and pointer input, full desktop CSS, fixture APIs; no network or business data'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({show:false,width:1440,height:900,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_request,done)=>done({cancel:true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    const js = source => win.webContents.executeJavaScript(source, true);
    await win.loadFile(path.join(__dirname, 'fixtures/requirement-sheet-receipt.html'));
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{const n=document.createElement('link');n.rel='stylesheet';n.href=href;n.onload=resolve;n.onerror=reject;document.head.append(n)}))).then(()=>true)`);
    const snapshot = () => js(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,bottom:r.bottom,right:r.right,height:r.height}}, head=document.querySelector('.wes-head'),foot=document.querySelector('.wes-layer .cp-acts'),body=document.querySelector('.cp-form-scroll')||document.querySelector('.wes-body');return{head:rect(head),foot:rect(foot),body:rect(body),top:body.scrollTop,viewport:innerHeight,width:innerWidth,outer:document.querySelector('.pui-dialog').scrollTop,root:document.scrollingElement.scrollTop,footVisible:foot.contains(document.elementFromPoint(foot.getBoundingClientRect().x+30,foot.getBoundingClientRect().y+20)),materials:!!body.querySelector('.wes-attach-zone')}})()`);
    for (const [width,height,zoom,overlay] of [[1440,900,1,false],[600,650,1,true],[390,650,1,false],[960,700,1.25,true]]) {
      const label = `${width}-${height}-${zoom}-${overlay?'overlay':'native'}`;
      win.setContentSize(width,height); win.webContents.setZoomFactor(zoom);
      await js(`document.documentElement.dataset.windowTitlebar=${JSON.stringify(overlay?'overlay':'native')};openSheet()`); await wait(160);
      // Measure fixed geometry only after the drawer opening transition finishes.
      await js(`Promise.all(document.querySelector('.pui-dialog').getAnimations({subtree:true}).filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})))`);
      const before = await snapshot();
      assert.ok(before.foot.y >= before.head.bottom && before.foot.bottom <= before.viewport + 1, label+': actions are visible before scrolling');
      assert.ok(before.footVisible, label+': footer accepts pointer input');
      assert.ok(before.materials, label+': attachments share the form scroller');
      const x = Math.round((before.body.x + before.body.right)/2*zoom), y = Math.round((before.body.y+before.body.bottom)/2*zoom);
      for (let i=0;i<6;i++) { win.webContents.sendInputEvent({type:'mouseWheel',x,y,deltaY:-420,deltaX:0,canScroll:true}); await wait(60); }
      const after = await snapshot();
      assert.ok(after.top>0,label+': native wheel scrolls the form');
      assert.deepEqual(after.head,before.head,label+': header stays fixed');
      assert.deepEqual(after.foot,before.foot,label+': actions stay fixed');
      assert.equal(after.outer,0,label+': drawer shell does not scroll');
      assert.equal(after.root,0,label+': document does not scroll');
      assert.ok(after.footVisible,label+': scrolled actions remain clickable');
      const attachments = await js(`(()=>{const n=document.querySelector('.wes-attach-zone');n.scrollIntoView({block:'nearest',behavior:'instant'});return n.getBoundingClientRect().bottom})()`);
      assert.ok(attachments <= after.foot.y+1,label+': final attachment section is not obscured');
      await js(`window.originalMaterials=document.querySelector('.wes-attach-zone');window.materialEvents=0;originalMaterials.addEventListener('fixture-retained',()=>materialEvents++);ComposeDraft.repaint();void 0`);
      assert.ok(await js(`originalMaterials===document.querySelector('.cp-form-scroll .wes-attach-zone')`),label+': repaint retains the original attachment tray');
      assert.equal(await js(`originalMaterials.dispatchEvent(new Event('fixture-retained'));materialEvents`),1,label+': attachment listeners survive repaint');
      const owner = await js(`(()=>{const n=document.querySelector('[data-selbtn="who"]');n.scrollIntoView({block:'center',behavior:'instant'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for(const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,x:Math.round(owner.x*zoom),y:Math.round(owner.y*zoom),button:'left',clickCount:1});
      await wait(100);
      const picker = await js(`(()=>{const popup=document.querySelector('.cp-sel.open .cp-selpop'), r=popup?.getBoundingClientRect(), scroller=document.querySelector('.cp-form-scroll').getBoundingClientRect();return r&&{height:r.height,top:r.top,bottom:r.bottom,within:r.top>=scroller.top&&r.bottom<=scroller.bottom+1}})()`);
      assert.ok(picker?.height>50&&picker.within,label+': owner picker fits inside the form viewport');
      await js(`document.querySelector('#cpTitle').focus();document.body.click();void 0`);
      await wait(70); fs.writeFileSync(path.join(output,label+'.png'),(await win.webContents.capturePage()).toPNG());
      const button=await js(`(()=>{const r=document.querySelector('#cpCancel').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for(const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,x:Math.round(button.x*zoom),y:Math.round(button.y*zoom),button:'left',clickCount:1});
      await wait(80); assert.equal(await js('Boolean(WorkEntrySheet.active())'),false,label+': native cancel still closes the draft');
      report.cases.push({label,before,after});
    }
    assert.deepEqual(report.errors,[]); report.ok=true;
  } catch(error) {report.error=String(error.stack||error);if(win)fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());}
  finally {fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,cases:report.cases.length,error:report.error,output}));app.exit(report.ok?0:1);}
});
