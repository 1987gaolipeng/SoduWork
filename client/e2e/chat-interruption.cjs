'use strict';
// Production replay, renderer and sidebar in isolated Electron. Synthetic
// archives only: no real model, Hub, user profile or business data is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '..'), output = process.argv[2];
  assert.ok(output && path.isAbsolute(output), 'An absolute evidence directory is required');
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-interruption-'));
  app.setPath('userData', path.join(temp, 'profile')); app.disableHardwareAcceleration();
  const scripts = ['vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js',
    ...['agent-brand', 'chat-crew', 'chat-thinking-collapse', 'chat-dom-patch', 'chat-decorate-carry',
      'chat-plugin-draft-placement', 'chat-output-links', 'chat-deliveries', 'panels-chat-tools', 'chat-context-meter',
      'panels-chat-status', 'chat-scroll-follow', 'chat-markdown', 'chat-acceptance-results', 'chat-turn-summary',
      'chat-message-renderer'].map(name => 'components/panels/' + name + '.js'),
    'components/workspace/workspace-chat-history.js', 'components/workspace/workspace-sidebar-state.js',
    'components/workspace/workspace-chat-list.js'];
  const styles = [...fs.readFileSync(path.join(root, 'desk.html'), 'utf8')
    .matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => match[1]);
  const fixture = path.join(temp, 'fixture.html');
  fs.writeFileSync(fixture, `<!doctype html><html lang="zh-CN" data-theme="azure"><meta charset="utf-8">
    <base href="${pathToFileURL(root + path.sep).href}"><title>Interrupted conversation regression</title>
    ${styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('\n')}
    <style>body{margin:0;background:var(--bg-0);color:var(--ink);font:14px var(--font-ui)}
      #sidebar{position:absolute;left:0;top:0;width:250px;height:100vh;overflow:auto;padding:16px;background:var(--bg-1)}
      #cpChat{position:absolute;left:270px;right:0;height:100vh}.ws-chat-title{max-width:160px}</style>
    <div class="workspace-shell"><aside id="sidebar" class="ws-side"><div id="wsSideScroll"><section id="wsChatsBox"><div id="chats"></div></section>
      <section id="wsPinnedBox"><div id="pinned"></div></section></div></aside></div>
    <div id="cpChat" class="nchat"><div class="nchat-main"><div id="nchatScroll" class="nchat-scroll">
      <div id="nchatList" class="nchat-inner"></div></div></div></div>
    ${scripts.map(file => '<script src="' + file + '"></script>').join('\n')}
    <script>
      window.errors=[];addEventListener('error',e=>errors.push(e.message));
      document.documentElement.dataset.workspaceView='create';document.documentElement.dataset.workspaceLayout='conversation';
      document.documentElement.dataset.skin='box';
      const noop=()=>{};window.locale='zh-CN';window.translations={};
      window.SoduWorkI18n={getLocale:()=>locale,translateText:text=>translations[text]||text};
      window.SoduWorkAPI={taskStorageKey:()=> 'interruption-fixture'};window.opened=[];
      window.WorkspaceHost={open:(page,options)=>opened.push(options.chatId)};
      window.ctx={_ref:'fixture',_sessionOptions:{},_collabTasks:new Map(),_collabEntries:()=>[],
        _openTool:new Set(),_openThink:new Set(),_closedThink:new Set(),_openToolGroup:new Set(),_pending:'',_pendingSentAt:0,
        _pendingPlugins:[],_pendingAttachmentNames:[],_outs:[],_api:()=>({}),_mount:()=>document.querySelector('#cpChat'),
        _messageWindowSize:80,_renderQueue:noop,_renderTaskStartPrompt:noop,_syncSlowStatusTicker:noop,_paintBar:noop,esc:ChatTools.esc,
        _snap:{status:'idle',execution:{running:false},tools:[],messages:[]}};
      window.metrics=ChatStatus.createThinking(()=>({snap:ctx._snap,ref:ctx._ref,pending:ctx._pending,document,esc:ctx.esc,tokenText:String}));
      ctx._syncThinkingClock=metrics.syncThinkingClock;ctx._turnMetricsHtml=metrics.metricsHtml;ctx._thinkingStatusHtml=metrics.statusHtml;
      window.renderer=ChatMessageRenderer.create(ctx);
      window.side={...WorkspaceChatHistory,root:document.querySelector('#sidebar'),active:'create',activeChatId:'',
        chatItems:[],chatNames:new Map(),wsT:(_key,text)=>text,icon:()=>'',mount:noop,_empty:noop,
        chats:document.querySelector('#chats'),pinnedChats:document.querySelector('#pinned')};
      window.list=WorkspaceChatList.create(side);Object.assign(side,list);
    </script></html>`);
  const entry = (role, content, extra = {}) => ({ type: 'message', message: { role, content, ...extra } });
  const entries = [entry('user', '整理出行计划', { sentAt: 1000 }),
    entry('assistant', [{ type: 'text', text: '已整理部分路线，接下来核对交通信息。' }], { stopReason: 'toolUse', completedAt: 3000 })];
  const snapshot = source => {
    const acc = require('../main/pi-session/event-stream').create();
    require('../main/pi-session/history-seed').seed(acc, { state: { messages: [] }, sessionManager: { getEntries: () => source } });
    return { ...acc.snapshot(), execution: { running: false } };
  };
  let win;
  const js = async code => {
    try {
      const result = await win.webContents.executeJavaScript(`(async()=>{try{return await eval(${JSON.stringify(code)})}catch(e){return {__error:e.stack}}})()`, true);
      if (result?.__error) throw Error(result.__error);
      return result;
    }
    catch (error) { throw Error(error.message + '\nExpression: ' + code); }
  };
  const publish = async snap => { await js(`ctx._snap=${JSON.stringify(snap)};renderer._render();void 0`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); };
  const shot = async name => fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const report = { ok: false, cases: [], boundary: 'Real Electron production rendering and replay; synthetic data, no real model or Hub.' };
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 740,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    win.webContents.on('console-message', event => {
      if (event.level === 'error') console.error(event.message);
    });
    await win.loadFile(fixture);
    await js(`list.upsertChat({id:'fixture',title:'整理出行计划，核对路线、交通和景点安排并保留已有记录',state:'interrupted',usedHarnesses:['pi']});void 0`);
    await publish(snapshot(entries));
    assert.equal(await js('document.querySelector(".nturn-outcome").textContent'), '本轮已中断');
    assert.equal(await js('document.querySelectorAll(".nturn-outcome button,[data-turn-toggle],[data-delivery-final=true]").length'), 0);
    assert.match(await js('document.querySelector("#nchatList").textContent'), /已整理部分路线/);
    assert.equal(await js('document.querySelector(".ws-chat").title'), '');
    assert.equal(await js('Array.from(document.querySelectorAll(".ws-chat [title]")).some(node=>node.title)'), false);
    assert.match(await js('document.querySelector(".ws-chat").getAttribute("aria-label")'), /已停止/);
    await shot('interrupted-zh'); report.cases.push('Interrupted reopen keeps partial content and shows one plain line, without recovery controls');
    const stopped = entries.concat({ type: 'custom', customType: require('../main/pi-session/turn-outcome').ENTRY_TYPE,
      data: { kind: 'stopped', sentAt: 1000, at: 20000 } });
    const snap = snapshot(stopped); await publish(snap);
    assert.equal(await js('document.querySelector(".nturn-outcome").textContent'), '你在 19 秒后停止了');
    await publish({ ...snap, execution: { running: false, elapsedMs: 999999 } });
    assert.equal(await js('document.querySelector(".nturn-outcome").textContent'), '你在 19 秒后停止了');
    await shot('stopped-zh');
    for (const [elapsedMs, expected, name] of [[318000, '你在 5 分 18 秒后停止了', 'minutes'],
      [3661000, '你在 1 小时 1 分 1 秒后停止了', 'hours']]) {
      const longer = snapshot(entries.concat({ type: 'custom', customType: require('../main/pi-session/turn-outcome').ENTRY_TYPE,
        data: { kind: 'stopped', sentAt: 1000, at: 1000 + elapsedMs } }));
      await publish(longer);
      assert.equal(await js('document.querySelector(".nturn-outcome").textContent'), expected);
      await publish({ ...longer, execution: { running: false, elapsedMs: 999999999 } });
      assert.equal(await js('document.querySelector(".nturn-outcome").textContent'), expected);
      await shot('stopped-' + name);
    }
    for (const [locale, file] of [['en-US', 'en-US-chat.js'], ['ja-JP', 'ja-JP-runtime-surfaces.js'], ['ko-KR', 'ko-KR-runtime-surfaces.js']]) {
      const translations = require('../core/locales/' + file);
      await js(`window.locale=${JSON.stringify(locale)};window.translations=${JSON.stringify(translations)};void 0`);
      await publish(snap);
      assert.doesNotMatch(await js('document.querySelector(".nturn-outcome").textContent'), /你|停止了/);
      await shot('stopped-' + locale);
    }
    await js('window.locale="zh-CN";window.translations={};void 0');
    await publish(snapshot(stopped.concat(entry('user', '继续核对交通', { sentAt: 30000 }),
      entry('assistant', [{ type: 'text', text: '交通信息已核对，计划已补全。' }], { stopReason: 'stop', completedAt: 34000 }))));
    assert.equal(await js('document.querySelectorAll(".nturn-outcome").length'), 1);
    assert.match(await js('document.querySelector("#nchatList").textContent'), /你在 19 秒后停止了/);
    assert.match(await js('document.querySelector("#nchatList").textContent'), /交通信息已核对/);
    assert.equal(await js('document.querySelectorAll(".nturn-summary").length'), 1);
    await shot('continued-zh'); report.cases.push('Fixed stop duration survives reopen, growing runtime clocks, four locales and a completed followup');
    await js('document.querySelector(".ws-chat-row").dispatchEvent(new MouseEvent("mouseenter"));void 0');
    await new Promise(resolve => setTimeout(resolve, 1200));
    const scroll = await js('(()=>{const t=document.querySelector(".ws-chat-title-text");return{left:new DOMMatrixReadOnly(getComputedStyle(t).transform).m41}})()');
    assert.ok(scroll.left < 0, JSON.stringify(scroll));
    await js('document.querySelector(".ws-chat").click();void 0');
    assert.deepEqual(await js('opened'), ['fixture']);
    report.cases.push('Sidebar has no title tooltip; in-row overflow scrolling and navigation remain functional');
    assert.deepEqual(await js('window.errors'), []); report.ok = true;
  }).catch(async error => { report.error = error.stack; if (win) { try { await shot('failure'); } catch (_) {} } })
    .finally(() => { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1); });
}
