'use strict';
// Use production forms in Chromium with a stub parser, without model or business-database access.
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
  const client = path.resolve(__dirname, '..'), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-work-labels-'));
  const out = path.resolve(process.argv[2] || 'outputs/work-action-labels-20261016');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  let win;
  const report = { ok: false, cases: [], network: [] };
  const js = code => win.webContents.executeJavaScript(code, true);
  app.whenReady().then(async () => {
    const page = path.join(temporary, 'fixture.html');
    const styles = ['theme/variables.css', 'components/panels/plugin-ui-host.css',
      'components/panels/work-entry-sheet.css', 'components/panels/work-automation-sheet.css'];
    fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8">' + styles.map(file =>
      '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') +
      '<style>body{font-family:var(--font-ui);background:var(--bg-0)}#host{max-width:900px;margin:24px auto}</style>' +
      '</head><body><div id="host"></div></body></html>');
    win = new BrowserWindow({ show: false, width: 1100, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
      report.network.push(request.url); callback({ cancel: true });
    });
    await win.loadFile(page);
    await js(`window.parsed=[];window.ComposeDraft={clear(){},open(text){parsed.push(text);return true;}};
      window.SoduWorkAPI={parseTaskText:async text=>{parsed.push(text);return{title:'隔离自动化',note:text}},
        taskExecutionOptions:async()=>({substrates:[],repos:[]})};void 0;`);
    for (const name of ['plugin-ui-host', 'schedule-timing', 'work-automation-bindings', 'work-automation-view',
      'work-automation-card-state','work-automation-sheet', 'work-entry-sheet']) {
      await js(fs.readFileSync(path.join(client, 'components/panels', name + '.js'), 'utf8') + '\nvoid 0;');
    }
    for (const kind of ['需求', '自动化']) {
      for (const long of [false, true]) {
        const original = '请处理 /login 与 #1，保留【需求】：原文。' + (long ? '\n完整要求。'.repeat(400) + '\n尾部验收' : '');
        await js(`WorkEntrySheet.close();document.querySelector('#host').replaceChildren();
          ${kind === '需求' ? 'WorkEntrySheet.openTask' : 'WorkAutomationSheet.open'}({
            host:document.querySelector('#host'),text:${JSON.stringify(original)},command:'schedule'});`);
        const actual = await js(`(document.querySelector('.pui-prompt-full') || document.querySelector('.pui-turn-prompt-bubble')).textContent`);
        assert.equal(actual, '【' + kind + '】：' + original);
        assert.equal(await js('parsed.at(-1)'), original, '展示标签不能进入解析任务正文');
        if (long) assert.equal(await js("document.querySelector('.pui-prompt-long').open"), false);
        else {
          // Wait for a layout frame before screenshots in isolated windows without a foreground paint loop.
          await new Promise(resolve => setTimeout(resolve, 150));
          fs.writeFileSync(path.join(out, kind + '.png'), (await win.webContents.capturePage()).toPNG());
        }
        report.cases.push(kind + (long ? '长文本完整保留且默认折叠' : '短文本使用自然语言标记'));
      }
    }
    assert.deepEqual(report.network, []); report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
