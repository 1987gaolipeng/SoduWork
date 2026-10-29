'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { EventEmitter } = require('node:events');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-computer-overlay-'));
  app.setPath('userData', root);
  // The production app owns other windows; this isolated harness does not.
  app.on('window-all-closed', () => {});
  const out = path.resolve(__dirname, '../../outputs/computer-use-overlay'); fs.mkdirSync(out, { recursive: true });
  const report = { ok: false, cases: [] }, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let overlay, service, endpoint, escape, themeWindow, cancelled = 0, running = true;
  const screen = new EventEmitter();
  const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 700 }, scaleFactor: 1 },
    { id: 2, bounds: { x: -600, y: 0, width: 600, height: 700 }, scaleFactor: 1.5 }];
  let cursor = { x: 460, y: 340 };
  screen.getAllDisplays = () => displays;
  screen.getCursorScreenPoint = () => cursor;
  screen.getDisplayNearestPoint = point => point.x < 0 ? displays[1] : displays[0];
  const request = async (route, data) => {
    const response = await fetch(endpoint.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + endpoint.token }, body: JSON.stringify(data) });
    return response.json();
  };
  app.whenReady().then(async () => {
    const themeFile = path.join(root, 'theme.html'); fs.writeFileSync(themeFile, '<!doctype html><title>Isolated theme owner</title>');
    themeWindow = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await themeWindow.loadFile(themeFile);
    require('../main/native-theme.cjs').install({ BrowserWindow, ipcMain, allowedFiles: [themeFile] });
    const owner = { attachedWindow: themeWindow, desktopControlScope: 'pi:isolated:1', inFlight: () => running, cancel() { cancelled++; running = false; } };
    overlay = require('../main/computer-use/overlay.cjs').create({ BrowserWindow, ipcMain, screen,
      globalShortcut: { register(key, fn) { assert.equal(key, 'Escape'); escape = fn; return true; }, unregister(key) { assert.equal(key, 'Escape'); escape = null; } },
      onCancel: () => service.cancel(), testOptions: { show: false, webPreferences: { offscreen: true } } });
    service = require('../main/computer-use/service.cjs').create({ overlay, sessions: () => [owner] });
    endpoint = await service.start();
    const input = { scope: owner.desktopControlScope, pid: process.pid, cwd: root, action: 'batch' };
    const lease = await request('/begin', input); assert.equal(lease.ok, true);
    const windows = overlay.windows(); assert.equal(windows.length, 2);
    for (const win of windows) { assert.equal(win.isFocusable(), false); assert.equal(win.isAlwaysOnTop(), true); assert.equal(win.isVisible(), false); }
    const main = windows[0], second = windows[1], js = code => main.webContents.executeJavaScript(code);
    await delay(120);
    const geometry = await js(`(()=>{const p=document.querySelector('.control-pill').getBoundingClientRect(),h=document.querySelector('.cursor-halo').getBoundingClientRect();return{label:document.querySelector('#controlLabel').textContent,pillCenter:p.x+p.width/2,cursor:[h.x+22,h.y+22],transparent:getComputedStyle(document.body).backgroundColor,events:getComputedStyle(document.body).pointerEvents,breathing:getComputedStyle(document.querySelector('.screen-edge')).animationName,globals:Object.keys(window.soduWorkComputerOverlay)}})()`);
    report.initialGeometry = { ...geometry, bounds: main.getBounds(), contentBounds: main.getContentBounds() };
    assert.equal(geometry.label, 'SoduWork 正在操作电脑'); assert.ok(Math.abs(geometry.pillCenter - main.getContentBounds().width / 2) < 1);
    assert.deepEqual(geometry.cursor, [460, 340]); assert.equal(geometry.transparent, 'rgba(0, 0, 0, 0)');
    assert.equal(geometry.events, 'none'); assert.equal(geometry.breathing, 'breathe'); assert.deepEqual(geometry.globals, ['onState', 'ready']);
    report.cases.push('Authenticated begin waits for real sandboxed Electron HUD renderers; centered pill, rainbow edge/halo, no focus or renderer input');
    const shot = await main.webContents.capturePage(), size = shot.getSize(), pixels = shot.toBitmap();
    const alpha = (x,y) => pixels[(Math.floor(y) * size.width + Math.floor(x)) * 4 + 3];
    const edges = [alpha(size.width/2, 1),alpha(size.width-2,size.height/2),alpha(size.width/2,size.height-2),alpha(1,size.height/2)];
    assert.ok(edges.every(value => value > 75), 'all four physical window edges visibly carry color');
    assert.equal(alpha(size.width/2,size.height/2),0,'center remains transparent over other applications');
    report.edgeAlpha = edges;
    await js("document.body.style.backgroundColor='#f3f5f9'"); await delay(80);
    fs.writeFileSync(path.join(out, 'light.png'), (await main.webContents.capturePage()).toPNG());
    await js("document.body.style.backgroundColor='transparent'");
    await js('window.labelChanges=0;new MutationObserver(()=>labelChanges++).observe(document.querySelector("#controlLabel"),{childList:true,characterData:true,subtree:true})');
    cursor = { x: 490, y: 380 }; await delay(80);
    assert.equal(await js('labelChanges'),0,'cursor motion must not repeat live announcements');
    cursor = { x: -260, y: 160 }; await delay(80);
    assert.equal(await js('document.querySelector(".control-pill").hidden'), true);
    const secondary = await second.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.control-pill').getBoundingClientRect(),h=document.querySelector('.cursor-halo').getBoundingClientRect();return{center:p.x+p.width/2,cursor:[h.x+22,h.y+22],visible:!document.querySelector('.control-pill').hidden}})()`);
    assert.equal(secondary.visible, true); assert.ok(Math.abs(secondary.center - second.getContentBounds().width / 2) < 1); assert.deepEqual(secondary.cursor, [340, 160]);
    report.cases.push('Negative-coordinate second display and mixed scale: halo follows DIP position and only active display has the pill');
    const wc = themeWindow.webContents;
    ipcMain.emit('client-theme', { sender: wc, senderFrame: wc.mainFrame }, { theme: 'dark', tokens: { '--bg-0': '#20232b', '--ink': '#f3f5f9', '--ink-2': '#b8bfcc', '--line': '#424955' } });
    await delay(80);
    assert.equal(await second.webContents.executeJavaScript('getComputedStyle(document.querySelector(".control-pill")).backgroundColor'), 'rgb(32, 35, 43)');
    fs.writeFileSync(path.join(out, 'dark.png'), (await second.webContents.capturePage()).toPNG());
    report.cases.push('Trusted parent-window theme updates the existing capsule without recreating the desktop overlay');
    require('../main/native-locale.cjs').setLocale('en-US'); await delay(80);
    assert.equal(await second.webContents.executeJavaScript('document.querySelector("#controlLabel").textContent'), 'SoduWork is controlling your computer');
    assert.equal(await second.webContents.executeJavaScript('document.querySelector("#cancelLabel").textContent'), 'Cancel control');
    await second.webContents.debugger.attach('1.3');
    await second.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await second.webContents.executeJavaScript('getComputedStyle(document.querySelector(".screen-edge")).animationName'), 'none');
    assert.equal(await second.webContents.executeJavaScript('Array.from(document.querySelectorAll(".edge-light,.cursor-halo i")).every(n=>getComputedStyle(n).animationName==="none")'),true);
    second.setBounds({x:0,y:0,width:360,height:640}); await delay(80);
    assert.ok(await second.webContents.executeJavaScript('(()=>{const r=document.querySelector(".control-pill").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height<130})()'));
    fs.writeFileSync(path.join(out, 'narrow-english.png'), (await second.webContents.capturePage()).toPNG());
    second.webContents.debugger.detach(); report.cases.push('English localization, narrow capsule layout and all reduced-motion animations');
    await request('/end', { scope: input.scope, leaseId: lease.leaseId });
    assert.equal(overlay.windows().length, 2, 'keeps indicator between desktop calls in one active turn');
    const secondLease = await request('/begin', input); assert.equal(secondLease.ok, true);
    escape(); await delay(80);
    assert.equal(cancelled, 1); assert.equal(overlay.windows().length, 0); assert.equal(escape, null);
    assert.equal((await request('/status', { scope: input.scope, leaseId: secondLease.leaseId })).cancelled, true);
    assert.equal((await request('/begin', input)).ok, false);
    report.cases.push('Escape callback cancels the owning run, removes windows/shortcut and rejects subsequent input in that turn');
    // The real shared Skill script may wait, but never sends input in this fixture.
    if (process.platform === 'win32') {
      running = true; owner.desktopControlScope = 'pi:isolated:2';
      // Observe the real script's first heartbeat instead of guessing readiness
      // from shortcut registration (which precedes the renderer and begin ACK).
      let heartbeatSeen = false;
      const bridge = require('node:http').createServer(async (req,res) => {
        try {
          let body = ''; for await (const chunk of req) body += chunk;
          const response = await fetch(endpoint.url + req.url, { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+endpoint.token}, body });
          const value = await response.json();
          if (req.url === '/status' && value.ok && value.cancelled === false) heartbeatSeen = true;
          res.writeHead(response.status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
        } catch (_) { res.writeHead(503);res.end('{}'); }
      });
      await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
      const endpointFile = path.join(root, 'endpoint.json'); fs.writeFileSync(endpointFile, JSON.stringify({ ...endpoint, url:'http://127.0.0.1:'+bridge.address().port }));
      const child = require('node:child_process').spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../../skills/computer-use/scripts/screen.ps1'), 'batch', 'stdin'], {
        windowsHide: true, env: { ...process.env, SODUWORK_DESKTOP_CONTROL_ENDPOINT: endpointFile, SODUWORK_DESKTOP_CONTROL_SCOPE: owner.desktopControlScope }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      const finished = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      child.stdin.end(JSON.stringify([{ cmd: 'wait', ms: 5000 }, { cmd: 'not-a-real-action' }]));
      const guard = setTimeout(() => child.kill(), 15000);
      try {
        for (let attempt = 0; attempt < 400 && !heartbeatSeen; attempt++) await delay(30);
        assert.equal(heartbeatSeen,true,'script must receive begin ACK and start its real batch before cancellation');
        assert.equal(typeof escape, 'function'); escape();
        assert.notEqual(await finished, 0); assert.match(output, /Desktop operation cancelled/);
        assert.doesNotMatch(output, /unsupported batch action|batch complete/); assert.equal(cancelled, 2);
        assert.equal(overlay.windows().length, 0);
      } finally { clearTimeout(guard); if (child.exitCode === null) child.kill(); bridge.closeAllConnections(); await new Promise(resolve=>bridge.close(resolve)); }
      report.cases.push('Real PowerShell Skill → authenticated local service → real Electron HUD → Escape callback → batch stops before its next action');
    }
    running = true; owner.desktopControlScope = 'pi:isolated:3';
    const crashLease = await request('/begin', { ...input, scope: owner.desktopControlScope }); assert.equal(crashLease.ok, true);
    const beforeClose = cancelled;
    overlay.windows()[0].destroy(); await delay(80);
    assert.equal(cancelled, beforeClose + 1); assert.equal(overlay.windows().length, 0);
    assert.equal((await request('/status', { scope: owner.desktopControlScope, leaseId: crashLease.leaseId })).cancelled, true);
    report.cases.push('Unexpected HUD window closure revokes desktop control and stops its owner');
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); })
    .finally(async () => {
      await service?.dispose(); require('../main/native-locale.cjs').setLocale('zh-CN');
      themeWindow?.destroy();
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
      app.exit(report.ok ? 0 : 1);
    });
}
