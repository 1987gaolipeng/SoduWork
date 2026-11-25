'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/output-reopen');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-output-reopen-e2e-')));
  app.setPath('userData', root); app.on('window-all-closed', () => {}); fs.mkdirSync(out, { recursive: true });
  const report = { ok: false, cases: [] }, sessions = new Map(), live = new Set();
  const artifacts = require('../main/conversation/artifact-runtime');
  const catalog = require('../main/agent-runtime/runtime-catalog');
  const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let win, legacyHistory, serial = 0, mode = 'mixed';
  const js = code => win.webContents.executeJavaScript(code, true).catch(error => { throw Error(code.slice(0, 180) + '\n' + error.message); });
  async function until(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(25); } throw Error('Timed out: ' + check); }
  const name = '示例企业官网.html', md = '成果说明.md';
  const old = Date.now() - 86400000, recent = Date.now() - 20000;
  const archive = [
    { seq: 1, kind: 'user', text: '生成网页与说明。', at: new Date(old).toISOString() },
    { seq: 2, kind: 'say', text: '已完成：`' + name + '`。另见 [成果说明](' + md + ') 和 `示例.png`。' },
    { seq: 3, kind: 'user', text: '再生成另一个网页。', at: new Date(recent).toISOString() },
    { seq: 4, kind: 'say', text: '已生成 `index.html`。' }
  ];
  const documentArchive = [
    { seq: 1, kind: 'user', text: '生成一份 Markdown 报告。', at: new Date(recent).toISOString() },
    { seq: 2, kind: 'say', text: '报告已落盘（`2026-09-30-soduwork-2026-09-30.md`）。' },
  ];
  async function click(expression) {
    const point = await js(`(()=>{const e=${expression};if(!e)throw Error('Missing click target');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded click target');return {x,y}})()`);
    for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
  }
  function makeFiles(work, runtime) {
    fs.mkdirSync(work, { recursive: true });
    // Real Qwen runs create this Node cache under TEMP. It must never consume
    // the bounded result index or hide a root/nested report in any runtime.
    const cache = path.join(work, 'temp', 'node-compile-cache', 'v24-e2e');
    fs.mkdirSync(cache, { recursive: true });
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(cache, i.toString(16)), 'runtime cache');
    if (runtime !== 'pi') for (let i = 0; i < 61; i++) {
      const input = path.join(work, 'a-input-' + i + '.txt');
      fs.writeFileSync(input, 'existing input');
      fs.utimesSync(input, new Date(old - 86400000), new Date(old - 86400000));
    }
    for (const [file, data] of [[name, '<!doctype html><meta charset="utf-8"><h1>可重新打开的历史成果</h1>'], [md, '# 历史成果说明'],
      ['示例.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')]]) {
      fs.writeFileSync(path.join(work, file), data); fs.utimesSync(path.join(work, file), new Date(old + 1000), new Date(old + 1000));
    }
    fs.writeFileSync(path.join(work, 'index.html'), '<h1>Current result</h1>');
    fs.utimesSync(path.join(work, 'index.html'), new Date(recent + 1000), new Date(recent + 1000));
    fs.mkdirSync(path.join(work, '.soduwork'));
    fs.writeFileSync(path.join(work, '.soduwork', 'delivery.json'), JSON.stringify({ schemaVersion: 1, deliverables: [{ path: 'index.html' }] }));
  }
  async function restore(id) {
    const cwd = path.join(root, 'work-' + id), ref = id + '-restored-' + (++serial);
    let handle;
    if (id === 'pi') {
      // Pi already scans resumed workspaces without a turn cutoff. This case
      // verifies its shared artifact index and UI using an archived snapshot.
      handle = { ref, sessionId: 'archive-pi', cwd, adapterId: 'pi', displayName: 'Pi',
        outputSnapshot: () => require('../main/pi-session/outputs').scan(cwd, 0, recent),
        snapshot: () => ({ status: 'idle', tools: [], messages: (mode === 'markdown' ? documentArchive : archive).map(item => item.kind === 'user'
          ? { role: 'user', text: item.text } : { role: 'assistant', done: true, blocks: [{ kind: 'text', text: item.text }] }) }) };
    } else {
      const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(id),
        modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
        runnerRuntime: { async rpc(op) { return op === 'job.session'
          ? { ok: true, data: { status: 'done', round: 2, started: recent / 1000, firstStarted: old / 1000, ended: (recent + 5000) / 1000, items: mode === 'markdown' ? documentArchive : archive } }
          : { ok: true, data: {} }; } } });
      const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd, ref, resumePath: 'archive-' + id } } } });
      live.add(session); handle = getRunnerSessionDetails(session).handle;
      await until(() => handle.snapshot().status === 'idle');
    }
    sessions.set(handle.ref, handle);
    return { ok: true, ref: handle.ref, cwd, sessionId: handle.sessionId, adapterId: id, displayName: handle.displayName, snapshot: handle.snapshot() };
  }
  async function createLegacyHistory() {
    const identity = require('../tests/helpers/platform-session-fixture.cjs').identity();
    const id = 'legacy-pi-website', cwd = path.join(root, 'legacy-project'), file = path.join(root, 'pi-agent', 'sessions', 'legacy-project', id + '.jsonl');
    const html = '<!doctype html><meta charset="utf-8"><h1>旧版 Pi 生成的网站</h1>';
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'index.html'), html);
    const entries = [{ type: 'session', id, cwd },
      { type: 'custom', customType: 'soduwork.access.policy', data: require('../main/access-control/policy').create('full', cwd) }, ...[
      { role: 'user', content: '创建一个网站' },
      { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'write1', name: 'write', arguments: { path: 'index.html', content: html } }] },
      { role: 'toolResult', toolCallId: 'write1', toolName: 'write', isError: false, content: [] },
      { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '已创建 `index.html`。' }] },
    ].map(message => ({ type: 'message', message }))];
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n'));
    const row = { id, cwd, adapterId: 'pi', path: file, count: entries.length - 1,
      workOwner: require('../main/platform-connections/runtime.cjs').scope(identity), creator: { account: 'one', hub: identity.hub } };
    const session = { historyEntry: require('../main/pi-session/session').historyEntry, findBySessionId: () => null };
    const store = require('../main/conversation/replica-store.cjs').create(path.join(root, 'legacy.sqlite'));
    legacyHistory = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => identity, workRoot: () => root });
    const [registered] = await legacyHistory.register([row]);
    const { snapshot, coverage } = await require('../main/conversation/device-history-native.cjs').read({ app, session, row, guard() {} });
    delete coverage.sources[0].artifactEvidenceVersion;
    const guard = { expectedRevision: registered.replicaRevision, expectedCatalogRevision: registered.revision };
    await store.saveDeviceHistory(id, { snapshot, coverage }, guard);
    await store.saveConversationTranscript(id, snapshot.messages, guard);
    return id;
  }
  app.whenReady().then(async () => {
    const bridge = require('../main/agent-runtime/pi-session-bridge'); bridge.get = ref => sessions.get(ref);
    require('../main/pi-session/artifact-ipc').install({ app, ipcMain, BrowserWindow, session: sessions, workDir: () => root });
    ipcMain.handle('pi-session-snapshot', (_event, ref) => ({ ok: true, snapshot: sessions.get(ref)?.snapshot() }));
    require('../main/work-preview').install({ app, ipcMain, BrowserWindow, WebContentsView, shell: { openExternal: async () => { throw Error('No external navigation in fixture'); } } });
    const legacyId = await createLegacyHistory();
    ipcMain.handle('pi-session-open-application', () => ({ ok: true, handled: false }));
    ipcMain.handle('access-preferences-get', () => ({ ok: true, mode: 'standard' }));
    ipcMain.handle('pi-session-runtimes', () => ({ ok: true, runtimes: catalog.runtimes() }));
    ipcMain.handle('pi-session-open', async (_event, options) => {
      if (options.chatId !== legacyId) return restore(options.adapterId || 'pi');
      const view = await legacyHistory.open(legacyId, { historyPreview: true, allowContinuation: true });
      sessions.set(view.ref, view);
      return { ok: true, ref: view.ref, sessionId: legacyId, adapterId: 'pi', localReplica: true, snapshot: view.snapshot() };
    });
    ipcMain.handle('pi-session-history', () => ({ ok: true, chats: [] }));
    ipcMain.handle('pi-session-runtime-models', () => ({ ok: true, items: [] }));
    ipcMain.handle('pi-session-release', async (_event, ref) => {
      artifacts.closeRef(ref);
      const handle = sessions.get(ref);
      if (handle?.historyPreview) await handle.close();
      sessions.delete(ref); return { ok: true };
    });
    const source = path.join(__dirname, 'fixtures/workbench-annotations.html'), scripts = [];
    const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
      const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return '';
    });
    scripts.unshift(...['chat-plugin-mention-model', 'chat-plugin-mention'].map(file =>
      fs.readFileSync(path.join(client, 'components/panels', file + '.js'), 'utf8')));
    const page = html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(path.dirname(source) + path.sep).href + '">');
    win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.console = [...(report.console || []), event.message]; });
    const origin = pathToFileURL(path.join(client, 'desk.html')).href;
    await win.webContents.session.protocol.handle('file', request => request.url === origin
      ? new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      : electron.net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    const destroyedListeners = win.webContents.listenerCount('destroyed');
    for (const spec of catalog.runtimes()) {
      mode = 'mixed';
      makeFiles(path.join(root, 'work-' + spec.id), spec.id);
      let firstId;
      for (let attempt = 0; attempt < 2; attempt++) {
        await win.loadURL(origin);
        for (const file of JSON.parse(fs.readFileSync(path.join(client, 'core/locales/manifest.json')))) await js(fs.readFileSync(path.join(client, 'core/locales', file), 'utf8'));
        for (const file of ['core/i18n-dom.js', 'core/i18n.js']) await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
        for (const script of scripts) await js(script + '\nvoid 0;');
        await js('SoduWorkI18n.setLocale(' + JSON.stringify(attempt ? 'en-US' : 'zh-CN') + ');NativeChat.enter("","archive-' + spec.id + '",{adapterId:' + JSON.stringify(spec.id) + '});void 0;');
        const selector = 'Array.from(document.querySelectorAll(".nmsg.ai [data-open-app]")).find(e=>e.textContent===' + JSON.stringify(name) + ')';
        await until(() => js('Boolean(' + selector + ')'));
        const id = await js(selector + '.dataset.openApp');
        if (!attempt) firstId = id; else assert.equal(id, firstId, 'artifact identity survives a new handle/ref');
        await click(selector);
        await until(async () => {
          for (const view of win.contentView.children) {
            if (view.webContents && !view.webContents.isDestroyed() && decodeURIComponent(view.webContents.getURL()).endsWith(name)) {
              return /可重新打开/.test(await view.webContents.executeJavaScript('document.body.innerText'));
            }
          }
          return false;
        });
        assert.equal(await js('ChatWorkbench.state().open'), true);
        await click('Array.from(document.querySelectorAll(".nmsg.ai [data-open-app]")).find(e=>e.textContent==="成果说明")');
        await until(() => js('document.querySelector(".ncw-markdown h1")?.textContent==="历史成果说明"'));
        await click('document.querySelector(".noutput-image")');
        await until(() => js('document.querySelector(".ncw-image img")?.naturalWidth===1'));
        assert.deepEqual(await js('window.errors'), []);
        if (spec.id === 'opencode' && attempt) fs.writeFileSync(path.join(out, 'reopened.png'), (await win.webContents.capturePage()).toPNG());
        await js('NativeChat.reset();void 0;');
        await until(() => win.contentView.children.length === 0);
        assert.equal(win.webContents.listenerCount('destroyed'), destroyedListeners, 'reopening previews must not accumulate owner cleanup listeners');
      }
      report.cases.push(spec.id + ': close/reopen twice; inline-code HTML opens real right WebContentsView; Markdown and PNG open in right panel; zh/en');
      mode = 'markdown';
      const work = path.join(root, 'work-' + spec.id);
      fs.unlinkSync(path.join(work, 'index.html'));
      fs.unlinkSync(path.join(work, '.soduwork', 'delivery.json'));
      const reportName = '2026-09-30-soduwork-2026-09-30.md';
      fs.mkdirSync(path.join(work, 'deep-research', 'reports'), {recursive:true});
      const reportPath = path.join(work, 'deep-research', 'reports', reportName);
      fs.writeFileSync(reportPath, '# Markdown 交付验收\n\n子目录报告可以直接查看。');
      fs.utimesSync(reportPath,new Date(recent+2000),new Date(recent+2000));
      await js('NativeChat.enter("","archive-' + spec.id + '",{adapterId:' + JSON.stringify(spec.id) + '});void 0;');
      await until(() => js('document.querySelector(".ncw-markdown h1")?.textContent==="Markdown 交付验收"'));
      assert.equal(await js('ChatWorkbench.state().open'), true, spec.id + ': newly generated Markdown opens automatically');
      await click('document.querySelector("[data-wb-close]")');
      await until(() => js('!ChatWorkbench.state().open'));
      // The same output refresh must respect a user closing the side pane.
      await js('document.querySelector("#nchatInput").dispatchEvent(new Event("input",{bubbles:true}));void 0;');
      assert.equal(await js('ChatWorkbench.state().open'), false);
      await click('Array.from(document.querySelectorAll(".nmsg.ai [data-open-app]")).find(e=>e.textContent===' + JSON.stringify(reportName) + ')');
      await until(() => js('ChatWorkbench.state().open && document.querySelector(".ncw-markdown h1")?.textContent==="Markdown 交付验收"'));
      fs.writeFileSync(path.join(out,spec.id+'-markdown.png'),(await win.webContents.capturePage()).toPNG());
      await js('NativeChat.reset();void 0;');
      report.cases.push(spec.id + ': nested Markdown auto-opens; filename is marked clickable; actual mouse closes and reopens the right preview');
    }
    await js(fs.readFileSync(path.join(client, 'components/panels/chat-deliveries.js'), 'utf8'));
    win.showInactive();
    await js('SoduWorkI18n.setLocale("zh-CN");void 0;');
    for (let visit = 0; visit < 2; visit++) {
      await js('NativeChat.enter("",' + JSON.stringify(legacyId) + ',{adapterId:"pi"});void 0');
      const link = visit ? 'document.querySelector(".ndelivery [data-open-app]")'
        : 'Array.from(document.querySelectorAll(".nmsg.ai [data-open-app]")).find(e => e.textContent === "index.html")';
      await until(() => js('Boolean(' + link + ')'));
      await click('document.querySelector("#nchatMode")');
      await until(() => js(`!document.querySelector('#nchatAccessPop').hidden &&
        document.querySelector('[data-access-mode="full"]').matches('[aria-pressed="true"]:enabled')`));
      await click('document.querySelector("#nchatMode")');
      await click(link);
      let visibleWebsite;
      await until(async () => {
        const slot = await js(`(() => {
          const rect = document.querySelector('[data-wb-native]')?.getBoundingClientRect();
          if (!rect || rect.x < innerWidth / 3 || rect.width < 240 || rect.height < 200 ||
              rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) return null;
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`);
        if (!slot) return false;
        for (const view of win.contentView.children) {
          if (!view.getVisible() || !view.webContents || view.webContents.isDestroyed()) continue;
          const bounds = view.getBounds();
          if (Object.keys(slot).some(key => Math.abs(slot[key] - bounds[key]) > 2)) continue;
          if (await view.webContents.executeJavaScript('document.querySelector("h1")?.textContent') === '旧版 Pi 生成的网站') {
            visibleWebsite = view; return true;
          }
        }
        return false;
      });
      assert.equal(await js('ChatWorkbench.state().open'), true);
      if (visit) {
        const pixels = await visibleWebsite.webContents.capturePage();
        assert.ok(!pixels.isEmpty());
        fs.writeFileSync(path.join(out, 'legacy-pi-website-preview.png'), pixels.toPNG());
      }
      await js('NativeChat.reset();void 0;'); await until(() => win.contentView.children.length === 0);
    }
    report.cases.push('Pi 1.13.19 archive: full permission remains selected and available; click the historical HTML filename, reopen the chat, click its delivery card and verify the original heading in the right WebContentsView');
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); })
    .finally(async () => {
      for (const session of live) await session.dispose(); artifacts.closeAll(); await legacyHistory?.close();
      win?.destroy(); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
      app.exit(report.ok ? 0 : 1);
    });
}
