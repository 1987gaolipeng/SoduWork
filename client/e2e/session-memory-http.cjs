'use strict';
// Real Electron/preload/main IPC -> private local imports. A real migrated Hub
// verifies that confirmed personal evidence is never uploaded automatically.
// Only file selection and the new-conversation host are deterministic adapters.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME',
    'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', env, windowsHide: true });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
app.on('window-all-closed', () => {}); // The journey deliberately reopens its renderer.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const memory = require('../main/conversation/session-memory');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-memory-http-'));
const evidence = path.resolve(process.argv[2] || path.join(root, 'evidence'));
fs.mkdirSync(evidence, { recursive: true });
app.setPath('userData', path.join(root, 'profile'));
const source = path.join(root, 'codex-rollout.jsonl');
const row = (role, text, channel) => ({ type: 'response_item', payload: { type: 'message', role, channel,
  content: [{ type: 'input_text', text }] } });
fs.writeFileSync(source, [
  { type: 'session_meta', payload: { id: 'e2e-memory-original-session' } },
  row('system', 'SYSTEM-MUST-NOT-IMPORT'), row('assistant', 'HIDDEN-REASONING', 'analysis'),
  row('user', '完成季度报告。api_key="PRIVATE-SECRET"'),
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'old-tool', output: 'RAW-TOOL-EVIDENCE' } },
  row('assistant', '决定：只采用核实的数据\n下一步：补齐回归', 'final'),
].map(JSON.stringify).join('\n'));
const report = { ok: false, checks: [], scope: 'Electron production memory panel/preload/IPC; durable account-local imports; real migrated Hub verifies no evidence upload; offline editing; no model calls' };
let hub, win, auth, identities, bridge, chosen = source, log = '', lastPort = 0;
const errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code);
async function until(code) {
  for (let i = 0; i < 200; i++) { if (await js(code)) return; await sleep(30); }
  throw Error('UI timeout: ' + code + '; ' + await js("document.querySelector('[data-message]')?.textContent"));
}
async function startHub() {
  const venvPython = path.resolve(__dirname, '../../hub-backend/.venv/Scripts/python.exe');
  const python = process.env.SODUWORK_PYTHON || (require('node:fs').existsSync(venvPython) ? venvPython : 'python');
  const child = spawn(python, [path.join(__dirname, 'fixtures/session-memory-hub.py'), root, String(lastPort)],
    { cwd: root, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  hub = child;
  child.stderr.on('data', data => { log = (log + data.toString()).slice(-12000); });
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('Fixture Hub startup timed out: ' + log)), 90000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error('Fixture Hub exited ' + code + ': ' + log)); });
    child.stdout.on('data', data => {
      output += data.toString();
      const match = output.match(/E2E_READY (.+)\r?\n/);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    });
  });
  lastPort = ready.port;
  identities = ready.identities.map(item => ({ ...item, hub: 'http://127.0.0.1:' + ready.port }));
  auth = identities[0];
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(auth.hub + '/healthz')).ok) return; } catch (_) {}
    await sleep(50);
  }
  throw Error('Hub socket not ready');
}
async function stopHub() {
  if (!hub || hub.exitCode !== null) return;
  const child = hub;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}
