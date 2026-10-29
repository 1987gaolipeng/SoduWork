'use strict';
// Isolated Electron/preload -> production task bridge/main open -> real Pi SDK.
// Task persistence and Hub policy/memory are fixtures; no account or paid model.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, protocol, net, screen } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-access-'));
  const output = process.argv.slice(2).find(value => !value.startsWith('--'));
  const out = output ? path.resolve(output) : path.resolve(client, '../outputs/task-compose-access-20261014'); fs.mkdirSync(out, { recursive: true });
  const baseline = process.argv.includes('--baseline'), report = { ok: false, baseline, cases: [], errors: [] };
  app.setPath('userData', path.join(root, 'profile')); app.on('window-all-closed', () => {});
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(path.join(app.getPath('userData'), 'access-preferences.json'), JSON.stringify({ schema: 1, mode: 'full', revision: 1, fullConsentVersion: 1 }));
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const desk = path.join(client, 'desk.html'), pageURL = pathToFileURL(desk).href;
  const surface = baseline ? require('node:child_process').execFileSync('git', ['show', '20add34a:client/components/panels/compose-surface.js'], { cwd: client, encoding: 'utf8' }) : read('components/panels/compose-surface.js');
  const html = '<!doctype html><html lang="zh-CN"><body><span id="before"></span><span id="actual"></span>' +
    '<script>' + read('components/panels/work-composer.js') + '</script><script>' + surface + '</script><script>' +
    `window.last=null;window.taskCalls=[];window.bindings=[];window.notices=[];window.petSay=m=>notices.push(m);
     window.NativeChat={hasSession:()=>Boolean(window.reuse&&last?.ok),bindTask:id=>bindings.push(id),enter:()=>true,
       openTask:async(id,title,options)=>{taskCalls.push(options);const result=await soduWorkAPI.conversationSession.open({
         adapterId:'pi',taskRef:id,taskSession:true,...options.sessionOptions});last=result;
         if(result.ok)document.querySelector('#actual').textContent=WorkComposer.permissionLabel(result.snapshot.accessPolicy.mode);
         return result.ok;}};
     window.createTask=(mode,reuse=false,transferred=false)=>{window.reuse=reuse;if(!reuse)window.last=null;
       document.querySelector('#before').textContent=WorkComposer.permissionLabel(mode);
       const bridge=ComposeSurface.taskBridge({accessMode:mode,model:()=>'',atts:()=>[],clearAtts(){},clearInput(){},reset(){},
         openTask:(id,title,access)=>ComposeSurface.openCreatedTask(id,title,null,access)});
       bridge.onPersisted('fixture-task','Isolated task',{handedOff:transferred});bridge.onCreated('fixture-task','Isolated task',{handedOff:transferred});};` +
    '</script></body></html>';
  let owner, fixture, context, opens = 0, confirmations = 0;
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, description) {
    for (let i = 0; i < 250; i++) { const value = await check(); if (value) return value; await delay(25); }
    throw Error('Timed out: ' + description);
  }
  async function click(win, selector) {
    const point = await js(win, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(35);
  }
  async function start(mode) {
    await fixture.handle?.close();
    await js(owner, `createTask(${JSON.stringify(mode)});void 0;`);
  }
  app.whenReady().then(async () => {
    protocol.handle('file', request => request.url.split('?')[0] === pageURL
      ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    function HiddenConsent(options) {
      const win = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
      win.show = () => {}; win.focus = () => {}; return win;
    }
    const nativeConfirm = require('../main/access-control/full-access-consent').create({ BrowserWindow: HiddenConsent, ipcMain, screen });
    const confirmFullAccess = parent => { confirmations++; return nativeConfirm(parent); };
    const newChatAccess = require('../main/access-control/new-chat-consent').create({ BrowserWindow, confirmFullAccess });
    fixture = await require('./fixtures/resumed-pi.cjs').create(path.join(root, 'runtime'));
    const source = read('main/pi-session/ipc.js');
    const handler = source.slice(source.indexOf('  async function openConversation('), source.indexOf("  ipcMain.handle('pi-session-open',"));
    context = vm.createContext({
      app, path, BrowserWindow, confirmFullAccess, newChatAccess,
      _cloudHandoff: { observe() {} }, skillTurn: require('../main/pi-session/skill-turn'), sendIdentityOf: null,
      identityOf: async () => ({ hub: 'http://127.0.0.1', clientId: 'fixture' }),
      memories: { context: async () => ({}), attach: async () => {} }, updateWorkloads: { guard: () => ({ ok: true }) },
      session: { open: async value => { opens++; const session = await fixture.open({ resumePath: '',
        ref: value.ref, taskRef: value.taskRef, accessPolicy: value.accessPolicy, readOnly: value.readOnly }); return { ok: true, session }; } },
      capabilities: { resolve: async () => ({ catalog: {}, selectedSkills: [], capabilityIds: [] }) },
      capabilityGrantsOf: null, _skillDirs: () => [], _newSessionCwd: () => fixture.cwd, workDir: () => root,
      attachments: { stage: async () => ({ files: [], warnings: [] }) }, sessionSpec: require('../main/conversation/session-spec'),
      _conf: () => ({}), _entryContextPrompts: () => [], _awaitBounded: value => value, OPEN_TIMEOUT_MS: 45000,
      _bindUsage() {}, _attach() {}, _detach() {}, _wire() {}, _openReply: session => ({ ok: true, ref: session.ref, snapshot: session.snapshot() }),
      require: name => require(path.join(client, 'main/pi-session', name)),
    });
    vm.runInContext(handler, context);
    ipcMain.handle('pi-session-open', (event, options) => context.openConversation(event, options));
    owner = new BrowserWindow({ show: false, width: 900, height: 650,
      webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    owner.webContents.on('console-message', event => { if (event.level >= 3) report.errors.push(event.message); });
    await owner.loadFile(desk);
    if (!baseline) {
      for (const mode of ['readonly', 'standard', 'full']) {
        fs.writeFileSync(path.join(app.getPath('userData'), 'access-preferences.json'),
          JSON.stringify({ schema: 1, mode, revision: 2, fullConsentVersion: mode === 'full' ? 1 : 0 }));
        await start(undefined); await until(() => js(owner, 'last?.ok'), mode + ' system default');
        assert.equal(fixture.handle.snapshot().accessPolicy.mode, mode);
        assert.equal(await js(owner, 'document.querySelector("#actual").textContent'),
          mode === 'full' ? '完全访问' : mode === 'readonly' ? '只读' : '默认权限');
      }
      await start('full'); await until(() => js(owner, 'last?.ok'), 'confirmed full default');
      assert.equal(fixture.handle.snapshot().accessPolicy.mode, 'full');
      assert.equal(confirmations, 0);
      report.cases.push('系统三种默认模式进入真实 Pi 会话并正确显示，已确认完全访问不重复询问');
      // Explicit elevation still requires native confirmation and cancellation when full access is unconfirmed.
      fs.writeFileSync(path.join(app.getPath('userData'), 'access-preferences.json'),
        JSON.stringify({ schema: 1, mode: 'standard', revision: 3, fullConsentVersion: 0 }));
    }
    await start('full');
    const first = await until(async () => BrowserWindow.getAllWindows().find(win => win.getParentWindow() === owner) || await js(owner, 'last'), 'full permission dialog or actual runtime result');
    if (baseline) {
      assert.equal(first.snapshot?.accessPolicy.mode, 'standard');
      assert.equal(await js(owner, 'document.querySelector("#before").textContent'), '完全访问');
      report.cases.push('Unmodified bridge reproduces full shown before submission and actual standard task policy');
    } else {
      assert.equal(typeof first.webContents?.executeJavaScript, 'function', 'full task must use native confirmation');
      await until(() => js(first, 'Boolean(document.querySelector("#consentAllow"))'), 'native consent renderer');
      assert.equal(await js(first, 'document.querySelector("#consentAllow").disabled'), true);
      await click(first, '.acknowledgement'); await click(first, '#consentAllow');
      await until(() => js(owner, 'last?.ok'), 'full task runtime');
      assert.equal(fixture.handle.snapshot().accessPolicy.mode, 'full');
      assert.equal(await js(owner, 'document.querySelector("#actual").textContent'), '完全访问');
      assert.equal(confirmations, 1);
      report.cases.push('Full composer choice reaches the actual Pi policy after one task-scoped native consent');
      const beforeReuse = opens;
      await js(owner, "createTask('readonly',true);void 0;"); await delay(60);
      assert.equal(opens, beforeReuse); assert.equal(fixture.handle.snapshot().accessPolicy.mode, 'full');
      assert.equal(await js(owner, 'bindings.length'), 1);
      report.cases.push('Binding a task to an existing conversation preserves its policy and native handle');
      for (const mode of ['readonly', 'standard']) {
        await start(mode); await until(() => js(owner, 'last?.ok'), mode + ' task runtime');
        assert.equal(fixture.handle.snapshot().accessPolicy.mode, mode);
      }
      assert.equal(confirmations, 1);
      report.cases.push('Readonly and standard choices reach real Pi policies without extra consent');
      const beforeCancel = opens;
      await start('full');
      const cancelled = await until(() => BrowserWindow.getAllWindows().find(win => win.getParentWindow() === owner), 'cancel consent');
      await until(() => js(cancelled, 'Boolean(document.querySelector("#consentCancel"))'), 'cancel button');
      await click(cancelled, '#consentCancel'); await until(() => js(owner, 'last?.cancelled'), 'cancelled result');
      assert.equal(opens, beforeCancel);
      report.cases.push('Cancelling full access creates no runtime and does not fall back to standard');
      await start(undefined); await until(() => js(owner, 'last?.ok'), 'unselected task runtime');
      assert.equal(fixture.handle.snapshot().accessPolicy.mode, 'standard');
      report.cases.push('Task callers without an explicit composer choice retain the standard default');
      const beforeTransfer = opens;
      await js(owner, "createTask('full',false,true);void 0;"); await delay(60);
      assert.equal(opens, beforeTransfer);
      report.cases.push('Transferred tasks do not open another local conversation or inherit full access');
    }
    assert.equal(fixture.requests.length, 0, 'no model inference requests');
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
    await fixture?.close();
    BrowserWindow.getAllWindows().forEach(win => { if (!win.isDestroyed()) win.destroy(); });
    fs.writeFileSync(path.join(out, baseline ? 'baseline.json' : 'fixed.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
