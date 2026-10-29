'use strict';
// Production chat/compose DOM and CSS in a hidden Electron window. Session data
// is synthetic; no live model, business service or user profile is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename],
    { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const out = path.resolve(client, '../outputs/composer-fixed-20261023');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-composer-height-'));
  const report = { ok: false, layouts: [], cases: [], errors: [] };
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  let win;
  const js = source => win.webContents.executeJavaScript(source, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function stylesheet(file) {
    await js(`new Promise((resolve,reject)=>{const e=document.createElement('link');e.rel='stylesheet';e.href=${JSON.stringify(pathToFileURL(path.join(client, file)).href)};e.onload=()=>resolve(true);e.onerror=()=>reject(Error('Stylesheet failed'));document.head.appendChild(e)})`);
  }
  async function mount(stage) {
    if (win) win.destroy();
    win = new BrowserWindow({ show: false, width: 1050, height: 760,
      webPreferences: { preload: path.join(client, 'preload.js'), offscreen: true,
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, done) => done({ cancel: true }));
    win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
    const filename = path.join(profile, stage + '.html');
    fs.writeFileSync(filename, '<!doctype html><html><meta charset="utf-8"><style>body{margin:0;font:15px system-ui}.desk-panel{position:absolute;inset:0}#cpChat{height:100vh}</style><body>' + (stage === 'chat' ? '<div id="cpChat"></div>' : '') + '</body></html>');
    await win.loadFile(filename);
    for (const file of ['theme/variables.css', 'components/workspace/workspace-shell.css',
      'components/panels/panels-chat.css', 'components/panels/chat-collaboration.css',
      'components/panels/conversation-attachments.css', 'components/panels/chat-plugin-mention.css',
      'components/panels/panels-compose-skills.css', 'components/panels/work-intent.css',
      'components/panels/work-composer.css']) await stylesheet(file);
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.petSay=()=>{};window.SoduWorkAPI={online:true,myModels:async()=>({usable:[]}),listTeammates:async()=>[],pluginCatalog:async()=>({items:[]})};void 0;`);
    if (stage === 'chat') {
      const fixture = path.join(__dirname, 'fixtures/workbench-annotations.html');
      for (const match of fs.readFileSync(fixture, 'utf8').matchAll(/<script src="([^"]+)"/g))
        await js(fs.readFileSync(path.resolve(path.dirname(fixture), match[1]), 'utf8') + '\nvoid 0;');
      await js(read('components/panels/panels-chat-chrome.js') + '\nvoid 0;');
      await js(`NativeChat.enter('','height-fixture',{});void 0;`);
      for (let i = 0; i < 100; i++) {
        if (await js(`NativeChat.sessionInfo().ref==='height-fixture'`)) break;
        await delay(30);
      }
    } else {
      for (const file of ['components/panels/work-composer.js', 'components/panels/compose-surface.js']) await js(read(file) + '\nvoid 0;');
      await js(`(()=>{const p=ComposeSurface.create({_bind:()=>{}})._panel();p.classList.add('show');p.dataset.stage='compose'})()`);
    }
    assert.equal(await js(`CSS.supports('field-sizing','content')`), true, 'Bundled Chromium supports native content sizing');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await delay(80);
  }
  async function geometry(stage, label) {
    if (stage === 'chat') report.structure = await js(`Array.from(document.querySelectorAll('.nchat-main,.nchat-content-area,.nchat-foot,.nchat-footin,.nchat-entry-dock,.nbox,#nchatQueue')).map(e=>({name:e.className,height:e.clientHeight,scrollHeight:e.scrollHeight,top:e.getBoundingClientRect().top,flex:getComputedStyle(e).flex,min:getComputedStyle(e).minHeight,max:getComputedStyle(e).maxHeight,display:getComputedStyle(e).display}))`);
    const data = await js(`(()=>{const input=document.querySelector(${JSON.stringify(stage === 'chat' ? '#nchatInput' : '#cpInput')}),send=document.querySelector(${JSON.stringify(stage === 'chat' ? '#nchatSend' : '#cpGo')}),outer=document.querySelector(${JSON.stringify(stage === 'chat' ? '.nchat-main' : '.cp-task')});const r=input.getBoundingClientRect(),s=send.getBoundingClientRect(),c=getComputedStyle(input);return{height:r.height,top:r.top,bottom:r.bottom,scrollHeight:input.scrollHeight,clientHeight:input.clientHeight,scrollTop:input.scrollTop,overflow:c.overflowY,maxHeight:c.maxHeight,fieldSizing:c.fieldSizing,value:input.value,sendTop:s.top,sendBottom:s.bottom,sendHit:send.contains(document.elementFromPoint(s.x+s.width/2,s.y+s.height/2)),outerHeight:outer.clientHeight,outerScrollHeight:outer.scrollHeight,outerScrollTop:outer.scrollTop,viewportHeight:innerHeight,horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,focused:document.activeElement===input}})()`);
    report.layouts.push({ stage, label, ...data, value: data.value.length });
    return data;
  }
  async function setText(stage, value, dispatch = true) {
    const selector = stage === 'chat' ? '#nchatInput' : '#cpInput';
    await js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus({preventScroll:true});input.value=${JSON.stringify(value)};input.setSelectionRange(input.value.length,input.value.length);${dispatch ? "input.dispatchEvent(new Event('input',{bubbles:true}));" : ''}})()`);
    await delay(80);
  }
  function expanded(g, text) {
    assert.equal(g.value, text, 'All original text is retained');
    assert.ok(g.height <= Math.min(624, g.viewportHeight * .4) + 1, 'Long text is capped to available viewport space');
    assert.ok(g.scrollHeight > g.clientHeight + 1, 'Overflowing text stays available through internal scrolling');
    assert.equal(g.overflow, 'auto');
    assert.equal(g.horizontalOverflow, false);
    assert.ok(g.outerScrollHeight <= g.outerHeight + 1, 'The composer never makes the whole chat or start page scroll');
    assert.ok(g.sendHit && g.sendTop >= 0 && g.sendBottom <= g.viewportHeight, 'Send remains reachable while editing: ' + JSON.stringify(g));
  }
  async function scrollTranscript(label) {
    const before = await geometry('chat', label + '-before-scroll');
    const track = await js(`(()=>{const e=document.querySelector('#nchatScroll');e.scrollTop=0;const r=e.getBoundingClientRect();return{x:Math.floor(r.right-2),top:Math.round(r.top+10),bottom:Math.floor(r.bottom-50),height:e.clientHeight,scrollHeight:e.scrollHeight}})()`);
    assert.ok(track.scrollHeight > track.height * 2, 'History overflows the transcript');
    win.webContents.sendInputEvent({ type: 'mouseDown', x: track.x, y: track.top, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: track.x, y: Math.round(track.top + (track.bottom - track.top) * i / 12), modifiers: ['leftButtonDown'] });
      await delay(12);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: track.x, y: track.bottom, button: 'left', clickCount: 1 });
    await delay(80);
    assert.ok(await js(`document.querySelector('#nchatScroll').scrollTop > 0`), 'Native scrollbar dragging scrolls message history');
    const after = await geometry('chat', label + '-after-scroll');
    assert.ok(Math.abs(before.top - after.top) < 1 && Math.abs(before.sendTop - after.sendTop) < 1,
      'The editor and send button remain anchored during native transcript scrollbar dragging');
    assert.equal(after.outerScrollTop, 0, 'No outer chat scrolling');
    assert.ok(after.sendHit, 'Send is still clickable after scrolling history');
    const bottom = await js(`(()=>{const e=document.querySelector('#nchatScroll');e.scrollTop=e.scrollHeight;return e.scrollTop})()`);
    await delay(80);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: track.x, y: track.bottom + 45, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: track.x, y: Math.round(track.bottom + 45 + (track.top - track.bottom - 45) * i / 12), modifiers: ['leftButtonDown'] });
      await delay(12);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: track.x, y: track.top, button: 'left', clickCount: 1 });
    await delay(80);
    assert.ok(await js(`document.querySelector('#nchatScroll').scrollTop < ${bottom}`), 'Native scrollbar dragging also moves upward through history');
    const upward = await geometry('chat', label + '-after-upward-scroll');
    assert.ok(Math.abs(before.top - upward.top) < 1 && upward.sendHit, 'Upward history scrolling keeps the composer anchored and usable');
    report.cases.push(label + ': native transcript scrollbar drags in both directions leave the editor and actions fixed');
  }
  async function crowdedChat() {
    await mount('chat');
    win.setContentSize(500, 500);
    await js(`(()=>{const box=document.querySelector('.nbox'),queue=document.querySelector('#nchatQueue');
      queue.classList.add('show');queue.innerHTML='<div class="nqueue-stack"><div class="nqueue-toolbar">待处理消息</div><div class="nqueue-items">'+Array.from({length:8},(_,i)=>'<div class="nqueue-row"><span class="nqueue-copy">待处理 '+i+'</span></div>').join('')+'</div></div>';
      const tray=document.createElement('div');tray.dataset.fixture='true';tray.className='catt-tray show';tray.innerHTML=Array.from({length:10},(_,i)=>'<div class="catt-item"><span class="catt-file">TXT</span><span class="catt-copy"><b>参考文件 '+i+'</b><small>测试资料</small></span><button>×</button></div>').join('');box.prepend(tray);
      const plugins=document.createElement('div');plugins.dataset.fixture='true';plugins.className='nplugin-strip';plugins.innerHTML='<span class="nplugin-chip">已选插件</span>';box.prepend(plugins);
    })()`);
    await setText('chat', '完整需求\n'.repeat(100), false);
    const g = await geometry('chat', 'crowded-narrow');
    expanded(g, '完整需求\n'.repeat(100));
    const details = await js(`(()=>{const scroll=document.querySelector('#nchatScroll'),tray=document.querySelector('[data-fixture].catt-tray');return{transcriptHeight:scroll.clientHeight,queueHeight:document.querySelector('.nqueue-items').clientHeight,attachmentHeight:tray.clientHeight,attachmentScroll:tray.scrollHeight,attachmentWidth:tray.clientWidth,attachmentScrollWidth:tray.scrollWidth}})()`);
    assert.ok(details.transcriptHeight >= 100, 'Message history keeps readable space with queued messages and attachments');
    assert.ok(details.attachmentHeight >= 60 && details.attachmentScroll <= details.attachmentHeight + 1, 'Attachment cards are fully visible without vertical clipping');
    assert.ok(details.attachmentScrollWidth > details.attachmentWidth, 'Extra attachments remain accessible along the horizontal rail');
    assert.ok(details.queueHeight >= 34, 'At least one queued message stays readable');
    await scrollTranscript('crowded-narrow');
    fs.writeFileSync(path.join(out, 'chat-crowded-narrow.png'), (await win.webContents.capturePage()).toPNG());
    report.cases.push('chat: queued messages, multiple attachments and selected plugin fit a 500px-high window');
    await js(`document.querySelector('[data-fixture].catt-tray').innerHTML='<div class="catt-item catt-image"><button class="catt-image-preview" aria-label="预览图片">图片预览</button><button data-catt-remove aria-label="移除图片">×</button></div>';void 0;`);
    await delay(80);
    expanded(await geometry('chat', 'image-queue-narrow'), '完整需求\n'.repeat(100));
    assert.ok(await js(`(()=>{const tray=document.querySelector('[data-fixture].catt-tray'),card=tray.firstElementChild;return tray.clientHeight>=card.offsetHeight&&tray.scrollHeight<=tray.clientHeight+1})()`), 'Image attachments remain fully visible beside queue and draft');
    report.cases.push('chat: complete image attachment remains visible with plugin, queue and expanded draft');
  }
  async function exercise(stage) {
    await mount(stage);
    const initial = await geometry(stage, 'empty');
    await setText(stage, 'Short line\n'.repeat(6));
    const growing = await geometry(stage, 'growing');
    assert.ok(growing.height > initial.height && growing.height < Math.min(624, growing.viewportHeight * .4), 'Short text grows naturally before reaching the limit');
    assert.ok(growing.scrollHeight <= growing.clientHeight + 1, 'Short text needs no internal scrollbar');
    // Under the text-card threshold, but enough explicit lines to exceed the limit.
    const lines = Array.from({ length: 200 }, (_, i) => '第' + i + '行').join('\n');
    await setText(stage, lines);
    expanded(await geometry(stage, 'multiline'), lines);
    report.cases.push(stage + ': multiline grows to the viewport limit, then scrolls internally; send stays visible');
    const outer = stage === 'chat' ? '.nchat-main' : '.cp-task';
    const inputSelector = stage === 'chat' ? '#nchatInput' : '#cpInput';
    await js(`document.querySelector(${JSON.stringify(outer)}).scrollTop=0;document.querySelector(${JSON.stringify(inputSelector)}).scrollTop=0;void 0;`);
    let g = await geometry(stage, 'start');
    assert.ok(g.top >= 0 && g.top < g.viewportHeight - 100, 'First line is accessible');
    assert.equal(g.scrollTop, 0, 'Internal scroll reaches the first line');
    assert.ok(g.sendHit, 'Sticky send is accessible at the start');
    await js(`(()=>{for(const selector of ${JSON.stringify([outer,inputSelector])}){const e=document.querySelector(selector);e.scrollTop=e.scrollHeight}})()`);
    g = await geometry(stage, 'end');
    assert.ok(g.bottom <= g.viewportHeight && g.bottom > 0, 'Last line is accessible');
    assert.ok(g.scrollTop > 0 && Math.abs(g.scrollTop + g.clientHeight - g.scrollHeight) <= 1, 'Internal scroll reaches the last line');
    assert.ok(g.sendHit, 'Send is accessible at the end');
    fs.writeFileSync(path.join(out, stage + '-expanded.png'), (await win.webContents.capturePage()).toPNG());
    if (stage === 'chat') await scrollTranscript('expanded');
    // Restore programmatically, as saved drafts and expanded text cards do.
    const restored = ('完整需求 abc 中文 ' + 'word '.repeat(10) + '\n').repeat(100);
    await setText(stage, restored, false);
    expanded(await geometry(stage, 'restored'), restored);
    win.setContentSize(500, 500);
    await delay(100);
    expanded(await geometry(stage, 'narrow'), restored);
    report.cases.push(stage + ': restored full text and viewport-width changes resize without another input event');
    await setText(stage, '', false);
    g = await geometry(stage, 'cleared');
    assert.ok(g.height <= initial.height + 1, 'Clearing or folding returns to the original height');
    assert.ok(g.scrollHeight <= g.clientHeight + 1 && g.scrollTop === 0, 'Clearing removes the internal scrollbar and resets its position');
    assert.ok(g.sendHit && g.outerScrollTop < 2, 'Collapsed composer and page position recover');
    await setText(stage, '继续补充');
    g = await geometry(stage, 'short');
    assert.ok(g.height <= initial.height + 1 && g.focused, 'Normal editing and input focus survive');
    assert.deepEqual(await js('errors'), []);
    report.cases.push(stage + ': clear/fold restores compact height and keeps focus for further editing');
  }
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(profile, 'profile'));
  app.on('window-all-closed', () => {});
  const state = { status: 'idle', messages: Array.from({length:60},(_,i)=>i%2
    ? { role: 'assistant', blocks: [{ kind: 'text', text: '原聊天内容仍可阅读。第 '+i+' 条消息。', done: true }], done: true }
    : { role: 'user', text: '布局验收 '+i, done: true }), tools: [],
    execution: { running: false, queue: [], turnQueue: {} } };
  app.whenReady().then(async () => {
    ipcMain.handle('pi-session-open', () => ({ ok: true, ref: 'height-fixture', sessionId: 'height-fixture', cwd: profile, snapshot: state }));
    for (const [name, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] },
      'pi-session-outputs': { ok: true, files: [], artifacts: [] }, 'pi-session-runtimes': { ok: true, runtimes: [] },
      'pi-session-snapshot': { ok: true, snapshot: state }, 'pi-session-release': { ok: true },
      'access-preferences-get': { ok: true } })) ipcMain.handle(name, () => value);
    await exercise('chat');
    await exercise('compose');
    await crowdedChat();
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, layouts: report.layouts.length, cases: report.cases,
      error: report.error, report: path.join(out, 'report.json') }));
    if (win) win.destroy();
    app.exit(process.exitCode || 0);
  });
}
