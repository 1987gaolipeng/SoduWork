'use strict';
// Real BrowserWindow destruction/recreation, production preload, complete desk
// graph and main.js window routing. Auth/Hub/Agent responses are isolated fixtures.
const fs = require('node:fs'), path = require('node:path'), electron = require('electron');
const output = path.resolve(__dirname, '../../outputs/workspace-reopen-20261014');
fs.mkdirSync(output, { recursive: true });
if (typeof electron === 'string') {
  const base = 'D:/SoduWorkTests'; fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'workspace-reopen-'));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  async function run(phase) {
    return new Promise((resolve, reject) => {
      const child = require('node:child_process').spawn(electron,
        [__filename, '--phase=' + phase, '--profile=' + path.join(root, 'profile')],
        { env, windowsHide: true, stdio: 'inherit' });
      const timer = setTimeout(() => { child.kill(); reject(Error('Electron phase timed out: ' + phase)); }, 90000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Electron failed: ' + phase)); });
    });
  }
  (async () => {
    if (process.argv.includes('--font-only')) { await run('font'); return; }
    await run('reopen'); await run('cold');
    const reports = ['reopen', 'cold'].map(phase => JSON.parse(fs.readFileSync(path.join(output, phase + '.json'), 'utf8')));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, profile: root, reports }, null, 2));
    console.log(JSON.stringify({ ok: true, checks: reports.flatMap(row => row.checks) }, null, 2));
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, ipcMain, net, session } = electron;
  const assert = require('node:assert/strict'), vm = require('node:vm'), { fileURLToPath } = require('node:url');
  const { limitSnapshot } = require('../main/pi-session/snapshot-window');
  const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8);
  const profile = process.argv.find(arg => arg.startsWith('--profile='))?.slice(10);
  if (!profile || !path.resolve(profile).startsWith(path.resolve('D:/SoduWorkTests/workspace-reopen-'))) throw Error('Isolated profile required');
  fs.mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  const report = { ok: false, scope: 'Production window route/preload/renderer; synthetic auth, Hub and Agent; no external model or user data', checks: [], timings: [] };
  const client = path.resolve(__dirname, '..'), windows = new Map();
  let owner = 'fixture-hub|account-a', sends = 0, opens = 0;
  const snapshotRequests = [];
  const uiWindow = require('../main/pi-session/ui-window').create(), handles = new Map();
  const state = require('../main/workspace-state.cjs').create({ ownerOf: () => owner });
  state.install({ ipcMain, BrowserWindow, getWorkspace: () => windows.get('workspace') });
  const projectTask = { id: 'project-task', projectId: 'fixture-project', repoId: 'fixture-repo',
    title: 'Project execution fixture', status: 'doing', canViewExecution: true,
    workRouting: { conversationTurn: { conversationId: 'project-chat' } } };
  const snapshots = new Map(['local-chat', 'cloud-chat', 'project-chat'].map(id => [id, {
    status: id === 'cloud-chat' ? 'idle' : 'streaming', adapterId: 'pi', tools: [],
    messages: Array.from({ length: 220 }, (_, i) => i % 2 === 0
      ? { role: 'user', text: id + ' user message ' + i, sentAt: 1000 + i }
      : { role: 'assistant', blocks: [{ kind: 'text', text: id + ' assistant message ' + i,
        done: id === 'cloud-chat' || i < 219 }], done: id === 'cloud-chat' || i < 219 }),
    ...(id === 'cloud-chat' ? { cloudHandoff: { phase: 'committed', taskId: 'cloud-task' } } : {}),
  }]));
  const handle = (name, fn) => ipcMain.handle(name, fn);
  ipcMain.on('client-distribution-info', event => { event.returnValue = { hubOrigin: 'http://127.0.0.1:19999' }; });
  handle('hub-connection-info', () => ({ hub: 'http://127.0.0.1:19999', internalTest: true, editable: false }));
  handle('device-auth-status', () => ({ ready: true, sessionReady: true, secure: true }));
  handle('app-info', () => ({ version: 'fixture', website: '', releaseHistory: [] }));
  handle('pi-session-open-application', () => ({ ok: true, handled: false }));
  handle('pi-session-open', (event, input) => {
    assert.ok(input.chatId, 'restoration must name an existing chat, never create execution'); opens++;
    const snapshot = snapshots.get(input.chatId);
    if (!snapshot) return { ok: false, notFound: true, reason: 'Fixture conversation deleted' };
    const runtime = handles.get(input.chatId) || { uiSnapshot: options => limitSnapshot(snapshots.get(input.chatId), options) };
    const window = BrowserWindow.fromWebContents(event.sender);
    if (runtime.attachedWindow !== window) uiWindow.reset(runtime);
    runtime.attachedWindow = window; runtime.detached = false; handles.set(input.chatId, runtime);
    window.once('closed', () => { runtime.detached = true; uiWindow.reset(runtime); });
    return { ok: true, ref: input.chatId, sessionId: input.chatId, title: input.chatId,
      ...(input.chatId === 'project-chat' ? { taskId: projectTask.id, taskTitle: projectTask.title } : {}),
      adapterId: 'pi', cwd: profile, model: null, snapshot: limitSnapshot(snapshot), capabilities: [] };
  });
  handle('pi-session-snapshot', (event, ref, options) => {
    snapshotRequests.push({ ref, options });
    const runtime = handles.get(ref);
    uiWindow.request(runtime, BrowserWindow.fromWebContents(event.sender), options);
    return { ok: true, snapshot: uiWindow.snapshot(runtime) };
  });
  handle('pi-session-send', () => { sends++; throw Error('Restoration must not send'); });
  handle('pi-session-history', require('./fixtures/history-ipc.cjs').create(() => ({ ok: true,
    items: [...snapshots.keys()].map(id => ({ id, title: id, state: 'running', adapterId: 'pi' })) })));
  handle('pi-session-work-cards', () => ({ ok: true, cards: [], workOnly: false }));
  for (const channel of ['pi-session-history-archived', 'pi-session-outputs', 'session-memory-options',
    'pi-session-probe', 'pi-session-runtimes', 'conversation-capabilities', 'pi-session-release',
    'client-update-status', 'file-type-icons', 'workspace-titlebar-status', 'window-titlebar-info',
    'work-preview-occlusion', 'access-preferences-get', 'file-open-list', 'platform-connection-status',
    'personal-plugin-list', 'personal-plugin-debug', 'pi-session-mode', 'work-preview-destroy', 'recent-workspace-get',
    'work-preview-reset-embedded', 'work-preview-app-data-changed', 'pi-session-conversation-runtimes',
    'window-shortcuts-state', 'release-notes-release', 'cloud-computer-status']) {
    handle(channel, () => ({ ok: true, items: [], files: [], runtimes: [], capabilities: [] }));
  }
  handle('work-root-default', () => profile);
  handle('pi-session-workdir', () => ({ dir: profile, name: 'Fixture workspace' }));
  let win, route, holdBoot = false;
  const js = code => win.webContents.executeJavaScript(code, true).catch(error => {
    throw new Error(code.slice(0, 170) + ': ' + error.message);
  });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code, label = code) {
    for (let i = 0; i < 240; i++) { if (await js('Boolean(' + code + ')')) return; await delay(40); }
    report.snapshotRequests = snapshotRequests;
    report.lastReading = await js('NativeChat.readingPosition()');
    report.lastClick = await js('window.fixtureLastClick || "none"');
    throw Error('Timed out: ' + label + '; errors=' + JSON.stringify(await js('window.fixtureErrors')));
  }
  async function click(selector) {
    const point = await js(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing pointer target');e.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=e.getBoundingClientRect();const x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);const hit=document.elementFromPoint(x,y);if(!e.contains(hit))throw Error('Pointer target occluded by '+hit?.outerHTML.slice(0,200));return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(80);
  }
  async function open(payload = { panel: 'workspace' }, pending) {
    const started = Date.now();
    holdBoot = !!pending;
    route.openDeskWindow(payload, null); win = windows.get('workspace');
    if (pending) {
      await until('window.fixtureBootStarted===true', 'bootstrap waiting for auth');
      win.webContents.send('desk-open', { panel: 'workspace', ...pending });
      await delay(40);
      await js('window.fixtureReleaseBoot=true;void 0;');
    }
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await until('window.fixtureReady===true && window.WorkspaceHost && window.NativeChat', 'complete workspace');
    await delay(100);
    report.timings.push({ operation: 'open', view: payload.view || '', chatId: payload.chatId || '', milliseconds: Date.now() - started });
  }
  async function close() {
    const old = win;
    await new Promise(resolve => { old.once('closed', resolve); old.close(); });
  }
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_request, callback) => callback({ cancel: true }));
    const timer = setTimeout(() => { report.error = 'Fixture exceeded 80 seconds'; finish(1); }, 80000);
    function finish(code) {
      clearTimeout(timer); fs.writeFileSync(path.join(output, phase + '.json'), JSON.stringify(report, null, 2)); app.exit(code);
    }
    try {
      const main = fs.readFileSync(path.join(client, 'main.js'), 'utf8');
      const start = main.indexOf('function openDeskWindow('), end = main.indexOf('function _appIcon(', start);
      function FixtureWindow(options) {
        const created = new BrowserWindow({ ...options, show: false, webPreferences: {
          ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
        created.show = () => {}; created.focus = () => {};
        return created;
      }
      route = { _desktopOverlay: { notifyBlur() {}, setWorkspaceMaximized() {} },
        _WORK_SPEC: require('../main/window-specs'), _workspaceState: state, _workWindows: windows,
        _geom: { get: () => null, restore: () => null,
          initial: (spec, source) => spec.placement === 'preferences'
            ? require('../main/window-layout').initial(spec, {x:0,y:0,width:1440,height:1000}, source.getBounds(), 1)
            : { width: 1440, height: 1000 },
          limits: () => ({ minWidth: 800, minHeight: 540 }), remember() {} },
        rendererRoot: () => client, _workspaceTitlebar: { windowOptions: () => ({}), attach() {} },
        BrowserWindow: FixtureWindow, _appIcon: () => undefined, __dirname: client, path,
        attachWorkWindowRecovery() {}, revealWorkWindow() {}, setTimeout, clearTimeout };
      vm.runInNewContext(main.slice(start, end), route);
      ipcMain.on('open-desk-window', (event, payload) => route.openDeskWindow(payload, BrowserWindow.fromWebContents(event.sender)));
      ipcMain.on('close-desk-window', event => BrowserWindow.fromWebContents(event.sender)?.close());
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, reply) => reply({ cancel: true }));
      await session.defaultSession.protocol.handle('file', request => {
        if (path.basename(fileURLToPath(request.url.split('?')[0])) !== 'desk.html') return net.fetch(request.url, { bypassCustomProtocolHandlers: true });
        const identity = JSON.stringify(owner);
        const injected = `<script>
          window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
          document.addEventListener('click',e=>{window.fixtureLastClick=e.target.outerHTML.slice(0,300);},true);
          window.fixtureUser='unbound';
          const fixtureProjectTask=${JSON.stringify(projectTask)};
          window.SoduWorkAPI=new Proxy({online:true,taskStorageKey:kind=>fixtureUser+':'+kind,
            clientAuthSnapshot:()=>({state:fixtureUser==='unbound'?'pending':'active',clientId:'fixture-device',
              user:fixtureUser==='unbound'?null:{id:fixtureUser}}),
            myModels:async()=>({usable:[]}),pluginCatalog:async()=>({items:[]}),listTeammates:async()=>[],
            cloudEnvironments:async()=>({environments:[],permissions:{canCreate:true}}),
            getTask:async id=>id===fixtureProjectTask.id?fixtureProjectTask:null,
            getTeamCapability:async()=>({canManage:false,meId:'fixture'}),getConfig:async()=>({})},
            {get:(target,key)=>key in target?target[key]:async()=>({items:[],skills:[],enabled:[],schedules:[],runs:[]})});
          initData=async()=>{fixtureBootStarted=true;while(${holdBoot}&&!window.fixtureReleaseBoot)await new Promise(r=>setTimeout(r,10));await new Promise(r=>setTimeout(r,30));fixtureUser=${identity};tasks=[];Store._tasks=[];Store._taskState='ready';Store._startupPromise=Promise.resolve();dispatchEvent(new CustomEvent('soduwork-device-auth',{detail:{state:'active',user:{id:'fixture'}}}));};
          addEventListener('soduwork-workspace-ready',()=>{window.fixtureReady=true;});
        </script>`;
        const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8').replace('<script src="desk-boot.js"></script>', injected + '<script src="desk-boot.js"></script>');
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      });
      await open(phase === 'reopen' ? { panel: 'workspace', view: 'account' } : undefined);
      if (phase === 'font') {
        const workspace = win;
        await js('openTaskConversation(fixtureProjectTask.id, fixtureProjectTask.title, {source:"task-list", chatId:"project-chat"})');
        const bus = main.slice(main.indexOf("ipcMain.on('soduwork-work-broadcast'"));
        vm.runInNewContext(bus.slice(0, bus.indexOf('\n});') + 4), {ipcMain, BrowserWindow});
        await click('#wsRailMine');
        win = windows.get('preferences');
        await until('window.WorkspaceHost?.view === "account"');
        await click('#wsSettingsDialog [data-view="settings"]');
        const bounds = [workspace.getBounds(), win.getBounds()];
        const measure = (w, selectors) => w.webContents.executeJavaScript(
          `(${JSON.stringify(selectors)}).map(s => parseFloat(getComputedStyle(document.querySelector(s)).fontSize))`
        ).catch(error => { throw new Error(selectors.join(', ') + ': ' + error.message); });
        const rows = [];
        for (const scale of ['small', 'medium', 'large']) {
          await click(`#fontSeg [data-font="${scale}"]`);
          await until(`document.querySelector('#fontSeg .active').dataset.font === '${scale}'`);
          const cfg = await workspace.webContents.executeJavaScript('Store._cfg.fontScale');
          assert.equal(cfg, scale);
          const settings = await measure(win, ['.ws-settings-sidebar .ws-nav-item','.set-page-main-title','#fontSeg button']);
          await click('#wsSettingsDialog [data-view="account"]');
          await click('[data-email-change]');
          const dialog = await measure(win, ['.ac-email-change .ac-muted', '.ac-email-change button[type=submit]']);
          await click('.ac-email-change [data-ac-close]');
          await click('#wsSettingsDialog [data-view="settings"]');
          rows.push([...settings, ...dialog, ...await measure(workspace, ['.ws-brand b','#nchatInput','.ntext'])]);
          assert.deepEqual([workspace.getBounds(), win.getBounds()], bounds);
        }
        for (let i = 0; i < rows[0].length; i++) {
          assert.ok(rows[0][i] >= 12 && rows[0][i] < rows[1][i] && rows[1][i] < rows[2][i],
            'Font sizes for sample ' + i + ': ' + JSON.stringify(rows));
        }
        await close(); win = workspace; await click('#wsRailMine'); win = windows.get('preferences');
        await until('window.WorkspaceHost?.view === "account"');
        assert.equal((await measure(win, ['.ws-settings-sidebar .ws-nav-item']))[0], rows[2][0]);
        await click('#wsSettingsDialog [data-view="cloud"]');
        await until('document.querySelector(".ce-empty > svg")');
        const cloudIcons = await js(`['.ws-settings-sidebar [data-view=cloud] svg', '.ce-empty > svg'].map(selector => {
          const svg = document.querySelector(selector), style = getComputedStyle(svg);
          return {path:svg.querySelector('path').getAttribute('d'), viewBox:svg.getAttribute('viewBox'),
            stroke:style.strokeWidth, width:style.width, color:style.color};
        })`);
        assert.equal(cloudIcons[0].path, cloudIcons[1].path);
        assert.equal(cloudIcons[0].viewBox, cloudIcons[1].viewBox);
        assert.equal(cloudIcons[0].stroke, cloudIcons[1].stroke);
        assert.deepEqual(cloudIcons.map(icon => icon.width), ['18px', '32px']);
        assert.notEqual(cloudIcons[0].color, cloudIcons[1].color);
        report.cloudIcons = cloudIcons;
        const prefs = win;
        await click('#wsSettingsDialog [data-view="settings"]');
        win = workspace;
        report.checks.push('Opened cloud and compared navigation and empty-state icons');
        await js(`{const now = Date.now();
          const item = {id:'density',title:'示例需求',kind:'requirement',status:'doing',createdAt:now,start:now,due:now,
            myRoles:['creator','executor'],assigneeName:'示例用户'};
          SoduWorkAPI.getTasksSnapshot = async () => ({online:true,items:[item]});
          tasks = Store._tasks;
        } void 0`);
        await js('WorkspaceHost.open("history");void 0');
        await until('document.querySelector(".rq-menu-toggle")');
        await click('.rq-menu-toggle'); await click('[data-rq-view="gantt"]');
        await click('[data-rq-scope="all"]');
        await until('document.querySelector(".gv-bar")');
        const density = [];
        report.ganttSizes = density;
        for (const choice of ['small','medium','large']) {
          win = prefs; await click(`#scaleSeg [data-scale="${choice}"]`);
          win = workspace;
          await until(`Store._cfg.uiScale === '${choice}'`);
          density.push(await js(`['.gv-daynum','.gv-row:not(.gv-headrow) .gv-lane','.gv-bar'].map((s,i) => {
            const r=document.querySelector(s).getBoundingClientRect(); return i===0 ? r.width : r.height;
          })`));
        }
        for (let i = 0; i < 3; i++) assert.ok(density[0][i] < density[1][i] && density[1][i] < density[2][i], JSON.stringify(density));
        assert.deepEqual([workspace.getBounds(), prefs.getBounds()], bounds);
        report.checks.push('Changed the requirement Gantt density in both open windows');
        await close(); await open();
        assert.equal(await js('document.documentElement.style.getPropertyValue("--ui-scale")'), '1.22');
        report.fontSizes = rows;
        report.checks.push('Default desktop, sidebar, preferences and account dialog scale together; reopening restores large text');
        console.log(JSON.stringify(report.fontSizes));
      } else if (phase === 'cold') {
        assert.equal(await js('WorkspaceHost.view'), 'create');
        assert.equal(await js('NativeChat.hasSession()'), false);
        assert.equal(opens, 0); report.checks.push('a second complete Electron process opens home using the same profile');
      } else {
        await until('WorkspaceHost.view==="account" && document.querySelector("#personalAccountPanel.show")');
        await click('#wsBack');
        await until('WorkspaceHost.view==="create" && document.getElementById("composePanel").dataset.stage==="compose"');
        assert.equal(await js('NativeChat.hasSession()'), false);
        assert.equal(opens, 0);
        report.checks.push('a direct profile entry without a previous page returns to the new conversation home');

        const taskOpened = await js('openTaskConversation(fixtureProjectTask.id, fixtureProjectTask.title, {source:"task-list", chatId:"project-chat"})');
        assert.equal(taskOpened, true);
        const projectInfo = await js('NativeChat.sessionInfo()');
        assert.equal(projectInfo.sessionId, 'project-chat');
        assert.equal(projectInfo.projectId, projectTask.projectId);
        assert.equal(projectInfo.repoId, projectTask.repoId);
        assert.ok(projectInfo.taskIds.includes(projectTask.id));
        await js('{const i=document.getElementById("nchatInput");i.value="unsent project draft";i.dispatchEvent(new Event("input",{bubbles:true}));}void 0;');
        const attachedBeforeProfile = opens;
        await click('#wsRailMine');
        const mainWindow = win;
        const prefs = windows.get('preferences');
        assert.ok(prefs && prefs !== mainWindow && !prefs.getParentWindow());
        win = prefs;
        if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        await until('WorkspaceHost.view==="account" && document.querySelector("#personalAccountPanel.show")');
        assert.ok(prefs.getBounds().width < mainWindow.getBounds().width && prefs.getBounds().height < mainWindow.getBounds().height);
        await click('#wsSettingsDialog [data-view="shortcuts"]');
        win = mainWindow;
        await click('#wsRailMine');
        assert.equal(windows.get('preferences'), prefs);
        assert.equal(await prefs.webContents.executeJavaScript('WorkspaceHost.view'), 'shortcuts');
        const closedPrefs = new Promise(resolve => prefs.once('closed', resolve));
        await prefs.webContents.executeJavaScript('document.querySelector("#wsSettingsClose").click()');
        await closedPrefs;
        await until('WorkspaceHost.view==="create" && document.querySelector("#composePanel.show").dataset.stage==="chat"');
        const returned = await js('NativeChat.sessionInfo()');
        assert.equal(returned.sessionId, projectInfo.sessionId);
        assert.equal(returned.projectId, projectInfo.projectId);
        assert.equal(returned.repoId, projectInfo.repoId);
        assert.deepEqual(returned.taskIds, projectInfo.taskIds);
        assert.equal(await js('document.getElementById("nchatInput").value'), 'unsent project draft');
        assert.equal(opens, attachedBeforeProfile);
        assert.equal(sends, 0);
        report.checks.push('profile back reveals the same project task, conversation and unsent draft without opening or sending a turn');

        await click('#wsRailMine');
        const remaining = windows.get('preferences');
        if (remaining.webContents.isLoading()) await new Promise(resolve => remaining.webContents.once('did-finish-load', resolve));
        await close();
        win = remaining;
        await until('WorkspaceHost.view==="account"');
        await click('#wsSettingsDialog [data-view="shortcuts"]');
        assert.equal(await js('WorkspaceHost.view'), 'shortcuts');
        await close();
        await open();
        report.checks.push('one smaller settings window is reused; either window can close while the other stays usable');

        for (const page of ['skills', 'schedules', 'settings']) {
          await js(`WorkspaceHost.open(${JSON.stringify(page)},{});void 0;`); await delay(120);
          await close(); await open();
          assert.equal(await js('WorkspaceHost.view'), page); report.checks.push('close/reopen restores ' + page);
        }
        for (const id of ['local-chat', 'cloud-chat']) {
          await open({ panel: 'workspace', view: 'create', chatId: id });
          await until(`NativeChat.sessionInfo().sessionId===${JSON.stringify(id)}`);
          (report.resumeDiagnostics ||= []).push(await js('({view:WorkspaceHost.view,reading:NativeChat.readingPosition(),messageNodes:document.querySelectorAll("#nchatMessages>*").length,scroll:!!document.getElementById("nchatScroll"),readingModule:typeof ChatReadingPosition,body:document.body.innerText.slice(-800)})'));
          await until('Boolean(document.querySelector("[data-load-older]"))');
          await js('{const s=document.getElementById("nchatScroll");s.__soduworkScrollFollow.follow=false;s.__soduworkScrollFollow.userIntent=true;s.scrollTop=0;s.dispatchEvent(new Event("scroll"));}void 0;');
          await click('[data-load-older]');
          await until('NativeChat.readingPosition().messageLimit===160');
          await js('{const s=document.getElementById("nchatScroll");s.__soduworkScrollFollow.follow=false;s.scrollTop=450;s.dispatchEvent(new Event("scroll"));const i=document.getElementById("nchatInput");i.value="unsent fixture draft";i.dispatchEvent(new Event("input",{bubbles:true}));}void 0;');
          await delay(160);
          const before = await js('NativeChat.readingPosition()');
          await close();
          const savedReading = JSON.parse(state.resolve({ panel: 'workspace' }).workspaceRestore).reading;
          await open();
          await until(`NativeChat.sessionInfo().sessionId===${JSON.stringify(id)} && NativeChat.readingPosition().messageLimit===160`);
          await delay(100);
          const after = await js('NativeChat.readingPosition()');
          (report.readings ||= []).push({ id, before, savedReading, after });
          assert.equal(after.anchor.index, before.anchor.index);
          assert.ok(Math.abs(after.anchor.offset - before.anchor.offset) < 3);
          assert.equal(await js('document.getElementById("nchatInput").value'), 'unsent fixture draft');
          assert.equal(sends, 0); report.checks.push('close/reopen restores ' + id + ', older history, reading anchor and unsent draft without sending');
          const live = snapshots.get(id);
          live.messages.at(-1).blocks[0].text = 'Fixture live tail after restoration';
          win.webContents.send('pi-session-event', { ref: id, kind: 'delta', snapshot: uiWindow.snapshot(handles.get(id)) });
          await until('document.getElementById("nchatList").textContent.includes("Fixture live tail after restoration")');
          assert.equal(await js('NativeChat.readingPosition().messageLimit'), 160);
          assert.equal(await js('NativeChat.readingPosition().anchor.index'), before.anchor.index);
          report.checks.push('live updates retain restored older history in ' + id);
        }
        const attachedBeforePending = opens;
        await close(); await open({ panel: 'workspace' }, { view: 'settings' });
        assert.equal(await js('WorkspaceHost.view'), 'settings');
        assert.equal(await js('NativeChat.hasSession()'), false);
        assert.equal(opens, attachedBeforePending);
        report.checks.push('explicit navigation during bootstrap cancels the saved chat restore');
        await open({ panel: 'workspace', view: 'create', chatId: 'local-chat' });
        await until('NativeChat.sessionInfo().sessionId==="local-chat"');
        await close(); snapshots.delete('local-chat'); await open();
        await until('WorkspaceHost.view==="create" && !NativeChat.hasSession()');
        assert.equal(sends, 0);
        report.checks.push('a deleted chat returns home without sending or starting execution');
        snapshots.set('local-chat', snapshots.get('cloud-chat'));
        await open({ panel: 'workspace', view: 'create', chatId: 'local-chat' });
        await until('NativeChat.sessionInfo().sessionId==="local-chat"');
        owner = 'fixture-hub|account-b'; await close(); await open();
        assert.equal(await js('NativeChat.hasSession()'), false);
        assert.equal(await js('WorkspaceHost.view'), 'create'); report.checks.push('account change cannot reopen a private chat');
        await js('WorkspaceHost.open("settings",{});localStorage.setItem("soduwork-workspace-last-view-v1","settings");void 0;');
        await delay(100); await close();
      }
      report.sends = sends; report.opens = opens;
      report.ok = true; finish(0);
    } catch (error) { report.error = String(error.stack || error); console.error(error); finish(1); }
  });
}
