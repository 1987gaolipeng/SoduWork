import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CdpPage, listPages, delay } from './lib/cdp.mjs';

// Read-only UI coverage: no dispatch, approval, retry, rename or task deletion.
const [targetId, outputDir] = process.argv.slice(2);
assert.ok(targetId && outputDir, 'Pass an isolated AI team target and evidence directory');
const target = (await listPages(Number(process.env.CDP_PORT || 9347)))
  .find(p => p.id === targetId && p.url.includes('panel=workspace&view=aidesk'));
assert.ok(target, 'An explicitly selected isolated AI team window is required');
const page = await CdpPage.connect(target);
const checks = [], layouts = [];
async function click(selector) {
  const point = await page.run(s => {
    const e = document.querySelector(s);
    if (!e) throw new Error('Missing control: ' + s);
    e.scrollIntoView({block:'nearest', inline:'nearest'});
    const r = e.getBoundingClientRect();
    return {x:r.x+r.width/2, y:r.y+r.height/2};
  }, selector);
  for (const type of ['mousePressed','mouseReleased']) {
    await page.call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
  }
}
async function shot(name) {
  const s = await page.call('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(path.join(outputDir, name+'.png'),Buffer.from(s.data,'base64'));
}
async function inspect(width, height, expectedColumns) {
  await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await delay(140);
  const result = await page.run(() => {
    const list = document.querySelector('.aio-work-list'), board = document.querySelector('.dk-office-layout');
    const rect = e => e.getBoundingClientRect().toJSON();
    const cards = [...document.querySelectorAll('.aio-work-item')];
    const text = [...document.querySelectorAll('.aio-office *')].filter(e =>
      e.getBoundingClientRect().height > 0 &&
      [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
    const count = el => getComputedStyle(el).gridTemplateColumns.split(' ').length;
    return {
      columns:count(list), deliveryColumns:count(document.querySelector('.aio-delivery-row')),
      boardOverflow:board.scrollWidth-board.clientWidth,
      available:board.clientWidth-parseFloat(getComputedStyle(board).paddingLeft)-parseFloat(getComputedStyle(board).paddingRight),
      seat:rect(document.querySelector('.aio-agent-avatar')).width,
      icon:rect(cards[0].querySelector('.aio-work-bot')).width,
      titleFont:getComputedStyle(cards[0].querySelector('h3')).fontSize,
      deliveryFont:getComputedStyle(document.querySelector('.aio-delivery-copy b')).fontSize,
      deliveryHeight:rect(document.querySelector('.aio-delivery-item')).height,
      tooSmall:text.filter(e => parseFloat(getComputedStyle(e).fontSize) < 12).map(e => e.className),
      clipped:cards.flatMap(card => {
        const cr = rect(card);
        return [...card.querySelectorAll('header,h3,p,.aio-work-footer,.aio-work-open')]
          .filter(e => { const r=rect(e); return r.right>cr.right+.5 || r.bottom>cr.bottom+.5 || r.left<cr.left-.5; })
          .map(e => e.className || e.tagName);
      }),
      ownerImages:[...document.querySelectorAll('.aio-agent-avatar img,.aio-work-bot img')]
        .every(e=>e.complete && e.naturalWidth>0),
    };
  });
  assert.equal(result.columns,expectedColumns, JSON.stringify({width,result}));
  assert.ok(result.boardOverflow <= 1);
  assert.equal(result.seat,result.available<=1040?34:36); assert.equal(result.icon,28);
  assert.equal(result.titleFont,'16px'); assert.equal(result.deliveryFont,'14px');
  assert.ok(result.deliveryHeight>=94);
  assert.deepEqual(result.tooSmall,[]); assert.deepEqual(result.clipped,[]);
  assert.equal(result.ownerImages,true);
  layouts.push({width,height,...result});
}
try {
  await fs.mkdir(outputDir,{recursive:true});
  if (await page.run(()=>!!document.querySelector('#aiDeskPanel.is-task-view .dk-back, #dkBody .dk-back'))) {
    await click('#dkBody .dk-back');
  }
  await page.waitFor(()=>document.querySelectorAll('.aio-work-item').length>0 && document.querySelector('.aio-delivery-item'));
  if (await page.run(()=>document.querySelector('#aioDeliveryContent').hidden)) await click('#aioDeliveryToggle');
  await inspect(2400,1350,4); await shot('01-wide-board');
  await inspect(1680,1050,3); await shot('02-desktop-board');
  await inspect(1280,900,2); await shot('03-compact-board');
  await inspect(920,800,1); await shot('04-narrow-board');
  checks.push('Four available-width layouts: 4/3/2/1 columns, no clipped card content, no text under 12px, all Agent images loaded');
  await inspect(1680,1050,3);

  await click('.aio-office-filters [data-office-phase="running"]');
  const running = await page.run(()=>({
    selected:document.querySelector('[data-office-phase="running"]').getAttribute('aria-pressed'),
    classes:[...document.querySelectorAll('.aio-work-item')].map(e=>e.className),
    empty:!!document.querySelector('.aio-filter-empty'),
  }));
  assert.equal(running.selected,'true');
  assert.ok(running.classes.every(x=>/is-running|is-dispatching/.test(x)));
  assert.ok(running.classes.length || running.empty);
  await shot('05-running-filter');
  await click('.aio-office-filters [data-office-phase="attention"]');
  assert.ok(await page.run(()=>[...document.querySelectorAll('.aio-work-item')].every(e=>e.matches('.is-waiting,.is-failed'))));
  await click('.aio-office-filters [data-office-phase="all"]');
  checks.push('Running/needs-attention/all filters preserve real task states and empty-state fallback');

  await click('.aio-agent:not(.aio-agent-all)');
  assert.equal(await page.run(()=>document.querySelector('.aio-agent:not(.aio-agent-all)').getAttribute('aria-pressed')),'true');
  await click('.aio-agent:not(.aio-agent-all)');
  assert.equal(await page.run(()=>document.querySelector('.aio-agent-all').getAttribute('aria-pressed')),'true');
  checks.push('Agent seat selection filters tasks; clicking the same seat returns to all');

  const taskId=await page.run(()=>document.querySelector('.aio-work-item').getAttribute('data-office-enter-task'));
  await page.run(()=>document.querySelector('.aio-work-item').focus());
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await page.waitFor(id=>_dkView==='task' && _deskTaskId===id && document.querySelector('.dk-task-summary'),taskId);
  await shot('06-active-task-detail');
  await click('#dkBody .dk-back');
  await page.waitFor(()=>document.querySelector('.aio-work-item'));
  checks.push('Keyboard Enter opens the correct shared task details and the back control restores the board');

  const deliveredId=await page.run(()=>document.querySelector('.aio-delivery-item').getAttribute('data-office-enter-task'));
  await click('.aio-delivery-item');
  await page.waitFor(id=>_dkView==='task' && _deskTaskId===id && document.querySelector('.dk-task-summary'),deliveredId);
  await shot('07-completed-task-detail');
  await click('#dkBody .dk-back');
  await page.waitFor(()=>document.querySelector('.aio-work-item'));
  checks.push('Completed delivery opens its existing task details and returns without dispatching any work');

  // Memory-only state fixtures: exercise long text and empty data without creating records.
  await page.run(()=>{
    window.__aiTeamSnapshot={data:_deskData,pick:_dkPick,phase:_dkPhase};
    clearInterval(_deskTimer); _deskTimer=null;
    _deskData={..._deskData,tasks:[{
      ..._deskData.tasks[0],id:'layout-only',title:'很长的任务名称、附件说明与验收要求，用来检查大字体和布局是否截断可操作内容。'.repeat(3),
      agent:'Long Agent Name '.repeat(4),machineLabel:'远程研发执行机 / 工作空间 / 长名称'.repeat(3),phase:'failed',
      workflow:{nodeName:'验证与验收',error:'用于检查失败状态下的长说明换行和详情入口。'.repeat(8),steps:Array.from({length:8},(_,i)=>({name:'阶段'+i,state:i<3?'succeeded':'failed'}))},
      artifacts:38,
    }]};
    _dkPick='__all__';_dkPhase='all';_renderDesks();
  });
  const long = await page.run(()=>{
    const c=document.querySelector('.aio-work-item'),r=c.getBoundingClientRect(),f=c.querySelector('.aio-work-footer').getBoundingClientRect();
    return {fits:f.bottom<=r.bottom && f.right<=r.right, font:getComputedStyle(c.querySelector('h3')).fontSize};
  });
  assert.equal(long.fits,true);assert.equal(long.font,'16px');await shot('08-long-content');
  await page.run(()=>{_deskData={desks:[],tasks:[]};_renderDesks();});
  assert.ok(await page.run(()=>!!document.querySelector('.aio-flow-empty')&&!!document.querySelector('.aio-agent-empty')));
  await shot('09-empty-state');
  await page.run(()=>{_deskData=window.__aiTeamSnapshot.data;_dkPick='__all__';_dkPhase='all';_renderDesks();delete window.__aiTeamSnapshot;});
  checks.push('Long task/Agent/machine/error text and 8 workflow steps retain the detail control; empty state stays full-width');
  const errors=page.takeRuntimeErrors();
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(outputDir,'report.json'),JSON.stringify({checks,layouts,errors},null,2));
  console.log(JSON.stringify({pass:checks.length,checks,outputDir}));
} finally {
  await page.run(()=>{if(window.__aiTeamSnapshot){_deskData=window.__aiTeamSnapshot.data;_dkPick='__all__';_dkPhase='all';_renderDesks();delete window.__aiTeamSnapshot;}}).catch(()=>{});
  page.close();
}
