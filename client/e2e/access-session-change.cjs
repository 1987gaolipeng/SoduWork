'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, stdio: 'inherit', windowsHide: true });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-change-ui-'));
app.setPath('userData', path.join(root, 'profile'));
const out = path.resolve(__dirname, '../../outputs/access-session-change'); fs.mkdirSync(out, { recursive: true });
const report = { ok: false, cases: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, fixture, live, changes, control, retryOperation, nativeDecision = 0, nativeOptions = null;
async function until(check) { for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await delay(10); } throw Error('Timed out'); }
async function click(selector) {
  const rect = await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded '+${JSON.stringify(selector)});return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
  await delay(80);
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 640, height: 720, webPreferences: {
    preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  fixture = await require('./fixtures/access-sdk.cjs').create(root, 'standard', () => {}, { reply: (body, operation) => operation || (/The user changed/.test(JSON.stringify(body.messages.at(-1))) ? retryOperation : null) });
  live = { session: fixture.session, access: fixture.access, policy: fixture.access.policy };
  changes = require('../main/access-control/pi-transition').create({ cwd: fixture.workspace, current: () => live,
    prepare: (policy, previous) => fixture.rebuild(policy, previous), commit: next => { live = next; } });
  control = require('../main/access-control/pi-live-change').create({ current: () => live, transition: changes });
  const snapshot = () => ({ ref: 'change-e2e', adapterId: 'pi', displayName: 'Pi', accessPolicy: live.policy,
    nextAccessPolicy: changes.pending(), accessControl: { schema: 'soduwork.access-policy/v1', supported: true, modes: ['standard', 'readonly', 'full'], canChangeDuringSession: true, changeTakesEffect: 'current-turn' } });
  const handle = { cwd: fixture.workspace, attachedWindow: win, snapshot,
    setAccessPolicy: (value, revision) => control.change(value, revision) };
  ipcMain.handle('pi-session-set-access-mode', require('../main/access-control/ipc').changeHandler({
    session: { get: ref => ref === 'change-e2e' ? handle : null }, BrowserWindow,
    confirmFullAccess: async (_parent, options) => { nativeOptions = options || null; return nativeDecision === 1; } }));
  await win.loadFile(path.join(__dirname, 'fixtures/access-controls.html'));
  await win.webContents.executeJavaScript(fs.readFileSync(path.resolve(__dirname, '../components/panels/chat-session-controls.js'), 'utf8'));
  await win.webContents.executeJavaScript(`
    document.body.innerHTML='<div id="controls" style="padding-top:530px"><span id="nchatRuntime"><span id="nchatRuntimeIcon"></span><span id="nchatRuntimeName"></span></span><button id="nchatMode"><span id="nchatModeName"></span></button></div>';
    window.changeState=${JSON.stringify(snapshot())};
    window.controls=ChatSessionControls.create(document.querySelector('#controls'),{state:()=>changeState,accessChanged:r=>{Object.assign(changeState,r.snapshot);controls.render();}});
    controls.render();`);
  const sid = live.session.sessionId;
  const send = async (tool, args) => { await control.run(() => live.session.prompt(JSON.stringify({ tool, args })));
    await win.webContents.executeJavaScript('Object.assign(changeState,' + JSON.stringify(snapshot()) + ');controls.render()'); };
  await send('write', { path: 'before.txt', content: 'kept history' });
  const messages = live.session.state.messages.length;
  await click('#nchatMode'); await click('[data-access-mode="readonly"]');
  await until(() => live.policy.mode === 'readonly');
  assert.equal(changes.pending(), null);
  await until(() => win.webContents.executeJavaScript('document.querySelector(".nchat-access-pending").hidden===true'));
  await send('write', { path: 'blocked.txt', content: 'no write' });
  assert.equal(fs.existsSync(path.join(fixture.workspace, 'blocked.txt')), false);
  assert.equal(live.session.sessionId, sid); assert.ok(live.session.state.messages.length > messages);
  report.cases.push('real mouse → production session UI → preload → production IPC → Pi SDK applies readonly immediately and keeps history');
  await click('#nchatMode'); await click('[data-access-mode="standard"]');
  await until(() => live.policy.mode === 'standard');
  await until(() => win.webContents.executeJavaScript("changeState.accessPolicy.mode === 'standard' && document.querySelector('#nchatMode').getAttribute('aria-busy') === 'false'"));
  const outside = path.join(root, 'outside.txt');
  retryOperation = { tool: 'write', args: { path: outside, content: 'explicit consent' } };
  const active = send(retryOperation.tool, retryOperation.args);
  const oldAccess = live.access;
  const oldRequest = await until(() => oldAccess.broker.pending()[0]);
  await click('#nchatMode'); await click('[data-access-mode="full"]');
  await until(() => win.webContents.executeJavaScript('document.querySelector(".nchat-access-status")?.textContent.includes("已取消")'));
  assert.ok(nativeOptions?.anchor && Number.isFinite(nativeOptions.anchor.left) && Number.isFinite(nativeOptions.anchor.top));
  assert.equal(changes.pending(), null); assert.equal(live.policy.mode, 'standard'); assert.equal(oldAccess.broker.pending().length, 1);
  report.cases.push('cancelled native full-access consent leaves policy and history unchanged');
  nativeDecision = 1;
  await click('#nchatMode');
  await click('[data-access-mode="full"]'); await until(() => live.policy.mode === 'full');
  await active;
  assert.equal(oldAccess.broker.answer({ ...oldRequest, decision: 'once' }).ok, false);
  assert.equal(changes.pending(), null);
  assert.equal(await win.webContents.executeJavaScript('document.querySelector(".nchat-access-pending").hidden'), true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'explicit consent'); assert.equal(live.session.sessionId, sid);
  report.cases.push('confirmed full access unblocks and finishes the active Pi turn without another user message; stale approval retires');
  fs.writeFileSync(path.join(out, 'session-controls.png'), (await win.webContents.capturePage()).toPNG());
  report.ok = true;
}).catch(async error => {
  report.error = error.stack || String(error);
  if (win && !win.isDestroyed()) {
    report.ui = await win.webContents.executeJavaScript('({text:document.body.innerText,viewport:[innerWidth,innerHeight]})').catch(() => null);
    fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  }
}).finally(async () => {
  control?.close(); changes?.close();
  try { live?.access?.broker.close(); await live?.session?.abort(); live?.session?.dispose(); await fixture?.close(); } catch (error) { report.cleanupError = String(error); report.ok = false; }
  if (win && !win.isDestroyed()) win.destroy();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  app.exit(report.ok ? 0 : 1);
});
