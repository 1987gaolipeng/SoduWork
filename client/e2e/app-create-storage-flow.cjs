'use strict';
// Real dialog -> production composer -> conversation open/send boundary.
// Transport responses are deterministic; no model or business cloud writes.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-storage-flow-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
let win;
const report = { ok: false, cases: [], boundary: 'Production Chromium dialog, composer and chat modules; deterministic conversation transport, no model execution or real cloud write.' };
const wait = async (fn, label) => {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('Timeout: ' + label);
};
app.whenReady().then(async () => {
  let html = fs.readFileSync(path.join(client, 'tests/new-conversation.html'), 'utf8');
  html = html.replace('<head>', '<head><base href="' + pathToFileURL(path.join(client, 'tests') + path.sep).href + '">');
  fs.writeFileSync(path.join(root, 'fixture.html'), html);
  win = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
  await win.loadFile(path.join(root, 'fixture.html'));
  const js = code => win.webContents.executeJavaScript(code);
  await wait(() => js('/new conversation smoke:/.test(out.textContent)'), 'base composer fixture');
  assert.match(await js('out.textContent'), /0 failed/);
  for (const file of ['panels-plugin-builder-entry.js', 'panels-apps.js']) {
    await js(fs.readFileSync(path.join(client, 'components/panels', file), 'utf8') + '\nvoid 0;');
  }
  for (const [location, label] of [['local', '数据本地化'], ['cloud', '数据云端化']]) {
    for (const [category, title] of [['office', '工具办公'], ['game', '小游戏'], ['robot', '机器人'], ['other', '其他']]) {
      const sentBefore = await js('sent.length');
      await js('openAppsCreateDialog()');
      assert.equal(await js('document.querySelectorAll("input[name=appsCreateStorage]:checked").length'), 0);
      await js('document.querySelector("[data-create-category=' + category + ']").click()');
      assert.equal(await js('sent.length'), sentBefore, 'unselected storage cannot start or send');
      await js('document.querySelector("input[name=appsCreateStorage][value=' + location + ']").click()');
      await js('document.querySelector("[data-create-category=' + category + ']").click()');
      const expected = '创建即用（' + label + '）：' + title + '：';
      assert.equal(await js('document.getElementById("cpInput").value'), expected, 'real composer displays selected storage');
      assert.equal(await js('sent.length'), sentBefore, 'creation does not auto-send');
      assert.equal(await js('routes.at(-1).payload.pluginId'), 'local:app-developer');
      await js('document.getElementById("cpGo").click()');
      await wait(() => js('sent.length > ' + sentBefore), 'send ' + location + '/' + category);
      assert.equal(await js('sent.at(-1).text'), expected);
      const options = await js('opened.at(-1)');
      assert.ok(options.contextPrompts.some(row => row.includes('"location":"' + location + '"')), 'storage reaches actual conversation open options');
      assert.ok(options.contextPrompts.some(row => row.includes('appCategory=' + category)));
      report.cases.push(location + '/' + category + ': required choice, visible composer, explicit send, model context');
    }
  }
  await js('openAppsCreateDialog();appsCreateCancel.click()');
  assert.equal(await js('appsCreateMask.classList.contains("show")'), false);
  await js('openAppsCreateDialog();appsCreateWebTab.click();appsCreateGo.click()');
  assert.equal(await js('cpInput.value'), '创建网页类即用：');
  report.cases.push('cancel and web entry preserve their existing behavior');
  report.ok = true;
}).catch(error => { report.error = String(error.stack || error); }).finally(() => {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: root }));
  win?.destroy(); app.exit(report.ok ? 0 : 1);
});
