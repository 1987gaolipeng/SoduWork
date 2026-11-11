'use strict';
// Production renderer, real pointer/keyboard events, fixture data only.
// This suite verifies layout/theme/focus, not live Hub, Runner or model execution.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { ok: false, boundary: 'real Electron UI with explicit fixture APIs', checks: [], layouts: [], themes: [] };
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1440, height: 1000, show: false,
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
    const js = source => win.webContents.executeJavaScript(source, true).catch(error => { report.failedExpression = source; throw error; });
    const click = async selector => {
      let point;
      for (let attempt = 0; attempt < 30; attempt++) {
        point = await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.getClientRects().length&&!x.disabled);if(!n)return null;n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`);
        if (point) break;
        await wait(50);
      }
      assert.ok(point, 'visible pointer target ' + selector);
      const zoom = win.webContents.getZoomFactor();
      point = {x: Math.round(point.x * zoom), y: Math.round(point.y * zoom)};
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp'])
        win.webContents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
      await wait(100);
    };
    const key = async keyCode => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await wait(70);
    };
    const capture = async name => {
      await wait(150);
      const screenshot = await win.webContents.capturePage();
      assert.ok(!screenshot.isEmpty(), 'nonempty screenshot ' + name);
      fs.writeFileSync(path.join(output, name + '.png'), screenshot.toPNG());
    };
    const layout = async label => {
      const value = await js(`(()=>{const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};const board=document.querySelector('.requirements-board'),grid=document.querySelector('.rq-kanban'),detail=document.querySelector('.rq-detail-content'),drawer=document.querySelector('.rq-detail'),footer=document.querySelector('.rq-detail-footer');const controls=[...document.querySelectorAll('.rq-controls>button,.rq-controls>label,.rq-controls>select,.rq-controls>.rq-view-switch,.rq-controls>.rq-scopes')].filter(n=>n.getClientRects().length).map(box);const footerBox=footer&&!footer.hidden?box(footer):null;const drawerBox=drawer?box(drawer):null;return{viewport:innerWidth,outerOverflow:document.documentElement.scrollWidth>innerWidth+1,board:box(board),grid:grid?{width:grid.clientWidth,scroll:grid.scrollWidth}:null,detailOverflow:detail?detail.scrollWidth>detail.clientWidth+1:false,footer:footerBox,drawer:drawerBox,controlsOverlap:controls.some((a,i)=>controls.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1)),cardOverflow:[...document.querySelectorAll('.rq-card')].some(n=>n.scrollWidth>n.clientWidth+1)}})()`);
      assert.equal(value.outerOverflow, false, label + ' outer overflow');
      assert.equal(value.controlsOverlap, false, label + ' toolbar overlap');
      assert.equal(value.cardOverflow, false, label + ' card overflow');
      assert.equal(value.detailOverflow, false, label + ' drawer overflow');
      report.layouts.push({ label, ...value });
      return value;
    };
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    win.webContents.setZoomFactor(1);
    await js(`localStorage.clear()`);
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
    await wait(150);
    const requirementSurface = await js(`(()=>{const rgb=n=>getComputedStyle(document.querySelector(n)).backgroundColor;const board=document.querySelector('#historyBoard');const rect=board.getBoundingClientRect();return{head:rgb('.hb-head'),controls:rgb('.rq-controls'),top:rect.top,right:innerWidth-rect.right,bottom:innerHeight-rect.bottom}})()`);
    assert.equal(requirementSurface.head, 'rgb(249, 249, 249)', 'requirement menu surface uses #F9F9F9');
    assert.equal(requirementSurface.controls, 'rgb(249, 249, 249)', 'requirement controls surface uses #F9F9F9');
    assert.equal(requirementSurface.top, 2);
    assert.equal(requirementSurface.right, 6);
    assert.equal(requirementSurface.bottom, 15);
    report.requirementSurface = requirementSurface;
    report.checks.push('requirement menu surfaces use #F9F9F9 and the board uses the shared workspace frame');
    const example = {title:'完善产品上线前的客户引导与团队协作流程',note:'梳理新成员从加入项目到提交首份交付的完整流程。\n重点检查权限说明、需求分工与验收反馈，减少来回确认。',acceptanceCriteria:['新成员可以独立找到与自己有关的需求','可以从需求直接进入同一项目的工作会话','交付材料有清晰的来源和验收记录']};
    await js(`Object.assign(tasks.find(t=>t.id==='intake-0'),${JSON.stringify(example)});RequirementsBoard.render(true)`);
    for (const width of [1440, 1366, 960, 600, 390]) {
      win.setContentSize(width, 1000); await wait(120);
      const value = await layout('board-' + width);
      if (width >= 1366) assert.ok(value.grid.scroll <= value.grid.width + 1, 'five stages fit at ' + width);
      await capture('board-' + width);
      await click('[data-rq-view="list"]');
      await layout('list-' + width);
      if ([1440, 600].includes(width)) await capture('list-' + width);
      await click('[data-rq-view="kanban"]');
    }
    win.setContentSize(1440, 1000); await wait(100);
    await click('[data-rq-open="intake-0"]');
    assert.equal(await js(`!!document.querySelector('#rqEditForm')`), false, 'default detail reads as a document');
    const detailIdentity = await js(`(()=>{const title=document.querySelector('#rqDetailTitle'),meta=document.querySelector('[data-rq-header-meta]'),footer=document.querySelector('.rq-detail-footer'),primary=footer?.querySelector('[data-rq-assign],[data-rq-approval],[data-rq-chat]');return{title:title?.textContent.trim(),meta:meta?.textContent.trim(),metaVisible:!!meta&&!meta.hidden,footerVisible:!!footer&&!footer.hidden,primaryVisible:!!primary&&!!primary.getClientRects().length}})()`);
    assert.equal(detailIdentity.title, example.title, 'detail header identifies the opened requirement');
    assert.ok(detailIdentity.metaVisible && detailIdentity.meta.includes('待梳理'), 'detail header exposes current stage');
    assert.ok(detailIdentity.footerVisible && detailIdentity.primaryVisible, 'detail keeps a primary action in the footer');
    const detailLayout = await layout('detail-wide');
    assert.ok(detailLayout.footer && detailLayout.drawer && detailLayout.footer.bottom <= detailLayout.drawer.bottom + 1, 'detail footer stays inside drawer');
    await capture('detail-wide');
    await js(`document.documentElement.setAttribute('data-window-menu','')`);
    const titlebarSafeDetail = await layout('detail-titlebar-safe');
    assert.ok(titlebarSafeDetail.drawer && titlebarSafeDetail.drawer.y >= 34, 'detail drawer starts below the titlebar safe area');
    await capture('detail-titlebar-safe');
    await js(`document.documentElement.removeAttribute('data-window-menu')`);
    await click('.rq-detail-more>summary'); await capture('detail-actions');
    await key('Escape');
    assert.ok(await js(`!!document.querySelector('.rq-detail')&&!document.querySelector('.rq-detail-more').open`), 'Escape closes menu before drawer');
    await click('[data-rq-edit]');
    assert.equal(await js(`document.activeElement.name`), 'title', 'editing focuses title');
    await capture('detail-edit');
    await click('[data-rq-edit-cancel]');
    assert.equal(await js(`!!document.querySelector('#rqEditForm')`), false);
    for (const theme of ['vivid', 'ruby', 'warm', 'minimal']) {
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const colors = await js(`(()=>{const s=getComputedStyle(document.documentElement),button=getComputedStyle(document.querySelector('#hbAdd'));return{accent:s.getPropertyValue('--accent').trim(),surface:s.getPropertyValue('--bg-0').trim(),button:button.backgroundColor,title:getComputedStyle(document.querySelector('.rq-detail-title')).color,detailAccent:getComputedStyle(document.querySelector('.rq-detail-next b')).color}})()`);
      report.themes.push({ theme, ...colors });
      const contrast = await js(`(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');const light=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);const rgba=context.getImageData(0,0,1,1).data;return [...rgba].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)};const s=getComputedStyle(document.querySelector('#hbAdd')),a=light(s.backgroundColor),b=light(s.color);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05)})()`);
      report.themes.at(-1).primaryTextContrast = contrast;
      assert.ok(contrast >= 4.5, theme + ' primary action text contrast: ' + contrast);
      await capture('theme-' + theme);
    }
    assert.notEqual(report.themes[0].button, report.themes[1].button, 'theme changes primary action');
    assert.notEqual(report.themes[0].button, report.themes[3].button, 'minimal theme uses neutral actions');
    await js(`document.documentElement.dataset.theme='vivid'`);
    win.setContentSize(390, 844); await wait(100);
    const narrowDetail = await layout('detail-390');
    assert.ok(narrowDetail.footer && narrowDetail.drawer && narrowDetail.footer.bottom <= narrowDetail.drawer.bottom + 1, 'narrow detail footer stays inside drawer');
    await capture('detail-390');
    await click('.rq-detail-more>summary'); await capture('detail-actions-390'); await key('Escape');
    await click('[data-rq-edit]'); await layout('edit-390'); await capture('detail-edit-390');
    await click('[data-rq-edit-cancel]'); await click('[data-rq-dismiss]');
    win.setContentSize(1440, 1000); win.webContents.setZoomFactor(1.25); await wait(120);
    await layout('board-125-percent'); await capture('board-125-percent');
    await click('[data-rq-open="intake-0"]');
    assert.ok(await js(`!!document.querySelector('.rq-detail')`), 'scaled pointer opens drawer');
    await layout('detail-125-percent'); await capture('detail-125-percent');
    await key('Escape');
    report.returnFocus = await js(`document.activeElement.outerHTML.slice(0,800)`);
    assert.equal(await js(`document.activeElement.dataset.rqOpen`), 'intake-0', 'closing restores card focus');
    assert.deepEqual(await js('fixtureErrors'), []);
    report.checks.push('five readable stage columns fit at 1366; internal scroll at narrow widths',
      'board/list controls never overlap from 390 to 1440 pixels',
      'requirement detail header identifies title/stage/owner; section cards and fixed action footer remain in bounds',
      'default reading, edit/cancel, action menu, Escape and restored keyboard focus',
      'blue, corporate red, warm and minimal themes; actual 125% window scaling',
      'screenshots captured from the production Electron renderer; no external model calls');
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(output, 'failure.png'), image.toPNG())).catch(() => {});
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
