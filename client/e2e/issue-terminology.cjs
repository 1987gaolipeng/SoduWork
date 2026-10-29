'use strict';
// Production board/detail renderers + production locale loader, isolated data.
// No Hub, Runner, model or user profile is accessed by this language regression.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
let win;
const report = { ok: false, scope: 'real Electron renderer with isolated fixture APIs', checks: [], errors: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const js = source => win.webContents.executeJavaScript(source, true);
async function click(selector) {
  const pos = await js(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);if(!n)throw Error('No visible control');n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...pos });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...pos });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...pos });
  await wait(100);
}
async function locale(value) { await js(`SoduWorkI18n.setLocale(${JSON.stringify(value)})`); await wait(80); }
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1400, height: 1000, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
  await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
  const title = 'Customer Request / Task / Requirement 需求';
  await js(`tasks.find(t=>t.id==='ready-0').title=${JSON.stringify(title)};RequirementsBoard.render(true);`);
  for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
  for (const file of ['core/i18n-dom.js', 'core/i18n.js']) await js(read(file));
  await locale('en-US');
  await click('[data-rq-view="kanban"]');
  assert.equal(await js('document.querySelector("#hbTitleText").textContent'), 'Issues');
  assert.equal(await js('document.querySelector("#hbAdd").textContent'), '＋ New issue');
  assert.equal(await js('document.querySelector("#hbSearch").placeholder'), 'Search issues');
  assert.equal(await js('document.querySelector("#rqFilterToggle").getAttribute("aria-label")'), 'Filter issues');
  assert.equal(await js('document.querySelector(".rq-scopes").getAttribute("aria-label")'), 'Issue views');
  assert.ok(await js(`[...document.querySelectorAll('[data-hbid="ready-0"] button')].some(n=>n.textContent.trim()==='Assign issue')`));
  assert.ok(await js(`document.querySelector('[data-hbid="ready-0"]').textContent.includes(${JSON.stringify(title)})`));
  fs.writeFileSync(path.join(output, 'board-en.png'), (await win.webContents.capturePage()).toPNG());
  report.checks.push('English board heading, creation, search, filter and view labels use Issue; user title remains literal');

  await click('[data-rq-view="list"]');
  assert.deepEqual(await js('[...document.querySelectorAll(".rq-table th")].map(n=>n.textContent)'),
    ['Issue', 'Stage', 'Owner / assignee', 'Creator', 'Project', 'Priority', 'Due date', 'Actions']);
  assert.equal(await js('document.querySelector("[data-hbid=ready-2] .rq-table-project").textContent'), 'No project');
  for (const width of [1400, 800]) {
    win.setContentSize(width, 900); await wait(80);
    const metrics = await js('(()=>{const body=document.querySelector(".hb-body"),wrap=document.querySelector(".rq-table-wrap");return{overflow:body.scrollWidth-body.clientWidth,tableOverflow:wrap.scrollWidth-wrap.clientWidth,stages:[...document.querySelectorAll(".rq-table .rq-stage")].map(n=>({label:n.textContent,right:n.getBoundingClientRect().right,cellRight:n.closest("td").getBoundingClientRect().right}))}})()');
    assert.ok(metrics.overflow < 2, 'list scroll is contained');
    for (const stage of metrics.stages) assert.ok(stage.right <= stage.cellRight - 4, 'English stage overlaps next cell: ' + stage.label);
    if (width < 1000) assert.ok(metrics.tableOverflow > 0);
  }
  win.setContentSize(1400, 1000); await wait(80);
  fs.writeFileSync(path.join(output, 'list-en.png'), (await win.webContents.capturePage()).toPNG());
  report.checks.push('English table has complete labels and contained stage columns at desktop and narrow widths');
  await click('#hbSearch'); await win.webContents.insertText('Customer Request'); await wait(100);
  assert.deepEqual(await js('[...document.querySelectorAll(".hb-body [data-hbid]")].map(n=>n.dataset.hbid)'), ['ready-0']);
  await locale('zh-CN');
  assert.equal(await js('document.querySelector("#hbTitleText").textContent'), '需求池');
  assert.equal(await js('document.querySelector("#hbSearch").value'), 'Customer Request');
  assert.equal(await js('document.querySelector("#hbSearch").placeholder'), '搜索需求');
  await locale('en-US');
  assert.equal(await js('document.querySelector("#hbTitleText").textContent'), 'Issues');
  report.checks.push('Native list selection and search work; language round-trip retains view, search text and matching Issue');

  await click('[data-rq-open="ready-0"]');
  // The heading is user content; the separate eyebrow carries the translated label.
  assert.equal(await js('document.querySelector("#rqDetailTitle").textContent'), title);
  assert.equal(await js('document.querySelector(".rq-detail-eyebrow").textContent'), 'Issue details');
  await click('[data-rq-edit]');
  assert.equal(await js('document.querySelector("#rqEditForm [name=title]").value'), title);
  assert.ok(await js('document.querySelector("#rqEditForm [name=title]").parentElement.textContent.includes("Issue title")'));
  await js('window.retainedTitleField=document.querySelector("#rqEditForm [name=title]")');
  fs.writeFileSync(path.join(output, 'details-en.png'), (await win.webContents.capturePage()).toPNG());
  await locale('zh-CN');
  assert.equal(await js('document.querySelector("#rqDetailTitle").textContent'), title);
  assert.equal(await js('document.querySelector(".rq-detail-eyebrow").textContent'), '编辑需求');
  assert.ok(await js('document.querySelector("#rqEditForm [name=title]")===retainedTitleField'));
  assert.equal(await js('retainedTitleField.value'), title);
  await locale('en-US');
  assert.equal(await js('document.querySelector("#rqDetailTitle").textContent'), title);
  assert.equal(await js('document.querySelector(".rq-detail-eyebrow").textContent'), 'Edit issue');
  await click('[data-rq-dismiss]');
  assert.ok(await js('!document.querySelector(".rq-detail")'));
  report.checks.push('Native detail open/close works in English and Chinese without remounting or translating user form data');
  await click('#hbAdd');
  assert.equal(await js('fixtureCalls.at(-1)[0]'), 'create');
  assert.deepEqual(await js('fixtureErrors'), []);
  assert.deepEqual(report.errors, []);
  report.checks.push('Translated creation button retains its original action; no renderer errors');
  report.ok = true;
}).catch(async error => {
  report.error = error.stack;
  if (win) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
}).finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
});
