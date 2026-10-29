'use strict';
// Real Pi SDK/local model + production transcript, permission picker and IPC.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const hot = process.env.SODUWORK_TEST_ACCESS_HOT === '1';
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/' + (hot ? 'access-upgrade-latency' : 'access-change-feedback'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-feedback-'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(root, 'profile'));
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const report = { ok: false, cases: [] };
  let win, fixture, live, changes, control, running = false, ready = false, unsubscribe;
  const acc = require('../main/pi-session/event-stream').create();
  const js = code => win.webContents.executeJavaScript(code, true);
  const snapshot = () => ({ ...control.view(acc.snapshot()), ...live.access.snapshot(), adapterId: 'pi', displayName: 'Pi',
    execution: { running }, nextAccessPolicy: changes.pending(), accessControl: {
      schema: 'soduwork.access-policy/v1', supported: true, modes: ['standard', 'readonly', 'full'], canChangeDuringSession: true, changeTakesEffect: 'current-turn' } });
  function publish() {
    if (ready) win.webContents.send('pi-session-event', { ref: 'access-feedback', kind: 'snapshot', snapshot: snapshot() });
  }
  function subscribe(session) {
    unsubscribe = session.subscribe(event => { acc.push(event); publish(); });
  }
  async function until(check) {
    for (let i = 0; i < 300; i++) { if (await check()) return; await delay(20); }
    throw Error('Timed out: ' + check);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable control');const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(100);
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: {
      preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    const operation = { tool: 'write', args: { path: path.join(root, 'outside.txt'), content: 'exactly once' } };
    fixture = await require('./fixtures/access-sdk.cjs').create(root, 'standard', publish, { persist: true,
      reply: (body, op) => op || (/The user changed/.test(JSON.stringify(body.messages.at(-1))) ? operation : null) });
    live = { session: fixture.session, access: fixture.access, policy: fixture.access.policy }; subscribe(live.session);
    changes = require('../main/access-control/pi-transition').create({ cwd: fixture.workspace, current: () => live,
      commitPolicy: hot ? policy => { live.policy = policy; } : undefined,
      preload: hot ? () => { throw Error('Hot upgrade must not reload extensions'); } : undefined,
      prepare: (policy, previous) => fixture.rebuild(policy, previous), changed: publish,
      commit: next => { unsubscribe(); live = next; subscribe(next.session); } });
    control = require('../main/access-control/pi-live-change').create({ current: () => live, transition: changes, changed: publish });
    const handle = { cwd: fixture.workspace, attachedWindow: win, snapshot, setAccessPolicy: async (p, r) => {
      const started = performance.now(), result = await control.change(p, r);
      report.applyMs = performance.now() - started;
      return result;
    } };
    ipcMain.handle('pi-session-set-access-mode', require('../main/access-control/ipc').changeHandler({
      session: { get: ref => ref === 'access-feedback' ? handle : null }, BrowserWindow, confirmFullAccess: async () => true }));
    ipcMain.handle('pi-session-open', () => ({ ok: true, ref: 'access-feedback', sessionId: live.session.sessionId,
      adapterId: 'pi', displayName: 'Pi', cwd: fixture.workspace, model: { label: 'Local fixture' }, snapshot: snapshot() }));
    ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot: snapshot() }));
    for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, items: [] },
      'pi-session-release': { ok: true }, 'pi-session-runtime-models': { ok: true, items: [] }, 'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true } })) ipcMain.handle(channel, () => value);
    const source = path.join(__dirname, 'fixtures/workbench-annotations.html'), scripts = [];
    const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
      const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return '';
    });
    const documentFile = path.join(out, 'native-chat.html');
    fs.writeFileSync(documentFile, html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(path.dirname(source) + path.sep).href + '">'));
    await win.loadFile(documentFile);
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
    for (const file of ['core/i18n-dom.js', 'core/i18n.js']) await js(read(file) + '\nvoid 0;');
    for (const script of scripts) await js(script + '\nvoid 0;');
    await js('SoduWorkI18n.setLocale("zh-CN");NativeChat.enter("","access-feedback",{adapterId:"pi"});');
    ready = true;
    await until(() => js('Boolean(document.querySelector("#nchatMode"))'));
    await js(`window.redFrames=[];new MutationObserver(()=>{const e=document.querySelector('.ntool.error,.ntool-batch.error,.nbad.show');if(e)redFrames.push(e.textContent);}).observe(document.querySelector('#cpChat'),{childList:true,subtree:true,attributes:true});`);
    running = true;
    const active = require('../main/pi-session/background-process').run(() => control.run(() => live.session.prompt(JSON.stringify(operation))))
      .finally(() => { running = false; acc.push({ type: 'agent_settled' }); publish(); });
    await until(() => live.access.broker.pending().length);
    const original = live.session;
    let lastTick = performance.now(), maxTickGap = 0;
    const heartbeat = setInterval(() => { const now = performance.now(); maxTickGap = Math.max(maxTickGap, now - lastTick); lastTick = now; }, 10);
    await click('#nchatMode'); await click('[data-access-mode="full"]');
    await active;
    clearInterval(heartbeat); report.mainThreadMaxTickGapMs = maxTickGap;
    if (!hot) await until(() => js('Boolean(document.querySelector(".ntool.cancelled"))'));
    assert.equal(fs.readFileSync(operation.args.path, 'utf8'), 'exactly once');
    assert.deepEqual(await js('window.redFrames'), []);
    assert.equal(live.session.state.messages.filter(m => m.role === 'user').length, 1);
    assert.equal(live.session.state.messages.filter(m => m.role === 'toolResult' && !m.isError).length, 1);
    if (hot) {
      assert.equal(live.session, original);
      assert.equal(live.session.state.messages.filter(m => m.role === 'toolResult').length, 1);
      assert.equal(await js('document.querySelectorAll(".ntool.cancelled").length'), 0);
      assert.ok(report.applyMs < 250, 'Permission must apply without a runtime reload');
      assert.ok(maxTickGap < 250, 'Permission update must not block Electron');
    } else assert.match(await js('document.querySelector(".ntool.cancelled").textContent'), /权限已调整，未执行/);
    report.cases.push('Active approval → actual picker/IPC → full access → same-turn continuation without red error or duplicate write');
    for (const locale of ['en-US', 'zh-CN']) {
      await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ')'); await delay(100);
      if (hot) assert.match(await js('document.querySelector("#nchatMode").textContent'), locale === 'en-US' ? /Full access/i : /完全访问/);
      else assert.match(await js('document.querySelector(".ntool.cancelled").textContent'), locale === 'en-US' ? /Access changed · Not run/ : /权限已调整，未执行/);
    }
    report.cases.push(hot ? 'Full access is shown in both languages' : 'Neutral cancellation remains readable in both languages');
    const replay = require('../main/pi-session/event-stream').create(); require('../main/pi-session/session')._seed(replay, live.session);
    win.webContents.send('pi-session-event', { ref: 'access-feedback', kind: 'snapshot', snapshot: { ...snapshot(), ...replay.snapshot() } });
    await delay(180); assert.deepEqual(await js('window.redFrames'), []);
    report.cases.push(hot ? 'Native history replay preserves the original completed call' : 'Native history replay preserves neutral cancelled state');
    acc.push({ type: 'tool_execution_end', toolCallId: 'actual-failure', toolName: 'bash', isError: true,
      result: { content: [{ type: 'text', text: 'actual process failure' }] } }); publish();
    await until(() => js('Boolean(document.querySelector(".ntool.error,.ntool-batch.error"))'));
    report.cases.push('Actual execution failure remains visibly erroneous');
    assert.deepEqual(await js('window.errors'), []);
    fs.writeFileSync(path.join(out, 'verified.png'), (await win.webContents.capturePage()).toPNG());
    report.ok = true;
  }).catch(async error => {
    report.error = error.stack || String(error);
    if (win && !win.isDestroyed()) report.ui = await js('({text:document.body.innerText,errors:window.errors,red:window.redFrames})').catch(() => null);
  }).finally(async () => {
    ready = false; control?.close(); changes?.close(); unsubscribe?.();
    try { live?.access?.broker.close(); await live?.session?.abort(); live?.session?.dispose(); await fixture?.close(); } catch (error) { report.cleanupError = String(error); report.ok = false; }
    win?.destroy(); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Electron may still hold its temporary profile. */ } app.exit(report.ok ? 0 : 1);
  });
}