async function stats() { return (await fetch(identities[0].hub + '/__e2e/stats')).json(); }
async function imported(id) {
  const result = await js(`soduWorkAPI.conversationSession.memory.get(${JSON.stringify(id)})`);
  assert.notEqual(result.ok, false, result.reason);
  return result.item;
}
async function shot(name) { fs.writeFileSync(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function click(selector) {
  await until(`!!document.querySelector(${JSON.stringify(selector)})`);
  const point = await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await sleep(50);
}
async function input(selector, value) {
  await click(selector);
  await js(`document.querySelector(${JSON.stringify(selector)}).select()`);
  await win.webContents.insertText(value);
}
async function openWindow() {
  win = new BrowserWindow({ show: false, width: 1280, height: 860,
    webPreferences: { preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'fixtures/session-memory.html'));
  await until('window.ready===true');
  await js("window.e2eErrors=[];window.addEventListener('error',e=>e2eErrors.push(e.message));window.addEventListener('unhandledrejection',e=>e2eErrors.push(String(e.reason)));window.WorkspaceHost={open:(type,payload)=>{window.opened={type,payload};SessionMemoryEntry.set(payload)}};openSessionMemoryPanel()");
  await until("document.querySelector('[data-personal-content]') && !document.querySelector('[data-personal-content]').disabled");
}
async function preview() { await click('[data-import]'); await until("document.querySelector('[data-wizard]')?.dataset.wizardStep==='review'"); }
async function confirm() {
  await click('[data-wizard-next]'); await click('[data-confirm]'); await click('[data-wizard-submit]');
  await until("!!document.querySelector('[data-use]')");
}
async function run() {
  await startHub();
  bridge = memory.install({ app, ipcMain, BrowserWindow,
    dialog: { showOpenDialog: async () => chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] } },
    identityOf: async () => auth });
  await openWindow();
  report.checks.push('Hub boots with full lifespan and migrations; Electron opens the memory library');
  chosen = ''; await click('[data-import]'); assert.equal((await stats()).count, 0);
  chosen = source; await preview();
  assert.equal((await stats()).requests.filter(x => x.method === 'POST').length, 0);
  assert.doesNotMatch(await js('document.body.innerText'), /SYSTEM-MUST-NOT|HIDDEN-REASONING|PRIVATE-SECRET/);
  await shot('01-local-preview');
  await click('[data-cancel]'); assert.equal((await stats()).count, 0);
  report.checks.push('file cancellation and preview cancellation upload nothing; preview redacts credentials and excludes hidden instructions');
  await preview(); await input('[name=summary]', '经人工确认的季度总结'); await input('[name=title]', '端到端季度记忆');
  await confirm(); assert.equal((await stats()).count, 0);
  await click('[data-use]');
  const id = (await js('SessionMemoryEntry.options()')).memoryIds[0];
  let item;
  const detail = await imported(id);
  assert.equal(detail.fields.summary, '经人工确认的季度总结');
  assert.doesNotMatch(JSON.stringify(detail), /SYSTEM-MUST-NOT|HIDDEN-REASONING|PRIVATE-SECRET/);
  assert.equal(detail.scope, 'private');
  report.checks.push('UI confirmation persists reviewed summary and sanitized evidence locally; Hub has no uploaded evidence');
  await preview(); await confirm(); assert.equal((await stats()).count, 0);
  assert.equal((await imported(id)).fields.summary, '经人工确认的季度总结');
  report.checks.push('repeat import keeps one record and preserves the reviewed summary');
  errors.push(...await js('e2eErrors')); win.destroy(); await stopHub(); await startHub(); await openWindow();
  // Imports are private evidence, not extra rows in the singleton personal
  // memory document. Re-selecting the same source opens its durable record.
  await preview(); await confirm(); assert.equal((await stats()).count, 0);
  assert.equal(await js("document.querySelector('[name=summary]').value"), '经人工确认的季度总结');
  report.checks.push('Hub restart/token renewal and a new renderer retain the same account-local reviewed memory');
  await input('[name=summary]', '更新后的确认摘要');
  assert.equal(await js("document.querySelector('[data-use]').disabled"), true);
  await stopHub(); await click('[data-wizard-submit]');
  await until("document.querySelector('[data-message]').textContent.includes('已保存')");
  item = await imported(id); assert.equal(item.revision, 2);
  assert.equal(item.fields.summary, '更新后的确认摘要');
  assert.equal(await js("document.querySelector('[data-use]').disabled"), false);
  await startHub();
  report.checks.push('confirmed edits save offline as revision 2 and enable recall without waiting for the Hub');
  await click('[data-use]');
  const opened = await js('opened'); assert.equal(opened.type, 'create');
  const options = await js('SessionMemoryEntry.options()'); assert.deepEqual(options.memoryIds, [id]);
  const context = await bridge.context(auth, options);
  assert.match(context.prompt, /更新后的确认摘要/); assert.doesNotMatch(context.prompt, /RAW-TOOL-EVIDENCE/);
  bridge.bind('e2e-resumed-session', auth, context.ids);
  assert.deepEqual((await bridge.context(auth, { chatId: 'e2e-resumed-session' })).ids, [id]);
  report.checks.push('new-conversation entry and main-process recall use latest confirmed fields; resume reads persisted binding');
  auth = identities[1];
  assert.equal((await js(`soduWorkAPI.conversationSession.memory.get(${JSON.stringify(id)})`)).ok, false);
  const foreign = await bridge.context(identities[1], { chatId: 'e2e-resumed-session' });
  assert.doesNotMatch(foreign.prompt, /更新后的确认摘要/);
  assert.ok(foreign.warning);
  auth = identities[0];
  report.checks.push('other account cannot read imported evidence or reuse a local binding');
  await click('[data-archive]'); await until("document.querySelector('[data-use]').disabled");
  assert.match((await bridge.context(auth, { chatId: 'e2e-resumed-session' })).warning, /不可用/);
  assert.doesNotMatch((await bridge.context(auth, { memoryIds: [id] })).prompt, /更新后的确认摘要/);
  await click('[data-archive]'); await until("!document.querySelector('[data-use]').disabled");
  assert.match((await bridge.context(auth, { memoryIds: [id] })).prompt, /更新后的确认摘要/);
  report.checks.push('archive blocks recall; restoring the imported evidence re-enables latest context');
  win.setSize(560, 820); await sleep(200); await shot('02-library-narrow');
  const overflow = await js("[...document.querySelectorAll('.cmem-panel,.cmem-detail,.cmem-form')].map(n=>({name:n.className,width:n.clientWidth,scroll:n.scrollWidth}))");
  assert.ok(overflow.every(n => n.scroll <= n.width + 2), JSON.stringify(overflow));
  report.checks.push('560px window keeps memory form inside its scroll container');
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', (_e, method) => {
    if (method === 'Page.javascriptDialogOpening') win.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  await win.webContents.debugger.sendCommand('Page.enable');
  await click('[data-delete]'); await until("document.querySelector('[data-message]').textContent==='记忆已删除'");
  assert.equal((await stats()).count, 0); assert.ok(fs.existsSync(source));
  assert.equal((await js(`soduWorkAPI.conversationSession.memory.get(${JSON.stringify(id)})`)).ok, false);
  assert.equal((await stats()).requests.filter(x => x.method !== 'GET').length, 0);
  assert.match((await bridge.context(auth, { chatId: 'e2e-resumed-session' })).warning, /不可用/);
  report.checks.push('UI deletion removes local evidence, retains original file and safely degrades binding; no Hub mutation throughout');
  errors.push(...await js('e2eErrors')); assert.deepEqual(errors, []); report.ok = true;
}
app.whenReady().then(run).catch(async error => {
  report.error = error.stack; if (win && !win.isDestroyed()) await shot('failure').catch(() => {});
}).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy(); await stopHub();
  report.cleanup = { fixtureHubStopped: !hub || hub.exitCode !== null || hub.signalCode !== null, realUserDataTouched: false };
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(report.ok ? 0 : 1);
});
