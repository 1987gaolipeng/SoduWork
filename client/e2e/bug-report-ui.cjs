'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-bug-ui-'));
  const client = path.resolve(__dirname, '..'), output = path.join(client, '../outputs/bug-report-ui');
  app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    const page = path.join(root, 'fixture.html');
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><base href="${pathToFileURL(client + path.sep).href}">
      <link rel="stylesheet" href="theme/variables.css"><link rel="stylesheet" href="components/panels/panels-chat.css">
      <div class="nchat" id="chat"></div><script src="components/panels/panels-chat-chrome.js"></script>
      <script>window.errors=[];addEventListener('error',e=>errors.push(e.message));
      chat.innerHTML=ChatChrome.header()+'<div class="nchat-stage"><div class="nchat-main"><div id="answer">A completed result remains readable.</div></div></div>';
      ChatChrome.bind(chat,()=>({ref:'isolated'}));
      ChatChrome.workbenchState({count:1,has:true,summary:{files:[{name:'result.md',path:'result.md',size:20}]}});</script>`);
    win = new BrowserWindow({ show: false, width: 1200, height: 800,
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(page);
    win.webContents.debugger.attach('1.3');
    const layouts = [];
    for (const width of [1200, 960, 760, 390]) {
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await js('ChatChrome.openSummary()'); await delay(60);
      const layout = await js(`(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};return{header:box('.nchat-head'),stage:box('.nchat-stage'),popup:box('.nchat-summary'),overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      assert.equal(layout.overflow, false);
      assert.ok(layout.popup.top >= layout.header.bottom, 'summary clears the header');
      assert.ok(layout.popup.left >= 0 && layout.popup.right <= width + 1);
      if (width >= 960) assert.ok(layout.stage.right <= layout.popup.left, 'wide layouts reserve a separate summary column');
      layouts.push({ width, ...layout });
      fs.writeFileSync(path.join(output, 'summary-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      const point = await js(`(()=>{const r=document.querySelector('[data-chat-summary]').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
      await delay(40);
      assert.equal(await js('document.querySelector(".nchat-summary").hidden'), true);
      assert.equal(await js('Math.round(document.querySelector(".nchat-stage").getBoundingClientRect().width)'), width);
    }
    assert.deepEqual(await js('window.errors'), []);
    const report = { ok: true, layouts, scope: 'Production ChatChrome and CSS, isolated Chromium with native input events' };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
