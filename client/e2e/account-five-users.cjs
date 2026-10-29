'use strict';
// Full production main.js -> preload.js -> desk.html. Only OS side effects,
// external SMTP reception and the model provider are isolated test boundaries.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const spawnedAt = Date.now();
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const cleanup = require('./fixtures/owned-child-cleanup.cjs').createOwnedChildCleanup({ child, spawnedAt,
    timeoutMs: 18 * 60 * 1000, intervalMs: 5000, onReport(value) {
      const fs = require('node:fs'), path = require('node:path');
      const file = path.resolve(__dirname, '../../outputs/account-center-five-users-20261023/process-cleanup.json');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2));
    } });
  cleanup.ready.catch(error => process.stderr.write('Process supervision baseline: ' + error.message + '\n'));
  child.on('exit', async code => { await cleanup.stop('exit').catch(() => {}); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, session, dialog } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { spawn } = require('node:child_process'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), repo = path.dirname(client);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-five-'));
  const profile = path.join(root, 'profile'), workspace = path.join(root, 'workspace');
  const out = path.join(repo, 'outputs/account-center-five-users-20261023');
  for (const dir of [profile, workspace, path.join(root, 'home'), out]) fs.mkdirSync(dir, { recursive: true });
  process.env.SODUWORK_USER_DATA = profile;
  process.env.USERPROFILE = path.join(root, 'home');
  process.env.APPDATA = path.join(root, 'appdata'); process.env.LOCALAPPDATA = path.join(root, 'localappdata');
  process.env.SODUWORK_DATA_ROOT = path.join(root, 'hub-data');
  for (const key of Object.keys(process.env)) if (/API_KEY$|ACCESS_TOKEN$|AUTH_TOKEN$|^CODEX_HOME$|^CLAUDE_CONFIG_DIR$|^PI_CODING_AGENT_DIR$/.test(key)) delete process.env[key];
  app.setPath('userData', profile); app.setPath('home', path.join(root, 'home'));
  app.setPath('documents', workspace); app.setPath('downloads', path.join(root, 'home'));
  for (const key of ['appData', 'sessionData', 'temp', 'desktop', 'logs']) {
    const dir = path.join(root, key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir);
  }
  app.setAppPath(client); process.chdir(root);
  os.homedir = () => path.join(root, 'home');
  app.disableHardwareAcceleration();
  fs.writeFileSync(path.join(profile, 'autostart-initialized'), 'isolated QA');
  fs.writeFileSync(path.join(profile, 'chat-config.json'), JSON.stringify({ workDir: workspace, mode: 'readonly' }));
  fs.writeFileSync(path.join(profile, 'desk-flags.json'), JSON.stringify({ dock: false, pet: false, tray: false }));
  const report = { ok: false, root, profile, workspace, pid: process.pid, startedAt: new Date().toISOString(),
    cases: [], accounts: [], screenshots: [], errors: [], requests: [], blockedNetwork: [], ownedProcesses: [],
    boundary: 'Original production main, preload, desk, ClientAuth, API, Store, task permissions and Pi SDK conversation implementation. Pi runs in this isolated process rather than utilityProcess/RPC; that process boundary is not verified. Temporary SQLite and local TLS SMTP. Model provider returns deterministic text with no tools. Runner, system startup, shortcuts and update downloads disabled only in this test entry. The styled logout confirmation is clicked in the renderer; native window chrome and OS dialogs are not verified. No production accounts, mailbox or business data.' };
  let server, win, connection, serverErrors = '', lastChallenge = '', exiting = false;
  const limit = Number(process.argv.find(arg => arg.startsWith('--accounts='))?.split('=')[1] || 5);
  const pythonDeps = process.argv.find(arg => arg.startsWith('--python-deps='))?.slice('--python-deps='.length) || '';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const manifest = require('./fixtures/account-source-manifest.cjs');
  function sourceSnapshot() {
    const snapshot = manifest.snapshot(), crypto = require('node:crypto');
    const files = ['client/main.js', 'client/desk-boot.js', 'client/core/store.js', 'client/core/store-lifecycle.js', 'client/core/requirements.js',
      'client/core/win-bridge.js', 'client/main/device-auth-request.js', 'client/main/device-auth.js',
      'client/main/conversation/capabilities.js', 'client/main/pi-session/model-config.js', 'client/main/agent-runtime/process-auth.js',
      'client/main/pi-session/ipc.js', 'client/main/pi-session/task-input.js', 'client/main/pi-session/turn-queue.js',
      'client/main/pi-session/session.js', 'client/main/pi-session/environment-ipc.js',
      'client/main/pi-session/history-ipc.js', 'client/main/conversation/history-access.js',
      'client/main/conversation/session-memory.js', 'client/main/conversation/runtime-segments.js',
      'client/main/conversation/requirement-context.js', 'client/main/conversation/work-conversation-cards.js',
      'client/main/agent-runtime/process-worker.js', 'client/main/agent-runtime/process-host.js',
      'hub-backend/app/api/tasks.py', 'hub-backend/app/services/task_access.py', 'hub-backend/app/services/task_requirements.py',
      'hub-backend/app/services/tasks.py', 'hub-backend/app/services/task_dispatch.py', 'hub-backend/app/services/task_dispatch_context.py',
      'hub-backend/app/deps.py', 'hub-backend/app/db.py', 'hub-backend/app/schemas.py',
      'hub-backend/app/models.py', 'hub-backend/app/services/attachment_ownership.py', 'hub-backend/app/realtime.py',
      'hub-backend/app/api/ws.py', 'hub-backend/migrations/versions/0065_task_account_ownership.py',
      'client/e2e/account-five-users.cjs', 'client/e2e/fixtures/full_client_hub_fixture.py',
      'client/e2e/fixtures/full-client-isolation.cjs', 'client/e2e/fixtures/full-client-inprocess-runtime.cjs', 'client/e2e/fixtures/owned-child-cleanup.cjs',
      'client/components/workspace/workspace-shell.js'];
    for (const file of fs.readdirSync(path.join(repo, 'hub-backend/migrations/versions')))
      if (/^0066.*\.py$/.test(file)) files.push('hub-backend/migrations/versions/' + file);
    for (const dir of ['client/components/requirements', 'client/components/panels']) for (const file of fs.readdirSync(path.join(repo, dir)))
      if (/\.js$/.test(file) && (dir.endsWith('requirements') || /^(panels-(?:compose|forward)|chat-(?:session|task|work)|requirement-|work-entry|compose-)/.test(file))) files.push(dir + '/' + file);
    for (const file of files) if (fs.existsSync(path.join(repo, file))) snapshot.sha256[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex');
    return snapshot;
  }
  const flush = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report,
    (key, value) => /^(password|session|token|verificationToken|deviceKey|key)$/i.test(key) ? undefined : value, 2));
  const js = code => Promise.race([win.webContents.executeJavaScript(
    `(async()=>{try{return {ok:true,value:await eval(${JSON.stringify(code)})}}catch(error){return {ok:false,error:String(error.stack||error)}}})()`, true)
    .then(result => { if (!result.ok) throw Error(result.error); return result.value; }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Renderer operation timed out')), 12000); timer.unref(); })]);
  async function until(expression, ms = 30000) {
    const started = Date.now(); let lastError;
    while (Date.now() - started < ms) {
      try { if (typeof expression === 'function' ? await expression() : await js(expression)) return; }
      catch (error) { lastError = error.message; }
      await delay(80);
    }
    throw Error('Timed out: ' + expression + (lastError ? '\n' + lastError : ''));
  }
  async function click(selector) {
    const visible = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>!e.disabled&&e.checkVisibility({visibilityProperty:true,opacityProperty:true}))`;
    await until(`Boolean(${visible})`);
    await js(`(()=>{const e=${visible},r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight||r.left<0||r.right>innerWidth)e.scrollIntoView({block:'center'})})()`); await delay(60);
    const point = await js(`(()=>{const e=${visible},r=e.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Obscured '+${JSON.stringify(selector)});return{x,y}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(80);
  }
  async function fill(selector, value) {
    await click(selector);
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'A', modifiers: ['control'] });
    await win.webContents.insertText(value); await delay(40);
  }
  async function textButton(label, scope = 'body') {
    const selector = await js(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(e=>e.checkVisibility()&&e.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Missing button '+${JSON.stringify(label)});e.dataset.qaAction='current';return '[data-qa-action="current"]'})()`);
    try { await click(selector); } finally { await js(`document.querySelector(${JSON.stringify(selector)})?.removeAttribute('data-qa-action')`).catch(() => {}); }
  }
  async function shot(name) {
    win.qaShowInactive?.();
    try {
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      win.webContents.invalidate(); await delay(300);
      const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const file = path.join(out, name + '.png'); fs.writeFileSync(file, image.toPNG()); report.screenshots.push(file); flush();
    } finally { win.hide(); }
  }
  async function step(account, name, fn) {
    const started = Date.now();
    process.stdout.write('START ' + account + ' ' + name + '\n');
    try { const result = await fn(); report.cases.push({ account, name, ok: true, durationMs: Date.now() - started }); flush(); process.stdout.write('PASS ' + account + ' ' + name + '\n'); return result; }
    catch (error) {
      const state = await js("({url:location.pathname+location.search,loading:document.readyState,body:document.body.innerText.slice(0,6000),authPending:document.documentElement.classList.contains('soduwork-auth-pending'),userId:ClientAuth?.snapshot()?.user?.id,scope:SoduWorkAPI?.taskStorageKey?.('ops'),timeOrigin:performance.timeOrigin})").catch(() => null);
      report.cases.push({ account, name, ok: false, durationMs: Date.now() - started, error: String(error.stack || error), state });
      process.stdout.write('FAIL ' + account + ' ' + name + ': ' + error.message + '\n');
      await shot('failure-' + account + '-' + report.cases.length).catch(() => {}); flush(); throw error;
    }
  }
  const attempt = async (account, name, fn) => { try { return await step(account, name, fn); } catch { return undefined; } };
  function isLocal(url) { try { const u = new URL(url); return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); } catch { return false; } }
  async function mailbox() {
    await until(() => Boolean(lastChallenge)); const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const response = await fetch(connection.hub + '/__fixture__/mail/' + encodeURIComponent(lastChallenge), { headers: { 'X-Fixture-Key': connection.key } });
      const row = await response.json(); if (row.ready) { assert.equal(row.smtpDelivered, true); return row.code; }
      await delay(100);
    }
    throw Error('Local SMTP did not deliver the requested challenge');
  }
  async function backendSummary() {
    const response = await fetch(connection.hub + '/__fixture__/summary', { headers: { 'X-Fixture-Key': connection.key } });
    assert.equal(response.ok, true); return response.json();
  }
  async function startHub() {
    return new Promise((resolve, reject) => {
      process.stdout.write('START isolated Hub and local SMTP\n');
      const timeout = setTimeout(() => reject(Error('Isolated Hub startup timed out: ' + serverErrors)), 180000);
      server = spawn(path.join(repo, 'hub-backend/.venv/Scripts/python.exe'), ['-B', path.join(__dirname, 'fixtures/full_client_hub_fixture.py'), '--root', root],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: pythonDeps, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
      report.ownedProcesses.push({ pid: server.pid, role: 'isolated Hub and SMTP' }); flush();
      let stdout = '';
      server.stdout.on('data', chunk => { stdout += chunk; const match = stdout.match(/ACCOUNT_FIXTURE_READY (\{[^\n]+\})/); if (match) { clearTimeout(timeout); resolve(JSON.parse(match[1])); } });
      server.stderr.on('data', chunk => { serverErrors += chunk; });
      server.on('error', error => { clearTimeout(timeout); reject(error); });
      server.on('exit', code => { if (!connection) { clearTimeout(timeout); reject(Error('Fixture exit ' + code + ': ' + serverErrors)); } });
    });
  }
  function isolateSideEffects() {
    app.setLoginItemSettings = () => { throw Error('System autostart is disabled in isolated QA'); };
    electron.globalShortcut.register = () => false;
    electron.shell.openExternal = async () => { throw Error('External navigation is disabled in isolated QA'); };
    const runner = require('../main/runner-runtime');
    runner.install = dependencies => {
      ipcMain.handle('runner-status', () => ({ running: false, connected: false, state: 'stopped', capabilityGrants: [] }));
      for (const channel of ['runner-configure', 'runner-capability-set', 'runner-component-confirm'])
        ipcMain.handle(channel, () => ({ ok: false, error: 'Runner disabled in isolated QA', state: 'stopped' }));
    };
    const updater = require('../main/client-updater');
    updater.install = () => {
      ipcMain.handle('client-update-status', () => ({ state: 'idle', phase: 'idle', currentVersion: app.getVersion() }));
      for (const channel of ['client-update-check', 'client-update-install', 'client-update-resolve']) ipcMain.handle(channel, () => ({ ok: false, error: 'Updates disabled in isolated QA' }));
    };
    // Preserve the real handlers and UI. The account-center confirmation is
    // clicked by the test flow below; no native confirm shim is installed.
    app.on('browser-window-created', (_event, window) => {
      window.qaShowInactive = window.showInactive.bind(window);
      window.show = () => {}; window.showInactive = () => {}; window.focus = () => {};
      window.webContents.setBackgroundThrottling(false);
      window.webContents.on('console-message', (_event, details) => {
        if (details?.level === 'error') report.errors.push({ url: window.webContents.getURL(), message: details.message });
      });
    });
  }
  async function loginGate() {
    await until("document.querySelector('#soduWorkClientAuthGate')?.checkVisibility() && !document.querySelector('[data-auth-mode=register]')?.disabled", 45000);
  }
  async function logout() {
    for (const selector of ['.wes-result-close', '[data-act=fwd-close]', '[data-wes-close]', '[data-rq-dismiss]', '.ac-center [data-ac-close]']) {
      if (await js(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.checkVisibility())`)) await click(selector);
    }
    for (let i = 0; i < 3; i++) { for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' }); await delay(50); }
    // Open the consolidated account page from the bottom avatar. The account
    // entry now lives in the AI and account settings group; the former settings
    // page shortcut was removed to avoid a duplicate route.
    await click('#wsRailMine, #wsMine');
    await until('document.querySelector("#personalAccountPanel.show")');
    assert.equal(await js("document.querySelector('.soduwork-account-menu-btn,.soduwork-account-menu')"), null,
      'account summary no longer exposes the duplicate three-dot menu');
    await click('.ac-center [data-tab=security]');
    await click('.ac-center [data-logout]');
    await click('.ac-logout-confirm [data-ac-confirm]');
    await loginGate(); return true;
  }
  async function authenticatedWorkspace(account, beforeNavigation) {
    await until(`ClientAuth.snapshot().user?.email===${JSON.stringify(account.email)} && !document.documentElement.classList.contains('soduwork-auth-pending') && !document.querySelector('#soduWorkClientAuthGate')?.checkVisibility()`, 60000);
    const state = await js(`(async()=>{const me=await SoduWorkAPI.clientAuthMe();return{user:me.user,rendererUserId:ClientAuth.snapshot().user?.id,scope:SoduWorkAPI.taskStorageKey('ops'),timeOrigin:performance.timeOrigin,taskIds:tasks.map(t=>t.id),cachedIds:JSON.parse(localStorage.getItem(SoduWorkAPI.taskStorageKey('tasks'))||'[]').map(t=>t.id)}})()`);
    assert.equal(state.user.email, account.email);
    assert.equal(state.rendererUserId, state.user.id, 'Renderer and authenticated API must agree on the active user');
    if (account.user) assert.equal(state.user.id, account.user.id);
    assert.ok(state.scope.endsWith('@' + encodeURIComponent(state.user.id)), 'Task storage must use the authenticated user scope');
    if (account.scope) assert.equal(state.scope, account.scope, 'Returning to an account must restore its original storage scope');
    account.scope = state.scope;
    for (const other of report.accounts.filter(row => row.task?.id && row.user.id !== state.user.id)) {
      assert.ok(!state.taskIds.includes(other.task.id), 'Old account tasks must be cleared before an explicit test hydration');
      assert.ok(!state.cachedIds.includes(other.task.id), 'The active account cache must exclude other accounts');
    }
    report.authTransitions ||= [];
    report.authTransitions.push({ account: account.key, userId: state.user.id, scope: state.scope,
      reloaded: state.timeOrigin !== beforeNavigation, taskIdsBeforeHydration: state.taskIds });
    return state.user;
  }
  async function register(account) {
    await loginGate();
    if (await js("document.querySelector('.ac-auth-back')?.checkVisibility()")) await click('.ac-auth-back');
    await click('[data-auth-mode=register]');
    await fill('#soduWorkAuthAccount', account.email); lastChallenge = ''; await click('[data-send-code]');
    await fill('#acEmailCode', await mailbox()); await fill('#soduWorkAuthPassword', account.password); await fill('#acConfirmPassword', account.password);
    await click('#acConsent'); await shot(account.key + '-registration');
    const beforeNavigation = await js('performance.timeOrigin'); await click('[type=submit]');
    account.user = await authenticatedWorkspace(account, beforeNavigation);
    assert.equal(account.user.isActive, true); assert.equal(account.user.emailVerified, true);
    assert.equal(account.user.orgId, 'fixture-default-org');
    const evidence = await backendSummary();
    assert.equal(evidence.users.find(user => user.id === account.user.id)?.roleId, 'fixture-normal-role');
    await shot(account.key + '-workspace');
  }
  async function profileName(account) {
    await click('#wsRailMine, #wsMine');
    await until('document.querySelector("#personalAccountPanel.show")');
    assert.equal(await js("document.querySelector('.soduwork-account-menu-btn,.soduwork-account-menu')"), null,
      'account summary keeps no duplicate account actions');
    await click('#personalAccountSummary [data-account-profile-editor]');
    await fill('.ac-profile-editor [name=displayName]', account.name); await click('.ac-profile-editor [type=submit]');
    await until(`!document.querySelector('.ac-profile-editor') && ClientAuth.snapshot().user?.displayName===${JSON.stringify(account.name)}`);
  }
  async function conversation(account) {
    await click('[data-view=create], [data-rail-view=create]');
    await fill('#cpInput', '验收对话 ' + account.key + '。请仅回复：你好，' + account.name + '，账号对话验收通过。不要调用工具。');
    await click('#cpGo'); await until("[...document.querySelectorAll('#nchatList .nmsg.ai[data-streaming=false]')].some(e=>e.innerText.includes('这里使用本地 Mock 模型验证注册后的对话链路'))", 90000);
    const history = await js('(soduWorkAPI.conversationSession || soduWorkAPI.piSession).history()');
    assert.equal(history?.ok, true, history?.reason || 'The real history IPC must succeed');
    const rows = history.chats;
    assert.ok(Array.isArray(rows), 'History must return the production chats contract');
    account.conversationIds = rows.map(row => row.sessionId || row.id).filter(Boolean);
    assert.ok(account.conversationIds.length, 'The completed conversation must be persisted in the real history IPC');
    await shot(account.key + '-conversation');
  }
  async function requirement(account, fromChat = false) {
    // Navigate through the visible requirement entry; no fabricated task or
    // direct mutation is used to make UI submission succeed.
    await click('[data-view=history], [data-rail-view=history]'); await click('#hbAddMenuToggle');
    await click(fromChat ? '[data-rq-create-chat=intake]' : '[data-rq-create-manual=intake]');
    const draftStarted = Date.now();
    if (fromChat) { await fill('#cpInput', '/需求 ' + account.title + '。' + account.note); await click('#cpGo'); }
    await until("document.querySelector('#cpTitle')?.checkVisibility()", 30000);
    account.draftPreparationMs = Date.now() - draftStarted;
    await fill('#cpTitle', account.title); await fill('#cpNote', account.note);
    const visibility = await js("document.querySelector('#cpVisibility')?.tagName || ''");
    if (visibility === 'SELECT') assert.equal(await js("document.querySelector('#cpVisibility').value"), 'related',
      'A new requirement must default to related-only visibility without test intervention');
    await js("(()=>{const e=document.querySelector('#cpTriage');if(e){e.value='ready';e.dispatchEvent(new Event('change',{bubbles:true}));}})()");
    await shot(account.key + '-requirement-form');
    const before = await backendSummary(), submittedAt = Date.now(); await click('#cpCreate');
    await until(`tasks.some(t=>t.title===${JSON.stringify(account.title)}) && !document.querySelector('#cpCreate')?.disabled`, 45000);
    const persistedAt = Date.now(), after = await backendSummary();
    account.requirementCreation = { entry: fromChat ? 'chat' : 'manual', durationMs: persistedAt - submittedAt, modelCallsBefore: before.modelCalls.length,
      modelCallsAfter: after.modelCalls.length, newModelCalls: after.modelCalls.slice(before.modelCalls.length) };
    account.task = await js(`tasks.find(t=>t.title===${JSON.stringify(account.title)})`);
    assert.ok(account.task.id); assert.equal(account.task.visibility, 'related'); await shot(account.key + '-requirement-created');
    return account.task;
  }
  async function relogin(account, { emailCode = account.key === 'E' } = {}) {
    await click(emailCode ? '.ac-auth-tabs [data-auth-mode=emailCode]' : '[data-auth-mode=password]');
    await fill('#soduWorkAuthAccount', account.email);
    if (emailCode) { lastChallenge = ''; await click('[data-send-code]'); await fill('#acEmailCode', await mailbox()); }
    else await fill('#soduWorkAuthPassword', account.password);
    const beforeNavigation = await js('performance.timeOrigin'); await click('[type=submit]');
    await authenticatedWorkspace(account, beforeNavigation);
    return true;
  }
  async function reopen(account) {
    await click('[data-view=history], [data-rail-view=history]'); await until(`document.querySelector('[data-rq-open="${account.task.id}"]')`);
    await click('[data-rq-open="' + account.task.id + '"]'); await until(`document.querySelector('.rq-detail-content')?.innerText.includes(${JSON.stringify(account.note)})`);
    await shot(account.key + '-relogin-requirement');
  }
  async function arrange(account) {
    if (await js("!!document.querySelector('.wes-result-dialog')")) await textButton('查看详情', '.wes-result-dialog');
    else { await click('[data-view=history], [data-rail-view=history]'); await click('[data-rq-open="' + account.task.id + '"]'); }
    await until(`document.querySelector('.rq-detail-content')?.dataset.taskId===${JSON.stringify(account.task.id)} && document.querySelector('[data-rq-edit]')`);
    if (!await js("!!document.querySelector('.rq-detail-toolbar [data-rq-assign]')")) {
      await click('[data-rq-edit]');
      await js("(()=>{const e=document.querySelector('#rqEditForm [name=triageStage]');if(!e)throw Error('Preparation stage control unavailable');e.value='ready';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await textButton('保存修改');
    }
    await click('.rq-detail-toolbar [data-rq-assign]'); await until("document.querySelector('#fwdConfirm')&&!document.querySelector('#fwdConfirm').disabled", 60000);
    await shot(account.key + '-assignment'); const before = await backendSummary(); await click('#fwdConfirm');
    await until("!document.querySelector('#fwdPop')", 60000);
    const saved = await js(`SoduWorkAPI.getTask(${JSON.stringify(account.task.id)})`);
    const history = await js('(soduWorkAPI.conversationSession || soduWorkAPI.piSession).history()');
    assert.equal(history?.ok, true, history?.reason || 'The real history IPC must succeed');
    const rows = history.chats;
    assert.ok(Array.isArray(rows), 'History must return the production chats contract');
    const linked = rows.find(row => row.taskId === account.task.id || (row.taskIds || []).includes(account.task.id) ||
      (row.taskBindings || []).some(binding => binding.taskId === account.task.id));
    account.assigned = { status: saved.status, arrangementSaved: Boolean(linked), conversationId: linked?.sessionId || saved.conversationId || saved.workRouting?.conversationId || '' };
    assert.ok(linked, 'Assignment must link the requirement to an actual local conversation');
    account.conversationIds = [...new Set([...(account.conversationIds || []), linked.sessionId || linked.id].filter(Boolean))];
    await until(async () => (await backendSummary()).modelCalls.length > before.modelCalls.length, 45000);
    await until("[...document.querySelectorAll('#nchatList .nmsg.ai[data-streaming=false]')].some(e=>e.innerText.includes('这里使用本地 Mock 模型验证注册后的对话链路'))", 45000);
    account.assigned.executionStarted = true;
    await shot(account.key + '-assigned');
  }
  async function isolationCheck(account) {
    // Login and the startup heartbeat can invalidate an in-flight snapshot.
    // Observe the real Store becoming ready before requesting a fresh one.
    await until("Store._taskState==='ready' && Store._remoteReady===true", 60000);
    const hydrated = await js('Store.hydrate(true)');
    assert.equal(hydrated.online, true, 'Isolation requires a fresh authenticated task snapshot');
    const identity = await js('SoduWorkAPI.clientAuthMe().then(r=>({userId:r.user?.id,deviceId:r.device?.id}))');
    assert.equal(identity.userId, account.user.id);
    const current = await js('SoduWorkAPI.getTasks().then(rows=>rows.map(t=>t.id))');
    const visible = await js('tasks.map(t=>t.id)');
    const history = await js('(soduWorkAPI.conversationSession || soduWorkAPI.piSession).history()');
    assert.equal(history?.ok, true, history?.reason || 'The real history IPC must succeed');
    const historyRows = history.chats;
    assert.ok(Array.isArray(historyRows), 'History must return the production chats contract');
    const historyIds = historyRows.map(row => row.sessionId || row.id).filter(Boolean);
    for (const other of report.accounts) {
      for (const id of other.conversationIds || []) {
        assert.equal(historyIds.includes(id), other.user.id === account.user.id,
          account.key + ' conversation history must isolate ' + other.key);
      }
    }
    const observations = [];
    for (const other of report.accounts.filter(row => row.task?.id)) {
      const own = other.user.id === account.user.id;
      assert.equal(current.includes(other.task.id), own, account.key + ' API list must isolate ' + other.key);
      assert.equal(visible.includes(other.task.id), own, account.key + ' renderer cache must isolate ' + other.key);
      const observed = await js(`(async()=>{try{const value=await SoduWorkAPI.getTask(${JSON.stringify(other.task.id)});return{status:200,id:value?.id,readOnly:value?.readOnly}}catch(error){return{status:error.status||0,message:error.message}}})()`);
      assert.equal(observed.status, own ? 200 : 404, account.key + ' detail access must isolate ' + other.key);
      if (own) assert.equal(observed.readOnly, false, 'Returning to the creator must restore owner actions');
      observations.push({ owner: other.key, own, ...observed });
    }
    report.sameDeviceIsolation ||= [];
    report.sameDeviceIsolation.push({ account: account.key, deviceId: identity.deviceId,
      conversationIds: historyIds, observations });
  }
  (async () => {
    report.sourcesAtStart = sourceSnapshot(); flush();
    const ready = await startHub(); connection = { hub: 'http://127.0.0.1:' + ready.port, key: ready.key };
    report.hub = connection.hub; process.env.SODUWORK_TEST_HUB_URL = connection.hub;
    require('./fixtures/full-client-isolation.cjs').install({ app, electron, root, workspace, client, report });
    require('./fixtures/full-client-inprocess-runtime.cjs').install({ client, report });
    const originalFetch = global.fetch;
    global.fetch = async (input, options) => {
      const url = String(input?.url || input); if (!isLocal(url)) { report.blockedNetwork.push(url); throw Error('Nonloopback network blocked by isolated QA'); }
      const response = await originalFetch(input, options);
      if (url.endsWith('/email-challenges') && response.ok) { const body = await response.clone().json(); lastChallenge = body.challengeId || lastChallenge; }
      return response;
    };
    isolateSideEffects();
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, cb) => {
      const blocked = !isLocal(request.url); if (blocked) report.blockedNetwork.push(request.url); cb({ cancel: blocked });
    });
    session.defaultSession.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, request => {
      report.requests.push({ method: request.method, path: new URL(request.url).pathname, status: request.statusCode });
    });
    require('../main.js');
    ipcMain.removeHandler('work-root-default'); ipcMain.handle('work-root-default', () => workspace);
    await until(() => { win = BrowserWindow.getAllWindows().find(w => /\/desk\.html(?:[?#]|$)/.test(w.webContents.getURL())); return win; }, 60000);
    win.setContentSize(1440, 1000); win.webContents.debugger.attach('1.3');
    for (const name of ['did-start-navigation', 'dom-ready', 'did-finish-load', 'render-process-gone', 'unresponsive']) {
      win.webContents.on(name, () => {
        (report.navigation ||= []).push({ name, at: new Date().toISOString(), url: win.webContents.getURL(), loading: win.webContents.isLoading(), destroyed: win.isDestroyed() }); flush();
      });
    }
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Network.enable');
    win.webContents.debugger.on('message', (_e, method, params) => {
      if (method === 'Page.javascriptDialogOpening') {
        const entry = { type: params.type, message: params.message, url: params.url, at: new Date().toISOString() };
        (report.nativeDialogs ||= []).push(entry); flush();
        process.stdout.write('NATIVE DIALOG ' + JSON.stringify(entry) + '\n');
        void win.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true })
          .catch(error => { entry.controlError = error.message; flush(); });
      }
      if (method === 'Network.loadingFailed') report.errors.push({ transport: 'chromium', error: params.errorText, type: params.type, canceled: params.canceled });
    });
    for (let i = 0; i < limit; i++) {
      const key = String.fromCharCode(65 + i), account = { key, email: 'qa-1023-' + key.toLowerCase() + '@example.test',
        password: 'Fixture-account-1023-' + key, name: '验收-1023-' + key, title: '验收需求-1023-' + key,
        note: '私有隔离验收材料-' + key + '：此需求只属于本账号。请仅回复处理完成，不操作文件。' };
      report.accounts.push(account);
      await attempt(key, 'register-active-default-org', () => register(account));
      if (account.user) {
        await attempt(key, 'same-device-private-task-isolation', () => isolationCheck(account));
        await attempt(key, 'save-profile-name', () => profileName(account));
        await attempt(key, 'conversation-with-local-model', () => conversation(account));
        await attempt(key, 'create-requirement-through-ui', () => requirement(account));
        if (account.task && key === 'A') await attempt(key, 'immediate-requirement-assignment-and-execution', () => arrange(account));
        const loggedOut = await attempt(key, 'logout', logout);
        const loggedIn = loggedOut && await attempt(key, key === 'E' ? 'email-code-relogin' : 'password-relogin', () => relogin(account));
        if (loggedIn && account.task) await attempt(key, 'reopen-saved-requirement', () => reopen(account));
      }
      // Recovery after an already-recorded UI failure uses the unchanged auth
      // API so one account cannot contaminate or prevent the next registration.
      if (await js('Boolean(ClientAuth.snapshot().user)').catch(() => false)) {
        await attempt(key, 'final-logout', logout);
        if (await js('Boolean(ClientAuth.snapshot().user)').catch(() => false)) {
          report.cases.push({ account: key, name: 'API logout recovery after UI failure', ok: false });
          await js('SoduWorkAPI.clientLogout().then(()=>{})').catch(() => {}); win.reload();
        }
      }
      await loginGate();
    }
    // Once all five private tasks exist, exercise every directed account pair
    // through the unchanged login UI, API, renderer snapshot and detail ACL.
    for (const account of report.accounts.filter(row => row.user && row.task)) {
      const loggedIn = await attempt(account.key, 'matrix-password-relogin', () => relogin(account, { emailCode: false }));
      if (loggedIn) {
        await attempt(account.key, 'all-accounts-private-task-matrix', () => isolationCheck(account));
        await attempt(account.key, 'matrix-reopen-own-requirement', () => reopen(account));
        await attempt(account.key, 'matrix-logout', logout);
      }
    }
    report.backendEvidence = await backendSummary();
    // The flow must reach the styled AccountUI confirmation before each logout:
    // `logout()` clicks its [data-ac-confirm] button, then this request is the
    // observable server-side completion. Native `window.confirm` is not used.
    await delay(500);
    report.logoutConfirmations = (report.backendEvidence.requests || []).filter(row => row.method === 'POST' && /\/client-auth\/logout$/.test(row.path));
    assert.equal(report.logoutConfirmations.length, limit * 3, 'Each registration, relogin and matrix cycle must use the real logout confirmation call');
    const owners = report.backendEvidence.tasks.map(task => [task.createdBy, task.ownerUserId]);
    assert.equal(report.backendEvidence.users.filter(user => user.email?.endsWith('@example.test')).length, limit);
    assert.equal(report.backendEvidence.tasks.length, limit);
    assert.ok(owners.every(([creator, owner]) => creator === owner), 'Execution ownership must remain with each registered creator');
    assert.equal(new Set(report.backendEvidence.tasks.map(task => task.ownerClientId)).size, 1, 'All accounts must exercise one physical device');
    report.ok = report.accounts.length === limit && report.cases.every(row => row.ok) && !(report.nativeDialogs || []).length;
  })().catch(async error => { report.error = String(error.stack || error); if (win) await shot('fatal-error').catch(() => {}); }).finally(async () => {
    if (exiting) return; exiting = true;
    report.fixtureErrors = serverErrors.slice(-5000); report.endedAt = new Date().toISOString();
    report.sourcesAtEnd = sourceSnapshot(); report.sourceChangesDuringRun = report.sourcesAtStart ? manifest.changed(report.sourcesAtStart, report.sourcesAtEnd) : [];
    if (report.sourceChangesDuringRun.length) { report.ok = false; report.invalid = 'Source files changed during this run'; }
    for (const account of report.accounts) delete account.password;
    flush();
    try { await Promise.race([require('../main/agent-runtime/process-session').dispose(), delay(10000).then(() => { throw Error('Runtime cleanup timeout'); })]); } catch (error) { report.shutdownError = String(error.message || error); }
    try { require('../main/runner-runtime').pauseForHubChange(); } catch {}
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
    if (connection && server && server.exitCode === null) {
      try {
        const response = await fetch(connection.hub + '/__fixture__/shutdown', {
          method: 'POST', headers: { 'X-Fixture-Key': connection.key }, signal: AbortSignal.timeout(5000),
        });
        report.shutdownAccepted = response.ok;
        await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(10000)]);
      } catch (error) { report.shutdownError = String(error.message || error); }
    }
    if (server && server.exitCode === null) {
      report.shutdownFallback = true; server.kill();
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
    }
    report.hubLauncherExitCode = server?.exitCode; flush();
    process.stdout.write(JSON.stringify({ ok: report.ok, cases: report.cases.length, root, report: path.join(out, 'report.json') }) + '\n');
    app.exit(report.ok ? 0 : 1);
  });
}
