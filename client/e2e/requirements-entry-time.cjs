'use strict';
// Production renderer/CSS in an isolated Electron window; no business services.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {env, windowsHide: true, stdio: 'inherit', timeout: 90000});
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../outputs/requirements-entry-time-20261023');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-entry-time-')));
app.disableHardwareAcceleration();
const report = {ok: false, checks: [], layouts: [], errors: [], boundary: 'Isolated native Electron with fixture APIs, no business data or network'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({show: false, width: 1440, height: 1000, webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_request, done) => done({cancel: true}));
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    const js = source => win.webContents.executeJavaScript(source, true);
    const click = async selector => {
      const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const b=n.getBoundingClientRect();return b.width&&b.height?{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}:null})()`);
      assert.ok(point, selector + ' is visible');
      const zoom = win.webContents.getZoomFactor();
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, x: Math.round(point.x * zoom), y: Math.round(point.y * zoom), ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1})});
      await wait(80);
    };
    const state = () => js(`({scope:document.querySelector('#rqScope').value,archive:document.querySelector('#rqArchive').value})`);
    const capture = async name => fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    await wait(100);
    assert.deepEqual(await state(), {scope: 'actionable', archive: 'active'});
    await click('.rq-scopes [data-rq-scope="created"]');
    await js('RequirementsBoard.render(true); RequirementsBoard.refresh(); RequirementsBoard.open(); void 0');
    assert.equal((await state()).scope, 'created');
    await js('RequirementsBoard.close(); RequirementsBoard.open(); void 0');
    // Cross-page re-entry always returns to current actionable work.
    assert.deepEqual(await state(), {scope: 'actionable', archive: 'active'});
    await click('#rqArchiveEntry');
    assert.equal((await state()).archive, 'archived');
    assert.equal(await js(`document.querySelectorAll('.rq-archive .rq-updated').length`), 1);
    await js('RequirementsBoard.close(); RequirementsBoard.open(); void 0');
    assert.deepEqual(await state(), {scope: 'actionable', archive: 'active'});
    report.checks.push('Cross-page re-entry resets scope/archive; refresh and repeated open preserve selection; explicit review entry stays targeted');
    await js(`RequirementsBoard.open({phase:'reviewing'}); void 0`);
    assert.equal((await state()).scope, 'all');
    assert.equal(await js(`!!document.querySelector('[data-hbid="approval-only"]')`), true);
    await click('[data-rq-remove-filter="phase"]');
    await js(`Object.assign(tasks[0],{updatedAt:'2026-10-23T02:03:04Z',createdAt:'2026-10-20T01:00:00Z'});Object.assign(tasks[1],{updatedAt:'invalid',createdAt:'2026-10-20T01:00:00Z'});Object.assign(tasks[2],{updatedAt:null,createdAt:null});RequirementsBoard.render(true);void 0`);
    const times = await js(`['intake-0','clarifying-0','ready-0'].map(id=>{const n=document.querySelector('[data-hbid="'+id+'"] .rq-updated');return{text:n.textContent,datetime:n.querySelector('time')?.dateTime,title:n.querySelector('time')?.title}})`);
    assert.equal(times[0].datetime, '2026-10-23T02:03:04.000Z');
    assert.match(times[0].title, /最近更新：.*UTC/);
    // The card timestamp shares the assignee row and omits the Updated/Created prefix; verify the timestamp and tooltip.
    assert.match(times[1].text, /^20\d\d\/\d\d\/\d\d \d\d:\d\d$/);
    assert.match(times[1].title, /创建时间：.*UTC/);
    assert.equal(times[2].text, '时间未记录');
    report.checks.push('Every card uses real updated time, valid creation fallback, or explicit missing-time state');
    for (const theme of ['azure', 'steady']) for (const [width, zoom] of [[1440, 1], [820, 1], [480, 1.25]]) {
      win.setContentSize(width, 1000); win.webContents.setZoomFactor(zoom);
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('.rq-kanban').scrollLeft=0;void 0`);
      await wait(70);
      const layout = await js(`(()=>{const cards=[...document.querySelectorAll('.rq-card')];return{outerOverflow:document.documentElement.scrollWidth>innerWidth+1,cards:cards.length,times:document.querySelectorAll('.rq-card .rq-updated').length,overflow:cards.filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.dataset.hbid),escapedTimes:cards.filter(n=>{const c=n.getBoundingClientRect(),t=n.querySelector('.rq-updated').getBoundingClientRect();return t.right>c.right+1||t.left<c.left-1}).map(n=>n.dataset.hbid)}})()`);
      assert.equal(layout.outerOverflow, false); assert.equal(layout.cards, layout.times);
      assert.deepEqual(layout.overflow, []); assert.deepEqual(layout.escapedTimes, []);
      report.layouts.push({theme, width, zoom, ...layout});
      if (theme === 'azure' && width !== 820) await capture('board-' + width);
    }
    report.checks.push('Six theme/width/zoom combinations: timestamps visible without card or page overflow');
    win.setContentSize(1440, 1000); win.webContents.setZoomFactor(1); await wait(80);
    await click('[data-rq-view="list"]');
    assert.equal(await js(`document.querySelectorAll('.rq-table tbody tr').length===document.querySelectorAll('.rq-table .rq-updated').length`), true);
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth+1`), true);
    await capture('list-wide');
    await click('[data-rq-open="intake-0"]');
    const details = await js(`[...document.querySelectorAll('.rq-detail-properties time')].map(n=>({datetime:n.dateTime,title:n.title}))`);
    assert.equal(details.some(t => t.datetime === '2026-10-23T02:03:04.000Z'), true);
    assert.equal(details.some(t => t.datetime === '2026-10-20T01:00:00.000Z'), true);
    await capture('detail-times');
    await js(`RequirementsDetail.close();tasks[0].updatedAt='2026-10-23T03:04:05Z';RequirementsBoard.render(true);void 0`);
    assert.equal(await js(`document.querySelector('[data-hbid="intake-0"] .rq-updated time').dateTime`), '2026-10-23T03:04:05.000Z');
    report.checks.push('List and details use the same timestamps; a task update repaints real updated time');
    assert.deepEqual(await js('fixtureErrors'), []); assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
