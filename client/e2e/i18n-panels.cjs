'use strict';
// Isolated production-renderer fixtures: collects untranslated visible UI for
// review. Network is blocked and no production profile or model is used.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute output required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-panels-locale-')));
app.on('window-all-closed', () => {});
const names = ['ai-team-empty','capability-toolbar','compact-chat-model','long-conversation','mcp-layout','new-user-data','platform-connections','schedule-card-actions','session-memory','sidebar-projects','task-handoff','task-queue-removal'];
const report = { skipped: [
  { name: 'goal-blocking', reason: 'Requires its HTTP state harness; goal UI is verified separately in i18n.cjs.' },
  { name: 'image-generation', reason: 'Requires its IPC harness; model form and picker UI are verified in separate fixtures.' },
] }; let win;
app.whenReady().then(async () => {
  for (const name of names) {
    win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    const js = source => win.webContents.executeJavaScript(source);
    report[name] = { errors: [] };
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report[name].errors.push(message); });
    try {
      await win.loadFile(path.join(__dirname,'fixtures',name+'.html'));
      await new Promise(resolve=>setTimeout(resolve,160));
      if (!(await js('!!window.SoduWorkI18n'))) {
        for (const file of [...JSON.parse(fs.readFileSync(path.join(__dirname, '../core/locales/manifest.json'), 'utf8')).map(file => 'locales/' + file), 'i18n-dom.js', 'i18n.js']) {
          await js(fs.readFileSync(path.join(__dirname,'../core',file),'utf8'));
        }
      }
      await js('SoduWorkI18n.setLocale("en-US")');
      await new Promise(resolve=>setTimeout(resolve,120));
      report[name].candidates = await js('SoduWorkI18n.getMissing()');
      report[name].visible = await js('document.body.innerText');
      fs.writeFileSync(path.join(output,name+'-en.png'),(await win.webContents.capturePage()).toPNG());
      await js('SoduWorkI18n.setLocale("zh-CN")');
    } catch(error) { report[name].error = error.stack; }
    win.destroy(); win = null;
  }
}).catch(error=>report.error=error.stack).finally(()=>{
  fs.writeFileSync(path.join(output,'panels-report.json'),JSON.stringify(report,null,2));
  win?.destroy(); app.exit(0);
});
