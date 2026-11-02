'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soduwork-once-editor-'));
app.setPath('userData', profile);
const report = { ok: false, checks: [], screenshots: [] }, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const js = source => win.webContents.executeJavaScript(source, true);
async function until(source) {
  for (let i = 0; i < 100; i++) { if (await js(source)) return; await wait(30); }
  throw Error('Timeout: ' + source);
}
function fixture(file) {
  const root = path.dirname(file), css = (name, seen = new Set()) => {
    if (seen.has(name)) return ''; seen.add(name);
    return fs.readFileSync(name, 'utf8').replace(/@import\s+["']([^"']+)["'];/g,
      (_, child) => css(path.resolve(path.dirname(name), child), seen));
  };
  return fs.readFileSync(file, 'utf8')
    .replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, name) => '<style>' + css(path.resolve(root, name)) + '</style>')
    .replace(/<script src="([^"]+)"><\/script>/g, (_, name) => '<script>' + fs.readFileSync(path.resolve(root, name), 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>');
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});
    const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    if(!e.contains(document.elementFromPoint(x,y)))throw Error('Click obscured: '+${JSON.stringify(selector)});return{x,y};})()`);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await wait(80);
}
async function field(id, value) {
  await js(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function edit(id) {
  await click('.sch-item[data-sid="' + id + '"] [data-act="edit"]');
  await until('document.querySelector("#schRunAt") && document.querySelector("#schEditorLayer.show")');
}
async function shot(name) {
  await wait(240);
  const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1280, height: 950,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const requests = [];
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => { requests.push(request.url); callback({ cancel: true }); });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture(path.join(__dirname, 'fixtures/schedule-once-editor.html'))));
  await until('document.querySelectorAll(".sch-item").length===2');
  const cards = await js('[...document.querySelectorAll(".sch-item")].map(e=>e.textContent)');
  assert.ok(cards[0].includes('仅一次') && !cards[0].includes('每天'));
  assert.ok(cards[1].includes('本次预约已触发') && cards[1].includes('不再自动触发'));
  report.checks.push('pending/manual history and consumed cards use authoritative once state');
  await edit('pending');
  assert.equal(await js('document.getElementById("schRunAt").value'), '2099-10-15T00:30:15.123');
  assert.equal(await js('getComputedStyle(document.getElementById("schHWrap")).display'), 'none');
  report.checks.push('editor uses saved New York zone and hides recurring clock');
  await shot('once-editor-wide');
  await click('#schSave'); await until('calls.updated.length===1 && !document.querySelector("#schEditorLayer.show")');
  assert.equal(await js('calls.updated[0].body.runAt'), await js('originalInstant'));
  assert.equal(await js('calls.updated[0].body.scheduleId'), 'pending');
  assert.equal(await js('calls.updated[0].body.onceFired'), undefined);
  report.checks.push('native Save preserves untouched microseconds and scoped preflight identity');
  await edit('consumed');
  assert.match(await js('document.querySelector("#schOnceHint").textContent'), /重新预约/);
  await field('schRunAt', '2099-10-16T12:30');
  await js('document.querySelector("#schEnabled").checked=true');
  await click('#schSave'); await until('calls.updated.length===2 && !document.querySelector("#schEditorLayer.show")');
  assert.equal(await js('calls.updated[1].body.runAt'), '2099-10-16T16:30:00.000Z');
  report.checks.push('consumed appointment can explicitly choose and enable a future instant');
  await edit('pending');
  for (const value of ['', '2020-01-01T08:00', '2027-03-14T02:30']) {
    await field('schRunAt', value); await click('#schSave');
    assert.equal(await js('calls.updated.length'), 2);
    assert.equal(await js('document.querySelector("#schRunAt").getAttribute("aria-invalid")'), 'true');
  }
  report.checks.push('empty, past and daylight-saving gap edits cannot reach the save API');
  await field('schEvery', 'weekly');
  assert.equal(await js('getComputedStyle(document.querySelector("#schOnceWrap")).display'), 'none');
  await click('#schSave'); await until('calls.updated.length===3');
  assert.equal(await js('calls.updated[2].body.every'), 'weekly');
  assert.equal(await js('calls.updated[2].body.runAt'), '');
  report.checks.push('switching back to weekly clears absolute time and preserves periodic fields');
  await until('!document.querySelector("#schEditorLayer.show")');
  await edit('consumed'); win.setSize(390, 900); await wait(120);
  const size = await js('(()=>{const e=document.querySelector("#schRunAt"),r=e.getBoundingClientRect(),p=e.closest(".sch-editor-drawer").getBoundingClientRect();return{left:r.left,right:r.right,pLeft:p.left,pRight:p.right};})()');
  assert.ok(size.left >= size.pLeft - 1 && size.right <= size.pRight + 1);
  await shot('once-editor-390'); report.checks.push('date-time control stays within the 390px editor');
  win.setSize(1280, 950); await click('#schCancel');
  await js('rows[0].repoId="removed-repo"'); await edit('pending');
  assert.equal(await js('document.querySelector("#schRepo").value'), 'removed-repo');
  assert.match(await js('document.querySelector("#schRepo option:checked").textContent'), /不可用|无权/);
  report.checks.push('a removed saved project retains its identity and explicit unavailable label');
  await click('#schCancel');
  await js(`rows[0].repoId=''; rows[0].personalPluginKey='browser-method'; rows[0].requiredCapabilities=['browser'];
    window.soduWorkAPI={personalPlugins:{list:async()=>({items:[{key:'browser-method',name:'网页方法',
      version:'1.0.0',checksum:'a'.repeat(64),entrypoints:{automation:true},inputs:[],capabilities:{runtime:['browser']}}]})}}; void 0;`);
  await edit('pending');
  assert.equal(await js('document.querySelector("#schCaps input[value=browser]").disabled'), true);
  await field('schMethod', '');
  assert.equal(await js('document.querySelector("#schCaps input[value=browser]").checked'), false);
  assert.equal(await js('document.querySelector("#schCaps input[value=browser]").disabled'), false);
  report.checks.push('clearing a method removes its old hidden capability requirement');
  await js('rows[0].personalPluginKey=""; rows[0].requiredCapabilities=[]');
  for (const fail of [false, true]) {
    await js(`window.originalUpdate=SoduWorkAPI.updateSchedule;
      SoduWorkAPI.updateSchedule=()=>new Promise((resolve,reject)=>{window.finishSave=()=>${fail ? "reject(Error('old request failure'))" : "resolve({id:'pending'})"};}); void 0;`);
    await click('#schSave');
    assert.equal(await js('document.querySelector("#schTitle").disabled'), true);
    await click('#schCancel'); await edit('pending');
    await field('schTitle', '关闭重开后保留的新草稿');
    await js('window.notice="new draft"; finishSave(); void 0'); await wait(50);
    assert.equal(await js('!!document.querySelector("#schEditorLayer.show")'), true);
    assert.equal(await js('document.querySelector("#schTitle").value'), '关闭重开后保留的新草稿');
    assert.equal(await js('notice'), 'new draft');
    await js('SoduWorkAPI.updateSchedule=originalUpdate; void 0');
    report.checks.push('late save ' + (fail ? 'failure' : 'success') + ' cannot close or notify a reopened draft');
  }
  await click('#schCancel');
  await edit('pending'); await field('schEvery','daily');
  assert.deepEqual(await js('[schH.tagName,schM.tagName,schH.options.length,schM.options.length]'),['SELECT','SELECT',24,60]);
  const savedCount=await js('calls.updated.length');
  await field('schM','888');
  assert.match(await js('schPv.textContent'),/请选择分钟/);
  await click('#schSave'); assert.equal(await js('calls.updated.length'),savedCount);
  for (const id of ['schH','schM']) {
    await js('document.getElementById('+JSON.stringify(id)+').focus()');
    for (const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({type,keyCode:'End'});
    await wait(70);
  }
  assert.deepEqual(await js('[schH.value,schM.value]'),['23','59']);
  assert.match(await js('schPv.textContent'),/23:59/);
  await shot('recurring-time-select-wide');
  win.setSize(390,900); await wait(120);
  assert.equal(await js('schEditorContent.scrollWidth<=schEditorContent.clientWidth'),true);
  await shot('recurring-time-select-390'); win.setSize(1280,950);
  await click('#schSave'); await until('calls.updated.length==='+String(savedCount+1));
  assert.deepEqual(await js('[calls.updated.at(-1).body.atHour,calls.updated.at(-1).body.atMinute]'),[23,59]);
  await edit('pending'); await field('schEvery','hourly');
  assert.equal(await js('schH.hidden && getComputedStyle(schHWrap).display!=="none" && schM.checkVisibility()'),true);
  await field('schM','30'); await click('#schSave'); await until('calls.updated.length==='+String(savedCount+2));
  assert.equal(await js('calls.updated.at(-1).body.atMinute'),30);
  report.checks.push('Native bounded time selects update the preview immediately, reject 888 without saving, preserve 23:59 and hourly minutes, and fit 390px');
  await js('SoduWorkAPI.deleteSchedule=async()=>{throw Error("fixture offline")}; void 0');
  await click('.sch-item[data-sid="pending"] [data-act="del"]');
  await click('.sch-item[data-sid="pending"] [data-c="yes"]');
  assert.match(await js('notice'), /没删掉/);
  assert.equal(await js('!!document.querySelector(".sch-item[data-sid=pending]")'), true);
  assert.equal(await js('!!document.querySelector(".sch-confirm")'), false);
  report.checks.push('failed deletion retains the plan and reports the actual failure');
  await js(`window.originalList=SoduWorkAPI.listSchedules;
    SoduWorkAPI.listSchedules=()=>new Promise(resolve=>{window.finishOldList=resolve});
    _schRows=null; window.oldLoad=_loadSch(); void 0;`);
  await js(`dispatchEvent(new Event('soduwork-data-scope-changed'));
    SoduWorkAPI.listSchedules=async()=>[]; openSchedulePanel(); void 0;`);
  await until('_schRows !== null && _schRows.length===0');
  await js('finishOldList([{id:"old-private-plan",title:"old account"}]); oldLoad');
  assert.deepEqual(await js('_schRows'), []);
  assert.equal(await js('Object.keys(_schRunRows).length'), 0);
  assert.equal(await js('document.querySelectorAll(".sch-item").length'), 0);
  report.checks.push('identity switch clears history and rejects a late previous-account plan list');
  assert.deepEqual(await js('errors'), []); assert.deepEqual(requests, []);
  report.checks.push('no renderer errors, real network calls, real model requests or business data');
  report.ok = true;
}).catch(error => { report.error = String(error.stack || error); }).finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (win && !win.isDestroyed()) win.destroy();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  app.exit(report.ok ? 0 : 1);
});
