'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const output = path.resolve(__dirname, '../../outputs/tool-preparation-20261015');
  const report = { ok: false, bundledSdk: true, realFilesystem: true, realModel: false, productionRenderer: true, stages: [] };
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preparation-ui-')));
  app.disableHardwareAcceleration();
  let win;
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1000, height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    await win.webContents.executeJavaScript("window.rebuilds=0; const patch=ChatTools.patchList; ChatTools.patchList=(...args)=>{rebuilds++;return patch(...args)}; window.input=document.createElement('textarea');document.body.prepend(input);input.value='未发送草稿';input.focus();");
    report.write = await require('../tests/fixtures/native-streamed-write.cjs')(async (stage, snap, state) => {
      const result = await win.webContents.executeJavaScript('ctx._snap=' + JSON.stringify(snap) + '; renderer._render(); (' + (()=>{const rows=[...document.querySelectorAll('[data-tool-node="streamed-file"]')];return {count:rows.length,text:rows[0]?.querySelector('.ntool-head')?.textContent,body:!!rows[0]?.querySelector('.ntool-body'),clickable:!!rows[0]?.querySelector('button'),rebuilds,focus:document.activeElement===input,draft:input.value};}).toString() + ')()');
      assert.equal(result.count, 1); assert.equal(result.focus, true); assert.equal(result.draft, '未发送草稿');
      if (stage === 'preparing' || stage === 'chunk') {
        assert.match(result.text, /正在生成文件/); assert.match(result.text, /长文件.html/);
        assert.equal(result.body, false); assert.equal(result.clickable, false); assert.equal(state.exists, false);
        if (stage === 'preparing') report.initialRebuilds = result.rebuilds;
        else assert.equal(result.rebuilds, report.initialRebuilds, 'body chunks do not rebuild the transcript');
      } else { assert.doesNotMatch(result.text, /正在生成文件/); assert.equal(result.clickable, true); }
      if (stage !== 'chunk') {
        report.stages.push({ stage, ...result, ...state });
        try { fs.writeFileSync(path.join(output, stage + '.png'), (await win.webContents.capturePage()).toPNG()); }
        catch (error) { report.captureError = String(error); }
      }
    });
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
