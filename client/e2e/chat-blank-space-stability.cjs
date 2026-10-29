'use strict';

// Real Electron pointer events and layout; synthetic history, no model or account.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit',
  }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const baseline = process.argv.includes('--baseline');
  const baselineRef = process.argv.find(arg => arg.startsWith('--baseline-ref='))?.slice('--baseline-ref='.length)
    || 'de0543349364aca8ce96d8ddbca12637b29b0f99';
  const report = { ok: false, baseline, ...(baseline ? { baselineRef } : {}), synthetic: true };
  const output = path.resolve(__dirname, '../../outputs/chat-blank-space-stability');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-blank-space-')));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let win;

  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1400, height: 850, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    if (baseline) {
      const source = require('node:child_process').execFileSync('git',
        ['show', `${baselineRef}:client/components/panels/chat-scroll-follow.js`], {
          cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', windowsHide: true,
        });
      await win.webContents.executeJavaScript('renderer.reset();' + source +
        '\nwindow.renderer = ChatMessageRenderer.create(ctx); void 0;');
    }
    await win.webContents.executeJavaScript(`
      window.scrollBox = document.querySelector('#nchatScroll');
      scrollBox.classList.add('nchat-scroll');
      scrollBox.tabIndex = 0;
      fill(400); ctx._snap.tools = []; ctx._messageWindowSize = 420;
      ctx._snap.status = 'streaming';
      ctx._snap.messages.push({role:'assistant',done:false,blocks:[{
        kind:'text',index:0,done:false,text:'Stable streaming answer.'}]});
      renderer._render();
      window.followChanges = [];
      window.followObserver = new MutationObserver(records => {
        for(const record of records) followChanges.push({old:record.oldValue,current:scrollBox.dataset.scrollFollow});
      });
      followObserver.observe(scrollBox,{attributes:true,attributeOldValue:true,attributeFilter:['data-scroll-follow']});
      window.renderTimes = [];
      window.streamTick = () => {
        ctx._snap.messages.at(-1).blocks[0].text += ' next';
        const at = performance.now();renderer._render();renderTimes.push(performance.now()-at);
      };
      window.firstRow = document.querySelector('[data-chat-node="message:1"]');
      window.liveText = document.querySelector('[data-chat-node="message:400"] .ntext');
      window.pointerStates = [];
      scrollBox.addEventListener('pointerdown', () => pointerStates.push({
        follow:scrollBox.dataset.scrollFollow==='latest',visibility:getComputedStyle(firstRow).contentVisibility
      }));
    `);
    await delay(500);
    const snapshot = () => win.webContents.executeJavaScript(`({
      follow:scrollBox.dataset.scrollFollow==='latest',attribute:scrollBox.dataset.scrollFollow,
      top:scrollBox.scrollTop,height:scrollBox.scrollHeight,viewport:scrollBox.clientHeight,
      historicalVisibility:getComputedStyle(firstRow).contentVisibility,
      firstRowPreserved:firstRow===document.querySelector('[data-chat-node="message:1"]'),
      liveTextPreserved:liveText===document.querySelector('[data-chat-node="message:400"] .ntext'),
      mutations:followChanges.length
    })`);
    const point = await win.webContents.executeJavaScript(`(() => {
      const box=scrollBox.getBoundingClientRect(),list=document.querySelector('#nchatList').getBoundingClientRect();
      const x=Math.round((list.right+box.right-20)/2),y=Math.round(box.top+box.height/2);
      return {x,y,target:document.elementFromPoint(x,y)?.id};
    })()`);
    assert.equal(point.target, 'nchatScroll', 'test must click real blank space beside the transcript');
    report.before = await snapshot();
    const start = performance.now();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y });
    await delay(80);
    report.held = await snapshot();
    report.pointerRoundtripMs = +(performance.now() - start).toFixed(1);
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y });
    await delay(150);
    report.released = await snapshot();
    for (let i = 0; i < 60; i++) {
      await win.webContents.executeJavaScript('streamTick();void 0;');
      if (i % 10 === 0) {
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y });
      }
      await delay(16);
    }
    await delay(350);
    report.streaming = await snapshot();
    report.rendering = await win.webContents.executeJavaScript(`(() => {
      const sorted=renderTimes.toSorted((a,b)=>a-b);
      return {frames:sorted.length,p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1),
        finalTextComplete:liveText.textContent.trim()===ctx._snap.messages.at(-1).blocks[0].text.trim(),
        followChanges:followChanges.slice(),pointerStates:pointerStates.slice()};
    })()`);
    if (baseline) {
      assert.equal(report.rendering.pointerStates[0].follow, false, 'baseline must reproduce false scrollbar intent');
      assert.equal(report.rendering.pointerStates[0].visibility, 'visible', 'baseline must force all history to layout');
    } else {
      for (const state of [report.before, report.held, report.released, report.streaming]) {
        assert.equal(state.follow, true, 'blank-space clicks must not suspend stream following');
        assert.equal(state.attribute, 'latest');
        assert.equal(state.historicalVisibility, 'auto', 'history must retain offscreen rendering optimization');
        assert.equal(state.firstRowPreserved, true);
        assert.equal(state.liveTextPreserved, true);
        assert.ok(Math.abs(state.height-state.viewport-state.top)<3, 'blank click must not jump away from latest');
      }
      assert.equal(report.streaming.mutations, 0, 'blank clicks must not invalidate transcript styles');
      assert.equal(report.rendering.pointerStates.length, 7, 'Electron must deliver every blank-space press');
      assert.ok(report.rendering.pointerStates.every(state => state.follow && state.visibility === 'auto'));
      assert.equal(report.rendering.finalTextComplete, true, 'all streamed output remains visible');
    }
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, baseline ? 'baseline.json' : 'fixed.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  });
}
