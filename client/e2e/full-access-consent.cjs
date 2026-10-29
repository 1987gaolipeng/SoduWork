'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 120000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain, nativeTheme, protocol, net } = electron;
app.on('window-all-closed', () => {});
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-full-consent-'));
app.setPath('userData', path.join(profile, 'profile'));
const out = path.resolve(__dirname, '../../outputs/full-access-consent'); fs.mkdirSync(out, { recursive: true });
const report = { ok: false, cases: [], screenshots: [], boundary: 'Hidden native windows with production preload, top-frame URL validation and consent IPC; theme-only shell fixture at the production desktop URL, isolated profile and stubbed model/runtime opening.' }, windows = new Set();
const ownerPage = path.resolve(__dirname, '../desk.html'), ownerURL = pathToFileURL(ownerPage).href;
let themeSource;
const locale = require('../main/native-locale.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settled = task => Promise.race([task, delay(7000).then(() => { throw Error('Dialog did not settle after user input'); })]);
const until = async fn => { for (let n = 0; n < 400; n++) { const value = await fn(); if (value) return value; await delay(15); } throw Error('Timed out waiting for confirmation'); };
async function click(win, selector) {
  const point = await win.webContents.executeJavaScript(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await delay(35);
}
async function press(win, keyCode) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  if (!win.isDestroyed() && keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  if (!win.isDestroyed()) win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await delay(35);
}
async function parentWindow() {
  const parent = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: {
    preload: path.resolve(__dirname, '../preload.js'),
    contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  windows.add(parent);
  await parent.loadFile(ownerPage);
  const store = fs.readFileSync(path.resolve(__dirname, '../core/store.js'), 'utf8');
  const start = store.indexOf('const applyTheme=()=>{');
  const apply = store.slice(start, store.indexOf('\n};', start) + 3);
  await parent.webContents.executeJavaScript(`window.cfg={theme:'vivid',character:'box'};${apply}
    window.setFixtureTheme=(name,tokens={})=>{window.cfg.theme=name;document.documentElement.removeAttribute('style');
      for(const [key,value]of Object.entries(tokens))document.documentElement.style.setProperty(key,value);applyTheme();};setFixtureTheme('vivid');`);
  await until(() => themeSource.snapshot(parent).theme === 'vivid' && themeSource.snapshot(parent).tokens['--accent']);
  assert.equal(parent.isVisible(), false);
  return parent;
}
async function shown(parent) {
  const dialog = await until(() => BrowserWindow.getAllWindows().find(win => win.getParentWindow() === parent));
  windows.add(dialog);
  await until(() => !dialog.isDestroyed() && dialog.webContents.executeJavaScript("document.body.dataset.ready === 'true'"));
  assert.equal(dialog.isModal(), true);
  assert.equal(dialog.isVisible(), false);
  return dialog;
}
async function shot(dialog, name, width, height) {
  if (width && height) dialog.setContentSize(width, height);
  await delay(90);
  const metrics = await dialog.webContents.executeJavaScript(`(()=>{
    const all=[...document.querySelectorAll('.consent-header,.scope-summary,.permission-list,.acknowledgement,.consent-actions')].filter(e=>e.getClientRects().length&&e.getBoundingClientRect().height>0);
    return {width:innerWidth,height:innerHeight,lang:document.documentElement.lang,
      overflow:document.documentElement.scrollWidth>innerWidth,
      footer:document.querySelector('.consent-actions').getBoundingClientRect().bottom,
      fonts:all.map(e=>getComputedStyle(e).fontSize),
      texts:[...document.querySelectorAll('[data-text]')].map(e=>e.textContent),
      bodyColor:getComputedStyle(document.querySelector('.consent')).backgroundColor,
      title:document.querySelector('h1').textContent,
      theme:document.documentElement.dataset.theme,scheme:document.documentElement.dataset.colorScheme,
      accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      layout:all.map(e=>({width:e.clientWidth,scroll:e.scrollWidth})),
      dark:matchMedia('(prefers-color-scheme:dark)').matches};})()`);
  assert.equal(metrics.overflow, false); assert.ok(metrics.footer <= metrics.height);
  for (const rect of metrics.layout) assert.ok(rect.scroll <= rect.width, 'horizontal overflow: '+JSON.stringify(metrics));
  assert.ok(metrics.texts.every(Boolean), 'all labels rendered');
  fs.writeFileSync(path.join(out, name + '.png'), (await dialog.webContents.capturePage()).toPNG());
  report.screenshots.push({ file: name + '.png', ...metrics });
}

// Exercise the production new-conversation entry without contacting a model,
// capability provider or the user's persisted conversations.
function opening(confirmFullAccess) {
  const source = fs.readFileSync(path.resolve(__dirname, '../main/pi-session/ipc.js'), 'utf8');
  const handler = source.slice(source.indexOf('  async function openConversation('), source.indexOf("  ipcMain.handle('pi-session-open',"));
  const calls = [], cwd = profile;
  const context = vm.createContext({
    _cloudHandoff:{observe(){}}, skillTurn:require('../main/pi-session/skill-turn'), sendIdentityOf:null,
    app, path, identityOf: async () => ({ hub: 'fixture', clientId: 'fixture' }),
    memories: { context: async () => ({}), attach: async () => {} }, updateWorkloads: { guard: () => ({ ok: true }) },
    session: { open: async value => { calls.push(value); return { ok: true, session: {sessionId:'consent-fixture',cwd,close:async()=>{}} }; } },
    capabilities: { resolve: async () => ({ catalog: {}, selectedSkills: [], capabilityIds: [] }) },
    capabilityGrantsOf: null, _skillDirs: () => [], _newSessionCwd: () => cwd, _defaultCwd:()=>cwd, workDir: () => cwd,
    attachments: { stage: async () => ({ files: [], warnings: [] }) },
    sessionSpec: require('../main/conversation/session-spec'), _conf: () => ({}), BrowserWindow, confirmFullAccess,
    _entryContextPrompts: () => [], _awaitBounded: value => value, OPEN_TIMEOUT_MS: 45000,
    _bindUsage() {}, _attach() {}, _detach() {}, _wire() {}, _openReply: () => ({ ok: true }),
    require: name => {
      return require(path.resolve(__dirname, '../main/pi-session', name));
    },
  });
  vm.runInContext(handler, context);
  return { calls, open: parent => context.openConversation({ sender: parent.webContents,
    senderFrame: parent.webContents.mainFrame }, { accessMode: 'full' }) };
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light';
  // Keep the real trusted URL and renderer identity checks. Only the outer
  // shell is substituted, avoiding business/auth startup and model requests.
  const html = fs.readFileSync(path.resolve(__dirname, 'fixtures/consent-theme.html'), 'utf8')
    .replace('../../theme/variables.css', 'theme/variables.css');
  protocol.handle('file', request => request.url.split('?')[0] === ownerURL
    ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
  function HiddenConsent(options) {
    const win = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
    win.show = () => {}; win.focus = () => {};
    return win;
  }
  themeSource = require('../main/native-theme.cjs').create({ ...electron, allowedFiles: [ownerPage] });
  const confirm = require('../main/access-control/full-access-consent').create({ ...electron, BrowserWindow: HiddenConsent, themeSource });
  let parent = await parentWindow();
  const newChat = opening(confirm);
  let task = newChat.open(parent), dialog = await shown(parent);
  assert.equal(await dialog.webContents.executeJavaScript('document.activeElement.id'), 'consentCancel');
  assert.equal(await dialog.webContents.executeJavaScript('document.querySelector("#consentAllow").disabled'), true);
  await shot(dialog, 'full-access-zh', 448, 428);
  await press(dialog, 'Enter'); assert.equal((await settled(task)).cancelled, true); assert.equal(newChat.calls.length, 0);
  report.cases.push('actual new-conversation entry: unchecked confirmation disabled; initial Enter cancels without opening');

  task = newChat.open(parent); dialog = await shown(parent);
  await click(dialog, '#consentAllow'); assert.equal(newChat.calls.length, 0);
  const payload = await dialog.webContents.executeJavaScript('fullAccessConsent.content()');
  const outsider = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../main/access-control/full-access-consent-preload.cjs'), sandbox: true, contextIsolation: true } });
  windows.add(outsider); await outsider.loadURL('data:text/html,<title>Untrusted preview fixture</title>');
  assert.equal(await outsider.webContents.executeJavaScript('fullAccessConsent.content()'), null);
  const forged = await outsider.webContents.executeJavaScript('fullAccessConsent.answer(' + JSON.stringify({ requestId: payload.requestId, decision: 'allow', acknowledged: true }) + ')');
  assert.equal(forged.ok, false); assert.equal(newChat.calls.length, 0);
  outsider.destroy();
  await click(dialog, '#consentAcknowledged');
  assert.equal(await dialog.webContents.executeJavaScript('document.querySelector("#consentAllow").disabled'), false);
  await shot(dialog, 'full-access-zh-checked');
  await click(dialog, '#consentAllow'); const opened = await settled(task); assert.equal(opened.ok, true, JSON.stringify(opened)); assert.equal(newChat.calls.length, 1);
  assert.equal(newChat.calls[0].accessPolicy.mode, 'full');
  report.cases.push('actual new-conversation entry: foreign IPC rejected; real checkbox and mouse confirmation opens exactly once with full policy');

  const rules = require('../main/access-control/policy');
  let policy = rules.create('standard', profile), writes = 0;
  const handle = { cwd: profile, attachedWindow: parent,
    snapshot: () => ({ accessPolicy: policy, accessControl: { supported: true, canChangeDuringSession: true, modes: [...rules.MODES] } }),
    setAccessPolicy(value) { policy = value; writes++; return { ok: true, effective: 'current-turn' }; } };
  const change = require('../main/access-control/ipc').changeHandler({ session: { get: () => handle }, BrowserWindow, confirmFullAccess: confirm });
  const requestChange = () => change({ sender: parent.webContents, senderFrame: parent.webContents.mainFrame }, 'test-chat', 'full', policy.revision);
  for (const action of ['cancel', 'escape', 'close']) {
    task = requestChange(); dialog = await shown(parent);
    if (action === 'escape') await press(dialog, 'Escape'); else await click(dialog, action === 'close' ? '#consentClose' : '#consentCancel');
    assert.equal((await settled(task)).cancelled, true); assert.equal(writes, 0); assert.equal(policy.mode, 'standard');
  }
  task = requestChange(); dialog = await shown(parent);
  await click(dialog, '#consentAcknowledged'); await click(dialog, '#consentAllow');
  const applied = await settled(task); assert.equal(applied.ok, true); assert.equal(applied.effective, 'current-turn'); assert.equal(policy.mode, 'full'); assert.equal(writes, 1);
  report.cases.push('production current-session IPC: Cancel/Escape/close preserve old policy; trusted modal confirmation applies current-turn policy exactly once');

  locale.setLocale('en-US');
  task = confirm(parent); dialog = await shown(parent);
  await shot(dialog, 'full-access-en', 448, 428);
  assert.equal(await dialog.webContents.executeJavaScript('/[\\u3400-\\u9fff]/.test(document.body.innerText)'), false);
  await click(dialog, '#permissionDetails summary');
  assert.equal(await dialog.webContents.executeJavaScript('document.querySelector("#permissionDetails").open'), true);
  await shot(dialog, 'full-access-en-details', 448, 530);
  await shot(dialog, 'full-access-en-narrow', 320, 460);
  await click(dialog, '#consentAcknowledged');
  await shot(dialog, 'full-access-en-short', 448, 340);
  await click(dialog, '#consentCancel'); assert.equal(await settled(task), false);
  nativeTheme.themeSource = 'dark';
  task = confirm(parent); dialog = await shown(parent);
  await shot(dialog, 'full-access-os-dark-app-light', 448, 428);
  assert.equal(report.screenshots.at(-1).dark, true);
  assert.equal(report.screenshots.at(-1).scheme, 'light');
  assert.equal(report.screenshots.at(-1).bodyColor, 'rgb(255, 255, 255)');
  await dialog.webContents.debugger.attach('1.3');
  await dialog.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await dialog.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion:reduce)').matches"), true);
  await click(dialog, '#consentCancel'); assert.equal(await settled(task), false);
  report.cases.push('448px Chinese/English, progressive disclosure, 320px narrow, 340px short and reduced-motion layouts have readable labels and reachable actions; OS dark does not override light app theme');

  nativeTheme.themeSource = 'light';
  task = confirm(parent); dialog = await shown(parent);
  await click(dialog, '#consentAcknowledged');
  for (const theme of ['azure', 'ruby', 'warm', 'minimal', 'steady']) {
    await parent.webContents.executeJavaScript('setFixtureTheme(' + JSON.stringify(theme) + ')');
    await until(() => dialog.webContents.executeJavaScript('document.documentElement.dataset.theme === ' + JSON.stringify(theme)));
    assert.equal(await dialog.webContents.executeJavaScript('document.querySelector("#consentAcknowledged").checked'), true);
    assert.equal(await dialog.webContents.executeJavaScript('document.querySelector("#consentAllow").disabled'), false);
    const ownerAccent = await parent.webContents.executeJavaScript('getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()');
    await shot(dialog, 'full-access-theme-' + theme, 448, 428);
    assert.equal(report.screenshots.at(-1).accent, ownerAccent);
  }
  const darkTokens = { '--bg-0':'#20242a','--bg-1':'#272c33','--bg-2':'#343b44','--bg-3':'#404955',
    '--ink':'#eff3f8','--ink-2':'#dce3ed','--ink-3':'#aebdcc','--ink-4':'#aebdcc','--line':'rgba(220,230,245,.12)',
    '--line-3':'rgba(220,230,245,.2)','--accent':'#75b4f6','--accent-hover':'#8bc6ff','--accent-soft':'rgba(117,180,246,.12)',
    '--accent-soft-2':'rgba(117,180,246,.2)' };
  await parent.webContents.executeJavaScript('setFixtureTheme("custom-night",' + JSON.stringify(darkTokens) + ')');
  await until(() => dialog.webContents.executeJavaScript('document.documentElement.dataset.colorScheme === "dark"'));
  await shot(dialog, 'full-access-app-dark', 448, 428);
  assert.equal(report.screenshots.at(-1).dark, false, 'OS is light');
  assert.equal(report.screenshots.at(-1).bodyColor, 'rgb(32, 36, 42)');
  const other = await parentWindow(); await other.webContents.executeJavaScript('setFixtureTheme("warm")');
  await until(() => themeSource.snapshot(other).theme === 'warm');
  assert.equal(await dialog.webContents.executeJavaScript('document.documentElement.dataset.theme'), 'custom-night');
  other.destroy();
  await click(dialog, '#consentCancel'); assert.equal(await settled(task), false);
  report.cases.push('actual applyTheme and production preload IPC update an open dialog across five application palettes and custom dark without losing acknowledgement; independent owner changes never leak');

  nativeTheme.themeSource = 'light'; locale.setLocale('zh-CN');
  task = confirm(parent); dialog = await shown(parent);
  const duplicate = confirm(parent); assert.equal(await duplicate, false); assert.equal(await settled(task), false); assert.equal(dialog.isDestroyed(), true);
  task = confirm(parent); dialog = await shown(parent); await parent.loadURL('data:text/html,<title>Owner navigated</title>'); assert.equal(await settled(task), false);
  task = confirm(parent); dialog = await shown(parent); parent.destroy(); assert.equal(await settled(task), false); assert.equal(dialog.isDestroyed(), true);
  parent = await parentWindow(); task = confirm(parent); dialog = await shown(parent); dialog.destroy(); assert.equal(await settled(task), false);
  report.cases.push('real native child closes and denies on duplicate requests, owner navigation/destruction and OS window closure');

  parent.destroy(); parent = await parentWindow();
  const view = new electron.WebContentsView({ webPreferences: { preload:path.resolve(__dirname,'../preload.js'), contextIsolation:true, sandbox:true, backgroundThrottling:false } });
  parent.contentView.addChildView(view); view.setBounds({x:580,y:30,width:410,height:660});
  await view.webContents.loadFile(ownerPage,{query:{panel:'chatbar'}});
  const draftConsent = require('../main/access-control/new-chat-consent').create({BrowserWindow,confirmFullAccess:confirm}); draftConsent.install(ipcMain);
  const embeddedPolicy = require('../main/access-control/policy').create('standard',profile);
  const embeddedHandle = { cwd:profile, attachedWindow:{webContents:view.webContents},
    snapshot:()=>({accessPolicy:embeddedPolicy,accessControl:{supported:true,canChangeDuringSession:true,modes:['standard','full','readonly']}}),
    setAccessPolicy:()=>{throw Error('This positioning check must never approve access');} };
  ipcMain.handle('pi-session-set-access-mode',require('../main/access-control/ipc').changeHandler({
    session:{get:()=>embeddedHandle},BrowserWindow,confirmFullAccess:confirm}));
  const checkEmbeddedPosition = async dialog => {
    const content=parent.getContentBounds(),bounds=view.getBounds(),popup=dialog.getBounds(),zoom=view.webContents.getZoomFactor();
    const icon=await view.webContents.executeJavaScript('(()=>{const r=document.querySelector("#consentAnchor").getBoundingClientRect();return {top:r.top,left:r.left}})()');
    assert.ok(popup.x>=content.x+bounds.x-1 && popup.x+popup.width<=content.x+bounds.x+bounds.width+1,'native confirmation remains inside the right-hand chat view');
    assert.ok(popup.y>=content.y+bounds.y-1 && popup.y+popup.height<=content.y+bounds.y+icon.top*zoom-8,'native confirmation stays above the permission icon');
    (report.embeddedPositions ||= []).push({view:bounds,popup,zoom});
  };
  for (const width of [230,310,430,800]) for (const mode of ['draft','session']) {
    view.setBounds({x:990-width,y:30,width,height:660});
    view.webContents.setZoomFactor(width===430?1.25:1);
    await view.webContents.executeJavaScript('document.body.insertAdjacentHTML("beforeend",\'<button id="consentAnchor" style="position:fixed;left:40px;bottom:20px;width:28px;height:28px">权限</button>\')');
    const request = `(()=>{const r=document.querySelector('#consentAnchor').getBoundingClientRect(),anchor={left:r.left,top:r.top,width:r.width,height:r.height,screenX:screenX+r.left,screenY:screenY+r.top};return `+
      (mode==='draft' ? `soduWorkAPI.conversationSession.confirmNewChatAccess({draftId:'sidebar-${width}',adapterId:'pi',anchor})` : `soduWorkAPI.conversationSession.setAccessMode('sidebar-session','full',${embeddedPolicy.revision},{anchor})`)+`;})()`;
    task=view.webContents.executeJavaScript(request); dialog=await shown(parent); await delay(80);
    await checkEmbeddedPosition(dialog);
    await click(dialog,'#permissionDetails summary'); await delay(80); await checkEmbeddedPosition(dialog);
    parent.setPosition(140,80); await delay(80); await checkEmbeddedPosition(dialog);
    if((width===230 || width===430) && mode==='session') await shot(dialog,'full-access-sidebar-above-icon-'+width);
    await click(dialog,'#consentCancel'); assert.equal((await settled(task)).cancelled,true);
    await view.webContents.executeJavaScript('document.querySelector("#consentAnchor").remove()');
  }
  view.webContents.close();
  report.cases.push('Production draft and existing-session IPC from a right-side WebContentsView keep native consent within 230/310/430/800px chat widths and above the icon, including 125% zoom, expanded details and parent movement; all requests cancelled without granting access.');
  report.ok = true;
}).catch(error => { report.error = error.stack || String(error); }).finally(async () => {
  for (const win of windows) { try { if (!win.isDestroyed()) win.destroy(); } catch (_) {} }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  app.exit(report.ok ? 0 : 1);
});
