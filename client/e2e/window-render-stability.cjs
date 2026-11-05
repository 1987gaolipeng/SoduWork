'use strict';
// Real Electron layout/DOM regression with isolated fixture data; no Hub/model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const output = process.argv[2], observe = process.argv.includes('--observe');
if (!output || !path.isAbsolute(output)) throw Error('Pass an absolute evidence directory');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-render-stability-')));
app.commandLine.appendSwitch('disable-lcd-text');
let win;
const report = { ok: false, observe, layouts: [], screenshots: [], checks: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = async code => {
  const result = await win.webContents.executeJavaScript(`(() => { try { return eval(${JSON.stringify(code)}); }
    catch (error) { return { __fixtureError: error.stack || String(error) }; } })()`, true);
  if (result?.__fixtureError) throw new Error(result.__fixtureError);
  return result;
};
async function shot(name) {
  const file = path.join(output, name + '.png');
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  report.screenshots.push(file);
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1366, height: 768, webPreferences: {
    offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
  await win.loadFile(path.join(__dirname, 'fixtures/ai-team-empty.html'));
  await js(`(() => {
    for (const href of ['components/panels/panels-base.css','components/workspace/workspace-shell.css','theme/workspace-page-heads.css']) {
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; document.head.append(link);
    }
    document.documentElement.dataset.deskPanel = 'workspace';
    document.documentElement.dataset.workspaceView = 'aidesk';
    document.documentElement.style.setProperty('--ws-side-w', '240px');
    document.querySelector('.dk-head').insertAdjacentHTML('beforeend', '<div class="dk-acts"><button class="dk-agent-manage">Agent 管理</button><button class="dk-refresh">刷新</button></div>');
    setFixture('active');
    const base = _deskData.tasks[0];
    _deskData.tasks = Array.from({length:12}, (_, i) => ({...base, id:'work-'+i,
      title:'研发自动化任务 '+(i+1),lastAction:'正在核验需求、实现代码和测试结果',artifacts:2}));
    _deskData.tasks.push(...Array.from({length:8}, (_, i) => ({...base,id:'done-'+i,phase:'done',title:'交付成果 '+(i+1),artifacts:3})));
    _deskData.summary = {running:12,done:8}; _renderDesks();
  })()`);
  await wait(250);
  report.refresh = await js(`(() => {
    const root = document.querySelector('.aio-office'), card = document.querySelector('.aio-work-item');
    const icon = card.querySelector('svg, img'); card.focus({preventScroll:true});
    const list = document.querySelector('.aio-work-list'); list.scrollTop = 80;
    for (let i=0;i<40;i++) { _deskData.tasks[0].usage={tokens:i}; _deskData.tasks[0].updatedAt=i; _renderDesks(); }
    const unchanged = {root:root===document.querySelector('.aio-office'),card:card===document.querySelector('.aio-work-item'),focus:document.activeElement===card};
    for(let i=0;i<30;i++) { _deskData.tasks[0].lastAction='执行步骤 '+i; _renderDesks(); }
    const changed = {root:root===document.querySelector('.aio-office'),card:card===document.querySelector('.aio-work-item'),
      icon:icon===document.querySelector('.aio-work-item').querySelector('svg, img'),focus:document.activeElement===card,
      text:document.querySelector('.aio-work-item .aio-work-action').textContent};
    document.querySelector('.aio-work-item').click();
    return {unchanged,changed,navigations:navigations.length};
  })()`);
  if (!observe) {
    assert.deepEqual(report.refresh.unchanged, {root:true,card:true,focus:true});
    assert.deepEqual(report.refresh.changed, {root:true,card:true,icon:true,focus:true,text:'执行步骤 29'});
    assert.equal(report.refresh.navigations, 1);
  }
  await js(`document.querySelector('[data-office-deliveries-toggle]').click()`);
  for (const [width, height, sidebar] of [[1920,1080,240],[1366,768,240],[1280,720,240],[1024,600,220],[912,512,188],[800,600,188],[600,500,188]]) {
    win.setContentSize(width, height);
    await js('document.documentElement.style.setProperty("--ws-side-w",'+JSON.stringify(sidebar+'px')+')');
    await wait(110);
    const result = await js(`(() => {
      const panel=document.querySelector('#aiDeskPanel'),main=panel.querySelector('.dk-main'),list=panel.querySelector('.aio-work-list');
      main.scrollTop=0;
      const card=list.firstElementChild, head=panel.querySelector('.aio-workboard-head');
      const r=e=>e.getBoundingClientRect();
      return {width:innerWidth,height:innerHeight,available:main.clientWidth,columns:getComputedStyle(list).gridTemplateColumns,
        rows:getComputedStyle(main).gridTemplateRows, regions:[...panel.querySelectorAll('.aio-teamline,.aio-agent-line,.aio-workboard,.aio-workboard-head')].map(e=>({name:e.className,height:r(e).height,top:r(e).top,bottom:r(e).bottom})),
        mainHeight:main.clientHeight,listHeight:list.clientHeight,firstCardHeight:r(card).height,
        agentHeight:r(panel.querySelector('.aio-agent')).height,
        overflow:panel.scrollWidth-panel.clientWidth,headOverflow:head.scrollWidth-head.clientWidth,
        nested:[list,panel.querySelector('.aio-delivery-row')].filter(e=>e.scrollHeight>e.clientHeight+1&&/auto|scroll/.test(getComputedStyle(e).overflowY)).map(e=>e.className)};
    })()`);
    if (!observe) {
      assert.ok(result.overflow<=1,JSON.stringify(result)); assert.ok(result.headOverflow<=1); assert.deepEqual(result.nested,[]);
      assert.ok(result.regions[1].bottom<=result.regions[2].top,JSON.stringify(result));
      assert.ok(result.agentHeight>=44 && result.regions[0].height>=result.agentHeight,JSON.stringify(result));
    }
    report.layouts.push(result);
    if ([1366,1024,912,600].includes(width)) await shot('workbench-'+width+'x'+height);
    const end = await js(`(() => {
      const main=document.querySelector('.dk-main'); const last=document.querySelector('.aio-delivery-row').lastElementChild;
      last.scrollIntoView({block:'end'});const r=last.getBoundingClientRect(),m=main.getBoundingClientRect();
      return {visible:r.top>=m.top-1&&r.bottom<=m.bottom+1,scroll:main.scrollTop};
    })()`);
    if (!observe) assert.ok(end.visible,JSON.stringify({width,end}));
  }
  assert.deepEqual(await js('errors'), []);
  if (!observe) report.checks.push('70 updates retain card/icon/focus; one click opens exactly one task', 'Seven workspace sizes, all task and delivery entries reachable');
  await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
  await js(`(() => {
    document.querySelector('#root').insertAdjacentHTML('beforeend','<button id="nchatMeta" class="nmeta show-detail"></button><button id="nchatSend"></button>');
    ctx._snap.contextWindow=128000;ctx._snap.contextUsage={input:1000};fill(4);draw();
    window.kept={text:document.querySelector('.ntext'),heading:document.querySelector('.ntext h2'),
      pop:document.querySelector('.nctx-pop'),send:document.querySelector('#nchatSend svg')};
  })()`);
  await wait(200);
  report.chat = await js(`(() => {
    for(let i=0;i<40;i++){
      ctx._snap.messages[1].blocks[0].text+='增量';ctx._snap.contextUsage.input+=100;draw();
    }
    const host=document.createElement('div');
    const cases=['<p>甲</p><p>乙</p>','<p>甲</p><h2>标题</h2><p>丙</p>','<p>甲</p>',
      '<p title="说明">甲<strong>重点</strong></p>','<svg><circle r="7"/></svg><span>尾部</span>',
      '<svg><circle r="8"/><circle r="4"/></svg><span>尾部</span>','<svg><circle r="8"/></svg><span>尾部</span>',''];
    const patchCorrect=cases.every(html=>{const next=document.createElement('div');next.innerHTML=html;
      const expected=next.innerHTML;ChatTools.patchContent(host,next);return host.innerHTML===expected;});
    return {text:kept.text===document.querySelector('.ntext'),heading:kept.heading===document.querySelector('.ntext h2'),
      intermediateActionsHidden:document.querySelectorAll('.ntext-copy').length===0,pop:kept.pop===document.querySelector('.nctx-pop'),
      send:kept.send===document.querySelector('#nchatSend svg'),usage:document.querySelector('.nctx-total').textContent,patchCorrect};
  })()`);
  if (!observe) {
    for (const k of ['text','heading','intermediateActionsHidden','pop','send','patchCorrect']) assert.equal(report.chat[k],true,k);
    assert.match(report.chat.usage,/5(?:\.0)?k|5,?000/);
  }
  await wait(50);
  report.chat.restartedTooltip = await js('document.querySelector(".nctx-pop").getAnimations().some(a=>a.playState==="running")');
  if (!observe) assert.equal(report.chat.restartedTooltip,false);
  report.contextAccounting = await js(`(() => {
    const rows = [];
    for (const [name, value, expected] of [
      ['Pi cache', {input:1000,cacheRead:90000,cacheWrite:5000}, '96,000'],
      ['normalized cache', {input:96000,cacheRead:95000,inputIncludesCache:true}, '96,000'],
      ['OpenAI cache', {input_tokens:96000,cached_input_tokens:95000}, '96,000'],
      ['compacted', null, '暂未获取用量'],
    ]) {
      ctx._snap.contextUsage=value;ctx._snap.usage={input:900000};draw();
      const popup=document.querySelector('.nctx-pop');
      rows.push({name,expected,text:popup.textContent,visible:popup.getBoundingClientRect().width>0,
        overflow:popup.scrollWidth>popup.clientWidth+1});
    }
    return rows;
  })()`);
  if (!observe) for (const row of report.contextAccounting) {
    assert.ok(row.text.includes(row.expected),JSON.stringify(row));
    assert.ok(row.visible && !row.overflow,JSON.stringify(row));
    assert.ok(!row.text.includes('900,000'),JSON.stringify(row));
  }
  if (process.argv.includes('--context-only')) { report.ok = true; return; }
  await win.loadFile(path.join(__dirname,'fixtures/overlay-stability.html'));
  await wait(850);
  report.overlay = await js(`(() => {
    const image=document.querySelector('#petSvg').firstElementChild;
    const observer=new MutationObserver(()=>{});observer.observe(pet,{childList:true,subtree:true,attributes:true});
    for(let i=0;i<100;i++)updatePet();
    const mutations=observer.takeRecords().length;observer.disconnect();
    shapeCalls.length=0;pet.classList.add('awake');
    return {sameSvg:image===document.querySelector('#petSvg').firstElementChild,mutations};
  })()`);
  await wait(750);
  report.overlay.nativeRegionRequests=await js('shapeCalls.length');
  report.overlay.errors=await js('errors');
  if (!observe) {
    assert.equal(report.overlay.sameSvg,true);assert.equal(report.overlay.mutations,0);
    assert.ok(report.overlay.nativeRegionRequests<=4,JSON.stringify(report.overlay));assert.deepEqual(report.overlay.errors,[]);
    report.checks.push('Streaming preserves text blocks, copy controls and context tooltip without replaying its entry animation',
      '100 unchanged pet updates perform zero DOM mutations; CSS scale transition uses at most 4 native-region requests');
  }
  report.ok = true;
}).catch(error => { report.error = error.stack; })
.finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
});
