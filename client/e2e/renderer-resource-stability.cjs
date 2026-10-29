'use strict';
// Real Electron DOM, image loading/decoding and ResizeObserver. Isolated profile;
// no user session, user window, model request, or production service is touched.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const http = require('node:http'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-renderer-stability-'));
  const output = path.resolve(process.argv[2] || path.join(root, '../outputs/renderer-resource-stability/report.json'));
  const report = { ok: false, cases: [], isolated: true, realModel: false, osCompositorGlitchReproduced: false };
  const requests = [];
  let window, server;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const run = source => window.webContents.executeJavaScript(source, true);
  const load = file => {
    const source = process.env.SODUWORK_RENDERER_BASELINE === '1'
      ? require('node:child_process').execFileSync('git', ['show', 'HEAD:client/' + file], { cwd: root, encoding: 'utf8' })
      : fs.readFileSync(path.join(root, file), 'utf8');
    return run(source + '\n;void 0;');
  };
  async function until(source, label, timeout = 7000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await run(source); if (value) return value; await delay(30); }
    throw Error('Timed out: ' + label);
  }
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    server = http.createServer((req, res) => {
      const name = decodeURIComponent(new URL(req.url, 'http://fixture').pathname).replace(/^\//, '');
      if (!name) { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html><body></body></html>'); }
      if (!/^assets\/pet-skins\/soduwork-actions\/(resting|ready|working|complete)\/frame-\d\d\.png$/.test(name)) { res.writeHead(404); return res.end(); }
      requests.push(name);
      const ms = name.endsWith('working/frame-02.png') ? 1400
        : name.endsWith('working/frame-04.png') || /\/(resting|complete)\//.test(name) ? 1200 : 30;
      setTimeout(() => {
        if (name.endsWith('working/frame-03.png')) { res.writeHead(404); return res.end(); }
        res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store');
        res.end(fs.readFileSync(path.join(root, name)));
      }, ms);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    window = new BrowserWindow({ show: false, width: 800, height: 600, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadURL('http://127.0.0.1:' + server.address().port + '/');
    await run(`
      window.cfg = { _lastSkinId: 'soduwork-signature', petVisible: true };
      document.body.innerHTML = '<div id="pet" class="pet"><svg id="petSvg" class="pet-svg" viewBox="0 0 72 72"><rect width="72" height="72" fill="red"/></svg></div>';
      const style = document.createElement('style'); style.textContent = ${JSON.stringify(fs.readFileSync(path.join(root, 'components/pet/pet.css'), 'utf8'))} + '.pet{left:20px;top:20px;transform:none!important;opacity:1!important}'; document.head.append(style);
      window.shapeCalls = 0;
      window.decodePending = false;
      const nativeDecode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function(){
        await nativeDecode.call(this);
        if((this.dataset.soduworkFrame||'').endsWith('working/frame-02.png')){
          window.decodePending = true; await new Promise(resolve=>setTimeout(resolve,350)); window.decodePending = false;
        }
      };
      window.soduWorkAPI = {setOverlayShape(){shapeCalls++},setIgnoreMouseEvents(){},setAlwaysOnTop(){}};
      window.roTargets = new Map(); const NativeRO = window.ResizeObserver;
      window.ResizeObserver = class extends NativeRO {
        constructor(callback){super(callback);roTargets.set(this,new Set())}
        observe(el,options){roTargets.get(this).add(el);return super.observe(el,options)}
        unobserve(el){roTargets.get(this).delete(el);return super.unobserve(el)}
        disconnect(){roTargets.get(this).clear();return super.disconnect()}
      };
      window.roStats = () => ({ targets:[...roTargets.values()].reduce((n,s)=>n+s.size,0),
        detached:[...roTargets.values()].flatMap(s=>[...s]).filter(el=>!el.isConnected).length });
      void 0;
    `);
    await load('core/electron.js');
    await load('components/pet/soduwork-pet-skin.js');
    await run(`SoduWorkPetSkin.setState('working')`);
    await until(`SoduWorkPetSkin.isSpriteReady()`, 'first actual PNG decode');
    // JS readiness is set during the decode callback, before Chromium paints
    // the replacement. Establish the pixel baseline after that paint; capturing
    // immediately can record the fixture's red SVG instead of the decoded PNG.
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const first = await window.webContents.capturePage({ x: 20, y: 20, width: 72, height: 72 });
    await delay(500);
    const slow = await window.webContents.capturePage({ x: 20, y: 20, width: 72, height: 72 });
    assert.equal(Buffer.compare(first.toBitmap(), slow.toBitmap()), 0, 'slow frame keeps identical visible pixels');
    assert.equal(await run(`document.querySelector('#pet').classList.contains('soduwork-sprite-fallback')`), false);
    assert.equal(requests.filter(x => x.endsWith('working/frame-02.png')).length, 1);
    await until('decodePending', 'delayed native image decode');
    const decoding = await window.webContents.capturePage({ x: 20, y: 20, width: 72, height: 72 });
    assert.equal(Buffer.compare(first.toBitmap(), decoding.toBitmap()), 0, 'slow decode keeps identical visible pixels');
    report.cases.push('Actual PNG load plus delayed native decode: previous pixels retained, one in-flight frame, no fallback flash');
    await until(`document.querySelector('#soduWorkPetSprite').dataset.soduworkFrame.endsWith('working/frame-02.png')`, 'delayed frame committed');
    await delay(400);
    assert.equal(await run(`document.querySelector('#soduWorkPetSprite').dataset.soduworkFrame.endsWith('working/frame-02.png') && SoduWorkPetSkin.isSpriteReady()`), true);
    report.cases.push('Actual 404 image: last valid frame remains displayed');
    await run(`SoduWorkPetSkin.setState('ready')`);
    await until(`document.querySelector('#soduWorkPetSprite').dataset.soduworkFrame.includes('/ready/')`, 'switch state');
    await delay(1000);
    assert.equal(await run(`document.querySelector('#soduWorkPetSprite').dataset.soduworkFrame.includes('/ready/')`), true);
    await run(`cfg.petVisible = false; SoduWorkPetSkin.sync()`); await delay(60);
    const hiddenRequests = requests.length; await delay(700);
    assert.equal(requests.length, hiddenRequests, 'hidden pet does not load new frames');
    const hiddenFrame = await run(`document.querySelector('#soduWorkPetSprite').dataset.soduworkFrame`);
    await run(`cfg.petVisible = true; SoduWorkPetSkin.sync()`);
    await until(`document.querySelector('#soduWorkPetSprite').dataset.soduworkFrame !== ${JSON.stringify(hiddenFrame)}`, 'hidden pet frame resumes');
    await run(`cfg._lastSkinId = 'box-biz'; SoduWorkPetSkin.sync()`);
    assert.equal(await run(`document.querySelector('#pet').classList.contains('soduwork-sprite-active')`), false);
    const inactiveRequests = requests.length; await delay(600); assert.equal(requests.length, inactiveRequests);
    report.cases.push('State switch rejects late frames; hidden/changed skin pauses work and restore resumes');
    for (const state of ['resting', 'complete']) {
      await run(`cfg._lastSkinId = 'soduwork-signature'; SoduWorkPetSkin.setState('working')`);
      await until(`document.querySelector('#soduWorkPetSprite').dataset.soduworkFrame.includes('/working/')`, 'working frame before static transition');
      await run(`SoduWorkPetSkin.setState(${JSON.stringify(state)})`);
      await delay(80);
      await run(`cfg.petVisible = false; SoduWorkPetSkin.sync()`); await delay(100);
      await run(`cfg.petVisible = true; SoduWorkPetSkin.sync()`);
      await until(`document.querySelector('#soduWorkPetSprite').dataset.soduworkFrame.includes('/${state}/')`, 'interrupted static ' + state + ' frame resumes');
      if (state === 'complete') {
        await run(`cfg.petVisible = false; SoduWorkPetSkin.sync()`);
        await until(`document.querySelector('#pet').dataset.soduworkState === 'resting'`, 'completion deadline ends while hidden');
        await run(`cfg.petVisible = true; SoduWorkPetSkin.sync()`);
        await until(`document.querySelector('#soduWorkPetSprite').dataset.soduworkFrame.includes('/resting/')`, 'hidden completion resumes resting pixels');
        assert.equal(await run(`document.querySelector('#pet').dataset.soduworkState`), 'resting');
      }
    }
    report.cases.push('Delayed actual resting/completion PNG loads resume after hiding; completion expiring while hidden restores resting pixels without replaying the animation');
    await run(`cfg._lastSkinId = 'soduwork-signature'; SoduWorkPetSkin.setState('working')`);
    await delay(600);
    await window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await run(`SoduWorkPetSkin.sync()`); await delay(500);
    const reducedRequests = requests.length; await delay(700); assert.equal(requests.length, reducedRequests);
    report.cases.push('Real Chromium reduced-motion preference stops frame animation');
    await run(`SoduWorkPetSkin.destroy()`);
    const baseline = await run(`roStats()`);
    const observer = await run(`(async () => {
      for(let i=0;i<500;i++){
        const panel=document.createElement('div'); panel.className='panel'; panel.textContent='ephemeral '+i;
        document.body.append(panel); await Promise.resolve(); panel.remove(); await Promise.resolve();
      }
      await new Promise(resolve=>setTimeout(resolve,100)); return roStats();
    })()`);
    assert.equal(observer.targets, baseline.targets); assert.equal(observer.detached, 0);
    report.observer = { baseline, after500Overlays: observer };
    report.cases.push('500 actual overlay DOM add/remove cycles: observed target count constant, no detached target');
    await load('components/panels/chat-context-meter.js');
    await load('components/panels/chat-scroll-follow.js');
    await load('components/panels/chat-markdown.js');
    await load('components/panels/chat-acceptance-results.js');
    await load('components/panels/chat-message-renderer.js');
    const chat = await run(`(async () => {
      window.ChatTools={goalProgressRows:()=>[],appendTimeline(){},appendGoalProgress(){},paintSendButton(){}};
      const host=document.createElement('main'); document.body.append(host);
      const ctx={_ref:'fixture',esc:s=>String(s||''),_snap:{status:'idle',messages:[],tools:[]},
        _sessionOptions:{},_collabTasks:new Map(),_pendingAttachmentNames:[],_openThink:new Set(),_closedThink:new Set(),
        _openTool:new Set(),_openToolGroup:new Set(),_collabEntries:()=>[],_outs:[],
        _renderQueue(){},_syncThinkingClock(){},_thinkingStatusHtml:()=>'',_renderTaskStartPrompt(){},_syncSlowStatusTicker(){},
        _mount:()=>host};
      const renderer=ChatMessageRenderer.create(ctx); const before=roStats(); let max=0;
      for(let i=0;i<300;i++){
        host.innerHTML='<div class="nchat-content-area"><div id="nchatScroll" style="height:80px;overflow:auto"><div id="nchatList"></div></div></div>';
        ctx._ref='fixture-'+i; renderer._render(); max=Math.max(max,roStats().targets);
        renderer.reset(); host.replaceChildren();
        if(i%20===0) await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      await new Promise(resolve=>requestAnimationFrame(resolve));
      return {before,after:roStats(),max,jumpButtons:host.querySelectorAll('.nchat-jump-latest').length};
    })()`);
    assert.equal(chat.after.targets, chat.before.targets); assert.equal(chat.after.detached, 0);
    assert.equal(chat.max, chat.before.targets + 1); assert.equal(chat.jumpButtons, 0);
    report.chat = chat;
    report.cases.push('300 actual chat renderer mount/reset cycles release scroll observers and jump controls');
    report.shapeCalls = await run(`shapeCalls`);
    report.gpu = app.getGPUFeatureStatus();
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); })
    .finally(async () => {
      if (window && !window.isDestroyed()) window.destroy();
      if (server) await new Promise(resolve => server.close(resolve));
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
    });
}
