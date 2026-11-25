'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit', timeout: 180000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain, protocol, net } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..'), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-new-consent-'));
const out = path.resolve(process.argv[2] || path.join(client, '../outputs/new-chat-consent')); fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(profile, 'profile')); app.on('window-all-closed', () => {});
const read = file => fs.readFileSync(path.join(client, file), 'utf8');
const ownerPage = path.join(client, 'desk.html'), ownerURL = pathToFileURL(ownerPage).href;
const report = { ok: false, cases: [], screenshots: [], errors: [], boundary: 'Production composer, runtime picker, NativeChat, preload, native consent, first-send journal and openConversation. Trusted desktop URL serves an isolated shell; identity, discovery and runtime execution are local fixtures. Hidden windows, blocked network, no business data or model calls.' };
const calls = [], sends = [], sessions = new Map(); let win, dialogs = 0, failNextOpen = false, failNextSend = false;
const catalog = require('../main/agent-runtime/runtime-catalog');
const identity = require('../tests/helpers/platform-session-fixture.cjs').identity();
const identityOf = async () => identity;
const locale = require('../main/native-locale.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true).catch(error => { throw Error(error.message + '\nRenderer code: ' + code.slice(0, 400)); });
async function until(check, label = '') {
  const end = Date.now() + 8000;
  while (Date.now() < end) { const value = typeof check === 'string' ? await js(check) : await check(); if (value) return value; await delay(25); }
  throw Error('Timed out: ' + (label || check));
}
async function click(selector, target = win) {
  const point = await target.webContents.executeJavaScript(`(()=>{try{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!e.contains(hit)&&![...(e.labels||[])].some(label=>label.contains(hit)))throw Error('Occluded '+${JSON.stringify(selector)}+' by '+hit?.outerHTML);return{x,y}}catch(error){return{error:error.stack}}})()`);
  if (point.error) throw Error(point.error);
  for (const type of ['mouseDown', 'mouseUp']) target.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await delay(50);
}
async function shot(name, target = win) {
  target.webContents.invalidate();
  await delay(160);
  fs.writeFileSync(path.join(out, name + '.png'), (await target.webContents.capturePage()).toPNG());
  report.screenshots.push(name + '.png');
}
async function dialog() {
  const child = await until(() => BrowserWindow.getAllWindows().find(item => item.getParentWindow() === win), 'native dialog');
  await until(() => !child.isDestroyed() && child.webContents.executeJavaScript("document.body.dataset.ready==='true'"), 'dialog presented');
  assert.equal(child.isModal(), true); assert.equal(child.isVisible(), false); return child;
}
async function pick(mode) { await click('#cpPermission'); await click('#cpPermissionPop [data-mode="' + mode + '"]'); }
async function adapter(id) {
  await click('#cpRuntime'); await click('[data-runtime="' + id + '"]');
  await until(`ComposeRuntime.value()===${JSON.stringify(id)}&&ComposeRuntime.accessSupported()`);
}
async function draft(text = 'Isolated consent message') {
  await js('openComposePanel({newSession:true});void 0;');
  await until('ComposeRuntime.accessSupported()');
  await js(`(()=>{const i=document.querySelector('#cpInput');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
function installOpening(confirmFullAccess, newChatAccess) {
  const source = read('main/pi-session/ipc.js');
  const code = source.slice(source.indexOf('  async function openConversation('), source.indexOf("  ipcMain.handle('pi-session-open',"));
  const context = vm.createContext({ app, path, BrowserWindow, confirmFullAccess, newChatAccess,
    // This local-only fixture never transfers its isolated sessions to cloud.
    _cloudHandoff: { observe() {} }, firstTurnTitle: { enroll() {} }, _sessionOwners: null,
    skillTurn: require('../main/pi-session/skill-turn'), sendIdentityOf: null,
    identityOf, updateWorkloads: { guard: () => ({ ok: true }) },
    memories: { context: async () => ({}), attach: async () => {} }, capabilityGrantsOf: null, _skillDirs: () => [],
    workDir: () => profile, _newSessionCwd: () => profile, _conf: () => ({}),
    capabilities: { resolve: async () => ({ catalog: {}, selectedSkills: [], capabilityIds: [] }) },
    attachments: { stage: async () => ({ files: [], warnings: [] }) }, sessionSpec: require('../main/conversation/session-spec'),
    session: { open: async options => {
      calls.push({ adapterId: options.adapterId, accessPolicy: options.accessPolicy, ref: options.ref });
      if (failNextOpen) { failNextOpen = false; return { ok: false, reason: 'Isolated initialization failure' }; }
      const handle = { ...options, sessionId: options.ref, close: async () => { sessions.delete(options.ref); return true; },
        snapshot: () => ({ status: 'idle', messages: [], tools: [], accessPolicy: options.accessPolicy, accessControl: catalog.runtime(options.adapterId).accessControl }) };
      sessions.set(options.ref, handle); return { ok: true, session: handle };
    } },
    _entryContextPrompts: () => [], _awaitBounded: value => value, OPEN_TIMEOUT_MS: 45000,
    _bindUsage() {}, _attach() {}, _detach() {}, _wire() {},
    _openReply: openReply,
    require: name => name.startsWith('node:') ? require(name) : require(path.resolve(client, 'main/pi-session', name)),
  });
  vm.runInContext(code, context);
  ipcMain.handle('pi-session-open', (event, options) => context.openConversation(event, options));
  return context.openConversation;
}
function openReply(handle) {
  return { ok: true, ref: handle.ref, sessionId: handle.sessionId, adapterId: handle.adapterId,
    cwd: profile, mode: 'full', model: { id: 'isolated', label: 'Isolated test model' },
    accessControl: catalog.runtime(handle.adapterId).accessControl, snapshot: handle.snapshot() };
}
async function sendConversation(ref, text, _files, options, _observe, _request, guard) {
  await guard?.();
  const handle = sessions.get(ref);
  assert.ok(handle);
  sends.push({ ref, text, submissionId: options?.submissionId });
  if (failNextSend) { failNextSend = false; return { ok: false, reason: 'Isolated send failure', accepted: false }; }
  guard?.beforeDispatch();
  return { ok: true, snapshot: handle.snapshot() };
}
app.whenReady().then(async () => {
  const css = ['theme/variables.css', 'components/panels/panels-base.css', 'components/panels/agent-brand.css',
    'components/panels/panels-chat.css', 'components/panels/work-composer.css', 'components/panels/access-controls.css',
    'components/panels/work-intent.css', 'components/panels/conversation-attachments.css'];
  const html = '<!doctype html><html><head><meta charset="utf-8">' + css.map(file => '<link rel="stylesheet" href="' + file + '">').join('') +
    '<style>*{box-sizing:border-box}body{margin:0;font-family:var(--font-ui)}#composePanel{position:fixed;inset:0;display:block}.cp-body{display:flex;align-items:center;justify-content:center;min-height:100vh}.cp-task{width:min(900px,calc(100vw - 40px))}.cp-mid{padding:0!important}.cp-hero,.cp-hero-note{display:none}#composePanel[data-stage=compose] .cp-chat{display:none}#composePanel[data-stage=chat] .cp-mid{display:none}.cp-chat{width:100%;height:100vh}</style></head><body></body></html>';
  protocol.handle('file', request => request.url.split('?')[0] === ownerURL
    ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
  function HiddenConsent(options) {
    dialogs++;
    const child = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
    child.show = () => {}; child.focus = () => {}; return child;
  }
  const themeSource = require('../main/native-theme.cjs').create(electron);
  const confirmFullAccess = require('../main/access-control/full-access-consent').create({ ...electron, BrowserWindow: HiddenConsent, themeSource });
  const newChatAccess = require('../main/access-control/new-chat-consent').create({ BrowserWindow, confirmFullAccess });
  require('../main/conversation/requirement-context').cachedIdentity = () => identity;
  newChatAccess.install(ipcMain);
  const openConversation = installOpening(confirmFullAccess, newChatAccess);
  require('../main/conversation/first-send-ipc.cjs').install({ app, ipcMain, BrowserWindow, session: sessions,
    identityOf, openConversation, sendConversation, detach() {}, attach: (_event, id) => openReply(sessions.get(id)) });
  require('../main/access-control/preferences').install({ app, ipcMain, BrowserWindow, confirmFullAccess });
  ipcMain.on('client-locale', (_event, value) => locale.setLocale(value));
  ipcMain.handle('pi-session-probe', (_event, id) => ({ ok: true, accessControl: catalog.runtime(id || 'pi').accessControl }));
  const runtimes = catalog.runtimes().filter(item => item.accessControl.supported);
  ipcMain.handle('pi-session-runtimes', () => ({ ok: true, runtimes, availableRuntimes: runtimes, missing: [] }));
  ipcMain.handle('pi-session-snapshot', (_event, ref) => ({ ok: true, snapshot: sessions.get(ref).snapshot() }));
  ipcMain.handle('pi-session-send', (_event, ...args) => sendConversation(...args));
  for (const [channel, value] of Object.entries({ 'pi-session-workdir': { ok: true, dir: profile }, 'conversation-capabilities': { ok: true, items: [] },
    'pi-session-mode': { ok: true, mode: 'full' }, 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, items: [] },
    'pi-session-release': { ok: true }, 'recent-workspace-get': { ok: true, dir: '' },
    'pi-session-runtime-models': { ok: true, models: [{ id: 'isolated', label: 'Isolated test model' }] },
    'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true }, 'work-preview-reset-embedded': { ok: true } })) ipcMain.handle(channel, () => value);
  win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: {
    preload: path.join(client, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  await win.loadFile(ownerPage);
  await js("window.errors=[];window.notices=[];window.petSay=x=>notices.push(x);window.SoduWorkAPI={online:true,taskStorageKey:()=>'isolated-consent',myModels:async()=>({usable:[{name:'isolated',label:'Isolated test model'}],defaultModel:'isolated'}),listTeammates:async()=>[],pluginCatalog:async()=>({items:[]})};addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));void 0;");
  for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
  for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/settings/access-preferences.js']) await js(read(file));
  const loaded = new Set();
  const load = async file => { if (loaded.has(file)) return; loaded.add(file); await js(read(file) + '\nvoid 0;'); };
  for (const file of ['agent-brand.js', 'work-composer.js', 'compose-candidate-navigation.js', 'chat-plugin-mention-model.js',
    'chat-plugin-mention.js', 'panels-compose-runtime.js', 'panels-compose-capabilities.js',
    'panels-compose-work-actions.js', 'compose-surface.js', 'panels-compose.js']) await load('components/panels/' + file);
  // Reuse the established production NativeChat dependency order, not its fake shell.
  for (const match of read('e2e/fixtures/workbench-annotations.html').matchAll(/<script src="\.\.\/\.\.\/([^"]+)"/g)) await load(match[1]);
  await js('SoduWorkI18n.setLocale("zh-CN");void 0;');
  await draft('保留这段未发送的内容'); await pick('readonly'); await pick('full');
  let child = await dialog(); assert.equal(calls.length, 0); assert.equal(sends.length, 0);
  assert.equal(await child.webContents.executeJavaScript('document.querySelector("#consentAllow").disabled'), true);
  await shot('select-full-zh', child); await click('#consentCancel', child);
  await until('document.querySelector("#cpPermissionName").textContent==="只读"');
  assert.equal(await js('document.querySelector("#cpInput").value'), '保留这段未发送的内容');
  assert.equal(calls.length, 0); report.cases.push('Selecting full opens the actual native dialog immediately; cancellation preserves readonly and the unsent draft without creating a session.');
  for (const [index, id] of ['pi', 'opencode', 'qwen', 'codex-harness'].entries()) {
    report.stage = 'prepare ' + id;
    const lang = index % 2 ? 'en-US' : 'zh-CN';
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(lang)});document.documentElement.dataset.theme=${JSON.stringify(index % 2 ? 'ruby' : 'azure')};soduWorkAPI.reportTheme({theme:document.documentElement.dataset.theme,tokens:{'--accent':getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()}});void 0;`);
    await draft('Consent fixture ' + id); await adapter(id);
    const before = calls.length, beforeSends = sends.length, beforeDialogs = dialogs;
    report.stage = 'select ' + id; await pick('full'); child = await dialog(); assert.equal(calls.length, before);
    assert.equal(await child.webContents.executeJavaScript('document.documentElement.lang'), lang);
    if (lang === 'en-US') assert.equal(await child.webContents.executeJavaScript('/[\u3400-\u9fff]/.test(document.body.innerText)'), false);
    if (index === 1) { child.setContentSize(320, 460); await shot('select-full-en-narrow', child); }
    report.stage = 'confirm ' + id; await click('#consentAcknowledged', child); await click('#consentAllow', child);
    await until(`document.querySelector('#cpPermissionName').textContent===${JSON.stringify(lang === 'zh-CN' ? '完全访问' : 'Full access')}`);
    assert.equal(calls.length, before); await shot('confirmed-' + id);
    await click('#cpGo'); await until(() => sends.length === beforeSends + 1, 'first send ' + id);
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).adapterId, id);
    assert.equal(calls.at(-1).accessPolicy.mode, 'full'); assert.equal(dialogs, beforeDialogs + 1);
    report.cases.push(id + ': real checkbox/mouse consent before send; full policy reaches runtime open once; first message sends without another native window.');
  }
  await js('SoduWorkI18n.setLocale("zh-CN");void 0;'); await draft('Switch adapter after consent'); await adapter('pi');
  await pick('full'); child = await dialog(); await click('#consentAcknowledged', child); await click('#consentAllow', child);
  await until('document.querySelector("#cpPermissionName").textContent==="完全访问"'); const count = dialogs;
  await adapter('qwen'); const sentBefore = sends.length; await click('#cpGo'); await until(() => sends.length === sentBefore + 1);
  assert.equal(dialogs, count); assert.equal(calls.at(-1).adapterId, 'qwen'); assert.equal(calls.at(-1).accessPolicy.mode, 'full');
  await draft('Fresh draft'); assert.equal(await js('document.querySelector("#cpPermissionName").textContent'), '完全访问');
  report.cases.push('Same draft may switch supported adapter after consent; a fresh draft remembers the last explicitly selected access mode.');
  await pick('full'); child = await dialog(); await click('#consentAcknowledged', child); await click('#consentAllow', child);
  await until('document.querySelector("#cpPermissionName").textContent==="完全访问"'); failNextOpen = true;
  const beforeFailure = calls.length, beforeDialog = dialogs; await click('#cpGo'); await until(() => calls.length === beforeFailure + 1);
  await until('document.querySelector(".nbad-copy")?.textContent.includes("Isolated initialization failure") && !NativeChat.isBusy()', 'failed native initialization');
  const failedOpen = await js('soduWorkAPI.piSession.firstSends().then(r=>r.rows.find(row=>row.canRetry && !row.sessionId))');
  assert.ok(failedOpen);
  assert.equal(await js('document.querySelector("#nchatInput").value'), 'Fresh draft');
  await js("document.querySelector('#nchatInput').value='Retry same draft';document.querySelector('#nchatInput').dispatchEvent(new Event('input',{bubbles:true}));void 0;");
  await click('#nchatSend'); await until(() => calls.length === beforeFailure + 2);
  await until(() => sends.at(-1)?.text === 'Retry same draft'); assert.equal(dialogs, beforeDialog);
  const resumed = await js(`soduWorkAPI.piSession.waitFirstSend(${JSON.stringify(failedOpen.intentId)})`);
  assert.equal(resumed.row.status, 'accepted');
  assert.equal(resumed.row.sessionId, sends.at(-1).ref);
  assert.equal(resumed.row.text, 'Retry same draft');
  report.cases.push('Failed native initialization safely retries the retained draft credential in production NativeChat without a second confirmation.');
  await draft('Open then retry sending'); await pick('full'); child = await dialog(); await click('#consentAcknowledged', child); await click('#consentAllow', child);
  await until('document.querySelector("#cpPermissionName").textContent==="完全访问"'); failNextSend = true;
  const beforeOpen = calls.length, beforeSend = sends.length, beforeFinalDialog = dialogs; await click('#cpGo'); await until(() => sends.length === beforeSend + 1);
  const refused = sends.at(-1);
  assert.match(refused.submissionId, /^first-/);
  await until('document.querySelector(".nbad-copy")?.textContent.includes("Isolated send failure") && !NativeChat.isBusy()', 'refused first send');
  assert.equal(await js('NativeChat.sessionInfo().ref'), refused.ref);
  assert.equal(await js('document.querySelector("#nchatInput").value'), refused.text);
  await js("document.querySelector('#nchatInput').value='Retry existing session';document.querySelector('#nchatInput').dispatchEvent(new Event('input',{bubbles:true}));void 0;");
  await click('#nchatSend'); await until(() => sends.length === beforeSend + 2);
  assert.equal(calls.length, beforeOpen + 1); assert.equal(dialogs, beforeFinalDialog);
  assert.equal(sends.at(-1).ref, refused.ref);
  assert.equal(sends.at(-1).text, 'Retry existing session');
  const recorded = await js(`soduWorkAPI.piSession.waitFirstSend(${JSON.stringify(refused.submissionId)})`);
  assert.equal(recorded.row.status, 'accepted');
  assert.equal(recorded.row.attemptId, sends.at(-1).submissionId);
  report.cases.push('If first send fails after open succeeded, retry reuses the existing session and never reuses the consumed grant to open another runtime.');
  report.stage = 'explicitly new draft after a refused open';
  await draft('Two separate conversations'); await pick('readonly');
  failNextOpen = true;
  await click('#cpGo');
  await until('document.querySelector(".nbad-copy")?.textContent.includes("Isolated initialization failure") && !NativeChat.isBusy()', 'independent failed draft');
  const original = await js('soduWorkAPI.piSession.firstSends().then(r=>r.rows.find(row=>row.canRetry && !row.sessionId))');
  assert.equal(original.text, 'Two separate conversations');
  const beforeIndependent = sends.length;
  await draft('Two separate conversations'); await click('#cpGo');
  await until(() => sends.length === beforeIndependent + 1, 'separate successful draft');
  const independent = sends.at(-1).submissionId;
  assert.notEqual(independent, original.intentId);
  assert.equal((await js(`soduWorkAPI.piSession.waitFirstSend(${JSON.stringify(independent)})`)).row.status, 'accepted');
  assert.equal((await js(`soduWorkAPI.piSession.waitFirstSend(${JSON.stringify(original.intentId)})`)).row.canRetry, true);
  report.cases.push('A new composer with identical text starts an independent conversation and preserves the old failed request for recovery.');
  report.stage = 'sidebar first-send recovery';
  await draft('Keep this independent draft');
  for (const file of ['workspace-chat-history', 'workspace-first-sends', 'workspace-chat-list', 'workspace-shell'])
    await load('components/workspace/' + file + '.js');
  await win.webContents.insertCSS(read('components/workspace/workspace-navigation.css'));
  await js(`document.documentElement.dataset.deskPanel='workspace';
    window.WorkspaceHost={open(view, payload) { const opened=openComposePanel(payload);
    WorkspaceShell.setActive(view); return opened; }};
    WorkspaceShell.setActive('create'); WorkspaceShell.refreshConversationHistory(); void 0;`);
  const recordButton = '.ws-chat[data-first-send="' + original.intentId + '"]';
  await until(`Boolean(document.querySelector(${JSON.stringify(recordButton)}))`, 'visible sidebar recovery row');
  const beforeInspect = { opens: calls.length, sends: sends.length, dialogs };
  await click(recordButton);
  await until('document.querySelector("#cpChat .nmsg.user .nbubble")?.textContent==="Two separate conversations"', 'original message in conversation');
  assert.match(await js('document.querySelector("#cpChat [role=status]").textContent'), /Isolated initialization failure/);
  assert.equal(await js('Boolean(document.querySelector("dialog[open]"))'), false);
  assert.equal(await js(`document.querySelector(${JSON.stringify(recordButton)}).getAttribute('aria-current')`), 'page');
  await shot('sidebar-recovery-inline');
  await js('WorkspaceHost.open("create",{newSession:true});void 0;');
  assert.equal(await js('document.querySelector("#cpInput").value'), 'Keep this independent draft');
  assert.equal(await js('Boolean(document.querySelector("[data-first-send-record]"))'), false);
  assert.deepEqual({ opens: calls.length, sends: sends.length, dialogs }, beforeInspect);
  report.cases.push('Mouse selection of a failed sidebar send shows its original message and reason inside the conversation. Returning to a new chat restores the independent draft. No modal, runtime allocation or resend occurred.');
  assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []);
  report.runtimeOpens = calls; report.nativeDialogs = dialogs; report.sentMessages = sends.length; report.ok = true;
}).catch(async error => { report.error = error.stack || String(error); try { if (win) { report.rendererErrors = await js('errors'); await shot('failure'); } } catch {} }).finally(() => {
  for (const window of BrowserWindow.getAllWindows()) { try { window.destroy(); } catch {} }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, error: report.error, errors: report.errors, report: path.join(out, 'report.json') }));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  app.exit(report.ok ? 0 : 1);
});
