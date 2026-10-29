'use strict';

// Real Electron, preload and NativeChat with production desktop script order.
// The debug IPC endpoint supplies controlled snapshots and delayed replies;
// no workflow execution, real model, account or business process is involved.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron,
    [__filename, ...process.argv.slice(2), '--disable-gpu'],
    { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-debug-card-'));
const out = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ||
  path.join(client, '../outputs/plugin-debug-card-ownership'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const stream = require('../main/pi-session/event-stream');
const report = { ok: false, cases: [], network: [],
  boundary: 'Real NativeChat renderer, production event accumulator, PluginUIHost/PluginDebugCard and preload. Controlled debug IPC replies only; no model/workflow execution or live profile.' };
let win, page, acc, current, recoverable = false, visibleMessages = 80, viewStatus = 'idle';
let chatRef = 'fixture-chat';
let delayNextGet = false, pendingGet = null, rejectPendingGet = null;
const js = code => win.webContents.executeJavaScript(code, true);
const clone = value => JSON.parse(JSON.stringify(value));
async function until(check, label) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Timed out: ' + label);
}
function snapshot() {
  return require('../main/pi-session/snapshot-window').limitSnapshot({ ...acc.snapshot(), status: viewStatus, adapterId: 'pi',
    execution: { running: viewStatus === 'streaming', turnQueue: { active: null, items: [], paused: false } } },
  { messageLimit: visibleMessages });
}
function addUser(text, key, at) {
  acc.push({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }],
    timestamp: at, sentAt: at, ...(key ? { taskOutputKey: key } : {}) } });
}
function addAssistant(text, key, at) {
  Object.assign(acc.appendAssistant(text, stream.SCOPES.NORMAL, at),
    { taskOutputKey: key, sourceAgent: { agentId: 'pi' } });
}
function publish() { win.webContents.send('pi-session-event', { ref: chatRef, kind: 'task-message', snapshot: snapshot() }); }
async function image(name) {
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function runCase(name, action) {
  try {
    await action(); assert.deepEqual(await js('window.errors'), []);
    report.cases.push({ name, ok: true });
  }
  catch (error) {
    report.cases.push({ name, ok: false, error: error.stack || String(error),
      ui: await js('document.body.innerText').catch(() => ''), backend: clone(current) });
  } finally {
    delayNextGet = false; pendingGet?.(); pendingGet = null; rejectPendingGet = null;
    await js('PluginDebugCard.close();void 0;');
  }
}
function buildPage() {
  const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  const original = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-annotations.html'), 'utf8');
  const required = new Set([...original.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)]
    .map(match => path.relative(client, path.resolve(__dirname, 'fixtures', match[1])).replace(/\\/g, '/')));
  for (const file of ['core/plugin-icon.js', 'components/panels/agent-brand.js',
    'components/panels/compose-candidate-navigation.js', 'components/panels/chat-plugin-mention-model.js',
    'components/panels/chat-plugin-mention.js', 'components/panels/chat-message-plugins.js',
    'components/panels/plugin-ui-host.js', 'components/panels/plugin-debug-card.js']) required.add(file);
  const scripts = [...desk.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)]
    .map(match => match[1]).filter(file => required.has(file));
  assert.equal(scripts.length, required.size);
  const styles = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["']/g)].map(match => match[1]);
  const url = file => pathToFileURL(path.join(client, file)).href;
  page = path.join(temp, 'chat.html');
  fs.writeFileSync(page, '<!doctype html><html data-theme="azure"><head><meta charset="utf-8">' +
    '<base href="' + pathToFileURL(client + path.sep).href + '">' +
    styles.map(file => '<link rel="stylesheet" href="' + url(file) + '">').join('') +
    '<style>body{margin:0;height:100vh}#cpChat{height:100vh}.nchat{height:100%}</style></head><body><div id="cpChat"></div>' +
    '<script>window.errors=[];addEventListener("error",event=>errors.push(event.message));' +
    'addEventListener("unhandledrejection",event=>errors.push(String(event.reason)));window.petSay=()=>{};' +
    'window.SoduWorkAPI={online:true,myModels:async()=>({usable:[]}),listTeammates:async()=>[],pluginCatalog:async()=>({items:[]})};</script>' +
    scripts.map(file => '<script src="' + url(file) + '"></script>').join('') + '</body></html>');
}
async function setup(options = {}) {
  chatRef = 'fixture-chat';
  acc = stream.create(); visibleMessages = 80; viewStatus = 'idle'; recoverable = options.recoverable === true;
  const now = Date.now() - 30000;
  addUser('制作网页：第一轮协作', 'workflow-one:start', now);
  addAssistant('协作暂停：节点未正常完成（failed）。', 'plugin-debug:workflow-one:work:1:failed', now + 1000);
  current = { id: 'workflow-one', conversationId: 'fixture-session', pluginId: 'local:fixture',
    name: 'Pi 与 Qwen 漂亮页面工坊', version: '1.0.0', checksum: 'fixture', mode: 'conversation',
    revision: 4, createdAt: now, updatedAt: now + 1000, status: 'failed', reason: '节点未正常完成（failed）', issues: [],
    nodes: [{ key: 'work', name: '页面设计', type: 'ai', status: 'failed', attempt: 1, maxAttempts: 1,
      canReconnect: true, pendingPermissions: [], agent: 'pi', model: 'fixture-model',
      reason: '节点未正常完成（failed）', outputs: [{ key: 'design', label: '设计说明', path: 'design.md' }] }] };
  if (options.status) { current.status = options.status; current.nodes[0].status = options.status; }
  await win.loadFile(page);
  await js("NativeChat.enter('', 'fixture-session', {adapterId:'pi'}).then(()=>true)");
  await until(() => js("Boolean(document.querySelector('.pdebug:not([hidden])')) && document.querySelector('#nchatList')?.textContent.includes('第一轮协作')"), 'failed workflow card');
  // enter() schedules the initial composer focus after opening the transcript.
  // Start interaction assertions only once that normal navigation has settled.
  await until(() => js("document.activeElement?.id === 'nchatInput'"), 'initial composer focus');
}
async function clickElement(expression) {
  const point = await js(`(() => {
    const node = ${expression};
    if (!node || node.disabled) throw Error('Missing action');
    node.scrollIntoView({block:'nearest'});const rect=node.getBoundingClientRect();
    const x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
    if (!node.contains(document.elementFromPoint(x,y))) throw Error('Action occluded');return{x,y};})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
}
const clickAction = label => clickElement(`[...document.querySelectorAll('.pdebug button')].find(button => button.textContent === ${JSON.stringify(label)})`);
async function stalePollCase(command, label, nextStatus) {
  await setup(); delayNextGet = true;
  await until(() => Boolean(pendingGet), 'captured old failed get');
  await clickAction(label);
  await until(() => current.status === nextStatus && js("!document.querySelector('.pdebug') || document.querySelector('.pdebug').hidden"), 'new action receipt hides failed controls');
  pendingGet(); pendingGet = null;
  await js('new Promise(resolve=>setTimeout(resolve,50))');
  await image('stale-' + command);
  assert.equal(current.status, nextStatus);
  assert.equal(await js("!document.querySelector('.pdebug') || document.querySelector('.pdebug').hidden"), true,
    'a delayed failed get must not overwrite the newer ' + command + ' receipt');
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: {
    preload: path.join(client, 'preload.js'), contextIsolation: true, sandbox: true,
    nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    report.network.push(request.url); callback({ cancel: true });
  });
  ipcMain.handle('personal-plugin-debug', async (_event, ref, options) => {
    assert.ok(['fixture-chat', 'other-chat'].includes(ref));
    if (options.command === 'get') {
      const result = { ok: true, run: clone(current), recoverable };
      if (delayNextGet) {
        delayNextGet = false;
        return new Promise((resolve, reject) => {
          pendingGet = () => resolve(result);
          rejectPendingGet = () => reject(Error('旧协作状态请求失败'));
        });
      }
      return result;
    }
    assert.equal(options.runId, current.id); assert.equal(options.revision, current.revision);
    assert.ok(['cancel', 'reconnect'].includes(options.command));
    const nextStatus = options.command === 'cancel' ? 'cancelled' : 'running';
    current = { ...current, revision: current.revision + 1,
      status: nextStatus, reason: '',
      nodes: current.nodes.map(node => ({ ...node, status: nextStatus })) };
    return { ok: true, run: clone(current), recoverable };
  });
  ipcMain.handle('pi-session-open', () => ({ ok: true, ref: chatRef, sessionId: current.conversationId,
    adapterId: 'pi', cwd: temp, model: { label: 'Fixture model' }, snapshot: snapshot() }));
  ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot: snapshot() }));
  for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] },
    'pi-session-outputs': { ok: true, items: [] }, 'pi-session-release': { ok: true },
    'pi-session-runtimes': { ok: true, runtimes: [{ id: 'pi', displayName: 'Pi', modelMode: 'managed' }] },
    'access-preferences-get': { ok: true, mode: 'standard', revision: 0 },
    'pi-session-runtime-models': { ok: true, items: [] }, 'work-preview-hide': { ok: true },
    'work-preview-destroy': { ok: true }, 'work-preview-reset-embedded': { ok: true } })) ipcMain.handle(channel, () => value);
  buildPage();
  await runCase('failed workflow controls stay with their original messages after a later turn', async () => {
    await setup();
    const later = Date.now();
    addUser('第二轮：继续处理新的要求', '', later);
    addAssistant('第二轮正在执行，与上一轮失败无关。', '', later + 1);
    publish();
    await until(() => js("document.querySelector('#nchatList')?.textContent.includes('第二轮正在执行')"), 'later rendered turn');
    await image('later-turn');
    const position = await js(`(() => {
      const card=document.querySelector('.pdebug'), later=[...document.querySelectorAll('#nchatList .nmsg.user')].find(node=>node.textContent.includes('第二轮：'));
      return {visible:!card.hidden,beforeLater:!!(card.compareDocumentPosition(later)&Node.DOCUMENT_POSITION_FOLLOWING),
        host:card.parentElement.className};})()`);
    assert.equal(position.visible, true, 'unfinished workflow still has recovery controls');
    assert.equal(position.beforeLater, true, 'old workflow controls must not appear after a later unrelated turn: ' + JSON.stringify(position));
    assert.equal(current.status, 'failed'); assert.equal(current.revision, 4,
      'rendering a later message must not issue a workflow action');
    assert.deepEqual(await js('window.errors'), []);
  });
  await runCase('delayed failed poll cannot undo cancellation', () => stalePollCase('cancel', '停止协作', 'cancelled'));
  await runCase('delayed failed poll cannot undo reconnection', () => stalePollCase('reconnect', '核对执行状态', 'running'));
  await runCase('same message retains the control surface and focused action through rendering', async () => {
    await setup();
    await js(`window.heldSurface=document.querySelector('.pdebug');
      window.heldAction=[...heldSurface.querySelectorAll('button')].find(button=>button.textContent==='核对执行状态');
      heldAction.focus();void 0;`);
    assert.equal(await js('document.activeElement===heldAction'), true, 'recovery action accepts keyboard focus');
    addUser('下一轮仍保留前一轮的处理入口', '', Date.now()); publish();
    await until(() => js("document.querySelector('#nchatList')?.textContent.includes('下一轮仍保留')"), 'structural render');
    assert.deepEqual(await js(`({surface:document.querySelector('.pdebug')===heldSurface,
      connected:heldAction.isConnected,focused:document.activeElement===heldAction})`),
    { surface: true, connected: true, focused: true });
  });
  await runCase('history window reuse exposes earlier workflow controls without attaching them to a later message', async () => {
    await setup();
    await js('window.heldSurface=document.querySelector(".pdebug");void 0;');
    addUser('窗口中的新用户消息', '', Date.now());
    addAssistant('窗口中的新回复', '', Date.now() + 1);
    visibleMessages = 2; publish();
    await until(() => js("document.querySelector('#nchatList')?.textContent.includes('窗口中的新回复') && !document.querySelector('#nchatList')?.textContent.includes('制作网页：第一轮')"), 'sliding message window');
    const missing = await js(`(() => {
      const surface=document.querySelector('.pdebug'), fallback=surface?.closest('details'), first=document.querySelector('#nchatList .nmsg');
      return {same:surface===heldSurface,inLaterMessage:!!surface?.closest('.nmsg'),fallback:!!fallback,
        compact:fallback?.open===false,
        explicit:!!fallback?.querySelector('summary')?.textContent.includes('较早协作'),
        named:!!fallback?.querySelector('summary')?.textContent.includes('Pi 与 Qwen 漂亮页面工坊'),
        beforeLater:!!fallback&&!!(fallback.compareDocumentPosition(first)&Node.DOCUMENT_POSITION_FOLLOWING)};
    })()`);
    assert.deepEqual(missing, { same: true, inLaterMessage: false, fallback: true, compact: true, explicit: true, named: true, beforeLater: true });
    await image('history-outside-window');
    await clickElement("document.querySelector('.pdebug-history > summary')");
    await until(() => js("document.querySelector('.pdebug-history')?.open === true"), 'earlier workflow recovery expanded');
    assert.equal(await js(`(() => {
      const action=[...document.querySelectorAll('.pdebug button')].find(button=>button.textContent==='核对执行状态');
      const rect=action?.getBoundingClientRect();return !!rect&&rect.width>0&&rect.height>0&&!action.disabled;
    })()`), true, 'compact history entry exposes enabled recovery controls');
    await image('history-expanded');
    visibleMessages = 80; publish();
    await until(() => js("document.querySelector('.pdebug')?.closest('[data-workflow-message-key]')?.dataset.workflowMessageKey === 'plugin-debug:workflow-one:work:1:failed'"), 'exact workflow receipt restored');
    assert.equal(await js('document.querySelector(".pdebug")===heldSurface'), true);
    await clickAction('核对执行状态');
    await until(() => current.status === 'running', 'relocated control remains functional');
  });
  await runCase('same ref refresh adopts a new run and rejects the older run poll', async () => {
    await setup(); delayNextGet = true;
    await until(() => Boolean(pendingGet), 'old run poll pending');
    current = { ...current, id: 'workflow-two', revision: 1, createdAt: Date.now(), updatedAt: Date.now(),
      status: 'running', reason: '', nodes: current.nodes.map(node => ({ ...node, status: 'running', reason: '', outputs: [] })) };
    addUser('开始第二次协作', 'workflow-two:start', Date.now()); publish();
    await js("PluginDebugCard.open({ref:'fixture-chat',mode:'conversation'}).then(()=>true)");
    await until(() => js("!document.querySelector('.pdebug') || document.querySelector('.pdebug').hidden"), 'new run refresh');
    pendingGet(); pendingGet = null;
    await js('new Promise(resolve=>setTimeout(resolve,50))');
    assert.equal(await js("!document.querySelector('.pdebug') || document.querySelector('.pdebug').hidden"), true,
      'old run failure must not replace the current run');
  });
  await runCase('late poll error cannot reopen cancelled controls', async () => {
    await setup(); delayNextGet = true;
    await until(() => Boolean(rejectPendingGet), 'old poll error pending');
    await clickAction('停止协作');
    await until(() => current.status === 'cancelled' && js("!document.querySelector('.pdebug') || document.querySelector('.pdebug').hidden"), 'cancelled');
    rejectPendingGet(); pendingGet = null; rejectPendingGet = null;
    await js('new Promise(resolve=>setTimeout(resolve,50))');
    assert.equal(await js("!document.querySelector('.pdebug') || document.querySelector('.pdebug').hidden"), true,
      'stale request failure must not reactivate the card');
  });
  await runCase('recoverability can change without incrementing the run revision', async () => {
    await setup({ status: 'running', recoverable: true });
    assert.match(await js("document.querySelector('.pdebug').innerText"), /恢复协作/);
    recoverable = false;
    await js("PluginDebugCard.open({ref:'fixture-chat'}).then(()=>true)");
    assert.equal(await js("!document.querySelector('.pdebug') || document.querySelector('.pdebug').hidden"), true,
      'fresh same-revision recovery information must be applied');
  });
  await runCase('closed surface rejects its pending error after the same conversation is reopened', async () => {
    await setup(); delayNextGet = true;
    await until(() => Boolean(rejectPendingGet), 'disposed poll pending');
    const releaseError = rejectPendingGet;
    current = { ...current, revision: 5, status: 'cancelled', reason: '',
      nodes: current.nodes.map(node => ({ ...node, status: 'cancelled' })) };
    await js("PluginDebugCard.close();PluginDebugCard.open({ref:'fixture-chat'}).then(()=>true)");
    releaseError(); pendingGet = null; rejectPendingGet = null;
    await js('new Promise(resolve=>setTimeout(resolve,50))');
    assert.equal(await js("!document.querySelector('.pdebug') || document.querySelector('.pdebug').hidden"), true);
    assert.deepEqual(await js('window.errors'), []);
  });
  await runCase('reopening the same failed workflow restores its controls without waiting for another transcript update', async () => {
    await setup();
    await js("PluginDebugCard.close();PluginDebugCard.open({ref:'fixture-chat'}).then(()=>true)");
    assert.equal(await js("Boolean(document.querySelector('.pdebug:not([hidden])'))"), true,
      'reopening the active workflow must retain a reachable recovery action');
    await clickAction('核对执行状态');
    await until(() => current.status === 'running', 'reopened recovery action');
  });
  await runCase('debug mode preserves its inline host and detached-host modal fallback', async () => {
    await setup(); current.mode = 'debug';
    await js("PluginDebugCard.close();PluginDebugCard.open({ref:'fixture-chat'}).then(()=>true)");
    assert.equal(await js("Boolean(document.querySelector('.nchat-draft .pdebug:not([hidden])'))"), true,
      'explicit local debug stays in its existing composer surface');
    await js("PluginDebugCard.close();PluginDebugCard.open({ref:'fixture-chat',host:document.createElement('div')}).then(()=>true)");
    assert.equal(await js("Boolean(document.querySelector('body > .pui-layer.pdebug:not([hidden]) .pui-dialog'))"), true,
      'a detached optional host must retain the connected modal fallback');
  });
  for (const outcome of ['success', 'error']) {
    await runCase('a different conversation rejects the old pending poll ' + outcome, async () => {
      await setup(); delayNextGet = true;
      await until(() => Boolean(pendingGet), 'old conversation poll pending');
      const release = outcome === 'success' ? pendingGet : rejectPendingGet;
      chatRef = 'other-chat'; acc = stream.create();
      current = { ...current, id: 'workflow-other', conversationId: 'other-session', name: '另一条会话的协作' };
      addUser('另一条会话的需求', 'workflow-other:start', Date.now());
      addAssistant('另一条会话待处理', 'plugin-debug:workflow-other:work:1:failed', Date.now() + 1);
      await js("NativeChat.enter('', 'other-session', {adapterId:'pi'}).then(()=>true)");
      await until(() => js("document.querySelector('.pdebug-title strong')?.textContent === '另一条会话的协作'"), 'new conversation controls');
      await js("window.currentSurface=document.querySelector('.pdebug');void 0;");
      release(); pendingGet = null; rejectPendingGet = null;
      await js('new Promise(resolve=>setTimeout(resolve,50))');
      assert.deepEqual(await js(`({same:document.querySelector('.pdebug')===currentSurface,
        title:document.querySelector('.pdebug-title strong')?.textContent,
        owner:document.querySelector('.pdebug')?.closest('[data-workflow-message-key]')?.dataset.workflowMessageKey,
        error:document.querySelector('.pdebug-error:not([hidden])')?.textContent||''})`),
      { same: true, title: '另一条会话的协作', owner: 'plugin-debug:workflow-other:work:1:failed', error: '' });
      await clickAction('核对执行状态');
      await until(() => current.status === 'running', 'new conversation recovery action');
    });
  }
  assert.deepEqual(report.network, []);
  report.ok = report.cases.every(item => item.ok);
}).catch(error => { report.error = error.stack || String(error); }).finally(() => {
  pendingGet?.(); win?.destroy();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases.map(({ name, ok, error }) =>
    ({ name, ok, ...(error ? { error: error.split('\n')[0] } : {}) })),
    error: report.error, report: path.join(out, 'report.json') }));
  app.exit(report.ok ? 0 : 1);
});
