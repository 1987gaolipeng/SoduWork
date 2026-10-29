'use strict';
// Load real rendering components and listener order with isolated APIs and user data.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-escape-layers-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/client-fixes-20261016/escape'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, cases: [], errors: [], networkRequests: [] };
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(code) {
    for (let i = 0; i < 150; i++) { if (await js(code)) return; await delay(20); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});void 0;`);
    await delay(180);
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      const hit=document.elementFromPoint(p.x,p.y);return {...p,covered:!e.contains(hit),rect:r.toJSON(),hit:hit?.outerHTML.slice(0,250)}})()`);
    if (point.covered) {
      fs.writeFileSync(path.join(out, 'covered.png'), (await win.webContents.capturePage()).toPNG());
      throw Error('Covered button: ' + selector + ' ' + JSON.stringify(point));
    }
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await delay(30);
  }
  async function escape() {
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
    await delay(80);
  }
  async function snapshot() {
    return js(`(()=>{const board=document.querySelector('#historyBoard');return {
      sheet:!!document.querySelector('#workEntryLayer'),previews:document.querySelectorAll('.catt-preview').length,
      title:document.querySelector('#cpTitle')?.value||'',note:document.querySelector('#cpNote')?.value||'',
      files:[...document.querySelectorAll('#wesAttachTray b')].map(e=>e.textContent),
      boardVisible:board.classList.contains('show')&&!board.inert&&getComputedStyle(board).opacity!=='0',
      boardHosted:board.classList.contains('workspace-hosted'),route:WorkspaceHost.view,
      nativeCloseCalls:nativeCloseCalls,focus:document.activeElement?.className||'',
      closeCalls:sheetClosed,previewTitles:[...document.querySelectorAll('.catt-preview-title b')].map(e=>e.textContent)
    }})()`);
  }
  function background(state) {
    assert.equal(state.boardVisible, true, 'background requirements board must stay visible and interactive');
    assert.equal(state.boardHosted, true); assert.equal(state.route, 'history');
    assert.equal(state.nativeCloseCalls, 0, 'Escape owned by an overlay must not close the native workspace');
  }
  function draft(state) {
    assert.equal(state.sheet, true, 'preview Escape must preserve the requirement form');
    assert.equal(state.title, '未提交的需求标题'); assert.equal(state.note, '未提交的正文必须保留');
    assert.deepEqual(state.files, ['隔离截图.png']); assert.equal(state.closeCalls, 0); background(state);
  }
  async function reset() {
    await js(`document.querySelectorAll('.catt-preview [data-catt-preview-close]').forEach(e=>e.click());
      document.querySelectorAll('dialog,#fixturePopover').forEach(e=>e.remove());
      WorkAutomationSheet.close(true);WorkEntrySheet.close();window.chatAttachments?.destroy();document.querySelector('#inlineHost').replaceChildren();
      WorkspaceHost.open('history');window.nativeCloseCalls=0;window.sheetClosed=0;void 0;`);
  }
  async function openSheet(inline = false, empty = false) {
    await js(`WorkEntrySheet.openTask({${inline ? "host:'#inlineHost'," : ''}
      proposal:${empty ? "{title:'',note:''}" : "{title:'未提交的需求标题',note:'未提交的正文必须保留',assignee:'me'}"},
      bridge:{atts:()=>${empty ? '[]' : '[pngFile]'}},onClose:()=>sheetClosed++});void 0;`);
    await until("!!document.querySelector('#cpTitle')");
    if (!empty) await until("!!document.querySelector('#wesAttachTray .catt-openable')");
    await delay(40);
  }
  async function run(name, action) {
    await reset();
    const result = { name, ok: false };
    try { await action(result); result.ok = true; }
    catch (error) { result.error = String(error.stack || error); result.after = await snapshot(); }
    report.cases.push(result);
  }
  app.whenReady().then(async () => {
    const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
    const css = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m => m[1]);
    const wanted = new Set(['task-priority', 'requirements', 'requirements-view', 'requirements-board', 'task-execution-client',
      'plugin-ui-host', 'requirement-routing', 'panels-compose-submit', 'panels-compose-draft', 'library-transfer',
      'conversation-attachments', 'work-entry-sheet', 'work-automation-bindings', 'work-automation-view',
      'work-automation-card-state','work-automation-sheet', 'schedule-timing', 'panels', 'desk-boot']);
    const scripts = [...desk.matchAll(/<script\b[^>]*src=["']([^"']+\.js)["'][^>]*>/g)]
      .map(m => m[1]).filter(file => wanted.has(path.basename(file, '.js')));
    report.scripts = scripts;
    const href = file => pathToFileURL(path.join(client, file)).href;
    const scriptTag = file => '<script>' + fs.readFileSync(path.join(client, file), 'utf8')
      .replace(/<\/script/gi, '<\\/script') + '\n//# sourceURL=' + href(file) + '\n</script>';
    const styleTag = file => '<style>' + fs.readFileSync(path.join(client, file), 'utf8')
      .replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (match, _quote, value) =>
        /^(?:[a-z]+:|\/\/|#)/i.test(value) ? match : 'url(' + JSON.stringify(pathToFileURL(path.resolve(client, path.dirname(file), value)).href) + ')') + '</style>';
    const fixture = path.join(temporary, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><html data-desk-panel="workspace"><head><meta charset="utf-8">' +
      css.map(styleTag).join('') +
      '<style>body{margin:0}#inlineHost{position:fixed;inset:20px;overflow:auto;z-index:80;background:white}#inlineHost:empty{display:none}</style></head><body>' +
      '<div id="inlineHost"></div><script>window.__deskPanel="workspace";window.__deskArgs={view:"history"};' +
      'window.errors=[];addEventListener("error",e=>errors.push(e.error?.stack||e.message));window.tasks=[];window.cfg={};' +
      'window.Store={taskState:"ready"};window.initData=async()=>{};window.hideCtx=()=>{};' +
      'window.nativeCloseCalls=0;window.sheetClosed=0;window.soduWorkAPI={closeDeskWindow:()=>nativeCloseCalls++};' +
      'window.SoduWorkAPI={taskStorageKey:()=>"isolated-escape",listTeammates:async()=>({mates:[]}),' +
      'taskExecutionOptions:async()=>({substrates:[],workflows:[],repos:[]}),workCatalog:async()=>({scenarios:[]}),' +
      'uploadLibraryFile:async file=>({ok:true,item:{id:file.name}}),listAIAgents:async()=>({agents:[]}),' +
      'listRepos:async()=>({repos:[]})};</script>' + scripts.map(scriptTag).join('') + '</body></html>');
    win = new BrowserWindow({ show: false, width: 1200, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, cb) => {
      report.networkRequests.push(request.url); cb({ cancel: true });
    });
    await win.loadFile(fixture);
    win.setContentSize(1200, 1000);
    await until('innerWidth >= 1100 && innerHeight >= 900');
    await until("window.WorkspaceHost?.view==='history'&&document.querySelector('#historyBoard.show')");
    await js(`window.pngFile=new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'隔离截图.png',{type:'image/png'});void 0;`);
    for (const inline of [false, true]) {
      await run((inline ? 'inline' : 'modal') + ' image Escape preserves requirement draft and workspace', async result => {
        await openSheet(inline); await click('#wesAttachTray .catt-openable');
        await until("document.querySelector('.catt-preview img')?.complete"); result.before = await snapshot();
        await escape(); result.after = await snapshot();
        assert.equal(result.after.previews, 0); draft(result.after);
      });
      await run((inline ? 'inline' : 'modal') + ' form Escape closes only the empty form', async result => {
        await openSheet(inline, true); await js("document.querySelector('#cpTitle').focus();void 0;");
        await escape(); result.after = await snapshot();
        assert.equal(result.after.sheet, false); assert.equal(result.after.closeCalls, 1); background(result.after);
      });
    }
    await run('image X retains the requirement draft and workspace', async result => {
      await openSheet(); await click('#wesAttachTray .catt-openable'); await click('[data-catt-preview-close]');
      result.after = await snapshot(); assert.equal(result.after.previews, 0); draft(result.after);
    });
    for (const nativeLayer of ['dialog', 'popover']) {
      await run('native ' + nativeLayer + ' owns Escape above an image and form', async result => {
        await openSheet(); await click('#wesAttachTray .catt-openable');
        await js(`window.topLayer=document.createElement(${JSON.stringify(nativeLayer === 'dialog' ? 'dialog' : 'div')});
          topLayer.id='fixturePopover';topLayer.innerHTML='<button>上层确认</button>';document.body.append(topLayer);
          ${nativeLayer === 'dialog' ? 'topLayer.showModal()' : "topLayer.popover='auto';topLayer.showPopover()"};topLayer.querySelector('button').focus();void 0;`);
        await escape(); result.after = await snapshot();
        assert.equal(await js(nativeLayer === 'dialog' ? 'topLayer.open' : "topLayer.matches(':popover-open')"), false);
        assert.equal(result.after.previews, 1, 'the image below the native layer must remain open'); draft(result.after);
      });
    }
    await run('stacked image previews close only the top preview per Escape', async result => {
      await openSheet(); await click('#wesAttachTray .catt-openable');
      await js("document.querySelector('#wesAttachTray .catt-openable').click();void 0;");
      await until("document.querySelectorAll('.catt-preview').length===2");
      await escape(); result.after = await snapshot(); assert.equal(result.after.previews, 1); draft(result.after);
      await escape(); assert.equal((await snapshot()).previews, 0); draft(await snapshot());
    });
    await run('conversation image Escape preserves its composer and workspace', async result => {
      await js(`inlineHost.innerHTML='<textarea id="chatText">未发送的会话正文</textarea><div id="chatTray"></div>';
        window.chatAttachments=ConversationAttachments.create({host:inlineHost,tray:chatTray});chatAttachments.add([pngFile]);void 0;`);
      await until("!!document.querySelector('#chatTray .catt-openable')");
      await click('#chatTray .catt-openable'); await escape(); result.after = await snapshot();
      assert.equal(result.after.previews, 0); background(result.after);
      assert.equal(await js('chatText.value'), '未发送的会话正文');
      assert.deepEqual(await js('chatAttachments.names()'), ['隔离截图.png']);
    });
    await run('automation form stays open when an attachment preview consumes Escape', async result => {
      await js("WorkAutomationSheet.open({proposal:{title:'未保存的自动化',note:'保持原文'},text:''});void 0;");
      await until("!!document.querySelector('#wazForm')");
      await js(`window.chatAttachments=ConversationAttachments.create({host:inlineHost,tray:inlineHost});chatAttachments.add([pngFile]);void 0;`);
      await until("!!document.querySelector('#inlineHost .catt-openable')");
      await js("document.querySelector('#inlineHost .catt-openable').click();void 0;");
      await until("!!document.querySelector('.catt-preview')"); await escape(); result.after = await snapshot();
      assert.equal(result.after.previews, 0); assert.equal(await js('WorkAutomationSheet.active()?.mode'), 'automation'); background(result.after);
    });
    await run('repeated Escape without overlays keeps the workspace open', async result => {
      await js('document.body.focus();void 0;');
      await escape(); await escape(); await escape(); result.after = await snapshot(); background(result.after);
    });
    await run('repeated Escape in the composer preserves text and attachments', async result => {
      await js(`inlineHost.innerHTML='<textarea id="chatText">未发送的会话正文</textarea><div id="chatTray"></div>';
        window.chatAttachments=ConversationAttachments.create({host:inlineHost,tray:chatTray});chatAttachments.add([pngFile]);
        chatText.focus();void 0;`);
      await until("!!document.querySelector('#chatTray .catt-openable')");
      await escape(); await escape(); result.after = await snapshot(); background(result.after);
      assert.equal(await js('chatText.value'), '未发送的会话正文');
      assert.deepEqual(await js('chatAttachments.names()'), ['隔离截图.png']);
    });
    const workspace = win;
    // Load capture and bubble handlers together to cover both Escape interception and main-page close wrappers.
    for (const [panel, id, opener, closer] of [
      ['settings', 'settingsPanel', 'openSettings', 'closeSettings'],
      ['skin', 'skinManager', 'openSkinManager', 'closeSkinManager'],
      ['notices', 'noticePanel', 'openNoticePanel', 'closeNoticePanel'],
      ['history', 'historyBoard', 'openHistoryBoard', 'closeHistoryBoard'],
      ['workitems', 'historyBoard', 'openTaskCenter', 'closeHistoryBoard'],
    ]) {
      const result = { name: panel + ' primary page ignores Escape and keeps explicit close', ok: false };
      const toolFixture = path.join(temporary, panel + '.html');
      fs.writeFileSync(toolFixture, '<!doctype html><html data-desk-panel="' + panel + '"><body>' +
        '<div id="' + id + '"><textarea id="draft">未保存的内容</textarea><button id="close">关闭</button></div><script>' +
        'window.__deskPanel=' + JSON.stringify(panel) + ';window.cfg={};window.tasks=[];window.errors=[];' +
        'addEventListener("error",e=>errors.push(e.error?.stack||e.message));window.TaskPriority={labels:{}};window.Store={};' +
        'window.initData=async()=>{};window.hideCtx=()=>{};window.nativeCloseCalls=0;window.panelCloseCalls=0;' +
        'window.soduWorkAPI={closeDeskWindow:()=>nativeCloseCalls++};window.' + opener + '=()=>document.getElementById(' + JSON.stringify(id) + ').classList.add("show");' +
        'window.' + closer + '=()=>{panelCloseCalls++;document.getElementById(' + JSON.stringify(id) + ').classList.remove("show")};' +
        'document.getElementById("close").onclick=()=>window[' + JSON.stringify(closer) + ']();</script>' +
        ['components/panels/panels.js', 'desk-boot.js'].map(scriptTag).join('') + '</body></html>');
      win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
      try {
        await win.loadFile(toolFixture); await until('document.getElementById(' + JSON.stringify(id) + ').classList.contains("show")');
        await js('draft.focus();void 0;'); await escape(); await escape();
        assert.deepEqual(await js('[nativeCloseCalls,panelCloseCalls,draft.value]'), [0, 0, '未保存的内容']);
        assert.equal(await js('document.getElementById(' + JSON.stringify(id) + ').classList.contains("show")'), true);
        await js('window.pop=document.createElement("div");pop.popover="auto";pop.textContent="菜单";document.body.append(pop);pop.showPopover();void 0;');
        await escape(); assert.equal(await js('pop.matches(":popover-open")'), false);
        await escape(); assert.equal(await js('nativeCloseCalls'), 0);
        await js('document.getElementById("close").click();void 0;');
        assert.deepEqual(await js('[nativeCloseCalls,panelCloseCalls]'), [1, 1]);
        assert.deepEqual(await js('errors'), []); result.ok = true;
      } catch (error) { result.error = String(error.stack || error); }
      finally { win.destroy(); win = workspace; }
      report.cases.push(result);
    }
    const addResult = { name: 'legacy standalone requirement form survives Escape and still closes explicitly', ok: false };
    const addFixture = path.join(temporary, 'add.html');
    fs.writeFileSync(addFixture, fs.readFileSync(fixture, 'utf8').replace('data-desk-panel="workspace"', 'data-desk-panel="add"')
      .replace('window.__deskPanel="workspace"', 'window.__deskPanel="add"'));
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
    try {
      await win.loadFile(addFixture); await until("!!document.querySelector('#cpTitle')");
      await js('cpTitle.value="未保存的独立需求";cpTitle.focus();void 0;'); await escape(); await escape();
      assert.equal(await js('cpTitle.value'), '未保存的独立需求'); assert.equal(await js('nativeCloseCalls'), 0);
      await js('WorkEntrySheet.close();void 0;'); assert.equal(await js('nativeCloseCalls'), 1);
      assert.deepEqual(await js('errors'), []); addResult.ok = true;
    } catch (error) { addResult.error = String(error.stack || error); }
    finally { win.destroy(); win = workspace; }
    report.cases.push(addResult);
    report.errors.push(...await js('errors'));
    assert.deepEqual(report.errors, []);
    assert(report.cases.every(result => result.ok), report.cases.filter(result => !result.ok).map(result => result.name).join('; '));
    report.ok = true;
  }).catch(async error => {
    report.error = String(error.stack || error);
    if (win && !win.isDestroyed()) report.rendererErrors = await js('window.errors || []').catch(() => []);
    if (win && !win.isDestroyed()) report.startup = await js(`({priority:typeof TaskPriority,requirements:typeof Requirements,
      view:typeof RequirementsView,host:typeof WorkspaceHost,draft:typeof ComposeDraft,entry:typeof WorkEntrySheet,
      ready:document.readyState,scripts:[...document.scripts].map(s=>s.src),body:document.body.innerText.slice(0,500)})`).catch(() => null);
  }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.map(({ name, ok, error }) => ({ name, ok, error })), errors: report.errors, error: report.error }, null, 2));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
