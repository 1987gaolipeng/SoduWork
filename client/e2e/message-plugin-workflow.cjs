'use strict';

// Real Electron/preload, send IPC, personal workflow controller, Pi transcript
// and archive. Only workflow node execution/model transport use local fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron,
    [__filename, ...process.argv.slice(2), '--disable-gpu'],
    { env, windowsHide: true, stdio: 'inherit', timeout: 90000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-message-plugin-'));
const out = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ||
  path.join(client, '../outputs/message-plugin-workflow'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(root, 'profile'));
app.setPath('documents', root);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const report = { ok: false, checks: [], phases: [], network: [],
  boundary: 'Real Electron, production preload/send IPC/workflow controller/Pi transcript/archive and desktop-ordered renderer. Workflow node events and loopback model replies are isolated fixtures. No paid model, user profile or running business process.' };
const personal = require('../main/personal-plugins');
const pendingResults = [], requests = [], errors = [];
const prompt = '请使用「Pi 与 Qwen 漂亮页面工坊」帮我做一个简单贪吃蛇小游戏';
let win, fixture, handle, off, plugin, page, ready = false, sendContext, workflowOutput;
let workflowRuns = 0, nodeStarted = false;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const submitGate = deferred(), streamGate = deferred(), finishGate = deferred();
const js = code => win.webContents.executeJavaScript(code, true);
async function until(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error('Timed out: ' + label);
}
function publish(_windows, _session, event, snapshot) {
  if (ready) win.webContents.send('pi-session-event', { ref: handle.ref, ...event,
    snapshot: snapshot || handle.uiSnapshot() });
}
async function click(selector) {
  const point = await js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node || node.disabled) throw Error('Unavailable control: ' + ${JSON.stringify(selector)});
    node.scrollIntoView({block:'nearest'}); const rect = node.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    if (!node.contains(document.elementFromPoint(x, y))) throw Error('Occluded control');
    return {x, y};
  })()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
}
async function type(value) {
  await click('#nchatInput');
  await until(() => js("document.activeElement === document.querySelector('#nchatInput')"), 'composer focus');
  await win.webContents.insertText(value);
}
async function assertBadge(phase, expected = 1, text = prompt) {
  const state = await js(`(() => {
    const rows = [...document.querySelectorAll('#nchatList .nmsg.user')]
      .filter(node => node.querySelector('.nbubble')?.textContent === ${JSON.stringify(text)});
    return {rows: rows.length, badges: rows.map(node => node.querySelectorAll('.nmessage-plugin').length),
      labels: rows.flatMap(node => [...node.querySelectorAll('.nmessage-plugin-label')].map(label => label.textContent)),
      icons: rows.flatMap(node => [...node.querySelectorAll('.nmessage-plugin .wc-plugin-icon')].map(icon => Boolean(icon.querySelector('svg,img')))),
      keys: rows.map(node => node.dataset.chatNode)};
  })()`);
  report.phases.push({ phase, ...state });
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(out, phase + '.png'), (await win.webContents.capturePage()).toPNG());
  assert.equal(state.rows, 1, phase + ': one visible user message');
  assert.deepEqual(state.badges, [expected], phase + ': message badge must survive authoritative rendering');
  if (expected) {
    assert.deepEqual(state.labels, ['Pi 与 Qwen 漂亮页面工坊'], phase + ': trusted selected plugin name');
    assert.deepEqual(state.icons, [true], phase + ': shared plugin icon stays visible');
  }
  return state;
}
async function reopen() {
  off?.(); handle?.close();
  handle = await fixture.open({ resolvePlugins: async ids => personal.resolve(app, ids) });
  handle.attachedWindow = win;
  off = handle.on(event => publish(null, handle, event, handle.uiSnapshot()));
}
function installSend(pluginDebug) {
  const source = fs.readFileSync(path.join(client, 'main/pi-session/ipc.js'), 'utf8');
  sendContext = vm.createContext({ app, BrowserWindow, path, Promise, Date,
    _uiWindow: require('../main/pi-session/ui-window').create(), _cloudHandoff: { guard: () => false },
    require: require('node:module').createRequire(path.join(client, 'main/pi-session/ipc.js')),
    updateWorkloads: { guard: () => ({ ok: true }) }, session: { get: ref => ref === handle.ref ? handle : null },
    sendIdentityOf: async () => identity, identityOf: async () => identity, memories: { assertOwner() {} },
    pluginDebug, workDir: () => root, attachments: require('../main/pi-session/attachments'),
    _publish: publish, _scheduleRelease() {},
  });
  vm.runInContext(source.slice(source.indexOf('function _contextSnapshot('), source.indexOf('function _send(')) + '\n' +
    source.slice(source.indexOf('  async function sendConversation('), source.indexOf("  ipcMain.handle('pi-session-send',")), sendContext);
  ipcMain.handle('pi-session-send', async (_event, ref, text, files, options) => {
    requests.push({ ref, text, options });
    if (requests.length === 1) await submitGate.promise;
    return sendContext.sendConversation(ref, text, files, options,
      completion => completion.then(result => pendingResults.push(result)));
  });
}
const now = Math.floor(Date.now() / 1000);
const identity = { hub: 'https://example.invalid', clientId: 'fixture-device',
  session: Buffer.from(JSON.stringify({ typ: 'device', uid: 'fixture-user', cid: 'fixture-device',
    iat: now, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };

function buildPage() {
  const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-annotations.html'), 'utf8');
  const required = new Set([...fixtureHtml.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)]
    .map(match => path.relative(client, path.resolve(__dirname, 'fixtures', match[1])).replace(/\\/g, '/')));
  for (const file of ['core/plugin-icon.js', 'components/panels/agent-brand.js',
    'components/panels/compose-candidate-navigation.js', 'components/panels/chat-plugin-mention-model.js',
    'components/panels/chat-plugin-mention.js', 'components/panels/chat-message-plugins.js']) required.add(file);
  const scripts = [...desk.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)].map(match => match[1]).filter(file => required.has(file));
  assert.equal(scripts.length, required.size, 'all renderer dependencies must occur in the production desktop');
  const styles = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["']/g)].map(match => match[1]);
  const url = file => pathToFileURL(path.join(client, file)).href;
  page = path.join(root, 'native-chat.html');
  fs.writeFileSync(page, '<!doctype html><html lang="zh-CN" data-theme="azure"><head><meta charset="utf-8">' +
    '<base href="' + pathToFileURL(client + path.sep).href + '">' +
    styles.map(file => '<link rel="stylesheet" href="' + url(file) + '">').join('') +
    '<style>body{margin:0;height:100vh}#cpChat{height:100vh}.nchat{height:100%}</style></head><body><div id="cpChat"></div>' +
    '<script>window.errors=[];addEventListener("error",e=>errors.push(e.message));addEventListener("unhandledrejection",e=>errors.push(String(e.reason)));' +
    'window.petSay=()=>{};window.SoduWorkAPI={online:true,myModels:async()=>({usable:[]}),listTeammates:async()=>[],' +
    'pluginCatalog:async()=>({items:[' + JSON.stringify(plugin) + ']})};</script>' +
    scripts.map(file => '<script src="' + url(file) + '"></script>').join('') + '</body></html>');
  report.scripts = scripts;
}
async function openView() {
  await win.loadFile(page);
  ready = true;
  await js(`NativeChat.enter('', ${JSON.stringify(handle.sessionId)}, {adapterId:'pi'});`);
  await until(() => js("document.querySelector('#nchatList')?.textContent.includes('Previous report is preserved.')"), 'history loaded');
  await until(() => js('NativeChat.hasSession()'), 'session ready');
}

app.whenReady().then(async () => {
  fixture = await require('./fixtures/resumed-pi.cjs').create(root);
  fixture.reply(() => ({ text: '普通追问的本地回复。' }));
  plugin = personal.create(app, { template: 'workflow', key: 'badge-workflow',
    name: 'Pi 与 Qwen 漂亮页面工坊', description: '消息标记隔离回归', version: '1.0.0',
    instructions: '按当前问题生成简短答复。', workflow: { nodes: [
      { key: 'work', name: 'Pi 回复', type: 'ai', agent: 'pi', outputs: [{ key: 'result', kind: 'evidence' }], config: { prompt: '回答当前问题' } },
      { key: 'done', name: '完成', type: 'publish', dependsOn: ['work'], outputs: [] },
    ] } }).plugin;
  win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: {
    preload: path.join(client, 'preload.js'), contextIsolation: true, sandbox: true,
    nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    report.network.push(request.url); callback({ cancel: true });
  });
  await reopen();
  const pluginDebug = require('../main/personal-plugin-debug-ipc').install({ app, ipcMain,
    session: { get: ref => ref === handle.ref ? handle : null }, identityOf: async () => identity,
    skillDirs: () => [], deviceGrants: () => [], managedInputsRoot: () => path.join(root, 'inputs'),
    createExecutor: ({ handle: parent }) => ({ preflight: async () => ({ ok: true }), stopNode: async () => {},
      async executeNode() {
        workflowRuns++; nodeStarted = true;
        workflowOutput = require('../main/conversation/task-live-output').create(parent, '',
          { coalesceText: true, sourceAgent: { agentId: 'pi', agentName: 'Pi' } });
        await streamGate.promise;
        await workflowOutput.consume('fixture-pi-node', [{ seq: 1, kind: 'say', streamId: 'reply', delta: true,
          text: '正在准备贪吃蛇页面。', done: false }]);
        await finishGate.promise;
        await workflowOutput.consume('fixture-pi-node', [{ seq: 2, kind: 'say', streamId: 'reply', delta: true,
          text: '隔离回归完成。', done: true }]);
        await workflowOutput.finish('fixture-pi-node');
        return [{ key: 'result', kind: 'evidence', text: 'Local fixture completed.' }];
      },
    }),
  });
  installSend(pluginDebug);
  ipcMain.handle('pi-session-open', () => ({ ok: true, ref: handle.ref, sessionId: handle.sessionId,
    adapterId: 'pi', cwd: fixture.cwd, model: { label: 'Local regression model' }, snapshot: handle.uiSnapshot() }));
  ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot: handle.uiSnapshot() }));
  for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] },
    'pi-session-outputs': { ok: true, items: [] }, 'pi-session-release': { ok: true },
    'pi-session-runtimes': { ok: true, runtimes: [{ id: 'pi', displayName: 'Pi', modelMode: 'managed' }] },
    'access-preferences-get': { ok: true, mode: 'standard', revision: 0 },
    'pi-session-runtime-models': { ok: true, items: [] }, 'work-preview-hide': { ok: true },
    'work-preview-destroy': { ok: true }, 'work-preview-reset-embedded': { ok: true } })) ipcMain.handle(channel, () => value);
  buildPage(); await openView();
  await type('/漂亮页面');
  await until(() => js("Boolean(document.querySelector('.nplugin-menu .nplugin-option:not(.is-action):not([disabled])'))"), 'plugin picker');
  await click('.nplugin-menu .nplugin-option:not(.is-action):not([disabled])');
  await until(() => js("document.querySelectorAll('.nplugin-chip').length === 1"), 'selected plugin');
  await type(prompt); await click('#nchatSend');
  await until(() => requests.length === 1, 'send IPC');
  const optimistic = await assertBadge('01-optimistic');
  assert.deepEqual(optimistic.keys, ['message:pending']);
  submitGate.resolve();
  await until(() => nodeStarted && handle.snapshot().messages.some(message => message.role === 'user' && message.text === prompt), 'authoritative workflow echo');
  await until(() => js(`!document.querySelector('[data-chat-node="message:pending"]') &&
    [...document.querySelectorAll('#nchatList .nmsg.user .nbubble')].some(node => node.textContent === ${JSON.stringify(prompt)})`), 'optimistic echo replaced');
  await assertBadge('02-authoritative');
  report.checks.push('Selected workflow name and icon survive the optimistic-to-authoritative message replacement.');
  streamGate.resolve();
  await until(() => js("document.querySelector('#nchatList')?.textContent.includes('正在准备贪吃蛇页面。')"), 'real streaming projection');
  assert.equal(handle.snapshot().status, 'streaming');
  await assertBadge('03-streaming');
  finishGate.resolve();
  await until(() => pendingResults.length === 1 && !handle.inFlight(), 'workflow completed');
  assert.equal(pendingResults[0].ok, true);
  await until(() => js("document.querySelector('#nchatList')?.textContent.includes('协作已完成')"), 'settled workflow');
  await assertBadge('04-settled');
  report.checks.push('The same message keeps its badge during node streaming and after workflow completion.');
  ready = false; await reopen(); await openView();
  await assertBadge('05-reopened');
  report.checks.push('A fresh renderer and reopened real Pi archive restore the selected workflow badge.');
  const followup = '普通追问；正文提到请使用「Pi 与 Qwen 漂亮页面工坊」不等于选择插件';
  // Explicit clearing preserves the existing runtime inheritance contract;
  // message decorations must not infer selection from matching prompt text.
  const result = await sendContext.sendConversation(handle.ref, followup, [], {
    plugins: [], clearPluginSelection: true, sentAt: Date.now(), submissionId: 'badge-clear-followup-0001',
  }, completion => completion.then(value => pendingResults.push(value)));
  assert.equal(result.ok, true, result.reason);
  await until(() => pendingResults.length === 2 && !handle.inFlight(), 'normal followup completed');
  assert.equal(pendingResults[1].ok, true, pendingResults[1].reason);
  await until(() => js(`document.querySelector('#nchatList')?.textContent.includes(${JSON.stringify(followup)})`), 'normal message rendered');
  await assertBadge('06-followup-unselected', 0, followup);
  await assertBadge('07-original-retained');
  assert.equal(workflowRuns, 1, 'ordinary followup must not execute another workflow');
  report.checks.push('Explicitly cleared followup has no badge even when its text names the plugin; original badge stays on its own message.');
  assert.deepEqual(await js('window.errors'), []);
  assert.deepEqual(errors, []); assert.deepEqual(report.network, []);
  report.ok = true;
}).catch(async error => {
  report.error = error.stack || String(error);
  report.snapshot = handle?.snapshot();
  if (win && !win.isDestroyed()) report.ui = await js('({text:document.body.innerText,errors:window.errors})').catch(() => null);
}).finally(async () => {
  ready = false; submitGate.resolve(); streamGate.resolve(); finishGate.resolve();
  off?.(); await fixture?.close(); win?.destroy();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks, phases: report.phases,
    error: report.error, report: path.join(out, 'report.json') }));
  app.exit(report.ok ? 0 : 1);
});
