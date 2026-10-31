'use strict';
// Isolated Chromium rendering and interaction checks; no real account or model calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const out = path.resolve(__dirname, '../../outputs/quota-plans-client'); fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-quota-ui-')));
  app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], boundary: 'Isolated Chromium UI using production quota components with fixture responses. No live Hub, account, model, or billing changes.' };
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const script = file => '<script>' + read(file).replace(/<\/script/gi, '<\\/script') + '</script>';
  let win;
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 960, height: 720, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const phrases = read('core/token-quota.js') + read('components/client-auth/quota-notice.js');
    const messages = Object.fromEntries(['en-US', 'ja-JP', 'ko-KR'].map(locale => [locale, Object.fromEntries(
      Object.entries(require('../core/locales/' + locale + '-gap-pages')).filter(([key]) => phrases.includes(key)))]));
    const html = '<!doctype html><meta charset="utf-8"><style>' +
      ':root{--ink:#303238;--ink-3:#747780;--bg-0:#fff;--bg-1:#f7f8fa;--bg-2:#eff1f4;--line:#e5e7eb;--accent:#467de6}' +
      'body{margin:0;background:white;font:14.5px Segoe UI,sans-serif;color:var(--ink)}main{max-width:740px;margin:55px auto;padding:0 20px}#transcript{min-height:260px}textarea{box-sizing:border-box;width:100%;min-height:90px;padding:20px;border:1px solid #e5e7eb;border-radius:16px;font:inherit}small{color:#747780}' +
      read('components/client-auth/quota-notice.css') + '</style><main><small>Allowance UI validation fixture</small>' +
      '<section id="transcript"><h2>已保存的对话</h2><p>这条已完成的回复和工具结果保持不变。</p></section>' +
      '<div id="composer"><textarea id="draft">保留这段尚未发送的文字</textarea></div></main>' +
      '<script>window.fixture={user:"fixture-a",locale:"zh-CN",calls:0};window.messages=' + JSON.stringify(messages) + ';' +
      'window.SoduWorkI18n={getLocale:()=>fixture.locale,translateText:value=>messages[fixture.locale]?.[value]||value};' +
      'window.SoduWorkAPI={hubConfig:()=>({hub:"http://fixture.invalid"}),clientAuthSnapshot:()=>({user:{id:fixture.user}}),' +
      'clientAuthMe:()=>{fixture.calls++;return new Promise(resolve=>fixture.resolve=resolve)}};</script>' +
      script('core/token-quota.js') + script('components/client-auth/quota-notice.js') +
      '<script>SoduWorkQuotaNotice.mount(document.querySelector("#composer"));</script>';
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const js = code => win.webContents.executeJavaScript(code, true);
    const update = quota => js('SoduWorkQuotaNotice.update({quota:' + JSON.stringify(quota) + '})');
    const view = () => js('({text:document.querySelector(".soduwork-quota-card").innerText,hidden:document.querySelector(".soduwork-quota-card").hidden,draft:document.querySelector("#draft").value,history:document.querySelector("#transcript").innerText})');
    const record = name => { report.cases.push(name); console.log('PASS ' + name); };
    const total = { enabled: true, exceeded: true, reason: 'total_exhausted', limit: 100000, used: 100000,
      planName: '试用套餐', expiresAt: '2026-11-01T08:00:00Z', models: [] };
    await update(total);
    assert.match((await view()).text, /试用额度已用完/);
    assert.equal(await js('document.querySelector(".soduwork-quota-card").parentNode === document.querySelector("#composer").parentNode'), true);
    assert.equal(await js('document.querySelector("#transcript .soduwork-quota-card")'), null);
    assert.equal(await js('document.querySelector(".quota-card-copy").getAttribute("aria-live")'), 'polite');
    assert.equal((await view()).draft, '保留这段尚未发送的文字');
    record('Trial allowance appears beside composer, with polite status, retained draft and history');
    await js('window.savedTitle=document.querySelector("[data-quota-title]");document.querySelector("details").open=true');
    for (let i = 0; i < 10; i++) await update(total);
    assert.equal(await js('savedTitle===document.querySelector("[data-quota-title]") && document.querySelector("details").open'), true);
    assert.equal(await js('document.querySelectorAll(".soduwork-quota-card").length'), 1);
    record('Repeated quota updates preserve nodes and expanded details');
    await update({ ...total, reason: 'trial_expired', used: 12 });
    assert.match((await view()).text, /试用已结束/);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(out, 'trial-expired.png'), image.toPNG()));
    for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
      await js('fixture.locale=' + JSON.stringify(locale) + ';dispatchEvent(new Event("soduwork-locale-change"))');
      assert.equal(await js('document.querySelector("[data-quota-title]").textContent'), messages[locale]['试用已结束']);
      assert.equal(await js('document.querySelector("[data-quota-refresh]").textContent'), messages[locale]['刷新额度']);
    }
    record('English, Japanese and Korean status and actions localize without rebuilding the card');
    await js('fixture.locale="zh-CN";dispatchEvent(new Event("soduwork-locale-change"))');
    const row = { provider: 'example', model: 'model-a', limit: 1000, used: 1000, remaining: 0, exceeded: true, unattributedUsed: 150 };
    const model = { enabled: true, exceeded: true, totalLimited: false, reason: 'model_exhausted', model: row, models: [row] };
    await update({ ...model, models: [row, { ...row, model: 'model-b', exceeded: false, remaining: 500 }] });
    await js('SoduWorkQuotaNotice.modelChanged({id:"model-b"})');
    assert.equal((await view()).hidden, true, 'a different conversation with allowance clears the previous model notice');
    await js('SoduWorkQuotaNotice.modelChanged({id:"model-a"})');
    assert.equal((await view()).hidden, false, 'returning to the exhausted model re-evaluates its allowance');
    await update(total);
    await js('SoduWorkQuotaNotice.modelChanged({id:"model-b"})');
    assert.equal((await view()).hidden, false, 'conversation navigation retains account-wide exhaustion');
    await update(model);
    assert.match((await view()).text, /其中 150 Tokens 来自旧版用量，已计入当前模型额度/);
    await js('SoduWorkQuotaNotice.refresh();SoduWorkQuotaNotice.refresh();void 0');
    assert.equal(await js('fixture.calls'), 1);
    await js('fixture.resolve({quota:' + JSON.stringify({ ...model, model: null, exceeded: false, reason: '' }) + '})');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await view()).hidden, false);
    await js('SoduWorkQuotaNotice.refreshIfBlocked();void 0');
    await js('fixture.resolve({quota:' + JSON.stringify({ ...model, model: null, exceeded: false, reason: '', models: [{ ...row, limit: 2000, remaining: 1000, exceeded: false }] }) + '})');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await view()).hidden, true);
    const refreshedCalls = await js('fixture.calls');
    await js('SoduWorkQuotaNotice.refreshIfBlocked();void 0');
    assert.equal(await js('fixture.calls'), refreshedCalls, 'successful unblocked turns do not poll allowance');
    record('Refresh is single-flight and preserves model-specific denial until that model recovers');
    await update(total);
    await js('SoduWorkQuotaNotice.refresh();fixture.user="fixture-b";dispatchEvent(new Event("soduwork-data-scope-changed"));fixture.resolve({quota:' + JSON.stringify(total) + '})');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await view()).hidden, true);
    record('An old-account refresh cannot restore quota guidance after an account switch');
    win.setSize(370, 680);
    await update(total);
    assert.equal((await view()).hidden, false);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(out, 'allowance-narrow.png'), image.toPNG()));
    record('Narrow composer has no horizontal overflow');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); console.error(report.error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  });
}
