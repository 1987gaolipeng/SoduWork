'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-update-ui-'));
  const out = path.resolve(client, '../outputs/update-details-issue-27/electron'); fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'electron-profile'));
  const report = { ok: false, cases: [], layouts: [], errors: [] }, states = [], scheduled = [];
  let win, server, interval, resumeDownload, busyWork = true, version = '1.2.12', helperCalls = 0, prompts = 0;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(check, label, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = typeof check === 'string' ? await js(check) : await check(); if (value) return value; await delay(25); }
    throw Error('Timed out: ' + label);
  }
  async function click(selector) {
    const point = await js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('unavailable button');b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!b.contains(document.elementFromPoint(x,y)))throw Error('occluded button: '+${JSON.stringify(selector)});return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(60);
  }
  function publish(status) {
    states.push(status); if (win && !win.isDestroyed()) win.webContents.send('client-update-status', status);
  }
  app.whenReady().then(async () => {
    ipcMain.handle('workspace-state-context', () => null);
    const contract = require('../main/client-update-contract'), updater = require('../main/client-updater');
    const appPath = path.join(root, 'app'); fs.mkdirSync(appPath);
    const pair = crypto.generateKeyPairSync('ed25519'), key = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    fs.writeFileSync(path.join(appPath, 'update-trust.json'), JSON.stringify({ schema: 1, keys: { 'fixture-key': key } }));
    const artifact = Buffer.alloc(2 * 1024 ** 2, 83), id = '12345678-1234-4234-8234-123456789abc';
    const artifactName = process.platform === 'linux' ? 'SoduWork-1.2.13-linux.deb'
      : process.platform === 'darwin' ? 'SoduWork-1.2.13-mac-' + process.arch + '.dmg' : 'SoduWork-1.2.13-Setup.exe';
    const manifest = { schema: 1, releaseId: id, version: '1.2.13', channel: 'stable', platform: process.platform, arch: process.arch,
      artifact: { name: artifactName, size: artifact.length, sha256: crypto.createHash('sha256').update(artifact).digest('hex'), url: '/api/v1/client-updates/artifacts/' + id },
      mandatory: false, keyId: 'fixture-key', notes: '修复与改进\n• 保留工作内容\n<img src=x onerror=alert(1)>' };
    manifest.signature = crypto.sign(null, contract.canonicalBytes(manifest), pair.privateKey).toString('base64');
    server = http.createServer((request, response) => {
      request.resume();
      if (request.url.includes('/check?')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ hasUpdate: true, attemptId: id, manifest })); }
      else if (request.url === manifest.artifact.url) {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': artifact.length });
        let offset = 0, released = false; resumeDownload = () => { released = true; };
        interval = setInterval(() => {
          if (offset >= artifact.length) { clearInterval(interval); response.end(); return; }
          if (offset >= artifact.length / 4 && !released) return;
          const next = Math.min(offset + 65536, artifact.length); response.write(artifact.subarray(offset, next)); offset = next;
        }, 35);
      } else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(request.url.endsWith('/prepare') ? { safe: true, blockers: [], retryAfterMs: 100 } : { ok: true })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: false, width: 1150, height: 850,
      webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
    updater.install({ app: { isPackaged: true, getVersion: () => version, getPath: () => root, getAppPath: () => appPath,
      whenReady: () => Promise.resolve(), quit: () => assert.fail('fixture must never quit client'), exit: () => assert.fail('fixture must never exit client') },
      ipcMain, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_channel, state) => publish(state) } }] },
      identityOf: async () => ({ hub: 'http://127.0.0.1:' + server.address().port, clientId: 'fixture', session: 'isolated' }),
      getWindow: () => null, dialog: { showMessageBox: async () => { prompts++; return { response: 1 }; } },
      localWorkloads: () => ({ safe: !busyWork, blockers: busyWork ? [{ kind: 'conversation', id: 'fixture-chat', ref: 'fixture-ref', title: '正在生成的报告' }] : [] }),
      // Exercise the Linux update state machine with fixture package-manager results; never install system packages.
      linuxExec: async (file, args) => {
        if (file === 'dpkg-query') return { stdout: args[0] === '-L'
          ? fs.realpathSync(process.execPath) : 'install ok installed' };
        if (file === 'rpm') return { error: { code: 1 }, stdout: '' };
        if (file === 'which') return { stdout: '/fixture/' + args[0] };
        if (file === '/fixture/pkexec') { helperCalls++; return { stdout: '' }; }
        throw Error('Unexpected fixture command: ' + file);
      },
      launchHelper: async () => { helperCalls++; }, schedule: (fn, ms) => scheduled.push({ fn, ms }),
      wait: () => delay(60), drainTimeoutMs: 20000,
    });
    const desk = read('desk.html'), cardStart = desk.indexOf('<div class="set-group client-update-card">');
    const realCard = desk.slice(cardStart, desk.indexOf('\n</div>', cardStart));
    assert.ok(realCard.includes('clientUpdateProgress'));
    const fixtureHtml = '<!doctype html><html lang="zh-CN" data-theme="azure"><meta charset="utf-8"><title>升级体验隔离验证</title>' +
      '<base href="' + pathToFileURL(client + path.sep).href + '">' +
      ['theme/variables.css', 'components/workspace/workspace-shell.css', 'components/panels/panels-detail.css', 'components/settings/settings.css', 'components/settings/client-update-view.css', 'theme/box-theme.css']
        .map(file => '<link rel="stylesheet" href="' + file + '">').join('') +
      '<style>*{box-sizing:border-box}body{margin:0;background:var(--bg-1);font:14px var(--font-ui);color:var(--ink)}main{padding:44px 70px}textarea{width:100%;height:130px;border:1px solid var(--line);border-radius:14px;padding:20px;background:var(--bg-0);font:16px var(--font-ui)}.ws-update{position:fixed;left:18px;bottom:20px}#settingsPanel{display:none;position:absolute;inset:0;padding:40px 60px;background:var(--bg-0);overflow:auto}.client-update-card{max-width:700px;margin:auto}#settingsPanel.show{display:block}</style>' +
      '<main><h2>继续当前工作</h2><p>更新在后台进行</p><textarea id="workInput" placeholder="工作内容保持不变"></textarea></main><aside class="ws-rail"><button class="ws-update ws-rail-update" id="wsUpdate" hidden></button></aside>' +
      '<section id="settingsPanel"><div style="height:1100px" aria-hidden="true"></div>' + realCard + '</section></html>';
    const file = path.join(root, 'update.html'); fs.writeFileSync(file, fixtureHtml); await win.loadFile(file);
    await js('window.errors=[];addEventListener("error",e=>errors.push(e.message));window.openSettings=()=>document.querySelector("#settingsPanel").classList.add("show");window.closeSettings=()=>document.querySelector("#settingsPanel").classList.remove("show");void 0;');
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
    for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/settings/client-update-view.js']) await js(read(file) + '\nvoid 0;');
    const settings = read('components/settings/settings.js');
    await js(settings.slice(settings.indexOf('let _clientUpdateState'), settings.indexOf('function _bindSettingsEvents(')) + '\nvoid 0;');
    await js('window.cfg={};window._refreshBindNote=()=>{};void 0;');
    await js(settings.slice(settings.indexOf('function openSettings()'), settings.indexOf('function applyScale(')) + '\nvoid 0;');
    // Exercise the production workspace route as well as the settings lifecycle.
    // Calling openSettings alone leaves the previous page and navigation active.
    await js(`window.__deskPanel='workspace';
      window.OPENERS={settings:()=>openSettings(),create:()=>{document.querySelector('main').hidden=false;}};
      window.CLOSERS={create:'closeComposePanel',settings:'closeSettings'};
      window.closeComposePanel=()=>{document.querySelector('main').hidden=true;};
      window.WorkspaceShell={setActive:key=>{document.body.dataset.activeView=key;}};void 0;`);
    const boot = read('desk-boot.js');
    await js(boot.slice(boot.indexOf('const WORKSPACE_TARGET'), boot.indexOf('OPENERS.workspace =')) + '\nvoid 0;');
    for (const file of ['components/workspace/workspace-navigation.js', 'core/win-bridge.js']) await js(read(file) + '\nvoid 0;');
    await js('WorkspaceHost.open("create",{});');
    await js('_bindClientUpdateStatus();soduWorkAPI.onClientUpdateStatus(s=>ClientUpdateView.present(s,document.querySelector("#wsUpdate")));document.querySelector("#workInput").focus();');
    const download = updater.check({ interactive: false });
    await until(() => states.some(row => row.phase === 'downloading' && row.receivedBytes >= artifact.length / 4), 'actual quarter download');
    await until('document.querySelector(".update-notice [data-update-percent]").textContent==="25%"', 'visible byte progress');
    assert.equal(prompts, 0); assert.equal(await js('document.activeElement.id'), 'workInput');
    assert.equal(helperCalls, 0);
    await click('.update-notice [data-update-notes] summary');
    assert.equal(await js('document.querySelector(".update-notice [data-update-notes]").open'), true);
    assert.equal(await js('document.querySelector(".update-notice [data-release-notes-body]").textContent'), manifest.notes);
    assert.equal(await js('document.querySelector(".update-notice [data-release-notes-body] img")'), null);
    await click('.update-notice [data-update-notes] summary');
    report.cases.push('真实签名清单、本机 HTTP 流、真实 updater 和 preload 推送下载进度；无弹窗、未抢输入焦点、未触发安装。');
    for (const width of [1150, 480, 320]) for (const lang of ['zh-CN', 'en-US']) {
      win.setSize(width, 850); await js(`SoduWorkI18n.setLocale(${JSON.stringify(lang)});document.documentElement.dataset.theme=${JSON.stringify(lang === 'zh-CN' ? 'azure' : 'ruby')}`); await delay(180);
      const layout = await js('(()=>{const n=document.querySelector(".update-notice"),r=n.getBoundingClientRect(),b=n.querySelector("[data-update-close]").getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,height:r.height,overflow:n.scrollWidth>n.clientWidth,closeVisible:b.right<=innerWidth,bar:getComputedStyle(n.querySelector("[data-update-bar] i")).backgroundColor,accent:getComputedStyle(n).getPropertyValue("--accent").trim(),font:parseFloat(getComputedStyle(n.querySelector("p")).fontSize),focus:document.activeElement.id}})()');
      assert.ok(layout.left >= 0 && layout.right <= width); assert.equal(layout.overflow, false); assert.equal(layout.closeVisible, true); assert.ok(layout.font >= 13);
      report.layouts.push({ viewportWidth: width, lang, ...layout }); fs.writeFileSync(path.join(out, `download-${width}-${lang}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await js('document.documentElement.style.setProperty("--font-scale","1.3")'); await delay(100);
    assert.ok(await js('(()=>{const n=document.querySelector(".update-notice"),r=n.getBoundingClientRect();return n.scrollWidth===n.clientWidth&&r.top>=0&&r.right<=innerWidth&&parseFloat(getComputedStyle(n.querySelector("p")).fontSize)>16})()'));
    report.layouts.push({ viewportWidth: 320, lang: 'en-US', fontScale: 1.3, overflow: false });
    await js('document.documentElement.style.removeProperty("--font-scale")');
    win.setSize(1150, 850); await js('SoduWorkI18n.setLocale("zh-CN")'); await delay(120);
    await click('[data-update-close]'); assert.equal(await js('document.querySelector(".update-notice").hidden'), true);
    resumeDownload(); const ready = await download; assert.equal(ready.state, 'downloaded');
    assert.equal(helperCalls, 0); assert.equal(await js('document.querySelector(".update-notice").hidden'), true);
    await click('#wsUpdate'); await until('document.querySelector("[data-update-action]").textContent.includes("重启并更新")', 'ready action');
    await js('document.querySelector("[data-update-details]").focus()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until('document.querySelector(".update-notice").hidden&&document.activeElement.id==="wsUpdate"', 'keyboard minimize and focus return');
    await click('#wsUpdate');
    assert.equal(await js('document.querySelector(".update-notice [data-update-percent]").textContent'), '');
    report.cases.push('收起进度后百分比变化不反复弹出；下载并校验完成仍等待明确重启操作，100%下载不冒充安装完成。');
    const readyCopies = { 'zh-CN': ['下载完成', '校验通过', '待重启'], 'en-US': ['Downloaded', 'Verified', 'Awaiting restart'],
      'ja-JP': ['ダウンロード済み', '検証済み', '再起動待ち'], 'ko-KR': ['다운로드 완료', '검증 완료', '재시작 대기'] };
    for (const [skin, theme] of [['box', 'azure'], ['glass', 'azure'], ['glass', 'ruby'], ['glass', 'minimal']]) {
      for (const width of [1150, 480, 320]) for (const lang of ['zh-CN', 'en-US']) {
        win.setSize(width, 850);
        await js(`document.documentElement.dataset.skin=${JSON.stringify(skin)};document.documentElement.dataset.theme=${JSON.stringify(theme)};SoduWorkI18n.setLocale(${JSON.stringify(lang)});ClientUpdateView.present(${JSON.stringify(ready)},document.querySelector('#wsUpdate'));`);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: width - 20, y: 20 });
        await delay(200); // Wait for the existing background transition before comparing theme colors.
        const layout = await js(`(()=>{const notice=document.querySelector('.update-notice'),r=notice.getBoundingClientRect(),
          badge=document.querySelector('#wsUpdate'),button=notice.querySelector('[data-update-action]'),
          title=notice.querySelector('[data-update-title]').textContent;return{
          left:r.left,right:r.right,top:r.top,overflow:notice.scrollWidth>notice.clientWidth,
          badgeColor:getComputedStyle(badge).color,buttonColor:getComputedStyle(button).backgroundColor,
          badgeBackground:getComputedStyle(badge).backgroundColor,noticeBackground:getComputedStyle(notice).backgroundColor,
          stepLabels:[...notice.querySelectorAll('[data-update-step-label]')].map(e=>e.textContent),
          currentSteps:notice.querySelectorAll('.is-current').length,completedSteps:notice.querySelectorAll('.is-complete').length,
          trackVisible:notice.querySelector('[data-update-bar]').checkVisibility(),
          metaVisible:notice.querySelector('.update-progress-meta').checkVisibility(),
          titleCount:notice.innerText.split(title).length-1,
          buttonVisible:button.checkVisibility(),closeVisible:notice.querySelector('[data-update-close]').checkVisibility(),
          clip:{x:0,y:Math.max(0,Math.floor(r.top)-16),width:Math.min(innerWidth,450),height:innerHeight-Math.max(0,Math.floor(r.top)-16)}};})()`);
        assert.ok(layout.left >= 0 && layout.right <= width && layout.top >= 0);
        assert.equal(layout.overflow, false); assert.equal(layout.badgeColor, layout.buttonColor);
        assert.equal(layout.badgeBackground, layout.noticeBackground);
        assert.deepEqual(layout.stepLabels, readyCopies[lang]);
        assert.equal(layout.currentSteps, 0); assert.equal(layout.completedSteps, 2);
        assert.equal(layout.trackVisible, false); assert.equal(layout.metaVisible, false); assert.equal(layout.titleCount, 1);
        assert.ok(layout.buttonVisible && layout.closeVisible);
        report.layouts.push({ phase: 'ready', skin, theme, viewportWidth: width, lang, ...layout });
        if (lang === 'zh-CN' && width !== 480) fs.writeFileSync(path.join(out, `ready-${skin}-${theme}-${width}.png`),
          (await win.webContents.capturePage(layout.clip)).toPNG());
      }
    }
    for (const lang of ['ja-JP', 'ko-KR']) {
      win.setSize(320, 850);
      await js(`document.documentElement.dataset.skin='box';SoduWorkI18n.setLocale(${JSON.stringify(lang)});ClientUpdateView.present(${JSON.stringify(ready)},document.querySelector('#wsUpdate'));`);
      await delay(80);
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('.update-notice [data-update-step-label]'),e=>e.textContent)`), readyCopies[lang]);
      assert.equal(await js(`(()=>{const n=document.querySelector('.update-notice');return n.scrollWidth>n.clientWidth})()`), false);
    }
    report.cases.push('24 组就绪态布局：盒子/玻璃皮肤、紫/蓝/红/黑主题、320/480/1150 宽度、中英文；入口与按钮同主题色，无绿色底色混入，标题仅一处，下载/校验完成与待重启准确显示；日/韩文窄屏也无溢出。');
    win.setSize(1150, 850);
    await js(`document.documentElement.dataset.skin='glass';document.documentElement.dataset.theme='azure';SoduWorkI18n.setLocale('zh-CN');ClientUpdateView.present(${JSON.stringify(ready)},document.querySelector('#wsUpdate'));`);
    await click('[data-update-details]');
    assert.equal(await js('WorkspaceHost.view'), 'settings');
    assert.equal(await js('document.documentElement.dataset.workspaceView'), 'settings');
    assert.equal(await js('document.body.dataset.activeView'), 'settings');
    assert.equal(await js('document.querySelector("main").hidden'), true);
    await until('document.querySelector("#settingsPanel").scrollTop>400', 'ready details after settings scroll reset');
    assert.equal(await js('document.activeElement.id'), 'clientUpdateAction');
    assert.equal(await js('document.querySelector(".update-notice").hidden'), true);
    assert.equal(helperCalls, 0);
    await click('#clientUpdateNotes summary');
    assert.equal(await js('document.querySelector("#clientUpdateNotes").open'), true);
    assert.equal(await js('document.querySelector("#clientUpdateNotes [data-release-notes-body]").textContent'), manifest.notes);
    assert.equal(await js('document.querySelector("#clientUpdateNotes [data-release-notes-body] img")'), null);
    await js(`_paintClientUpdateStatus(${JSON.stringify(ready)})`);
    assert.equal(await js('document.querySelector("#clientUpdateNotes").open'), true);
    report.cases.push('真实签名说明经过更新 IPC 到设置详情，鼠标展开后文本及换行完整、HTML 不执行、进度刷新保留展开。');
    // Reopening details while already in settings must still reveal the card.
    await js('document.querySelector("#settingsPanel").scrollTop=0;');
    await click('#wsUpdate'); await click('[data-update-details]');
    await until('document.querySelector("#settingsPanel").scrollTop>400', 'details from settings');
    fs.writeFileSync(path.join(out, 'ready-details.png'), (await win.webContents.capturePage()).toPNG());
    report.cases.push('实际点击查看详情经过生产工作区导航：切到设置、关闭原工作页、定位更新卡并聚焦；设置页内重复打开也可定位，未触发安装。');
    await js('WorkspaceHost.open("create",{});');
    await click('#wsUpdate');
    await click('[data-update-action]'); await until(() => states.at(-1).state === 'waiting', 'real busy work drain');
    await until('document.querySelector(".update-notice [data-update-title]").textContent.includes("等待")', 'waiting title');
    assert.equal(helperCalls, 0); await click('[data-update-action]');
    assert.equal(await js('WorkspaceHost.view'), 'settings');
    assert.equal(await js('document.body.dataset.activeView'), 'settings');
    await until('document.querySelector("#settingsPanel").classList.contains("show")', 'settings details');
    await until('document.querySelector("#settingsPanel").scrollTop>400', 'details stay scrolled past settings reset');
    assert.ok(await js('(()=>{const r=document.querySelector("#clientUpdateAction").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'));
    assert.ok(await js('document.querySelector("#clientUpdateBlockers").textContent.includes("正在生成的报告")'));
    await click('#clientUpdateAction'); await until(() => states.at(-1).state === 'deferred', 'cancel waiting');
    report.cases.push('实际工作阻塞时显示等待阶段、具体任务和取消等待；下载100%不会掩盖安全等待。');
    busyWork = false; await click('#clientUpdateAction'); await until(() => helperCalls === 1, 'safe handoff boundary');
    assert.ok(states.some(row => row.phase === 'verifying')); assert.ok(states.some(row => row.phase === 'restarting'));
    assert.ok(scheduled.length >= 2); assert.equal(await js('document.querySelector("#clientUpdateProgress [data-update-bar]").hasAttribute("aria-valuenow")'), false);
    report.cases.push('工作结束后重新安装，真实复验与静默交接阶段可见；安装器启动及退出在边界拦截，不操作本机客户端。');
    version = '1.2.13'; await updater.confirmPending(); await until(() => states.at(-1).state === 'installed', 'new version confirmed');
    await until('document.querySelector("[data-update-title]").textContent.includes("已更新")', 'success visible');
    await js('closeSettings()'); await delay(180);
    fs.writeFileSync(path.join(out, 'installed.png'), (await win.webContents.capturePage()).toPNG());
    publish({ state: 'failed', phase: 'downloading', targetVersion: '1.2.14', error: '<img src=x onerror=alert(1)> 网络断开' });
    await until('document.querySelector(".update-notice [data-update-title]").textContent.includes("没有完成")', 'failure visible');
    assert.equal(await js('document.querySelector(".update-notice").querySelectorAll("img").length'), 0);
    assert.equal(await js('document.querySelector(".update-notice [data-update-bar]").closest(".update-progress").hidden'), true);
    report.cases.push('只有新版启动确认才显示成功；失败覆盖旧进度且错误内容按纯文本显示。');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(async error => { report.error = error.stack || String(error); report.lastStates = states.slice(-8); try {
    fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } catch {} }).finally(async () => {
    clearInterval(interval); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, layouts: report.layouts.length, error: report.error, report: path.join(out, 'report.json') }));
    app.exit(report.ok ? 0 : 1);
  });
}
