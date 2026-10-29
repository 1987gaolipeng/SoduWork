'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute output directory required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-locale-')));
let win;
const report = { cases: [], errors: [], candidates: {} };
const tick = () => new Promise(resolve => setTimeout(resolve, 140));
const js = source => win.webContents.executeJavaScript(source);
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
  await win.loadFile(path.join(__dirname, '../tests/plugin-presentation.html')); await tick();
  for (const file of [...JSON.parse(fs.readFileSync(path.join(__dirname, '../core/locales/manifest.json'), 'utf8')).map(file => 'locales/' + file), 'i18n-dom.js', 'i18n.js']) {
    await js(fs.readFileSync(path.join(__dirname, '../core', file), 'utf8'));
  }
  await js('SoduWorkI18n.setLocale("en-US")'); await tick();
  report.candidates.catalog = await js('SoduWorkI18n.getMissing()');
  report.catalogLabels = await js(`Array.from(document.querySelectorAll('[title],[aria-label]')).flatMap(el=>['title','aria-label'].map(attr=>el.getAttribute(attr)||'')).filter(text=>/PDF 工具箱|产品创新引擎/.test(text))`);
  assert.ok(report.catalogLabels.some(text => /^Open(?: plugin)? PDF 工具箱$/.test(text)));
  assert.ok(report.catalogLabels.every(text => !/^打开/.test(text)));
  report.cases.push('plugin action labels translate while Chinese plugin names remain intact');
  await js(`document.querySelector('#capAddButton').click();document.querySelector('[data-cap-add="plugin-create"]').click()`); await tick();
  assert.equal(await js('!!document.querySelector("#capPluginName")'), true);
  report.cases.push('production plugin authoring opens from the catalog');
  await js(`document.querySelector('#capPluginName').value='保存 this draft';document.querySelector('#capPluginName').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#capPluginName').focus();window.originalInput=document.querySelector('#capPluginName');`);
  for (const kind of ['method', 'connector', 'workflow']) {
    await js(`document.querySelector('[data-maker-type="${kind}"]').click();SoduWorkI18n.setLocale('en-US')`); await tick();
    report.candidates[kind] = await js('SoduWorkI18n.getMissing()');
    assert.equal(await js('document.querySelector("[data-entrypoint=task]").parentElement.textContent.trim()'), 'Issue execution');
    fs.writeFileSync(path.join(output, 'plugin-' + kind + '-en.png'), (await win.webContents.capturePage()).toPNG());
  }
  await js(`document.querySelector('#capPluginName').focus();SoduWorkI18n.setLocale('zh-CN');SoduWorkI18n.setLocale('en-US')`); await tick();
  assert.equal(await js('originalInput === document.querySelector("#capPluginName")'), true);
  assert.equal(await js('document.querySelector("#capPluginName").value'), '保存 this draft');
  assert.equal(await js('document.activeElement.id'), 'capPluginName');
  assert.equal(await js('fixtureDrafts.length'), 0);
  report.cases.push('three authoring modes switch language while preserving unsaved input and focus');
  win.setSize(820, 720); await tick();
  report.overflow = await js('document.documentElement.scrollWidth > innerWidth + 1');
  report.fixtureErrors = await js('fixtureErrors');
  assert.deepEqual(report.fixtureErrors, []);
  assert.deepEqual(report.errors, []);
  assert.equal(report.overflow, false);
  fs.writeFileSync(path.join(output, 'plugin-maker-en-narrow.png'), (await win.webContents.capturePage()).toPNG());
  report.ok = true;
}).catch(error => { report.error = error.stack; }).finally(() => {
  fs.writeFileSync(path.join(output, 'plugin-report.json'), JSON.stringify(report, null, 2));
  win?.destroy(); app.exit(report.ok ? 0 : 1);
});
