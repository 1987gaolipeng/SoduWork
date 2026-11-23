'use strict';
// Run from client/: node e2e/plugin-unavailable-continuation.cjs [evidence-directory].
// Uses only synthetic personal plugins and a loopback HTTP model, never a live account.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const r = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit', timeout: 150000 });
  process.exit(r.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(client, '../outputs/plugin-unavailable-continuation'));
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-unavailable-ui-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const read = name => fs.readFileSync(path.join(client, name), 'utf8');
const personal = require(path.join(client, 'main/personal-plugins'));
const grant = require(path.join(client, 'main/pi-session/plugin-grant'));
const appGrant = require(path.join(client, 'main/pi-session/app-mcp-grant.cjs'));
const report = { ok: false, boundary: 'Visible Electron with production preload, NativeChat, slash picker, send IPC implementation, Pi SDK, personal plugin storage and authorization. Only model/runtime discovery and peripheral shell interfaces are fixtures. No live account/model or existing user profile.', cases: [] };
const requests = [], results = [], resolutions = [], errors = [];
let win, fixture, handle, off, ready = false, plugin, sessionId;
const js = code => win.webContents.executeJavaScript(code, true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function stage(name) { report.stage = name; console.log(name); }
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(35); }
  throw Error('Timed out: ' + label);
}
function publish(_windows, _session, event, snapshot) {
  if (ready) win.webContents.send('pi-session-event', { ref: handle.ref, ...event, snapshot: snapshot || handle.uiSnapshot() });
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable control: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control');return{x,y};})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
}
async function type(text) {
  await click('#nchatInput');
  await until(() => js("document.activeElement===document.querySelector('#nchatInput')"), 'composer focus');
  await win.webContents.insertText(text);
}
async function snapshot(name) {
  await delay(150);
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  return js("({text:document.body.innerText,input:document.querySelector('#nchatInput')?.value,error:document.querySelector('.nbad.show .nbad-copy')?.textContent,retry:!!document.querySelector('[data-plugin-retry]'),chips:document.querySelectorAll('.nplugin-chip').length})");
}
async function send(text, selected = false) {
  await type(text);
  const count = results.length + 1, modelBefore = fixture.requests.length, grantsBefore = resolutions.length;
  await click('#nchatSend');
  await until(() => results.length === count, 'send result ' + count);
  assert.equal(results.at(-1).ok, true, JSON.stringify(results.at(-1)));
  await until(() => !handle.inFlight(), 'turn settled');
  await until(() => js("document.querySelector('#nchatInput').value===''"), 'composer cleared');
  await until(() => js(`Array.from(document.querySelectorAll('.nmsg.user')).at(-1)?.innerText.includes(${JSON.stringify(text)})`), 'rendered user message');
  await delay(120);
  assert.equal(handle.sessionId, sessionId, 'ordinary continuation keeps its native session ID');
  assert.equal(fixture.requests.length, modelBefore + 1, 'one real loopback model call per successful send');
  assert.equal(resolutions.length, grantsBefore + Number(selected), 'unavailable inherited plugins never receive a fresh grant');
  const modelUser = fixture.requests.at(-1).messages.findLast(message => message.role === 'user');
  assert.equal(JSON.stringify(modelUser.content).includes('This is an isolated regression method.'), selected,
    'only explicit valid selection augments this model turn with plugin instructions');
  assert.equal(await js("document.querySelectorAll('.nbad.show').length"), 0, 'no failed-send banner');
  assert.equal(await js("Array.from(document.querySelectorAll('.nmsg.user')).at(-1).querySelectorAll('.nmessage-plugin').length"), Number(selected), 'only a newly selected active plugin badges this message');
  const lastUser = handle.uiSnapshot().messages.findLast(message => message.role === 'user');
  assert.deepEqual((lastUser.plugins || []).map(item => item.pluginId), selected ? [plugin.pluginId] : [], 'persisted message does not claim unavailable plugin use');
  assert.equal(fs.readFileSync(fixture.resumePath, 'utf8').startsWith(fixture.archivePrefix), true, 'original archive prefix is preserved');
  assert.ok(await js("document.querySelector('#nchatList').textContent.includes('Previous report is preserved.')"), 'original transcript remains visible');
  return { ok: results.at(-1).ok, reason: results.at(-1).reason, modelBefore, modelAfter: fixture.requests.length, outgoingPlugins: requests.at(-1).options.plugins };
}
async function selectPlugin() {
  await type('/停用删除');
  await until(() => js("Boolean(document.querySelector('.nplugin-menu .nplugin-option:not(.is-action)'))"), 'plugin picker');
  await click('.nplugin-menu .nplugin-option:not(.is-action)');
  await until(() => js("document.querySelectorAll('.nplugin-chip').length===1"), 'plugin selected');
}
function assertDetached() {
  assert.deepEqual(handle.uiSnapshot().activePlugins, [], 'unavailable inherited association is removed');
}
async function reopen() {
  off?.(); if (handle) { appGrant.unbind(handle); handle.close(); }
  handle = await fixture.open({ app, resolvePlugins: async (ids, projectId, turnContext) => {
    resolutions.push(ids.slice());
    return grant.resolve({ app, identityOf: async () => { throw Error('Unexpected live identity lookup'); }, fetchImpl: async () => { throw Error('Unexpected remote request'); }, pluginIds: ids, projectId, ref: handle?.sessionId || 'fixture', cwd: fixture.cwd, appContext: await appGrant.forSession(handle), ...turnContext });
  } });
  off = handle.on(event => publish(null, handle, event, handle.uiSnapshot()));
}
function installSend() {
  const source = read('main/pi-session/ipc.js');
  const code = source.slice(source.indexOf('  async function sendConversation('), source.indexOf("  ipcMain.handle('pi-session-send',"));
  const context = vm.createContext({ app, BrowserWindow, path, Promise, Date,
    _uiWindow: require(path.join(client, 'main/pi-session/ui-window')).create(), _cloudHandoff: { guard: () => false },
    require: require('node:module').createRequire(path.join(client, 'main/pi-session/ipc.js')),
    updateWorkloads: { guard: () => ({ ok: true }) }, session: { get: ref => ref === handle.ref ? handle : null },
    sendIdentityOf: async () => ({}), identityOf: async () => ({}), memories: { assertOwner() {} },
    pluginDebug: { guard: () => null }, workDir: () => root,
    attachments: require(path.join(client, 'main/pi-session/attachments')), _publish: publish, _scheduleRelease() {},
  });
  vm.runInContext(source.slice(source.indexOf('function _contextSnapshot('), source.indexOf('function _send(')) + '\n' + code, context);
  ipcMain.handle('pi-session-send', (_event, ref, text, files, options) => {
    requests.push({ ref, text, options });
    return context.sendConversation(ref, text, files, options, completion => completion.then(result => results.push(result)));
  });
}
app.whenReady().then(async () => {
  stage('Create isolated plugin and runtime');
  personal.install({ app, ipcMain, dialog: {}, identityOf: async () => { throw Error('Unexpected live identity lookup'); }, fetchImpl: async () => { throw Error('Unexpected remote request'); } });
  plugin = personal.create(app, { template: 'method', key: 'unavailable-ui-repro', name: '停用删除复现插件', version: '1.0.0', description: 'Isolated regression plugin', instructions: 'Reply briefly to the user. This is an isolated regression method.', skills: [], mcpServers: [], runtime: [] }).plugin;
  fixture = await require(path.join(client, 'e2e/fixtures/resumed-pi.cjs')).create(root);
  fixture.reply(() => ({ text: '本地模型已收到本轮消息（隔离验证）。' }));
  await reopen();
  sessionId = handle.sessionId;
  stage('Load real visible NativeChat');
  win = new BrowserWindow({ show: true, title: 'SoduWork 插件停用删除复现（隔离本地模型）', width: 1100, height: 850, webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  installSend();
  ipcMain.handle('pi-session-open-application', () => ({ ok: true, handled: false }));
  ipcMain.handle('pi-session-runtimes', () => ({ ok: true, runtimes: [{ id: 'pi', displayName: 'Pi', modelMode: 'managed' }] }));
  ipcMain.handle('access-preferences-get', () => ({ ok: true, mode: 'standard', revision: 0 }));
  ipcMain.handle('pi-session-open', event => {
    appGrant.bind(handle, event.sender, '', app, { identityOf: async () => { throw Error('Unexpected live identity lookup'); } });
    return { ok: true, ref: handle.ref, sessionId: handle.sessionId, adapterId: 'pi', cwd: fixture.cwd, model: { id: 'fixture-model', label: 'Local regression model' }, snapshot: handle.uiSnapshot() };
  });
  ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot: handle.uiSnapshot() }));
  for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, items: [] }, 'pi-session-release': { ok: true }, 'pi-session-runtime-models': { ok: true, items: [] }, 'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true }, 'work-preview-reset-embedded': { ok: true } })) ipcMain.handle(channel, () => value);
  const source = path.join(client, 'e2e/fixtures/workbench-annotations.html'), scripts = [];
  const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => { const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return ''; });
  const page = path.join(out, 'native-chat.html');
  fs.writeFileSync(page, html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(path.dirname(source) + path.sep).href + '">').replace('</style>', '</style><link rel="stylesheet" href="../../components/panels/chat-plugin-mention.css">'));
  await win.loadFile(page);
  for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
  for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/compose-candidate-navigation.js', 'components/panels/chat-plugin-mention-model.js', 'components/panels/chat-plugin-mention.js']) await js(read(file) + '\nvoid 0;');
  for (const script of scripts) await js(script + '\nvoid 0;');
  await js('SoduWorkAPI.pluginCatalog=()=>soduWorkAPI.personalPlugins.list();SoduWorkAPI.myModels=async()=>({usable:[{name:"fixture-model",id:"fixture-model",label:"Local regression model"}]});void 0;');
  ready = true;
  await js(`SoduWorkI18n.setLocale('zh-CN');NativeChat.enter('',${JSON.stringify(handle.sessionId)},{adapterId:'pi'});`);
  await until(() => js("document.querySelector('#nchatList')?.textContent.includes('Previous report is preserved.')"), 'initial history');
  await selectPlugin();
  const initial = await send('使用插件完成一次正常对话', true);
  assert.deepEqual(handle.uiSnapshot().activePlugins, [plugin.pluginId]);
  report.cases.push({ name: 'Enabled plugin initial conversation succeeds', ...initial, ui: await snapshot('01-enabled-success') });
  stage('Disable plugin and send ordinary follow-up');
  await js(`soduWorkAPI.personalPlugins.setEnabled(${JSON.stringify(plugin.pluginId)},false)`);
  const disabled = await send('插件已停用，现在只想普通聊天');
  assert.equal(disabled.outgoingPlugins.length, 0);
  assertDetached();
  report.cases.push({ name: 'Disabled inherited plugin is detached and ordinary chat succeeds', ...disabled, ui: await snapshot('02-disabled-continues') });
  stage('Reenable plugin without selecting it again');
  await js(`soduWorkAPI.personalPlugins.setEnabled(${JSON.stringify(plugin.pluginId)},true)`);
  const grantsBefore = resolutions.length;
  const reenabled = await send('重新启用插件后仍然只普通聊天');
  assertDetached();
  assert.equal(resolutions.length, grantsBefore, 'reenabling does not silently reactivate an old association');
  report.cases.push({ name: 'Reenabled plugin stays detached until explicitly selected', ...reenabled, ui: await snapshot('03-reenabled-stays-detached') });
  stage('Explicitly select the reenabled plugin');
  await selectPlugin();
  const selected = await send('现在明确重新使用这个插件', true);
  assert.deepEqual(handle.uiSnapshot().activePlugins, [plugin.pluginId]);
  assert.equal(resolutions.length, grantsBefore + 1);
  report.cases.push({ name: 'Explicitly selecting a valid plugin grants it again', ...selected, ui: await snapshot('04-explicit-plugin-success') });
  stage('Delete plugin and send ordinary follow-up');
  await js(`soduWorkAPI.personalPlugins.remove(${JSON.stringify(plugin.pluginId)})`);
  const deleted = await send('插件已删除，继续普通聊天');
  assert.equal(deleted.outgoingPlugins.length, 0);
  assertDetached();
  report.cases.push({ name: 'Deleted inherited plugin is detached and ordinary chat succeeds', ...deleted, ui: await snapshot('05-deleted-continues') });
  stage('Release and reopen saved session after deletion');
  ready = false; await js('NativeChat.reset();void 0;'); await reopen(); ready = true;
  await js(`NativeChat.enter('',${JSON.stringify(handle.sessionId)},{adapterId:'pi'});`);
  await until(() => js('NativeChat.hasSession()'), 'reopened session');
  assert.equal(handle.sessionId, sessionId);
  assertDetached();
  const grantsBeforeReopenSend = resolutions.length;
  const afterReopen = await send('重新打开会话后继续普通聊天');
  assert.equal(resolutions.length, grantsBeforeReopenSend);
  assertDetached();
  assert.equal(await js("document.querySelectorAll('.nmsg.user .nmessage-plugin').length"), 2, 'historical plugin badges remain accurate while later plain messages have none');
  report.cases.push({ name: 'Reopening preserves history and keeps the unavailable plugin detached', ...afterReopen, ui: await snapshot('06-reopened-continues') });
  report.rendererErrors = [...errors, ...await js('window.errors')];
  assert.deepEqual(report.rendererErrors, []);
  report.ok = true;
}).catch(async error => {
  report.error = error.stack || String(error);
  if (win && !win.isDestroyed()) report.ui = await snapshot('failure-debug').catch(() => null);
}).finally(async () => {
  ready = false; off?.(); if (handle) appGrant.unbind(handle); await fixture?.close(); win?.destroy();
  report.modelCalls = fixture?.requests.length; report.resolutions = resolutions;
  report.results = results.map(result => ({ ok: result.ok, reason: result.reason, failureKind: result.failureKind }));
  report.closedOwnWindow = !win || win.isDestroyed();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, error: report.error, report: path.join(out, 'report.json') }));
  app.exit(report.ok ? 0 : 1);
});
