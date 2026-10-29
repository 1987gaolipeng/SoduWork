'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/workspace-runtime-label');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-label-')));
  fs.mkdirSync(output, { recursive: true });
  const report = { ok: false, boundary: 'Production history reconciliation, icon rendering and styles in isolated Electron with synthetic whole-conversation provenance; network blocked.', cases: [], screenshots: [] };
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  async function setup() {
    await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
    const sheets = [...read('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => match[1]);
    const urls = sheets.map(file => require('node:url').pathToFileURL(path.join(client, file)).href);
    await js(`(()=>{const base=document.createElement('base');base.href=${JSON.stringify(require('node:url').pathToFileURL(client + path.sep).href)};document.head.prepend(base)})()`);
    await js(`(async()=>{document.querySelectorAll('link[rel=stylesheet]').forEach(e=>e.remove());await Promise.all(${JSON.stringify(urls)}.map(href=>new Promise((resolve,reject)=>{const e=document.createElement('link');e.rel='stylesheet';e.href=href;e.onload=resolve;e.onerror=reject;document.head.append(e)})));})()`);
    for (const file of ['components/panels/agent-brand.js', 'components/workspace/workspace-chat-history.js', 'components/workspace/workspace-chat-list.js']) await js(read(file) + '\nvoid 0;');
    await js(`document.documentElement.dataset.workspaceView='create';document.documentElement.dataset.workspaceLayout='conversation';document.documentElement.dataset.skin='box';
      document.body.innerHTML='<div class="workspace-shell"><nav class="ws-rail"></nav><aside class="ws-side"><div id="wsSideScroll"><section id="wsPinnedBox"><div id="pinned"></div></section><section id="wsChatsBox" class="ws-list"><div class="ws-list-title">最近聊天</div><div id="chats"></div></section></div></aside></div>';
      window.ctx={...WorkspaceChatHistory,root:document.querySelector('.workspace-shell'),active:'create',activeChatId:'saved-harness',chatItems:[],chatNames:new Map(),wsT:(_k,f)=>f,icon:()=>'',mount:()=>{},_empty:()=>{}};
      ctx.chats=document.querySelector('#chats');ctx.pinnedChats=document.querySelector('#pinned');window.list=WorkspaceChatList.create(ctx);ctx.renderChats=list.renderChats;ctx.setActiveChat=list.setActiveChat;
      window.openedChats=[];window.WorkspaceHost={open:(page,options)=>openedChats.push({page,options})};
      void 0;`);
  }
  async function labels() {
    return js(`[...document.querySelectorAll('.ws-chat-row')].map(row=>{const e=row.querySelector('.ws-chat-runtime'),title=row.querySelector('.ws-chat-title');return{id:row.querySelector('.ws-chat').dataset.chatId,text:e.textContent,title:e.title,width:e.clientWidth,scrollWidth:e.scrollWidth,titleWidth:title.clientWidth,hidden:e.hidden,icons:[...e.querySelectorAll('[data-agent-brand]')].map(n=>n.dataset.agentBrand),imagesLoaded:[...e.querySelectorAll('img')].every(n=>n.complete&&n.naturalWidth>0),rowWidth:row.clientWidth,rowScrollWidth:row.scrollWidth}})`);
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    await setup();
    await js(`list.upsertChat({localId:'draft-harness',title:'你好',adapterId:'codex-harness',pending:true,state:'starting',at:1000});void 0;`);
    assert.equal((await labels())[0].hidden, true, 'An unsent selection is not execution provenance');
    const saved = [
      {id:'saved-harness',title:'你好',adapterId:'claude',usedHarnesses:['pi','codex-harness','Pi','harness2','Google Harness²'],state:'completed',live:false,at:1000},
      {id:'native',title:'使用 Codex 整理资料',adapterId:'codex',usedHarnesses:['codex'],at:900},
      {id:'legacy',title:'旧记录兼容',runtime:'codex-harness',at:800},
      {id:'unused',title:'尚未开始的需求草稿',adapterId:'pi',usedHarnesses:[],at:700},
      {id:'many',title:'多种底座一起完成的长期工作',adapterId:'pi',usedHarnesses:['pi','codex-harness','harness2','codex','claude','qwen','dsh','opencode','pi'],at:600},
    ];
    await js(`list.setChats(${JSON.stringify(saved)});localStorage.setItem('fixture-history',JSON.stringify(ctx.chatItems));void 0;`);
    assert.deepEqual((await labels()).map(row => row.icons), [['pi','codex-harness','harness2'],['codex'],['codex-harness'],[],['pi','codex-harness','harness2','codex','claude','qwen','dsh','opencode']]);
    assert.ok((await labels()).every(row=>row.text===''), 'Harness names are no longer visible text');
    report.cases.push('Whole-conversation provenance renders each canonical harness once and ignores the current unused selection');
    await js(`list.updateChatState({sessionId:'saved-harness',presence:{...ctx.chatItems.find(c=>c.id==='saved-harness'),usedHarnesses:['pi','codex-harness','harness2','qwen']}});localStorage.setItem('fixture-history',JSON.stringify(ctx.chatItems));void 0;`);
    assert.deepEqual((await labels())[0].icons, ['pi','codex-harness','harness2','qwen']);
    assert.match(await js(`document.querySelector('[data-chat-id="saved-harness"]').getAttribute('aria-label')`), /Pi、Codex Harness、Google Harness²、Qwen Code/);
    report.cases.push('A provenance-only live update repaints icons even when title, state and live status are unchanged');
    await setup();
    await js(`list.setChats(JSON.parse(localStorage.getItem('fixture-history')));void 0;`);
    assert.deepEqual((await labels())[0].icons, ['pi','codex-harness','harness2','qwen']);
    report.cases.push('Reload restores the complete saved provenance and keeps native Codex distinct from Codex Harness');
    for (const width of [220, 180, 320]) {
      await js(`document.documentElement.style.setProperty('--ws-side-w','${width}px');void 0;`);
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const rows = await labels();
      for (const row of rows) {
        assert.equal(row.hidden, row.id==='unused');
        assert.ok(row.width >= row.scrollWidth, `Harness icons clipped at sidebar width ${width}: ${JSON.stringify(row)}`);
        assert.ok(row.titleWidth > 12, 'Conversation title retains visible space');
        assert.ok(row.rowWidth >= row.rowScrollWidth, 'Row does not overflow the sidebar');
        assert.ok(row.imagesLoaded, 'All brand icons resolve to actual local assets');
      }
      const file = path.join(output, `sidebar-${width}.png`);
      fs.writeFileSync(file, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      report.screenshots.push(file); report.cases.push(`Sidebar ${width}px shows up to eight distinct icons without clipping or losing the conversation title`);
    }
    await js(`document.querySelector('[data-chat-id="native"]').focus();void 0;`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
    win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(await js(`openedChats[0]?.options.chatId`), 'native');
    assert.deepEqual((await labels()).find(row=>row.id==='native').icons, ['codex']);
    report.cases.push('Keyboard navigation still opens the same conversation while preserving its harness identity');
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
    if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
