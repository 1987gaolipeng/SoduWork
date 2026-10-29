'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw Error('Absolute evidence directory required');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-model-load-')));
const report = { ok: false, cases: [] };
let win;
const js = code => win.webContents.executeJavaScript(code.includes('await ') ? `(async()=>{${code}})()` : code);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i = 0; i < 100; ++i) { if (await js(code)) return; await wait(30); }
  throw Error('Timeout: ' + code);
}
async function click(selector) {
  const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
}
async function run() {
  const isolated = session.fromPartition('model-loading-isolated');
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, cb) => cb({ cancel: true }));
  win = new BrowserWindow({ show: false, width: 1440, height: 950,
    webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  // Exercise the actual workspace and all its shared scripts, not a host that
  // defines helpers differently from production. No live account/API mutations.
  await win.loadFile(path.join(__dirname, '../desk.html'), { query: { panel: 'workspace' } });
  // Authentication is isolated too. Let the deliberately blocked startup
  // request settle before announcing the fixture account to the normal UI.
  await until('!!document.querySelector(".soduwork-auth-submit") && !document.querySelector(".soduwork-auth-submit").disabled');
  await js(`window.loadErrors=[];addEventListener('unhandledrejection',e=>loadErrors.push(String(e.reason)));
    window.modelFixture={providers:[{id:'test',name:'Test service',kind:'openai-compat',baseUrl:'https://fixture.invalid/v1',keySet:true,
      modelNames:['example'],modelDefs:[{name:'example',config:{imageRouting:'native'},capabilityCheck:{checkedAt:'2026-10-01T00:00:00Z',checks:{connection:{status:'passed',code:'verified'}}}}]}],
      myModels:[],usable:[{providerId:'test',name:'example',keyFrom:'org'}]};
    window.goodModels=async()=>structuredClone(modelFixture);SoduWorkAPI.myModels=goodModels;
    dispatchEvent(new CustomEvent('soduwork-device-auth',{detail:{state:'active',user:{id:'fixture-user',displayName:'UI test'}}}));
    WorkspaceShell.setActive('models');openModelsPanel();`);
  await until('!!document.querySelector(".md-model-row")');
  assert.equal(await js('typeof window.esc'), 'undefined');
  assert.equal(await js('typeof esc'), 'function');
  assert.equal(await js('!!document.querySelector(".md-cap-badge")'), true);
  assert.equal(await js('!!document.querySelector(".md-cap-report")'), true);
  assert.equal(await js('!!document.querySelector(".md-load")'), false);
  report.cases.push('production workspace opens the catalog and capability report with lexical esc; no window.esc shim');
  assert.equal(await js(`ModelCapabilitiesUI.report({error:'<img src=x onerror=alert(1)>"'}).includes('<img')`), false);
  report.cases.push('capability text remains HTML-escaped without a host helper');
  assert.equal(await js('document.querySelector("#soduWorkClientAuthGate").hidden'), true);
  await wait(180);
  fs.writeFileSync(path.join(root, 'models-workspace.png'), (await win.webContents.capturePage()).toPNG());

  await js(`window.savedRender=_mdRender;_mdRender=()=>{throw Error('simulated renderer fault')};await _mdLoad()`);
  assert.equal(await js('!!document.querySelector("[data-md-load-error]") && !document.querySelector(".md-load") && document.querySelector("#mdSave").disabled'), true);
  assert.match(await js('document.querySelector("#mdBody").textContent'), /页面显示遇到问题/);
  await js('_mdRender=savedRender;void 0'); await click('#mdRetry');
  await until('!!document.querySelector(".md-model-row")');
  report.cases.push('render exception becomes a recoverable error; real pointer click retries successfully');

  for (const [status, text] of [[401, '登录状态'], [403, '账号权限'], [503, '服务连接']]) {
    await js(`SoduWorkAPI.myModels=async()=>{throw Object.assign(Error('request failed'),{status:${status}})};await _mdLoad()`);
    assert.ok((await js('document.querySelector("#mdBody").textContent')).includes(text));
    assert.equal(await js('document.querySelector("#mdBody").hasAttribute("aria-busy")'), false);
  }
  for (const bad of [null, { providers: {}, usable: [], myModels: [] }, { providers: [null], usable: [], myModels: [] }]) {
    await js(`SoduWorkAPI.myModels=async()=>(${JSON.stringify(bad)});await _mdLoad()`);
    assert.match(await js('document.querySelector("#mdBody").textContent'), /格式异常/);
  }
  await js('SoduWorkAPI.myModels=goodModels;void 0'); await click('#mdRetry');
  await until('!!document.querySelector(".md-model-row")');
  report.cases.push('auth, permission, network and malformed-catalog failures end loading and recover through retry');

  await js(`window.realTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>realTimeout(fn,ms===20000?80:ms,...args);
    SoduWorkAPI.myModels=()=>new Promise(resolve=>window.finishLate=resolve);await _mdLoad();window.setTimeout=realTimeout`);
  assert.match(await js('document.querySelector("#mdBody").textContent'), /加载超时/);
  await js('SoduWorkAPI.myModels=goodModels;void 0'); await click('#mdRetry');
  await until('!!document.querySelector(".md-model-row")');
  await js('finishLate({providers:[],usable:[],myModels:[]});await Promise.resolve()');
  assert.equal(await js('document.querySelectorAll(".md-nav-item").length'), 1);
  report.cases.push('permanently pending catalog times out; successful retry is not overwritten by a late response');

  await js(`SoduWorkAPI.myModels=()=>new Promise(resolve=>window.finishOlder=resolve);window.olderLoad=_mdLoad();await Promise.resolve();
    SoduWorkAPI.myModels=goodModels;await _mdLoad();finishOlder({providers:[],usable:[],myModels:[]});await olderLoad`);
  assert.equal(await js('document.querySelectorAll(".md-nav-item").length'), 1);
  report.cases.push('overlapping loads keep only the newest successful catalog');

  await js(`SoduWorkAPI.myModels=()=>new Promise(resolve=>window.finishClosed=resolve);window.closedLoad=_mdLoad();await Promise.resolve();
    closeModelsPanel();finishClosed({providers:[],usable:[],myModels:[]});await closedLoad;SoduWorkAPI.myModels=goodModels;openModelsPanel()`);
  await until('!!document.querySelector(".md-model-row") && !document.querySelector("#mdBody").hasAttribute("aria-busy")');
  assert.deepEqual(await js('loadErrors'), []);
  report.cases.push('closing/reopening cancels obsolete UI writes; no unhandled promise rejection');
  report.ok = true;
}
app.whenReady().then(run).catch(async error => {
  report.error = error.stack;
  if (win) {
    fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    report.state = await js(`({body:document.querySelector('#mdBody')?.textContent, panel:document.querySelector('#mdPanel')?.getBoundingClientRect().toJSON(), retry:document.querySelector('#mdRetry')?.getBoundingClientRect().toJSON(), errors:loadErrors})`);
  }
}).finally(() => {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
});
