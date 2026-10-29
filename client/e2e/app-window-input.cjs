'use strict';
// Production detached-window layout and chrome, isolated profile and loopback page.
// --interactive leaves the fixture visible for real Windows mouse input. No JS clicks.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), process.argv.includes('--interactive') ? 600000 : 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const http = require('node:http'), assert = require('node:assert/strict');
  const interactive = process.argv.includes('--interactive');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-app-input-'));
  const output = path.resolve(__dirname, '../../outputs/app-window-input-20261020');
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(temp, 'profile'));
  const views = [], handlers = {}, report = { ok: false, cases: [], input: { app: 0, settings: 0, sidebar: 0 },
    boundary: 'Isolated Electron profile, production work-preview IPC/layout, production title bar/preload, loopback application. Minimal sidebar fixture with production preload; no models/accounts/user windows. Structural checks alone do not prove native mouse input.' };
  let host, detached, server, poll, done = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn, label) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(25); } throw Error('Timed out: ' + label); };
  const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const invoke = (name, sender, payload) => handlers['work-preview-' + name]({ sender }, payload);
  async function finish(error) {
    if (done) return; done = true; clearInterval(poll);
    if (error) report.error = String(error.stack || error);
    report.ok = !error; save();
    if (host && !host.isDestroyed()) host.destroy();
    for (const view of views) { if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close(); }
    if (detached && !detached.isDestroyed()) detached.destroy();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    console.log(JSON.stringify(report)); app.exit(error ? 1 : 0);
  }
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    fs.writeFileSync(path.join(temp, 'host.html'), '<!doctype html><title>Hidden input fixture owner</title>');
    fs.writeFileSync(path.join(temp, 'sidebar.html'), `<!doctype html><style>
      body{margin:0;background:#f3f4f6;font:16px sans-serif}button{padding:12px;margin:8px}
      </style><button id="side">对话侧栏测试 0</button><script>
      window.clicks=0;side.onclick=()=>{clicks++;side.textContent='对话侧栏测试 '+clicks;};
      soduWorkAPI.workPreview.onComposerMode(m=>{document.body.dataset.mode=m.state;});
      </script>`);
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><style>body{margin:0;background:#10151c;color:white;font:20px sans-serif}
        button{margin:60px;padding:25px;font:24px sans-serif}</style><button id="test">应用按钮：0</button>
        <p style="margin:60px">本地隔离窗口：验证应用按钮、标题栏设置与右侧栏。</p>
        <script>window.clicks=0;test.onclick=()=>{clicks++;test.textContent='应用按钮：'+clicks;};</script>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    require('../main/work-preview').install({ BrowserWindow,
      ipcMain: { handle(name, fn) { handlers[name] = fn; ipcMain.handle(name, fn); }, on: (...args) => ipcMain.on(...args) },
      WebContentsView: function (options) {
        const view = new WebContentsView(options); views.push(view);
        const setBounds = view.setBounds.bind(view), invalidate = view.webContents.invalidate.bind(view.webContents);
        view.boundsCalls = 0; view.invalidations = 0;
        view.setBounds = bounds => { view.boundsCalls++; return setBounds(bounds); };
        view.webContents.invalidate = () => { view.invalidations++; return invalidate(); };
        const loadFile = view.webContents.loadFile.bind(view.webContents);
        view.webContents.loadFile = (file, opts) => loadFile(path.basename(file) === 'desk.html' ? path.join(temp, 'sidebar.html') : file, opts);
        return view;
      }, shell: { openExternal: async () => { throw Error('No external navigation in input fixture'); } } });
    host = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false,
      preload: path.resolve(__dirname, '../preload.js') } });
    await host.loadFile(path.join(temp, 'host.html'));
    const originalSend = host.webContents.send.bind(host.webContents);
    host.webContents.send = (channel, ...args) => {
      if (channel === 'work-preview-apps-manage') { report.input.settings++; save(); }
      return originalSend(channel, ...args);
    };
    const result = await invoke('show-detached', host.webContents, {
      tabId: 'input-fixture', label: 'SoduWork input regression', url: 'http://127.0.0.1:' + server.address().port });
    assert.equal(result.ok, true, result.reason);
    detached = BrowserWindow.getAllWindows().find(win => win !== host);
    await until(() => views.length >= 3 && views.every(view => !view.webContents.isLoading()), 'views loaded');
    assert.equal(views.length, 3, 'Only application, title bar and sidebar; no whole-window decoration view');
    const application = views[0], chrome = views[1], sidebar = views[2];
    assert.deepEqual(detached.contentView.children, [chrome, application, sidebar]);
    assert.equal(typeof application.setBorderRadius, 'function');
    assert.equal(typeof application.webContents.setIgnoreMouseEvents, 'undefined');
    report.cases.push('Three native sibling views only; installed Electron supports native border radius and has no webContents.setIgnoreMouseEvents.');
    assert.equal(await chrome.webContents.executeJavaScript('typeof window.soduWorkWindowChrome?.action'), 'function');
    assert.equal((await chrome.webContents.executeJavaScript('window.soduWorkWindowChrome.action("apps")')).ok, true);
    assert.equal(report.input.settings, 1, 'Production chrome action reaches the owner');
    report.input.settings = 0; // Above is an IPC check, separate from native mouse input counts.
    report.cases.push('Production title-bar preload and settings IPC reach the owner (programmatic IPC check; not mouse evidence).');
    // These cases measure manually sized ordinary windows, after the new maximized opening.
    if (detached.isMaximized()) { detached.unmaximize(); await until(() => !detached.isMaximized(), 'restore before layout checks'); await delay(80); }
    for (const size of [[1120, 780], [650, 500]]) {
      detached.setContentSize(...size);
      for (const mode of [{ expanded: false, hover: false }, { hover: true }, { expanded: true }]) {
        assert.equal(invoke('composer-mode-set', sidebar.webContents, mode).ok, true);
        const a = application.getBounds(), c = chrome.getBounds(), s = sidebar.getBounds();
        assert.equal(a.x, 10, 'application keeps its left outer margin');
        assert.equal(a.y, c.y + c.height, 'application meets title bar without a gap');
        assert.equal(a.y + a.height, size[1] - 10, 'application keeps its bottom outer margin');
        assert.ok(s.y >= c.y + c.height, 'sidebar leaves title bar reachable');
        if (mode.expanded) {
          assert.equal(s.width, Math.max(320, Math.min(440, Math.round(size[0] * .36))) - 10, 'initial default width stays unchanged');
          assert.equal(a.x + a.width, s.x, 'floating sidebar toggle attaches to application edge without a gap');
          assert.equal(s.y, a.y, 'sidebar meets title bar');
          assert.equal(s.x + s.width, size[0] - 10, 'sidebar keeps its right outer margin');
          assert.equal(s.y + s.height, size[1] - 10, 'sidebar keeps its bottom outer margin');
        } else {
          assert.equal(a.x + a.width, size[0] - 10, 'application keeps its right outer margin');
        }
        assert.equal(detached.contentView.children.length, 3);
        (report.layouts ||= []).push({ size, state: mode.expanded ? 'pinned' : mode.hover ? 'float' : 'rail',
          app: a, chrome: c, sidebar: s, topGap: a.y - c.y - c.height,
          ...(mode.expanded ? { sidebarGap: s.x - a.x - a.width } : {}) });
        report.cases.push(`${size.join('x')}: ${mode.expanded ? 'pinned' : mode.hover ? 'float' : 'rail'} layout bounds passed`);
      }
    }
    detached.setContentSize(1120, 780);
    invoke('composer-mode-set', sidebar.webContents, { expanded: true });
    await delay(200);
    const beforeResize = { app: application.boundsCalls, chrome: chrome.boundsCalls, sidebar: sidebar.boundsCalls, invalidations: sidebar.invalidations };
    for (const width of [440, 440, 460, 460, 480]) {
      assert.equal(invoke('composer-width', sidebar.webContents, { width }).ok, true);
    }
    assert.equal(application.boundsCalls - beforeResize.app, 3, 'duplicate widths do not reset the application view');
    assert.equal(sidebar.boundsCalls - beforeResize.sidebar, 3, 'duplicate widths do not reset the sidebar view');
    assert.equal(chrome.boundsCalls, beforeResize.chrome, 'resizing the sidebar never resets unchanged title-bar bounds');
    assert.equal(sidebar.invalidations, beforeResize.invalidations, 'drag samples do not force extra compositor invalidations');
    report.cases.push('Repeated drag widths are deduplicated; unchanged chrome is not reset and drag samples do not force repaints.');
    for (const requestedWidth of [1120, 1440, 1920, 650, 600, 480]) {
      detached.setContentSize(requestedWidth, 780);
      await delay(80);
      const W = detached.getContentBounds().width;
      const min = Math.min(Math.floor(W / 2), Math.max(320, Math.min(440, Math.round(W * .36))));
      for (const [request, expected] of [[10000, W - min], [-10000, min]]) {
        const result = invoke('composer-width', sidebar.webContents, { width: request });
        assert.equal(result.ok, true); assert.equal(result.width, expected);
        const a = application.getBounds(), s = sidebar.getBounds();
        assert.equal(a.x + a.width, s.x, 'panes remain flush at both drag limits');
        assert.equal(s.x + s.width, W - 10, 'outer margin survives a wide sidebar');
        assert.ok(a.width >= min - 10 && s.width >= min - 10, 'both panes retain the default chat minimum');
        if (request > 0) {
          assert.equal(a.width, min - 10, 'application reaches the same minimum as chat');
          if (W >= 1120) assert.ok(s.width > 620, 'chat can expand beyond the old fixed cap');
        } else assert.equal(s.width, min - 10, 'chat shrinks back to its original default');
      }
      invoke('composer-mode-set', sidebar.webContents, { expanded: false });
      invoke('composer-mode-set', sidebar.webContents, { expanded: true });
      assert.equal(sidebar.getBounds().width, min - 10, 'collapse/reopen retains resized width');
    }
    detached.setContentSize(1440, 780); await delay(80);
    const wide = invoke('composer-width', sidebar.webContents, { width: 10000 }).width;
    detached.setContentSize(650, 780); await delay(80);
    assert.equal(application.getBounds().x + application.getBounds().width, sidebar.getBounds().x);
    assert.ok(application.getBounds().width >= 310 && sidebar.getBounds().width >= 310, 'small window clamps a prior wide selection');
    detached.setContentSize(1440, 780); await delay(80);
    assert.equal(sidebar.getBounds().width, wide - 10, 'growing the window restores the chosen wide sidebar');
    detached.setContentSize(1120, 780); await delay(80);
    report.cases.push('1120/1440/1920px sidebars expand beyond 620px until the app reaches the default chat minimum; both drag limits, 480/600/650px adaptation, collapse/reopen and window shrink/restore preserve flush bounds.');
    invoke('composer-mode-set', sidebar.webContents, { expanded: false, railArrival: false });
    const area=detached.getContentBounds();
    const beforeRail=sidebar.getBounds();
    assert.equal(beforeRail.width,64); assert.equal(beforeRail.height,80);
    assert.equal(invoke('composer-mode-set', application.webContents, {railScreenY:area.y+100}).ok,false,'application content cannot reposition the sidebar');
    assert.equal(invoke('composer-mode-set', sidebar.webContents, {railScreenY:NaN}).ok,false,'non-finite placements are rejected');
    for(const offset of [-1000,100,10000]){
      assert.equal(invoke('composer-mode-set', sidebar.webContents, {railScreenY:area.y+offset}).ok,true);
      const placed=sidebar.getBounds();
      assert.equal(placed.x+placed.width,area.width,'horizontal edge remains locked');
      assert.ok(placed.y>=30&&placed.y+placed.height<=area.height-10,'drag clamps inside application body');
      if(offset===100)assert.equal(placed.y+placed.height/2,100,'vertical placement follows the cursor');
    }
    const parked=sidebar.getBounds();
    invoke('composer-mode-set',sidebar.webContents,{expanded:true});
    invoke('composer-mode-set',sidebar.webContents,{expanded:false});
    assert.deepEqual(sidebar.getBounds(),parked,'expand/collapse retains the parked position');
    detached.setContentSize(650,500);await delay(80);
    assert.equal(sidebar.getBounds().y+sidebar.getBounds().height,490,'resizing keeps a bottom-docked sprite in view');
    report.cases.push('64×80 rail is fixed to the right; only its owned renderer can drag it vertically; NaN is rejected, extremes clamp, expand/collapse retains position, resizing keeps it inside the body.');
    assert.equal(await application.webContents.executeJavaScript('clicks'), 0);
    await detached.webContents.capturePage().then(img => fs.writeFileSync(path.join(output, 'fixture.png'), img.toPNG()));
    if (!interactive) return finish();
    report.cases.push('Interactive fixture ready; input counts below come from page handlers and production chrome IPC, without synthetic click injection.');
    save(); detached.show(); detached.focus();
    detached.on('close', () => {
      if (done) return;
      const passed = report.input.app > 0 && report.input.settings > 0 && report.input.sidebar > 0;
      void finish(passed ? null : Error('Interactive input incomplete: click application, settings and sidebar before closing'));
    });
    poll = setInterval(async () => {
      try {
        report.input.app = await application.webContents.executeJavaScript('clicks');
        report.input.sidebar = await sidebar.webContents.executeJavaScript('clicks');
        save();
      } catch (_) { /* window closing */ }
    }, 300);
    console.log('Interactive fixture ready: SoduWork input regression');
  }).catch(finish);
}
