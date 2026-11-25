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
      fs.writeFileSync(page, '<!doctype html><html lang="zh-CN" data-window-titlebar="overlay"><head><meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">' +
        ['theme/variables.css', 'components/client-auth/client-auth.css', 'components/client-auth/account-center.css'].map(file => '<link rel="stylesheet" href="' + file + '">').join('') +
        '</head><body><div id="privateWorkspace">Private workspace fixture</div><script>' +
        'window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)));' +
        'window.fixtureUser=null;window.SoduWorkAPI={hubBase:()=>"",hubConfig:()=>({editable:' + (scenario === 'pending') + '}),registerClient:()=>new Promise(resolve=>{window.finishEnrollment=resolve}),clientAuthMe:async()=>({user:fixtureUser}),clientAuthPolicy:async()=>({mailReady:false})};' +
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
        win.setContentSize(800, 540);
        await until(win, 'innerHeight < 560');
        const modalState = await win.webContents.executeJavaScript(`(() => {
          const password = document.querySelector('#soduWorkAuthPassword');
          const trigger = document.querySelector('[data-edit-hub]');
          const submit = document.querySelector('.soduwork-auth-submit');
          password.value = 'synthetic-only';
          trigger.focus();
          const top = submit.getBoundingClientRect().top;
          trigger.click();
          const dialog = document.querySelector('.ac-hub-dialog');
          const modal = dialog.matches(':modal') && document.activeElement === dialog.querySelector('input');
          dialog.querySelector('.ac-hub-cancel').click();
          return { modal, closed: !dialog.open, focused: document.activeElement === trigger,
            preserved: password.value === 'synthetic-only', stable: submit.getBoundingClientRect().top === top };
        })()`);
        assert.deepEqual(modalState, { modal: true, closed: true, focused: true, preserved: true, stable: true });
        await win.webContents.executeJavaScript('document.querySelector("[data-edit-hub]").click()');
        win.webContents.debugger.attach('1.3');
        for (const type of ['keyDown', 'keyUp']) {
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
            type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27
          });
        }
        await until(win, '!document.querySelector(".ac-hub-dialog").open && document.activeElement.matches("[data-edit-hub]")');
        // Native scrollbar dragging requires a displayed compositor surface.
        win.showInactive();
        await win.webContents.executeJavaScript(`document.querySelector('[data-auth-mode="register"]').click();
          document.querySelector('.soduwork-auth-gate').scrollTop = 0;`);
        await until(win, 'document.querySelector("#acConfirmPassword").checkVisibility()');
        const registration = await win.webContents.executeJavaScript(`(() => {
          const gate = document.querySelector('.soduwork-auth-gate');
          return { overflow: gate.scrollHeight > gate.clientHeight,
            pageDrag: getComputedStyle(gate).webkitAppRegion,
            captionDrag: getComputedStyle(gate, '::before').webkitAppRegion };
        })()`);
        assert.ok(registration.overflow, 'small-window registration exercises the scrolling surface');
        assert.notEqual(registration.pageDrag, 'drag', 'the scrolling surface must accept pointer input');
        assert.equal(registration.captionDrag, 'drag');
        if (process.platform === 'win32') {
          const wheel = await win.webContents.executeJavaScript(`(() => {
            const gate = document.querySelector('.soduwork-auth-gate');
            gate.scrollTop = 120;
            function tick(deltaY, options = {}, target = gate) {
              const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...options });
              Object.defineProperty(event, 'wheelDeltaY', { value: -Math.sign(deltaY) * 120 });
              target.dispatchEvent(event);
              return event.defaultPrevented;
            }
            const first = tick(100), repeated = tick(100), reversed = tick(-100);
            return { first, repeated, reversed, zoom: tick(100, { ctrlKey: true }),
              precise: tick(-2), select: tick(100, {}, gate.querySelector('select')) };
          })()`);
          assert.deepEqual(wheel, { first: true, repeated: true, reversed: true,
            zoom: false, precise: false, select: false });
          await until(win, 'document.querySelector(".soduwork-auth-gate").scrollTop < 60');
          await win.webContents.executeJavaScript('document.querySelector(".soduwork-auth-gate").scrollTo({top:0,behavior:"instant"})');
        }
        const track = await win.webContents.executeJavaScript(`(() => {
          const gate = document.querySelector('.soduwork-auth-gate');
          const rect = gate.getBoundingClientRect();
          return { width: gate.offsetWidth - gate.clientWidth, right: rect.right,
            top: rect.top + gate.clientTop };
        })()`);
        // Overlay scrollbars reserve no gutter. Classic scrollbars need a usable drag target.
        if (track.width) {
          assert.ok(track.width >= 10, 'the registration scrollbar is wide enough to grab');
          const x = track.right - track.width / 2;
          const pointer = (type, y, details) => win.webContents.debugger.sendCommand(
            'Input.dispatchMouseEvent', { type, x, y, ...details });
          await pointer('mouseMoved', track.top + 32, {});
          await win.webContents.executeJavaScript('new Promise(requestAnimationFrame)');
          await pointer('mousePressed', track.top + 32, { button: 'left', buttons: 1, clickCount: 1 });
          for (const offset of [48, 80, 120]) {
            await pointer('mouseMoved', track.top + offset, { button: 'left', buttons: 1 });
            await win.webContents.executeJavaScript('new Promise(requestAnimationFrame)');
          }
          await until(win, 'document.querySelector(".soduwork-auth-gate").scrollTop > 0');
          await pointer('mouseReleased', track.top + 120, { button: 'left', clickCount: 1 });
        }
        for (const deltaY of [1200, -1200]) {
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 40, y: 260, deltaX: 0, deltaY
          });
          await until(win, deltaY > 0
            ? 'document.querySelector(".ac-auth-footer").getBoundingClientRect().bottom <= innerHeight'
            : 'document.querySelector(".soduwork-auth-gate").scrollTop === 0');
        }
        win.hide();
        report.checks.push('Small-window registration scrolls to the footer and back from the page margin');
        await win.webContents.executeJavaScript(`document.querySelector('[data-edit-hub]').click();
          fixtureUser = { id: 'synthetic-restored-user' };
          dispatchEvent(new CustomEvent('soduwork-device-auth', { detail: { state: 'active', user: fixtureUser } })); void 0;`);
        await until(win, 'document.getElementById("soduWorkClientAuthGate").hidden && !document.querySelector("dialog:modal")');
        report.checks.push('Editing the endpoint opens a focused dialog; cancel retains credentials and returns focus');
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
