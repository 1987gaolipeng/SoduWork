'use strict';
// Isolated Electron layout/state verification; all business APIs are fixtures.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = process.argv[2];
if (!path.isAbsolute(output || '')) throw Error('Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
const report = { ok: false, scope: 'isolated Electron requirement UI with fixture APIs', checks: [], layouts: [] };
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1400, height: 1000, show: false,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    const js = source => win.webContents.executeJavaScript(source, true);
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    await js('RequirementsBoard.open();document.querySelector("[data-rq-view=list]").click();true');
    const before = await js('document.querySelectorAll(".hb-body [data-rq-open]").length'); assert.ok(before > 0);
    await js('window.retainedCard=document.querySelector(".hb-body [data-rq-open]");window.retainedBody=document.querySelector(".hb-body");retainedCard.focus();retainedBody.scrollTop=20;window.retainedTop=retainedBody.scrollTop;Store.taskState="stale";dispatchEvent(new CustomEvent("soduwork-task-source"))');
    assert.equal(await js('document.querySelector("#rqConnection").hidden'), false);
    assert.equal(await js('retainedCard===document.querySelector(".hb-body [data-rq-open]")'), true);
    assert.equal(await js('document.activeElement===retainedCard'), true);
    assert.equal(await js('retainedBody.scrollTop===retainedTop'), true);
    assert.equal(await js('document.querySelectorAll(".hb-body [data-rq-open]").length'), before);
    report.checks.push('disconnection retains existing card DOM, count, focus and scroll');
    await js('window.retryOptions=[];Store.refreshTasks=async options=>{retryOptions.push(options)};true');
    await js('document.querySelector("#rqConnection button").click();true');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await js('retryOptions'), [{ reconnect: true }]);
    report.checks.push('DOM button activation requests a connection check through the existing refresh action');
    for (const width of [1400, 420]) {
      win.setSize(width, 1000); await new Promise(resolve => setTimeout(resolve, 80));
      const layout = await js('(()=>{const r=document.querySelector("#rqConnection").getBoundingClientRect();const b=document.querySelector("#rqConnection button").getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,buttonVisible:b.right<=innerWidth&&b.left>=0&&b.top>=r.top&&b.bottom<=r.bottom}})()');
      assert.equal(layout.overflow, false); assert.equal(layout.buttonVisible, true); report.layouts.push(layout);
      fs.writeFileSync(path.join(output, 'stale-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    const retained = await js('window.recoveryCard=document.querySelector(".hb-body [data-rq-open]");Store.taskState="ready";dispatchEvent(new CustomEvent("soduwork-task-source"));recoveryCard===document.querySelector(".hb-body [data-rq-open]")');
    assert.equal(retained, true); assert.equal(await js('document.querySelector("#rqConnection").hidden'), true);
    report.checks.push('unchanged recovery removes the notice while preserving cards');
    await js('Store.taskState="offline";RequirementsBoard.render()');
    assert.equal(await js('document.querySelectorAll(".hb-body [data-rq-open]").length'), 0);
    report.checks.push('an unverified offline source retains the original empty-state boundary');
    assert.deepEqual(await js('fixtureErrors'), []); report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
