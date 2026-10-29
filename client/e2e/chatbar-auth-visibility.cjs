'use strict';
// Real Chromium computes production CSS and runs production sidebar wiring.
// Fixture authentication plus the production NativeChat composer; no login or models.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 30000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-chatbar-auth-'));
  app.setPath('userData', path.join(temp, 'profile'));
  const out = path.resolve(__dirname, '../../outputs/chatbar-auth-visibility-20261020');
  fs.mkdirSync(out, { recursive: true });
  const report = { ok: false, cases: [], boundary: 'Hidden isolated Chromium with production client-auth/desk CSS and chatbar runtime. Fixture auth states, then production NativeChat/composer with fixture session API; scripted DOM interactions, not native mouse evidence. No credentials, network, account changes or models.' };
  let win;
  const asset = file => pathToFileURL(path.resolve(__dirname, '..', file)).href;
  const js = code => win.webContents.executeJavaScript(code);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (code, label) => {
    const end = Date.now() + 3000;
    while (Date.now() < end) { if (await js(code)) return; await delay(25); }
    throw Error('Timed out: ' + label + ' ' + JSON.stringify(await js(`(()=>{const b=document.querySelector('#chatbarRailBtn'),s=document.querySelector('.chatbar-sprite');return {rect:b?.getBoundingClientRect().toJSON(),hover:b?.matches(':hover'),transform:s&&getComputedStyle(s).transform,hit:document.elementFromPoint(10,b?.getBoundingClientRect().y+28)?.outerHTML.slice(0,250)}})()`)));
  };
  const spriteX = "new DOMMatrix(getComputedStyle(document.querySelector('.chatbar-sprite')).transform).m41";
  const state = () => js(`(()=>{
    const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility==='visible';
    const rail=document.getElementById('chatbarRailBtn'),gate=document.getElementById('soduWorkClientAuthGate');
    const r=rail.getBoundingClientRect(),card=gate.querySelector('.soduwork-auth-card').getBoundingClientRect();
    return {rail:visible(rail),gate:visible(gate),conversation:visible(document.getElementById('composePanel')),
      pending:document.documentElement.classList.contains('soduwork-auth-pending'),expanded:rail.getAttribute('aria-expanded'),
      hit:document.elementFromPoint(Math.min(innerWidth-1,r.x+r.width/2),r.y+r.height/2)?.closest('button')?.id,
      cardFits:card.x>=0&&card.right<=innerWidth};})()`);
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const html = `<!doctype html><html data-desk-panel="chatbar" class="soduwork-auth-pending"><head>
      <meta charset="utf-8"><base href="${asset('desk.html')}">
      <link rel="stylesheet" href="${asset('theme/variables.css')}">
      <link rel="stylesheet" href="${asset('components/client-auth/client-auth.css')}">
      <link rel="stylesheet" href="${asset('desk-window.css')}"></head><body>
      <div id="composePanel"><div class="nchat-head-title">Conversation</div><textarea id="nchatInput" style="min-height:42px"></textarea></div>
      <div id="soduWorkClientAuthGate" class="soduwork-auth-gate"><div class="soduwork-auth-card"><h1>Login required</h1><input aria-label="Account"><button>Login</button></div></div>
      <script>window.__deskPanel='chatbar';window.NativeChat={prepare(){}};window.patches=[];
      window.soduWorkAPI={workPreview:{
        composerHello(){window.modeListener({state:'rail',bounds:{width:64}})},
        composerSetMode(p){patches.push(p);modeListener({state:p.expanded?'pinned':'rail',bounds:{width:p.expanded?400:64}})},
        composerSetWidth(){},onComposerMode(fn){window.modeListener=fn},onComposerSession(){},onComposerPut(){},onComposerSubmit(){}
      }};</script><script src="${asset('components/panels/chatbar-resize.js')}"></script><script src="${asset('components/panels/chatbar-embed.js')}"></script></body></html>`;
    fs.writeFileSync(path.join(temp, 'fixture.html'), html);
    win = new BrowserWindow({ show: false, width: 440, height: 650,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await win.loadFile(path.join(temp, 'fixture.html'));
    win.setContentSize(64, 240);
    await until("document.querySelector('#chatbarRailBtn img').naturalWidth>0", 'original brand icon loads');
    assert.equal(await js("document.querySelector('#chatbarRailBtn img').src"), asset('icon.png'));
    await until("(()=>{const e=document.querySelector('.chatbar-sprite'),r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&new DOMMatrix(getComputedStyle(e).transform).m11>1.1})()", 'arrival lands and enlarges the icon');
    fs.writeFileSync(path.join(out, 'sprite-arrival.png'), (await win.webContents.capturePage()).toPNG());
    await until("!document.getElementById('chatbarRail').classList.contains('is-arriving')", 'arrival finishes');
    assert.equal(await js(spriteX), 12.8, 'idle sprite leaves most of the enlarged icon visible');
    fs.writeFileSync(path.join(out, 'sprite-idle.png'), (await win.webContents.capturePage()).toPNG());
    const railBox = await js("JSON.stringify(document.getElementById('chatbarRailBtn').getBoundingClientRect().toJSON())");
    const railRect = JSON.parse(railBox);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:railRect.x+10,y:railRect.y+railRect.height/2});
    await until(`${spriteX}===0`, 'hover reveals the full sprite');
    assert.equal(await js("JSON.stringify(document.getElementById('chatbarRailBtn').getBoundingClientRect().toJSON())"), railBox, 'hover does not move the hit box');
    assert.equal(await js("patches.filter(p=>Object.hasOwn(p,'expanded')).length"), 0, 'hover does not open the conversation');
    fs.writeFileSync(path.join(out, 'sprite-hover.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
    await until(`${spriteX}===12.8`, 'leaving restores the docked sprite');
    await js("document.getElementById('chatbarRailBtn').focus()");
    await until(`${spriteX}===0`, 'keyboard focus also reveals the sprite');
    await js('document.activeElement.blur()');
    const dragX=railRect.x+20,dragY=railRect.y+40;
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:dragX,y:dragY,button:'left',clickCount:1});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragX-10,y:dragY+28,button:'left',buttons:1});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:dragX-10,y:dragY+28,button:'left',clickCount:1});
    await until("patches.some(p=>Number.isFinite(p.railScreenY))", 'vertical drag reaches mode pipeline');
    assert.equal(await js("patches.filter(p=>Object.hasOwn(p,'expanded')).length"),0,'drag release does not open chat');
    assert.equal(await js("chatbarRailBtn.classList.contains('is-dragging')"),false,'drag releases cleanly');
    report.cases.push('Original packaged icon loads at 64px; entrance drops and enlarges before docking with 80% visible; hover/focus reveal it without moving the hit box or opening chat; captured Chromium drag reports only vertical placement and suppresses the release click.');
    let s = await state();
    assert.equal(s.rail, true); assert.equal(s.gate, false); assert.equal(s.conversation, false);
    assert.equal(s.pending, true); assert.equal(s.expanded, 'false'); assert.equal(s.hit, 'chatbarRailBtn');
    report.cases.push('Pending auth + collapsed rail: entry remains visible and DOM-hit-testable; login form and conversation stay hidden.');
    await js("document.getElementById('chatbarRailBtn').click()");
    for (const width of [280, 440]) {
      win.setContentSize(width, 650);
      s = await state();
      assert.equal(s.rail, false); assert.equal(s.gate, true); assert.equal(s.conversation, false);
      assert.equal(s.pending, true); assert.equal(s.expanded, 'true'); assert.equal(s.cardFits, true);
      const authPin = await js(`(()=>{const b=chatbarPin,r=b.getBoundingClientRect();return {
        visible:getComputedStyle(b).visibility,width:r.width,height:r.height,x:r.x,center:r.y+r.height/2,
        hit:document.elementFromPoint(12,r.y+r.height/2)?.closest('button')?.id};})()`);
      assert.equal(authPin.visible, 'visible'); assert.equal(authPin.width, 24); assert.equal(authPin.height, 72);
      assert.equal(authPin.x, 0); assert.equal(authPin.center, 325); assert.equal(authPin.hit, 'chatbarPin');
      fs.writeFileSync(path.join(out, 'auth-collapse-handle-'+width+'.png'), (await win.webContents.capturePage()).toPNG());
      report.cases.push(`${width}px pending auth + expanded: real auth styles remain visible, card fits, conversation stays gated and collapse remains reachable.`);
    }
    await js("document.getElementById('chatbarPin').click()");
    assert.equal((await state()).expanded, 'false');
    assert.equal(await js('patches.at(-1).expanded'), false);
    report.cases.push('Auth pending preserves the same left midpoint collapse handle as a signed-in sidebar; collapsed rail retains its brand icon.');
    await js("document.documentElement.classList.remove('soduwork-auth-pending');document.getElementById('soduWorkClientAuthGate').hidden=true;modeListener({state:'pinned'})");
    s = await state();
    assert.equal(s.rail, false); assert.equal(s.gate, false); assert.equal(s.conversation, true);
    report.cases.push('After fixture auth activation: login gate and auth-only toggle disappear; normal conversation becomes visible.');
    const pin = await js(`(()=>{const b=chatbarPin,r=b.getBoundingClientRect();return {width:r.width,height:r.height,x:r.x,center:r.y+r.height/2,viewport:innerHeight,
      middle:document.elementFromPoint(12,r.y+r.height/2)?.closest('button')?.id,
      corner:document.elementFromPoint(23,r.y+1)?.closest('button')?.id};})()`);
    assert.equal(pin.width,24); assert.equal(pin.height,72); assert.equal(pin.x,0); assert.equal(pin.center,pin.viewport/2);
    assert.equal(pin.middle,'chatbarPin'); assert.notEqual(pin.corner,'chatbarPin', 'trapezoid corners do not intercept underlying content');
    assert.equal(await js("getComputedStyle(document.querySelector('.chatbar-pin-outline')).stroke"),'none','handle has no outline');
    assert.match(await js("getComputedStyle(chatbarPin).filter"),/drop-shadow/,'handle casts a subtle shadow');
    fs.writeFileSync(path.join(out, 'collapse-handle.png'), (await win.webContents.capturePage()).toPNG());
    await js("chatbarPin.click()");
    assert.equal((await state()).expanded,'false');
    assert.equal(await js('patches.at(-1).expanded'),false);
    assert.equal(await js("chatbarRail.classList.contains('is-arriving')"),false,'collapse does not replay arrival');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await js("chatbarRail.classList.add('is-arriving')");
    assert.equal(await js("getComputedStyle(document.querySelector('.chatbar-sprite')).animationName"),'none');
    assert.equal(await js("getComputedStyle(document.querySelector('#chatbarRailBtn img')).animationName"),'none');
    assert.equal(await js("getComputedStyle(document.querySelector('.chatbar-sprite')).transitionDuration"),'0s');
    win.webContents.debugger.detach();
    report.cases.push('Borderless trapezoid with right arrow and subtle shadow sits at the left midpoint; clipped corners pass DOM hit testing through, click collapses via the existing mode pipeline, arrival does not replay; reduced-motion disables entrance and sliding.');
    await win.loadFile(path.join(__dirname, '../tests/new-conversation.html'));
    await until('document.querySelector("#out")?.textContent.includes("new conversation smoke:")', 'production conversation fixture');
    assert.match(await js('document.querySelector("#out").textContent'), /new conversation smoke: \d+ passed, 0 failed/);
    await js('openComposePanel({chatId:"sidebar-layout"})');
    await until('!!document.querySelector(".nbox.work-composer")', 'real composer mounts');
    // Mount the actual NativeChat composer above in the detached sidebar's CSS.
    const deskHtml = fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8');
    const sheets = [...deskHtml.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)]
      .map(match => pathToFileURL(path.resolve(__dirname, '..', match[1])).href);
    await js(`Promise.all(${JSON.stringify(sheets)}.map(href=>new Promise((resolve,reject)=>{
      const link=document.createElement('link');link.rel='stylesheet';link.href=href;
      link.onload=resolve;link.onerror=()=>reject(Error('Stylesheet failed: '+href));document.head.appendChild(link);
    })))`);
    await js(`document.documentElement.dataset.deskPanel='chatbar';document.body.dataset.composerState='pinned';
      nchatInput.value='拉宽侧栏后，输入区域仍应居中';nchatInput.dispatchEvent(new Event('input',{bubbles:true}));void 0`);
    report.sidebarComposer = [];
    for (const width of [320, 440, 1000, 1600, 440]) {
      win.setContentSize(width, 720);
      await delay(100);
      const layout = await js(`(()=>{
        const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();
        return {viewport:innerWidth,main:rect('.nchat-main'),shell:rect('.nchat-footin'),
          dock:rect('.nchat-entry-dock'),box:rect('.nbox.work-composer'),
          draft:nchatInput.value,overflow:document.documentElement.scrollWidth>innerWidth+1};
      })()`);
      for (const key of ['shell', 'dock', 'box']) {
        assert.ok(Math.abs(layout[key].x+layout[key].width/2-layout.main.x-layout.main.width/2)<1,
          'Sidebar composer must remain centered: '+JSON.stringify(layout));
        assert.ok(layout[key].x>=layout.main.x && layout[key].right<=layout.main.right,
          'Sidebar composer must fit: '+JSON.stringify(layout));
      }
      assert.equal(layout.box.width, Math.min(780, layout.main.width-24));
      assert.equal(layout.draft, '拉宽侧栏后，输入区域仍应居中');
      assert.equal(layout.overflow, false);
      report.sidebarComposer.push(layout);
      fs.writeFileSync(path.join(out, 'sidebar-composer-'+width+'.png'), (await win.webContents.capturePage()).toPNG());
    }
    report.cases.push('Production NativeChat composer stays centered in 320/440/1000/1600px sidebars and after shrinking; queue dock matches the input width and unsent text survives resizing.');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    if (win && !win.isDestroyed()) win.destroy();
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
