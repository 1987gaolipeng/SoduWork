'use strict';

const electron = require('electron');
const { isolateProfile, withTemporaryRoot } = require('./lib/isolated-profile.cjs');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = withTemporaryRoot('soduwork-history-pages-', temp => require('node:child_process').spawnSync(electron, [__filename], {
    env: { ...env, TEMP: temp, TMP: temp, TMPDIR: temp }, stdio: 'inherit', windowsHide: true, timeout: 180000 }));
  if (run.error) console.error(run.error.message);
  process.exit(run.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = electron;
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto'), { pathToFileURL } = require('node:url');
const { userData: profile } = isolateProfile(app, 'history-pages');
const client = path.resolve(__dirname, '..');
app.disableHardwareAcceleration();
let win, history;
const js = expression => win.webContents.executeJavaScript(expression, true);
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const marker = (id, index) => id + ' message ' + index + '.';
const list = '#nchatList', older = '[data-load-older]', dialog = 'dialog.nchat-history-page[open]';
const node = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
const contains = (selector, text) => node(selector) + '?.textContent.includes(' + JSON.stringify(text) + ')';
async function until(condition, description) {
  for (const deadline = Date.now() + 12000; Date.now() < deadline; ) {
    if (await js(condition)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const status = await js("JSON.stringify({older:document.querySelector('[data-load-older]')?.textContent,page:document.querySelector('dialog [role=status]')?.textContent,notices,errors})");
  throw Error(description + ' · ' + status);
}
async function click(selector) {
  await until(node(selector) + ' && !' + node(selector) + '.disabled', 'Enabled ' + selector);
  await js('(async()=>{ const button=' + node(selector) + ';button.scrollIntoView({block:"center"});' +
    'await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));button.click(); })()');
}
const enter = id => js("NativeChat.enter(''," + JSON.stringify(id) + ")");

app.whenReady().then(async () => {
  const actor = require('../tests/helpers/platform-session-fixture.cjs').identity();
  const owner = require('../main/platform-connections/runtime.cjs').scope(actor);
  const directory = path.join(profile, 'pi-agent', 'sessions', 'fixture');
  fs.mkdirSync(directory, { recursive: true });
  const rows = [['history-medium', 302], ['history-long', 2184]].map(([id, count]) => {
    const entries = [{ type: 'session', id }];
    for (let index = 0; index < count; index++) {
      // The initial window starts inside the last turn of the medium archive.
      // Its user's saved timestamp is needed to display the final reply duration.
      const longTurn = id === 'history-medium' && index >= 200;
      const question = longTurn ? index === 200 : index % 2 === 0;
      const turn = longTurn ? 100 : Math.floor(index / 2);
      const elapsedMs = longTurn ? Math.round(23000 * (index - 200) / (count - 201)) : question ? 0 : 23000;
      const timestamp = Date.UTC(2026, 0, 1) + turn * 60000 + elapsedMs;
      let content = [{ type: 'text', text: marker(id, index) }];
      if (id === 'history-long' && index === 135) content = [{ type: 'thinking', thinking: 'Saved early reasoning' }];
      if (id === 'history-long' && index === 137)
        content.push({ type: 'toolCall', id: 'cancelled-edit', name: 'edit', arguments: { path: 'fixture.txt' } });
      entries.push({ type: 'message', id: 'm' + index, parentId: index ? entries.at(-1).id : null,
        timestamp: new Date(timestamp).toISOString(), message: { role: question ? 'user' : 'assistant', timestamp,
          content, ...(question ? {} : { completedAt: timestamp, stopReason: 'stop' }) } });
      if (id === 'history-long' && index === 137) entries.push({ type: 'message', id: 'edit-result', parentId: 'm137',
        message: { role: 'toolResult', toolName: 'edit', toolCallId: 'cancelled-edit', timestamp, content: [], isError: false,
          details: { soduWorkAccessChange: { state: 'cancelled', cancelReason: 'access-change' } } } });
    }
    const archive = path.join(directory, id + '.jsonl');
    fs.writeFileSync(archive, entries.map(item => JSON.stringify(item)).join('\n') + '\n');
    return { id, path: archive, adapterId: 'pi', title: id, count, cwd: profile, workOwner: owner,
      creator: { account: 'one', hub: actor.hub } };
  });
  const initialDigests = rows.map(row => digest(row.path));
  const session = { findBySessionId: () => null, historyEntry: require('../main/pi-session/session').historyEntry,
    archivedConversation: async (_app, id) => rows.find(row => row.id === id) };
  require('../main/conversation/requirement-context').cachedIdentity = () => actor;
  const store = require('../main/conversation/replica-store.cjs').create(path.join(profile, 'history.sqlite'));
  history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => actor });
  await history.register(rows);
  const views = new Map(), reads = [];
  let intercept;
  function holdNextRead() {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    intercept = async payload => {
      started.resolve(payload);
      return { ok: true, snapshot: await release.promise || payload.snapshot };
    };
    return { started: started.promise, release: release.resolve };
  }
  ipcMain.handle('pi-session-open', async (_event, options) => {
    assert.equal(options.historyIntent, 'view');
    const view = await history.open(options.chatId, { historyPreview: true, allowContinuation: true });
    views.set(view.ref, view);
    return require('../main/pi-session/open-reply').openReply(app, view);
  });
  ipcMain.handle('pi-session-release', async (_event, ref) => { await views.get(ref)?.close(); views.delete(ref); return { ok: true }; });
  ipcMain.handle('pi-session-snapshot', async (_event, ref, options = {}) => {
    const view = views.get(ref), snapshot = await view.loadHistory(options) || view.snapshot();
    if (options.messageLimit) reads.push({ options, start: snapshot.history.messageStart, end: snapshot.history.messageEnd });
    if (options.messageLimit && intercept) {
      const reply = intercept; intercept = null; return reply({ ref, snapshot });
    }
    return { ok: true, snapshot };
  });
  for (const [channel, reply] of Object.entries({ 'pi-session-open-application': { ok: true, handled: false },
    'pi-session-history': { ok: true, chats: rows }, 'pi-session-outputs': { ok: true, items: [] },
    'pi-session-runtimes': { ok: true, runtimes: [{ id: 'pi' }], availableRuntimes: [{ id: 'pi' }] },
    'access-preferences-get': { ok: true, mode: 'standard' }, 'work-preview-hide': { ok: true },
    'work-preview-destroy': { ok: true }, 'work-preview-reset-embedded': { ok: true } })) ipcMain.handle(channel, () => reply);

  const fixture = path.join(__dirname, 'fixtures/workbench-annotations.html');
  const html = fs.readFileSync(fixture, 'utf8').replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' +
    pathToFileURL(path.dirname(fixture) + path.sep).href + '">').replace('<script src="../../components/panels/chat-message-renderer.js">', tag =>
    ['compose-candidate-navigation', 'chat-plugin-mention-model', 'chat-plugin-mention', 'chat-turn-summary', 'chat-reading-position']
      .map(name => '<script src="../../components/panels/' + name + '.js"></script>').join('') + tag);
  const file = path.join(profile, 'long-history.html');
  fs.writeFileSync(file, html);
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(client, 'preload.js'),
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  await win.loadFile(file);
  await js("SoduWorkAPI.taskStorageKey=()=> 'fixture'; SoduWorkAPI.myModels=async()=>({usable:[{name:'fixture-model'}]}); void 0");

  for (const row of rows) {
    assert.equal(await enter(row.id), true);
    await until(contains(list, marker(row.id, row.count - 1)), 'Latest message visible');
    if (row.id === 'history-medium')
      assert.equal(await js(contains(list, marker(row.id, 200))), false, 'The first screen omits the beginning of this turn');
    await until(contains('.nturn-summary', '23s'), 'Completed turn has its archived elapsed time');
    const limit = Math.min(row.count, 2000);
    for (let size = 160; size < limit + 80; size += 80) {
      const wanted = Math.min(size, limit);
      if (row.id === 'history-medium' && size === 240) {
        // A byte-bounded preview can return the same visible range even when
        // the requested row limit grows. Closing its reader restores the link.
        const oldLabel = await js(node(older) + '.textContent');
        const current = [...views.values()].find(view => view.sessionId === row.id).snapshot();
        intercept = () => ({ ok: true, snapshot: current });
        await click(older);
        await until(contains(dialog + ' [role=status]', '/ 302'), 'A saturated preview opens its earlier page');
        await click(dialog + ' header button');
        await until(node(older) + '?.textContent === ' + JSON.stringify(oldLabel), 'The earlier history button is ready again');
      }
      const delayed = row.id === 'history-medium' && size === 160 ? holdNextRead() : null;
      await click(older);
      if (delayed) {
        // Deliver a newer same-ref publication while the older window reply is held.
        const { ref, snapshot } = await delayed.started;
        const final = { ...snapshot.messages.at(-1), text: 'Newly settled reply',
          blocks: [{ kind: 'text', text: 'Newly settled reply', done: true }] };
        win.webContents.send('pi-session-event', { ref, kind: 'settled', snapshot: { ...snapshot, status: 'idle',
          messages: [...snapshot.messages.slice(0, -1), final] } });
        await until(contains(list, final.text), 'Settled publication reaches the selected chat');
        delayed.release({ ...snapshot, status: 'streaming' });
        await until(node(older) + ' && !' + node(older) + '.disabled', 'Older request completes');
        assert.equal(await js(contains(list, final.text)), true, 'An older window reply cannot overwrite the final answer');
        assert.equal(await js('NativeChat.isBusy()'), false, 'The completed chat remains idle');
      }
      await until(contains(list, marker(row.id, row.count - wanted)), 'Reached tail of ' + wanted + ' messages');
      assert.equal(reads.at(-1).options.messageLimit, size, 'Every click expands the same tail by 80');
      if (wanted === limit) break;
    }
    if (row.count <= limit) {
      assert.equal(await js(node(older) + ' === null'), true, 'The first message is visible without a redundant earlier-records button');
      continue;
    }
    const region = dialog + ' section', status = dialog + ' [role=status]';
    const previous = dialog + ' footer button:first-child', next = dialog + ' footer button:last-child';
    intercept = () => ({ ok: false, reason: 'Page read interrupted' });
    await click(older); await until(contains(status, 'Page read interrupted'), 'The first page reports a read failure');
    await click(previous);
    await until(contains(status, '105–184 / 2184'), 'Nearest earlier page');
    assert.equal(await js(node(region) + '.lastElementChild.textContent'), '用时 23s', 'The last reply on a page ends its turn before the next user');
    assert.equal(await js(node(region) + '.lastElementChild.previousElementSibling.textContent'), marker(row.id, 183));
    assert.equal(await js(contains(region, 'Saved early reasoning')), true);
    assert.equal(await js(contains(region, '权限已调整，未执行')), true);
    await js('[...' + node(region) + '.querySelectorAll("summary")].find(item => item.textContent.includes("权限已调整，未执行")).click()');
    await until(contains(region + ' details[open] pre', '此操作在执行前因权限调整而取消'),
      'Expanding the receipt renders the formatted explanation for the cancelled edit');
    await click(previous); await until(contains(status, '25–104 / 2184'), 'Previous page');
    await click(previous); await until(contains(status, '1–24 / 2184'), 'Very first page');
    assert.equal(await js(contains(region, marker(row.id, 0))), true);
    assert.equal(await js(node(previous) + '.disabled'), true);
    await click(next); await until(contains(status, '25–104 / 2184'), 'Navigate forward');
    await click(dialog + ' header button'); await until(node(dialog) + ' === null', 'Close read-only history');
    assert.equal(await js(contains(list, marker(row.id, row.count - 1))), true, 'The active chat still contains the latest reply');
    const pending = holdNextRead();
    await click(older); await pending.started;
    await js("SoduWorkAPI.taskStorageKey = () => 'other-fixture'; window.dispatchEvent(new Event('soduwork-data-scope-changed'));");
    await until(node(dialog) + ' === null', 'An account switch closes the pending dialog');
    pending.release();
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await js('document.querySelector("dialog.nchat-history-page") === null'), true, 'The previous account page cannot reopen after its reply');
  }
  assert.deepEqual(rows.map(row => digest(row.path)), initialDigests);
  assert.deepEqual(await js('errors'), []);
  console.log('PASS historical paging, elapsed time, reasoning, cancelled tools, retry, account switch and late snapshot handling.');
}).catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await history?.close(); win?.destroy(); app.exit(process.exitCode || 0); });
