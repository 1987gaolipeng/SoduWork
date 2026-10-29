// Isolated browser only: no running SoduWork window, user data or backend is touched.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';
const client=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.argv[2]||path.join(os.tmpdir(),'soduwork-page-themes-evidence'));
fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-page-themes-browser-'));
const browser='C:/Program Files/Google/Chrome/Application/chrome.exe';
const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1120,780','about:blank'],{windowsHide:true,stdio:'ignore'});
// Serve source through Node so Windows protected files are decoded consistently.
const server=http.createServer((req,res)=>{
  if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}
  const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(client,'.'+requested);
  if(!file.startsWith(client+path.sep)||!(/\.(html|js|css|woff2?|ttf|png|svg)$/.test(file))){res.writeHead(403).end();return;}
  try{res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html;charset=utf-8':'application/octet-stream');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let page;const checks=[],responsive=[];
try{
  let port;
  for(let i=0;i<80;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break;}catch{}await delay(100);}
  assert.ok(port,'isolated browser starts');
  page=await CdpPage.connect((await listPages(port))[0]);
  await page.call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/tests/workspace-page-themes.html'});
  await page.waitFor(()=>document.querySelectorAll('.rq-card').length===3,null,10000);
  await page.call('Page.bringToFront');
  await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
  const skins=await page.run(()=>SkinRegistry.getSkins().map(s=>({id:s.id,name:s.name,theme:s.palette,skin:s.material})));
  async function click(selector){
    const r=await page.run(s=>{const e=document.querySelector(s);if(!e)throw Error('Missing '+s);e.scrollIntoView({block:'nearest'});
      const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}},selector);
    for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...r,button:'left',clickCount:1});
    await delay(120);
  }
  async function shot(name){const s=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(s.data,'base64'));}
  const views=['schedules','history','briefs','skills','aidesk'];
  for(const skin of skins){
    await page.run(s=>{document.documentElement.dataset.theme=s.theme;document.documentElement.dataset.skin=s.skin},skin);
    await page.call('Emulation.setDeviceMetricsOverride',{width:1680,height:1000,deviceScaleFactor:1,mobile:false});
    for(const view of views){
      await click('[data-test-view="'+view+'"]');
      await delay(140);
      if(view==='skills')assert.ok(await page.run(()=>!!document.querySelector('#capContent')),'plugin page renders with fixture catalog');
      const result=await page.run(view=>{
        const ids={schedules:'schPanel',history:'historyBoard',briefs:'briefPanel',skills:'capPanel',aidesk:'aiDeskPanel'};
        const root=document.getElementById(ids[view]),head=root.querySelector('.ws-page-head'),s=getComputedStyle(head);
        const title=head.querySelector('.sch-h-title,#hbTitleText,h1,.dk-title-name'),kicker=head.querySelector('.sch-h-kicker,.hb-kicker,.br-kicker,.dk-title-kicker');
        const rect=e=>e.getBoundingClientRect(),r=rect(head);
        const probe=document.createElement('i');probe.style.color='var(--accent)';head.appendChild(probe);
        const accent=getComputedStyle(probe).color;probe.remove();
        const control=view==='history'?root.querySelector('.rq-scopes .on'):null;
        const small=[head,...root.querySelectorAll('.rq-card,.rq-controls')].flatMap(e=>[...e.querySelectorAll('*')])
          .filter(e=>rect(e).width && rect(e).height && getComputedStyle(e).visibility!=='hidden' &&
            [...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(e).fontSize)<12)
          .map(e=>({class:e.className,font:getComputedStyle(e).fontSize}));
        const actions=head.querySelector('.sch-h-acts,.hb-head-actions,.br-head-actions,.dk-acts');
        return {view,title:title.textContent,titleSize:getComputedStyle(title).fontSize,kickerDisplay:kicker?getComputedStyle(kicker).display:'none',
          padding:s.paddingLeft,height:r.height,background:s.backgroundColor,accent,kickerColor:kicker?getComputedStyle(kicker).color:null,
          control:control?getComputedStyle(control).color:null,
          overflow:head.scrollWidth>head.clientWidth+1,actionsFit:!actions||rect(actions).right<=r.right+1,small,
          icons:[...head.querySelectorAll('.sch-h-ico,.br-title-mark')].map(e=>getComputedStyle(e).display)};
      },view);
      assert.equal(result.titleSize,'18px',JSON.stringify(result));assert.equal(result.kickerDisplay,'none');
      assert.equal(result.padding,'28px');assert.equal(result.height,60,JSON.stringify(result));assert.equal(result.overflow,false);
      assert.equal(result.actionsFit,true);assert.deepEqual(result.small,[]);assert.ok(result.icons.every(x=>x==='none'));

      if(result.control)assert.equal(result.control,result.accent,skin.id+' '+view+' follows accent');
      checks.push({skin:skin.id,...result});
      if(skin.id==='bear-ruby'||(skin.id==='flat-azure'&&view==='history'))await shot(skin.id+'-'+view);
    }
  }
  for(const width of [1000,1280,2400]){
    await page.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    for(const view of views){
      await click('[data-test-view="'+view+'"]');
      const r=await page.run(()=>{
        const h=[...document.querySelectorAll('.ws-page-head')].find(e=>e.getBoundingClientRect().width>0);
        const p=h.parentElement;
        const body=p.querySelector('.sch-body,.br-body,.hb-body,.dk-main');
        return{overflow:h.scrollWidth>h.clientWidth+1,body:body.scrollWidth>body.clientWidth+1,
          panelOverflow:p.scrollWidth>p.clientWidth+1,window:document.documentElement.scrollWidth>innerWidth+1};
      });
      assert.equal(r.overflow,false,width+' '+view+' header');
      assert.equal(r.window,false,width+' '+view+' window');
      if(view==='history'||view==='history')assert.equal(r.panelOverflow,false,width+' '+view+' board');
      responsive.push({width,view,...r});
    }
  }
  await page.call('Emulation.setDeviceMetricsOverride',{width:1680,height:1000,deviceScaleFactor:1,mobile:false});
  await click('[data-test-view="aidesk"]');await click('#dkAgentManage');
  assert.ok(await page.run(()=>fixtureCalls.some(c=>c[0]==='agents')),'Agent management retains its original entry');
  await page.run(()=>{window.holdDeskRefresh=true});await click('#dkRefresh');
  assert.ok(await page.run(()=>document.querySelector('#dkRefresh').disabled),'refresh disables while loading');
  await page.run(()=>{window.holdDeskRefresh=false;window.finishDeskRefresh()});
  await page.waitFor(()=>!document.querySelector('#dkRefresh').disabled);
  assert.ok(await page.run(()=>fixtureCalls.filter(c=>c[0]==='desk-refresh').length>1));
  assert.equal(await page.run(()=>document.querySelector('#dkSub').textContent),'1 条运行中 · 2 条需要处理');
  const headShot=await page.call('Page.captureScreenshot',{format:'png',clip:{x:220,y:10,width:1450,height:100,scale:1}});
  fs.writeFileSync(path.join(output,'ai-team-header.png'),Buffer.from(headShot.data,'base64'));
  await click('[data-test-view="history"]');
  await click('.rq-card');
  await page.waitFor(() => !!document.querySelector('[data-rq-journey]'));
  await shot('requirement-details');
  await click('[data-rq-dismiss]');
  assert.ok(await page.run(()=>!document.querySelector('.rq-detail-backdrop')));
  await click('#hbAdd');
  assert.ok(await page.run(()=>fixtureCalls.some(c=>c[0]==='requirement')));
  await click('.rq-card');
  await page.waitFor(() => !!document.querySelector('[data-rq-journey]'));
  await click('[data-rq-journey]');
  assert.ok(await page.run(()=>fixtureCalls.some(c=>c[0]==='detail')));
  await page.run(()=>{const q=document.querySelector('#hbSearch');q.value='no-match';q.dispatchEvent(new Event('input',{bubbles:true}))});
  assert.equal(await page.run(()=>document.querySelectorAll('.rq-card').length),0);
  await click('.rq-menu-toggle');
  await click('[data-rq-clear]');
  assert.equal(await page.run(()=>document.querySelectorAll('.rq-card').length),3);
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await page.run(()=>document.querySelector('#hbAdd').focus());
  assert.equal(await page.run(()=>getComputedStyle(document.activeElement).outlineStyle),'solid');
  assert.deepEqual(await page.run(()=>fixtureErrors),[]);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({ok:true,checks,responsive,interactions:[
    '5 real page headers across all registered skins','3 additional desktop widths, no header/page overflow',
    'AI team Agent management entry, refresh loading/complete and live summary',
    'requirement details open/close',
    'unified requirement retains creation callback','task card retains detail navigation',
    'search empty/clear','keyboard focus ring','no renderer exceptions',
    'isolated mock data: no backend mutation or live client restart'
  ]},null,2));
  console.log(JSON.stringify({ok:true,skinPageChecks:checks.length,additionalWidths:[1000,1280,2400],output}));
}catch(error){
  if(page){
    const state=await page.run(()=>({errors:fixtureErrors,body:document.body.innerText.slice(-2200)})).catch(()=>({}));
    console.error(JSON.stringify({state,runtime:page.takeRuntimeErrors()}));
    try{const s=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'failure.png'),Buffer.from(s.data,'base64'));}catch{}
  }
  throw error;
}finally{
  if(page){try{await page.call('Browser.close')}catch{}page.close();}
  if(child.exitCode===null)child.kill();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
