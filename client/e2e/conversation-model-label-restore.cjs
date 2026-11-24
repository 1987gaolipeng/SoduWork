'use strict';

// Real first paint from a saved desktop archive, without model inference or a Hub connection.
const electron = require('electron');
const { isolateProfile, withTemporaryRoot } = require('./lib/isolated-profile.cjs');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = withTemporaryRoot('soduwork-completed-model-', temp => require('node:child_process').spawnSync(electron, [__filename], {
    env: { ...env, TEMP: temp, TMP: temp, TMPDIR: temp }, windowsHide: true, stdio: 'inherit', timeout: 45000 }));
  if (run.error) console.error(run.error.message);
  process.exit(run.status ?? 1);
}
const { app, BrowserWindow, ipcMain, safeStorage } = electron;
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..');
const { userData: profile } = isolateProfile(app, 'completed-model');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-mock-keychain');
let win, history, held;
const ready = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const js = code => win.webContents.executeJavaScript(code, true);
async function until(predicate, reason) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await js(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(reason + ' · ' + await js("JSON.stringify({label:document.querySelector('.nmodel-button span')?.textContent,session:NativeChat.sessionInfo(),reads:directoryReads,errors})"));
}
async function verifyLabel(name, reason) {
  const button = await js("(()=>{const b=document.querySelector('.nmodel-button');return [b.querySelector('span').textContent,b.title,b.getAttribute('aria-label')]})()");
  assert.equal(button[0], name, reason);
  assert.ok(button[1].includes(name) && !button[1].includes('local:model-'), 'Tooltip shows the presentation label');
  assert.equal(button[2], button[1], 'Accessible name uses the same model label');
}
async function waitLabel(name, reason) {
  await until("document.querySelector('.nmodel-button span')?.textContent === " + JSON.stringify(name), reason);
  await verifyLabel(name, reason);
}
const setDirectory = response => js('window.directoryReply=' + JSON.stringify(response) + ';void 0');
async function refreshDirectory(response) {
  const previous = await js('directoryReads');
  await setDirectory(response);
  win.webContents.send('models-changed');
  await until('directoryReads > ' + previous, 'The visible conversation reads a changed model directory');
  await js('new Promise(resolve => setTimeout(resolve, 0))');
}
const enter = id => js("NativeChat.enter(''," + JSON.stringify(id) + ")");
const hold = id => { held = { id, arrived: ready(), release: ready() }; return held; };

