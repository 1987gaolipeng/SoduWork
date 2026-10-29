'use strict';
// Diagnostic for direct engine loading in an isolated Electron process.
// Production hosts the SDK in utilityProcess; verify that boundary with
// agent-runtime-process.cjs. Keep this diagnostic's latency assertions strict.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), cp = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-first-send-'));
const baseline = process.argv.includes('--baseline');
const prewarmed = process.argv.includes('--prewarmed');
const report = { ok: false, baseline, prewarmed, turns: [], launches: [], boundary:
  'Direct-engine diagnostic in isolated Electron; production utilityProcess isolation is verified separately. Actual click/preload, Pi open/send, real SDK and loopback streaming/auth fixtures; no live account/model. SDK import is ' + (prewarmed ? 'prepared before click.' : 'cold.') };
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
for (const name of ['spawn', 'spawnSync', 'execSync', 'execFile', 'execFileSync']) {
  const original = cp[name];
  const wrapped = function (...args) {
    const options = args.find((arg, i) => i > 0 && arg && typeof arg === 'object' && !Array.isArray(arg));
    const start = performance.now();
    const row = { method: name, executable: path.basename(String(args[0])).slice(0, 90), hidden: options?.windowsHide === true };
    report.launches.push(row);
    try { return original.apply(this, args); } finally { row.callMs = Math.round(performance.now() - start); }
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original)); cp[name] = wrapped;
}
require('node:module').syncBuiltinESMExports();
let win, fixture, handle, off, active, timer;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, name) {
  const end = Date.now() + 45000;
  while (Date.now() < end) { if (await check()) return; await delay(20); }
  throw Error('Timed out: ' + name);
}
app.whenReady().then(async () => {
  if (prewarmed) {
    const begin = performance.now();
    await require('../main/pi-session/session').prewarm(app, null);
    report.preparationMs = Math.round(performance.now() - begin);
  }
  ipcMain.handle('pi-session-open', async () => {
    active = { started: performance.now(), maxMainLoopLagMs: 0, firstTokenMs: null };
    const assistantCount = handle?.snapshot().messages.filter(m => m.role === 'assistant').length || 0;
    let tick = active.started;
    timer = setInterval(() => { const now = performance.now(); active.maxMainLoopLagMs = Math.max(active.maxMainLoopLagMs, now - tick - 10); tick = now; }, 10);
    if (!fixture) {
      if (!baseline) {
        const loaded = await require('../main/pi-session/session').loadSdk(app);
        assert.equal(loaded.ok, true, loaded.reason);
      }
      fixture = await require('./fixtures/resumed-pi.cjs').create(root);
      active.sdkAndFixtureMs = performance.now() - active.started;
      const begin = performance.now();
      handle = await fixture.open({ resumePath: undefined,
        accessPolicy: require('../main/access-control/policy').create('standard', fixture.cwd), ephemeral: true });
      active.openMs = performance.now() - begin;
    }
    off?.();
    off = handle.on(() => {
        const text = handle.snapshot().messages.filter(m => m.role === 'assistant').slice(assistantCount)
          .flatMap(m => m.blocks || []).filter(b => b.kind === 'text').map(b => b.text).join('');
        if (active && active.firstTokenMs === null && text.includes('Fixture complete.')) active.firstTokenMs = performance.now() - active.started;
    });
    return { ok: true, ref: handle.ref };
  });
  ipcMain.handle('pi-session-send', async (_event, ref, text) => {
    assert.equal(ref, handle.ref);
    const result = await handle.send(text);
    // Snapshot publication batches tokens for 50 ms; wait for the actual
    // observed reply before freezing this turn's timing record.
    await until(() => active && active.firstTokenMs !== null, 'visible reply token'); clearInterval(timer);
    const row = { ...active, totalMs: performance.now() - active.started }; delete row.started;
    for (const key of Object.keys(row)) if (typeof row[key] === 'number') row[key] = Math.round(row[key]);
    report.turns.push(row); active = null;
    assert.equal(result.ok, true, result.reason);
    return result;
  });
  win = new BrowserWindow({ show: false, width: 700, height: 400, webPreferences: {
    preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html,<button id="send" style="margin:40px;padding:20px">Send</button><p id="state">Ready</p>');
  await win.webContents.executeJavaScript(`window.done=0;window.errors=[];document.querySelector('#send').onclick=async()=>{
    document.querySelector('#state').textContent='Preparing';
    try{const s=await soduWorkAPI.conversationSession.open({});const r=await soduWorkAPI.conversationSession.send(s.ref,'Give a short acknowledgement.');
    if(!r.ok)throw Error(r.reason);window.done++;document.querySelector('#state').textContent='Complete';}catch(e){window.errors.push(e.message);}};void 0;`);
  for (let n = 0; n < 2; n++) {
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: 85, y: 80, button: 'left', clickCount: 1 });
    await until(() => win.webContents.executeJavaScript(`window.done === ${n + 1} || window.errors.length > 0`), 'turn ' + n);
    assert.deepEqual(await win.webContents.executeJavaScript('window.errors'), []);
  }
  assert.equal(fixture.requests.length, 2, 'exactly one model request per send');
  assert.ok(report.turns.every(turn => turn.firstTokenMs !== null));
  if (!baseline) {
    assert.ok(report.turns.every(turn => turn.maxMainLoopLagMs < 450), 'Cold preparation must yield to the desktop');
    assert.equal(report.launches.filter(row => /Sync$/.test(row.method)).length, 0, 'No synchronous process launch in cold create/send');
    assert.equal(report.launches.filter(row => !row.hidden).length, 0, 'Background children must not start visible consoles');
  }
  report.ok = true;
}).catch(error => { report.error = error.stack; }).finally(async () => {
  clearInterval(timer); off?.(); await fixture?.close(); win?.destroy();
  const out = path.resolve(process.env.SODUWORK_FIRST_SEND_REPORT_DIR || path.join(__dirname, '../../outputs/first-send-startup-20261004')); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, baseline ? 'baseline.json' : prewarmed ? 'prewarmed.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
