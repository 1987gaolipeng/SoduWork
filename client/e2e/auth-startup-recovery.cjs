'use strict';
// Production authentication UI and CSS in Chromium; temporary profiles, synthetic
// bootstrap replies, and no access to the operating-system credential store.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[name];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' })
    .on('error', error => { console.error(error); process.exitCode = 1; })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const profile = require('./lib/isolated-profile.cjs').isolateProfile(app, 'auth-startup-recovery');
  const client = path.resolve(__dirname, '..');
  const out = process.argv[2] || path.join(profile.root, 'evidence');
  assert.ok(path.isAbsolute(out), 'The evidence directory must be absolute');
  fs.mkdirSync(out, { recursive: true });
  // Chromium cookie encryption is outside this renderer-only regression.
  app.commandLine.appendSwitch('use-mock-keychain');
  const failure = '无法访问系统安全存储。请解锁登录钥匙串并重新打开 SoduWork；原设备凭据已保留。';
  const report = { ok: false, checks: [], states: [], boundary: 'Production auth renderer/CSS in Electron Chromium; synthetic bootstrap replies; isolated profile; no tray, OS keychain or production account access' };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(win, script) {
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript(script)) return;
      await sleep(20);
    }
    throw Error('Authentication state did not settle');
  }
  const windows = [];
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    for (const scenario of ['active', 'active-event', 'active-en', 'pending', 'failure', 'mount-failure']) {
      const brokenMount = scenario === 'mount-failure';
      const page = path.join(profile.root, scenario + '.html');
      const scripts = ['components/client-auth/account-ui.js', 'components/client-auth/email-auth.js'];
      const locales = scenario === 'active-en'
        ? [...JSON.parse(fs.readFileSync(path.join(client, 'core/locales/manifest.json'), 'utf8')).map(file => 'core/locales/' + file), 'core/i18n.js'] : [];
      fs.writeFileSync(page, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' +
        ['theme/variables.css', 'components/client-auth/client-auth.css', 'components/client-auth/account-center.css'].map(file => '<link rel="stylesheet" href="' + file + '">').join('') +
        '</head><body><div id="privateWorkspace">Private workspace fixture</div><script>' +
        'window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)));' +
        'window.fixtureUser=null;window.SoduWorkAPI={hubBase:()=>"",hubConfig:()=>({editable:false}),registerClient:()=>new Promise(resolve=>{window.finishEnrollment=resolve}),clientAuthMe:async()=>({user:fixtureUser}),clientAuthPolicy:async()=>({mailReady:false})};' +
        '</script>' + locales.map(file => '<script src="' + file + '"></script>').join('') +
        (scenario === 'active-en' ? '<script>SoduWorkI18n.setLocale("en-US",{persist:false,broadcast:false});</script>' : '') +
        scripts.map(file => '<script src="' + file + '"></script>').join('') +
        (brokenMount ? '<script>EmailAuth.mount=()=>{throw Error("Synthetic mount failure")};</script>' : '') +
        '<script src="components/client-auth/client-auth.js"></script></body></html>');
      const win = new BrowserWindow({ show: false, width: 1080, height: 840,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      windows.push(win);
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, callback) => callback({ cancel: true }));
      await win.loadFile(page);
      await until(win, 'typeof finishEnrollment === "function"');
      assert.equal(await win.webContents.executeJavaScript('document.getElementById("soduWorkClientAuthGate").checkVisibility()'), true);
      const restoring = await win.webContents.executeJavaScript(`({
        privateVisible: document.getElementById('privateWorkspace').checkVisibility({visibilityProperty:true}),
        loadingVisible: !!document.querySelector('[data-auth-restoring]')?.checkVisibility(),
        formVisible: !!document.querySelector('.soduwork-auth-card')?.checkVisibility(),
        accountVisible: !!document.getElementById('soduWorkAuthAccount')?.checkVisibility(),
        passwordVisible: !!document.getElementById('soduWorkAuthPassword')?.checkVisibility(),
        pending: document.documentElement.classList.contains('soduwork-auth-pending')
      })`);
      report.states.push({ scenario, phase: 'restoring', ...restoring });
      assert.equal(restoring.loadingVisible, true, 'Unconfirmed authentication shows only a neutral restoration surface');
      assert.equal(restoring.formVisible, false, 'The sign-in card must not flash before bootstrap settles');
      assert.equal(restoring.accountVisible, false);
      assert.equal(restoring.passwordVisible, false);
      assert.equal(restoring.privateVisible, false, 'Restoration must not expose unverified workspace data');
      assert.equal(restoring.pending, true);
      assert.equal(await win.webContents.executeJavaScript('document.getElementById("soduWorkAuthRestoringTitle").textContent'), scenario === 'active-en' ? 'Loading…' : '正在加载…');
      if (scenario.startsWith('active')) {
        if (scenario === 'active-event') {
          await win.webContents.executeJavaScript('fixtureUser={id:"synthetic-restored-user"};dispatchEvent(new CustomEvent("soduwork-device-auth",{detail:{state:"active",user:fixtureUser}}));void 0;');
          assert.equal(await win.webContents.executeJavaScript('document.getElementById("soduWorkClientAuthGate").hidden'), true);
          assert.equal(await win.webContents.executeJavaScript('document.getElementById("privateWorkspace").checkVisibility({visibilityProperty:true})'), true);
        }
        await win.webContents.executeJavaScript('fixtureUser={id:"synthetic-restored-user"};finishEnrollment({ok:true,user:fixtureUser});void 0;');
        await until(win, 'document.getElementById("soduWorkClientAuthGate").hidden');
        assert.equal(await win.webContents.executeJavaScript('document.getElementById("privateWorkspace").checkVisibility({visibilityProperty:true})'), true);
        assert.equal(await win.webContents.executeJavaScript('document.documentElement.classList.contains("soduwork-auth-pending")'), false);
        assert.deepEqual(await win.webContents.executeJavaScript('fixtureErrors'), []);
        report.checks.push(scenario + ': A restored authenticated session goes directly from neutral loading to its workspace without showing sign-in');
        win.destroy();
        continue;
      }
      if (scenario === 'pending') {
        await win.webContents.executeJavaScript('finishEnrollment({ok:true,activationRequired:true});void 0;');
        await until(win, '!document.querySelector("[type=submit]").disabled');
        assert.equal(await win.webContents.executeJavaScript('document.getElementById("soduWorkAuthAccount").checkVisibility()'), true);
        assert.equal(await win.webContents.executeJavaScript('document.getElementById("soduWorkAuthPassword").checkVisibility()'), true);
        assert.equal(await win.webContents.executeJavaScript('document.getElementById("privateWorkspace").checkVisibility({visibilityProperty:true})'), false);
        assert.deepEqual(await win.webContents.executeJavaScript('fixtureErrors'), []);
        report.checks.push('An authoritative pending result reveals an enabled sign-in form while keeping private content hidden');
        win.destroy();
        continue;
      }
      await win.webContents.executeJavaScript('finishEnrollment(' + JSON.stringify({ ok: false, stored: false, code: 'DEVICE_KEYCHAIN_UNAVAILABLE', error: failure }) + ');void 0;');
      await until(win, 'document.querySelector(".soduwork-auth-status").textContent === ' + JSON.stringify(failure));
      const state = await win.webContents.executeJavaScript(`({
        visible: document.getElementById('soduWorkClientAuthGate').checkVisibility(),
        privateVisible: document.getElementById('privateWorkspace').checkVisibility({visibilityProperty:true}),
        pending: document.documentElement.classList.contains('soduwork-auth-pending'),
        errors: fixtureErrors,
        recovery: !!document.querySelector('[data-auth-reload]'),
        disabled: document.querySelector('.soduwork-auth-submit').disabled
      })`);
      assert.equal(state.visible, true);
      assert.equal(state.privateVisible, false);
      assert.equal(state.pending, true);
      assert.equal(state.recovery, brokenMount);
      assert.equal(state.disabled, false);
      assert.deepEqual(state.errors, []);
      report.states.push({ scenario, phase: 'failed', ...state });
      if (brokenMount) {
        const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        await win.webContents.executeJavaScript('document.querySelector("[data-auth-reload]").click();void 0;');
        await reloaded;
        await until(win, '!!document.querySelector("[data-auth-reload]")');
        report.checks.push('A partially mounted login surface becomes visible recovery with a working reload button; private workspace stays hidden');
      } else {
        report.checks.push('Keychain cancellation leaves a visible actionable login surface with its recovery message and no renderer exception');
      }
      win.destroy();
    }
    report.ok = true;
  }).catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(() => {
    try { for (const win of windows) if (!win.isDestroyed()) win.destroy(); report.cleanup = { windowsClosed: true }; }
    catch (error) { report.ok = false; report.cleanup = { windowsClosed: false, error: String(error.stack || error) }; }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  });
}