app.whenReady().then(async () => {
  const actor = require('../tests/helpers/platform-session-fixture.cjs').identity();
  const owner = require('../main/platform-connections/runtime.cjs').scope(actor);
  const models = require('../main/local-model-store.cjs');
  const osEncryption = safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  models.configure({ app, safeStorage: osEncryption ? safeStorage : require('../tests/helpers/device-safe-storage-fixture.cjs').createSafeStorage() });
  const reference = models.save({
    providers: [{ id: 'private', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1' }],
    models: [{ providerId: 'private', name: 'glm-api-fixture', label: 'GLM 本地' }],
    keys: { private: 'synthetic-only' },
  }).myModels[0].id;
  assert.match(reference, /^local:model-[a-f0-9]{32}$/);
  const directory = path.join(profile, 'pi-agent', 'sessions', 'fixture');
  fs.mkdirSync(directory, { recursive: true });
  const rows = [['chat-a', reference], ['chat-b', 'deepseek-chat'], ['chat-first-offline', 'unseen-hub-id']].map(([id, name]) => {
    const archive = path.join(directory, id + '.jsonl');
    fs.writeFileSync(archive, [
      { type: 'session', id },
      { type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Request ' + id } },
      { type: 'custom', id: 'model', parentId: 'request', customType: 'soduwork.model.selection', data: { name } },
      { type: 'message', id: 'done', parentId: 'model', message: { role: 'assistant', model: name, content: [{ type: 'text', text: 'Finished ' + id }] } },
    ].map(item => JSON.stringify(item)).join('\n'));
    return { id, path: archive, adapterId: 'pi', title: id, count: 2, at: 123456, cwd: profile, workOwner: owner,
      creator: { account: 'one', hub: actor.hub } };
  });
  const runnerId = 'runner-opencode';
  const events = [{ seq: 1, kind: 'user', text: 'An OpenCode request' }, { seq: 2, kind: 'say', text: 'An OpenCode reply' }];
  require('../main/runner-runtime').rpc = async (method, input) => {
    assert.equal(method, 'job.session'); assert.equal(input.ref, runnerId); assert.equal(input.historyRead, true);
    return { ok: true, data: { ref: runnerId, seq: events.length, items: events.filter(item => item.seq > input.since) } };
  };
  require('../main/conversation/model-selection').preference(app, runnerId).write(reference);
  rows.push({ ...rows[0], id: runnerId, title: runnerId, path: '', adapterId: 'opencode' });
  const session = { findBySessionId: () => null, historyEntry: require('../main/pi-session/session').historyEntry,
    archivedConversation: async (_app, id) => rows.find(row => row.id === id) };
  require('../main/conversation/requirement-context').cachedIdentity = () => actor;
  const store = require('../main/conversation/replica-store.cjs').create(path.join(profile, 'history.sqlite'));
  history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => actor });
  await history.register(rows);
  const replies = new Map(), releases = [], views = new Map(), writes = [], continuations = [];
  ipcMain.handle('pi-session-open', async (_event, options) => {
    if (options.historyIntent === 'continue') {
      continuations.push(options);
      return { ok: false, reason: 'Fixture observed the selected continuation model' };
    }
    assert.equal(options.historyIntent, 'view');
    const view = await history.open(options.chatId, { historyPreview: true, allowContinuation: true });
    const reply = require('../main/pi-session/open-reply').openReply(app, view);
    assert.equal(reply.snapshot.execution.canContinueOnDevice, true);
    views.set(view.ref, view); replies.set(options.chatId, reply);
    if (held?.id === options.chatId) { const gate = held; held = null; gate.arrived.resolve(); await gate.release.promise; }
    return reply;
  });
  ipcMain.handle('pi-session-release', async (_event, ref) => { releases.push(ref); await views.get(ref)?.close(); return { ok: true }; });
  ipcMain.handle('pi-session-snapshot', (_event, ref) => ({ ok: true, snapshot: views.get(ref)?.snapshot() }));
  for (const name of ['pi-session-select-model', 'pi-session-send']) ipcMain.handle(name, () => { writes.push(name); return { ok: false }; });
  for (const [name, result] of Object.entries({ 'pi-session-open-application': { ok: true, handled: false },
    'pi-session-history': { ok: true, chats: rows }, 'pi-session-outputs': { ok: true, items: [] },
    'pi-session-runtimes': { ok: true, runtimes: [{ id: 'pi' }, { id: 'opencode' }],
      availableRuntimes: [{ id: 'pi', modelMode: 'managed' }, { id: 'opencode', modelMode: 'managed' }] },
    'access-preferences-get': { ok: true, mode: 'standard' },
    'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true }, 'work-preview-reset-embedded': { ok: true } }))
    ipcMain.handle(name, () => result);

  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(client, 'preload.js'),
    contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  await win.loadFile(path.join(__dirname, 'fixtures/workbench-annotations.html'));
  await js(`(async () => {
    for (const name of ['core/model-choice', 'components/panels/compose-candidate-navigation',
      'components/panels/chat-plugin-mention-model', 'components/panels/chat-plugin-mention']) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = '../../' + name + '.js';
        script.onload = resolve; script.onerror = () => reject(Error('Failed to load ' + name));
        document.head.appendChild(script);
      });
    }
  })()`);
  await js(`SoduWorkAPI.taskStorageKey = () => 'fixture';
    window.directoryReads = 0; window.directoryPending = []; window.directoryReply = null;
    window.directoryOptions = [];
    SoduWorkAPI.myModels = async options => {
      directoryReads++;
      directoryOptions.push(options);
      if (directoryReply === null) return new Promise(resolve => directoryPending.push(resolve));
      return directoryReply;
    }; void 0;`);
  assert.equal(await enter('chat-a'), true);
  assert.equal(replies.get('chat-a').snapshot.modelSelection.name, reference);
  await verifyLabel('GLM 本地', 'The first completed archive must show its local label before opening the picker');
  const local = { name: reference, label: 'GLM 本地', localOnly: true };
  const hub = name => ({ name: 'deepseek-chat', label: name });
  const directoryFor = label => ({ usable: [local, hub(label)] });
  const hubLabel = 'DeepSeek 新名称';
  await setDirectory(directoryFor('DeepSeek 原名称'));
  await js('directoryPending.splice(0).forEach(resolve => resolve(directoryReply));void 0');
  assert.equal(await enter('chat-b'), true);
  await waitLabel('DeepSeek 原名称', 'A historical Hub model resolves its label without opening the picker');
  assert.equal(await js('directoryOptions.at(-1).refreshManaged'), true);
  await refreshDirectory(directoryFor(hubLabel));
  await waitLabel(hubLabel, 'A Hub model rename is visible without a click');
  assert.equal(await js("document.querySelector('.nmodel-pop').hidden"), true);
  assert.equal(await js('NativeChat.sessionInfo().model'), 'deepseek-chat');

  assert.equal(await enter('chat-a'), true);
  await setDirectory({ ok: false, reason: 'offline' });
  const beforeOfflineReturn = await js('directoryReads');
  const reopening = hold('chat-b'), offlineReturn = enter('chat-b');
  await reopening.arrived.promise;
  await verifyLabel(hubLabel, 'The cached first paint preserves the known Hub label when returning offline');
  reopening.release.resolve(); assert.equal(await offlineReturn, true);
  await until('directoryReads > ' + beforeOfflineReturn, 'The reopened preview checked the offline directory');
  await verifyLabel(hubLabel, 'The reopened archive and failed refresh retain its last confirmed display name');
  assert.equal(await js('NativeChat.sessionInfo().model'), 'deepseek-chat');
  assert.equal(await enter('chat-first-offline'), true);
  await verifyLabel('unseen-hub-id', 'The first offline open displays its own saved ID when no label was ever known');
  assert.deepEqual(continuations, []); assert.deepEqual(writes, []);
  await setDirectory(directoryFor(hubLabel));

  const delayed = hold('chat-a');
  const older = enter('chat-a'); await delayed.arrived.promise;
  const oldRef = replies.get('chat-a').ref;
  await verifyLabel('GLM 本地', 'The cached archive paints the original label while its next IPC result is pending');
  assert.equal(await enter('chat-b'), true); await waitLabel(hubLabel, 'The active archive resolves its own label');
  delayed.release.resolve(); await older;
  assert.ok(releases.includes(oldRef), 'Dispose the obsolete preview after switching');
  await verifyLabel(hubLabel, 'An older preview cannot replace the current model');
  assert.equal(await enter('chat-a'), true); await verifyLabel('GLM 本地');
  assert.equal(await enter(runnerId), true);
  assert.equal(replies.get(runnerId).snapshot.adapterId, 'opencode');
  assert.equal(replies.get(runnerId).snapshot.modelSelection.name, reference);
  await verifyLabel('GLM 本地');
  await setDirectory(null);
  await js("document.querySelector('.nmodel-button').click()");
  await until('directoryPending.length > 0', 'The open picker requests the local and managed choices');
  await setDirectory(directoryFor(hubLabel));
  assert.equal(await enter('chat-b'), true);
  await waitLabel(hubLabel, 'A newer archive can load while the previous directory is still pending');
  await js("directoryPending.splice(0).forEach(resolve => resolve({usable:[{name:'deepseek-chat',label:'Old OpenCode directory'}]}));void 0");
  await verifyLabel(hubLabel, 'A late model directory cannot rename the newly selected conversation model');
  await refreshDirectory({ ok: false, reason: 'offline' });
  await verifyLabel(hubLabel, 'An unreadable catalog preserves the known label');
  await refreshDirectory({ usable: [local], managedCatalogUnavailable: true });
  await verifyLabel(hubLabel, 'A local-only partial catalog cannot declare the Hub selection deleted');
  assert.equal(await js("document.querySelector('.nmodel-pop').hidden"), true);
  const replacement = { name: 'hub-replacement', label: '替代模型' };
  await refreshDirectory({ usable: [replacement] });
  await until("/不可用/.test(document.querySelector('.nmodel-button span').textContent)", 'A removed historical model is visibly unavailable');
  assert.ok((await js("document.querySelector('.nmodel-button span').textContent")).includes(hubLabel));
  assert.equal(await js('NativeChat.sessionInfo().model'), 'deepseek-chat');
  assert.ok(await js("document.querySelector('#nchatList').textContent.includes('Finished chat-b')"));
  await js("const input=document.querySelector('#nchatInput');input.value='Keep this draft';input.dispatchEvent(new Event('input',{bubbles:true}));void 0");
  assert.equal(await js('NativeChat.send()'), false);
  assert.equal(await js("document.querySelector('#nchatInput').value"), 'Keep this draft');
  assert.equal(await js('NativeChat.sessionInfo().model'), 'deepseek-chat');
  assert.deepEqual(continuations, []);
  assert.deepEqual(writes, []);
  await js("document.querySelector('.nmodel-button').click()");
  await until("!!document.querySelector('[data-model-name=\"hub-replacement\"]')", 'The user can select an available replacement');
  await js("document.querySelector('[data-model-name=\"hub-replacement\"]').click()");
  await waitLabel(replacement.label, 'Only the explicit selection changes the continuation model');
  assert.equal(await js('NativeChat.sessionInfo().model'), replacement.name);
  await js('NativeChat.send()');
  assert.deepEqual(continuations.map(options => [options.chatId, options.adapterId, options.modelName]),
    [['chat-b', 'pi', replacement.name]]);
  const savedAgain = await history.open('chat-b', { historyPreview: true, allowContinuation: true });
  assert.equal(savedAgain.snapshot().modelSelection.name, 'deepseek-chat');
  await savedAgain.close();
  models.save({ models: [] });
  assert.equal(await enter(runnerId), true);
  assert.equal(replies.get(runnerId).snapshot.modelSelection.model.unavailable, true);
  await until("/不可用/.test(document.querySelector('.nmodel-button span').textContent)", 'The removed native model has a readable status');
  assert.equal(await js('NativeChat.sessionInfo().model'), reference);
  assert.doesNotMatch(await js("document.querySelector('.nmodel-button').title"), /local:model-/);
  assert.ok(await js("document.querySelector('#nchatList').textContent.includes('An OpenCode reply')"));
  await js("NativeChat.reset();NativeChat.prepare({adapterId:'pi'});void 0");
  await waitLabel(replacement.label, 'A fresh empty draft still selects its available default');
  assert.deepEqual(await js("(()=>{const state=NativeChat.sessionInfo();return [state.sessionId,state.ref,state.model]})()"),
    ['', '', replacement.name]);
  assert.deepEqual(writes, []);
  assert.deepEqual(await js('window.errors'), []);
  console.log('PASS old Pi and OpenCode labels, automatic Hub rename, offline and stale catalogs, removed choice with preserved history/draft, explicit continuation and new-chat default.');
}).catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await history?.close(); win?.destroy(); app.exit(process.exitCode || 0); });
