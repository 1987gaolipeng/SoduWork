'use strict';
// Run with Electron, using an isolated profile; never starts the daily Runner or a commercial model.
const { app, BrowserWindow, ipcMain, session: electronSession, net } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { install, create } = require('../main/agent-runtime/custom-runtimes.cjs');
const { createStore, startupAgents } = require('../main/agent-runtime/custom-runtime-store.cjs');
const { mutableCatalog, createRuntimeCatalog } = require('../main/agent-runtime/runtime-catalog');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const source = require('../../hub-backend/app/agent_catalog.json');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
try { fs.unlinkSync(path.join(output, 'failure.png')); } catch {}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-custom-electron-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.on('window-all-closed', () => {});
const report = { ok: false, checks: [], errors: [], boundaries: [
  'Production management renderer, dialog, ComposeRuntime, WorkComposer, private IPC handlers, file store, runtime catalog, registry and Runner adapter.',
  'Fixture document served at the production desk.html URL in a private Electron session and a thin preload invokes the real channels; full desktop startup is not exercised, while original sender trust checks stay enabled.',
  'Runner RPC acknowledgements, detection and file picker are fault-injection doubles; no commercial model or executable runs in this suite. Actual ACP lifecycle is covered separately by test_custom_agent_catalog.',
] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, outsider, bridge, restored;
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code) { for (let i = 0; i < 180; i++) { if (await js('Boolean(' + code + ')')) return; await delay(40); } throw Error('Timed out: ' + code); }
async function click(selector) {
  const point = await js('(()=>{const b=document.querySelector(' + JSON.stringify(selector) + ');b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(90);
}
async function setFields(values) {
  await js('(()=>{for(const [name,value]of Object.entries(' + JSON.stringify(values) + ')){const f=document.querySelector(".ca-dialog [name="+name+"]");f.value=value;f.dispatchEvent(new Event("change",{bubbles:true}));}})()');
}
async function screenshot(name) {
  win.webContents.invalidate(); await delay(160);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function newBridge(runner) {
  return createPiSessionBridge({ app, catalog: mutableCatalog(createRuntimeCatalog(source)), runnerAdapters: [],
    sessionModule: { open: async () => { throw Error('No model execution in this suite'); }, probe: async () => ({ ok: true, version: 'fixture' }) },
    dynamicRunnerOptions: { runnerRuntime: runner } });
}
app.whenReady().then(async () => {
  let mode = 'offline', picks = 0;
  const applied = new Map(), calls = [], rpcTimeouts = [];
  const runner = { async rpc(operation, payload, timeout) {
    calls.push(operation); rpcTimeouts.push(timeout);
    if (operation === 'runtime.detect') {
      assert.ok(applied.has(payload.key));
      return { ok: true, data: { installed: true, state: 'ready', version: 'fixture', accessControl: applied.get(payload.key).accessControl } };
    }
    assert.equal(operation, 'runtime.catalog.apply');
    if (mode === 'offline') throw Error('Runner offline');
    for (const row of payload.agents) {
      if (applied.has(row.id)) assert.deepEqual(applied.get(row.id), row);
      applied.set(row.id, row);
    }
    if (mode === 'lost-ack') throw Error('RPC timeout after apply');
    return { ok: true, data: { agents: [...applied.values()], added: [] } };
  } };
  bridge = newBridge(runner);
  const builtin = bridge.registry.describe('pi');
  const controller = install({ app, ipcMain, session: bridge, runner, BrowserWindow,
    dialog: { async showOpenDialog() { picks++; return { canceled: false, filePaths: [path.join(temporary, 'example-agent.exe')] }; } } });
  const store = createStore(app);
  ipcMain.handle('custom-fixture-runtimes', () => ({ ok: true, runtimes: bridge.runtimes() }));
  ipcMain.handle('custom-fixture-probe', (_event, id) => bridge.probe(app, id));
  const isolated = electronSession.fromPartition('soduwork-custom-' + Date.now());
  const deskURL = pathToFileURL(path.resolve(__dirname, '../desk.html')).href;
  isolated.protocol.handle('file', request => request.url === deskURL
    ? new Response(fs.readFileSync(path.join(__dirname, 'fixtures/custom-agents.html')), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  const preferences = { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
    offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, 'fixtures/custom-agents-preload.cjs') };
  win = new BrowserWindow({ show: false, width: 1100, height: 920, webPreferences: preferences });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
  await win.loadURL(deskURL); await until('window.fixtureReady && document.querySelector("#agAddRuntime")');
  for (const name of JSON.parse(fs.readFileSync(path.resolve(__dirname, '../core/locales/manifest.json'), 'utf8'))) {
    await js(fs.readFileSync(path.resolve(__dirname, '../core/locales', name), 'utf8'));
  }
  for (const name of ['i18n-dom.js', 'i18n.js']) await js(fs.readFileSync(path.resolve(__dirname, '../core', name), 'utf8'));
  await click('#agAddRuntime'); await until('document.querySelector("dialog[open]")');
  await click('.ca-primary');
  assert.match(await js('document.querySelector(".ca-error").textContent'), /请填写/);
  assert.equal(fs.existsSync(store.file), false);
  await setFields({ displayName: '保存', command: 'powershell.exe', args: '--acp' });
  await click('.ca-primary'); await until('!document.querySelector("form[aria-busy]")');
  assert.equal(fs.existsSync(store.file), false); assert.equal(calls.length, 0);
  assert.equal(await js('document.querySelector(".ca-error").hidden'), false);
  await click('[data-ca-pick]'); assert.equal(picks, 1);
  assert.equal(await js('document.querySelector("[name=command]").value'), path.join(temporary, 'example-agent.exe'));
  await click('.ca-primary'); await until('!document.querySelector(".ca-success").hidden');
  assert.match(await js('document.querySelector(".ca-success").textContent'), /尚未确认/);
  assert.equal(store.read().length, 1); const first = store.read()[0].declaration.id;
  assert.equal(store.read()[0].active, false); assert.equal(bridge.registry.describe(first), null);
  assert.equal(await js('ComposeRuntime.catalog().some(x=>x.id===' + JSON.stringify(first) + ')'), false);
  await screenshot('pending-offline'); await click('.ca-primary');
  await until('document.querySelector("[data-ca-activate]")');
  report.checks.push('Real management entry and native dialog validate input, use trusted picker IPC, persist offline as pending, and keep unacknowledged runtimes out of the conversation picker');

  mode = 'online'; await click('[data-ca-activate]');
  await until('document.querySelector("[data-ca-probe]") && ComposeRuntime.catalog().some(x=>x.id===' + JSON.stringify(first) + ')');
  assert.equal(store.read().length, 1); assert.equal(store.read()[0].active, true);
  assert.ok(bridge.registry.describe(first)); assert.deepEqual(bridge.registry.describe('pi'), builtin);
  await click('#cpRuntime'); await screenshot('new-runtime-picker'); await click('[data-runtime="' + first + '"]');
  await until('ComposeRuntime.value()===' + JSON.stringify(first));
  assert.equal(await js('ComposeRuntime.goalSupported()'), false); assert.equal(await js('ComposeRuntime.accessSupported()'), false);
  await click('[data-ca-probe]');
  assert.match(await js('document.querySelector(".ca-result").textContent'), /程序已找到/);
  report.checks.push('Retry acknowledges the same declaration once, registers a real Runner adapter, refreshes the existing production conversation picker and selects/probes the new substrate with truthful capability flags');

  mode = 'lost-ack'; await click('#agAddRuntime'); await until('document.querySelector("dialog")');
  await setFields({ displayName: '企业模型测试', command: 'example-acp', args: '--acp\n--verbose', modelMode: 'managed' });
  assert.equal(await js('document.querySelector(".ca-model-env").hidden'), false);
  await click('.ca-primary'); await until('!document.querySelector(".ca-success").hidden');
  const second = store.read()[1].declaration.id;
  assert.equal(applied.size, 2); assert.equal(bridge.registry.describe(second), null);
  assert.equal(store.read()[1].active, false);
  assert.match(await js('document.querySelector(".ca-success").textContent'), /尚未确认/);
  await click('.ca-primary'); await until('document.querySelector("[data-ca-activate]")');
  mode = 'online'; await click('[data-ca-activate]');
  await until('ComposeRuntime.catalog().some(x=>x.id===' + JSON.stringify(second) + ')');
  await controller.activate();
  assert.equal(store.read().length, 2); assert.equal(applied.size, 2);
  assert.equal(bridge.runtimes().filter(row => row.id === second).length, 1);
  assert.deepEqual(applied.get(second).runner.modelEnv, { OPENAI_BASE_URL: 'base', OPENAI_API_KEY: 'key', OPENAI_MODEL: 'model' });
  assert.deepEqual(applied.get(second).runner.args, ['--acp', '--verbose']);
  assert.equal(rpcTimeouts.filter((_value, i) => calls[i] === 'runtime.catalog.apply').every(value => value === 10000), true);
  report.checks.push('A lost apply acknowledgement remains pending; repeated activation does not duplicate registrations, preserves both entries, and transmits managed-model variable names without credentials');

  restored = newBridge(runner); create({ app, session: restored, runner }).restore();
  assert.equal(restored.runtimes().filter(row => row.id.startsWith('custom-')).length, 2);
  assert.equal(startupAgents(app).length, 2);
  report.checks.push('A new bridge restores acknowledged runtimes from the temporary disk store and startup declarations preserve both entries');

  for (const locale of ['en-US', 'zh-CN']) {
    await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ')'); await delay(100);
    assert.equal(await js('document.querySelector(".ca-row b").textContent'), '保存');
    assert.equal(await js('document.querySelector(' + JSON.stringify('[data-runtime="' + first + '"] .cp-runtime-head b') + ').textContent'), '保存');
    assert.equal(await js('document.querySelector("#cpRuntimeName").textContent'), '保存');
    assert.match(await js('document.querySelector("#cpRuntime").title'), /保存/);
    assert.match(await js('document.querySelector("#cpRuntime").getAttribute("aria-label")'), /保存/);
    await click('#agAddRuntime'); await until('document.querySelector("dialog")');
    await setFields({ displayName: 'My Agent', command: 'example-acp', modelMode: 'managed' });
    await delay(100);
    const title = await js('document.querySelector("#caTitle").textContent');
    assert.ok(locale === 'en-US' ? !/[\u3400-\u9fff]/.test(title) : /底座/.test(title), title);
    if (locale === 'en-US') {
      const copy = await js('document.querySelector(".ca-dialog").innerText');
      assert.equal(/[\u3400-\u9fff]/.test(copy), false, copy);
    }
    for (const width of [1100, 620, 390]) {
      win.setSize(width, 920); await delay(120);
      const geometry = await js('(()=>{const d=document.querySelector("dialog"),r=d.getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth,dialogOverflow:d.scrollWidth>d.clientWidth+1,bodyOverflow:document.documentElement.scrollWidth>innerWidth,inputs:[...d.querySelectorAll("input,select,textarea")].filter(x=>x.getClientRects().length).map(x=>{const a=x.getBoundingClientRect();return{left:a.left,right:a.right}})}})()');
      assert.ok(geometry.left >= 15 && geometry.right <= geometry.width - 15 && !geometry.dialogOverflow && !geometry.bodyOverflow, JSON.stringify(geometry));
      assert.ok(geometry.inputs.every(r => r.left >= geometry.left && r.right <= geometry.right), JSON.stringify(geometry));
      const visibleSave = await js('(()=>{const b=document.querySelector(".ca-primary"),r=b.getBoundingClientRect();return r.y>=0&&r.bottom<=innerHeight&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b})()');
      assert.equal(visibleSave, true, 'Save action must stay visible without scrolling at ' + width + 'px');
      await screenshot('dialog-' + locale + '-' + width);
    }
    const actionable = await js('(()=>{const b=document.querySelector(".ca-primary"),r=b.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b})()');
    assert.equal(actionable, true, 'Save action must remain reachable on a 390px viewport');
    await screenshot('dialog-footer-' + locale + '-390');
    await click('footer [data-ca-close]'); await until('!document.querySelector("dialog")'); win.setSize(1100, 920); await delay(80);
  }
  report.checks.push('Chinese/English dialogs and managed-model fields fit 1100/620/390px; locale switches preserve user-entered Agent names');

  outsider = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: preferences });
  await outsider.loadFile(path.join(__dirname, 'fixtures/i18n-roundtrip.html'));
  const denied = await outsider.webContents.executeJavaScript('soduWorkAPI.conversationSession.customAgents.add({id:"custom-untrusted",displayName:"Untrusted",command:"example-acp",modelMode:"account",args:[],modelEnv:{}})');
  assert.equal(denied.ok, false); assert.equal(store.read().length, 2); assert.equal(applied.size, 2);
  report.checks.push('A different file page cannot register commands through the same IPC handlers; sender authorization stays enforced');
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors)); report.ok = true;
}).catch(async error => {
  report.failure = error.stack || String(error);
  if (win && !win.isDestroyed()) await screenshot('failure').catch(() => {});
}).finally(async () => {
  if (bridge) await bridge.dispose().catch(() => {}); if (restored) await restored.dispose().catch(() => {});
  for (const window of [outsider, win]) if (window && !window.isDestroyed()) window.destroy();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const resolved = path.resolve(temporary), expectedParent = path.resolve(os.tmpdir());
  if (path.dirname(resolved) === expectedParent && path.basename(resolved).startsWith('soduwork-custom-electron-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Chromium may still hold its temporary profile until app.exit. */ }
  }
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
