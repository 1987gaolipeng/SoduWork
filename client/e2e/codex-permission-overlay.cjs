'use strict';
// Real mouse -> production renderer/preload/IPC -> real Python HTTP approval
// broker. ACP envelopes and the gated agent output are isolated fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), readline = require('node:readline');
  const { spawn } = require('node:child_process'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), repo = path.dirname(client);
  const out = path.join(repo, 'outputs/codex-permission-overlay');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-codex-permission-e2e-'));
  app.setPath('userData', path.join(root, 'profile'));
  fs.mkdirSync(out, { recursive: true });
  const report = { ok: false, boundary: 'Synthetic ACP envelopes matching installed codex-acp 1.6.2; real production AccessControls, preload, trusted answer IPC, ACP bridge, private authenticated HTTP AccessBroker, mouse events and gated temporary file writes. No real model/browser automation or business data.',
    cases: [], layouts: [], screenshots: [], answers: [], errors: [] };
  const replies = new Map(), ref = 'codex-permission-e2e';
  let win, python, rpcId = 0, latest, poll, updating = false, shuttingDown = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  function rpc(action, extra = {}) {
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { replies.delete(id); reject(Error('Fixture timeout: ' + action)); }, 15000);
      replies.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject });
      python.stdin.write(JSON.stringify({ id, action, ...extra }) + '\n');
    });
  }
  async function until(condition, label) {
    for (let index = 0; index < 200; index++) {
      const result = typeof condition === 'string' ? await js(condition) : await condition();
      if (result) return result;
      await delay(35);
    }
    throw Error('Timed out: ' + label);
  }
  async function refresh() {
    if (updating || shuttingDown) return;
    updating = true;
    try {
      latest = await rpc('snapshot');
      await js('window.renderSnapshot(' + JSON.stringify(latest) + ')');
    } finally { updating = false; }
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y}})()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(75);
  }
  async function shot(name) {
    await delay(120);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
  }
  async function start(kind, jobId) {
    await rpc('start', { kind, jobId });
    return jobId;
  }
  async function pending(jobId) {
    await until(() => latest?.pendingPermissions?.some(row => row.operationId === 'call-' + jobId), 'broker pending ' + jobId);
    const row = latest.pendingPermissions.find(item => item.operationId === 'call-' + jobId);
    await until(`document.querySelector('.access-request [data-ui-value=once]')?.dataset.permissionRequest===${JSON.stringify(row.requestId)}`, 'overlay ' + jobId);
    return row;
  }
  async function complete(jobId, allowed) {
    await until(() => latest?.jobs[jobId]?.done, 'operation complete ' + jobId);
    const result = latest.jobs[jobId];
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.allowed, allowed); assert.equal(result.exists, allowed);
    assert.equal(fs.existsSync(result.output), allowed);
    if (allowed) assert.equal(fs.readFileSync(result.output, 'utf8'), '# Permission verified\nActual isolated output.\n');
    await until('!document.querySelector(".access-request")?.checkVisibility()', 'overlay closed');
    return result;
  }
  async function choose(jobId, decision, allowed) {
    await click('.access-request [data-ui-value=' + decision + ']');
    return complete(jobId, allowed);
  }
  async function verifyLayout(name) {
    const result = await js(`(()=>{const d=document.querySelector('.access-request'),r=d.getBoundingClientRect(),b=document.querySelector('.nbox').getBoundingClientRect(),buttons=[...d.querySelectorAll('[data-ui-answer]')];return{width:innerWidth,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,overflow:d.scrollWidth>d.clientWidth+1,centerDelta:Math.abs((r.left+r.right-b.left-b.right)/2),buttons:buttons.map(x=>({decision:x.dataset.uiValue,text:x.textContent,top:x.getBoundingClientRect().top})),accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),primary:getComputedStyle(d.querySelector('.primary')).backgroundColor,locale:SoduWorkI18n.getLocale?.()};})()`);
    assert.equal(result.inside, true, JSON.stringify(result)); assert.equal(result.overflow, false);
    assert.ok(result.centerDelta <= 2);
    assert.ok(result.buttons.every(button => Math.abs(button.top - result.buttons[0].top) < 2));
    report.layouts.push({ name, ...result }); await shot(name);
  }
  app.whenReady().then(async () => {
    const interpreter = process.env.SODUWORK_E2E_PYTHON || 'D:/soduwork/access-controls/hub-backend/.venv/Scripts/python.exe';
    python = spawn(interpreter, ['-u', path.join(repo, 'hub-backend/tests/codex_permission_browser_server.py'), root],
      { cwd: path.join(repo, 'hub-backend'), windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let ready;
    const started = new Promise((resolve, reject) => { ready = resolve; python.on('error', reject); });
    python.stderr.on('data', chunk => report.errors.push('fixture: ' + chunk.toString()));
    readline.createInterface({ input: python.stdout }).on('line', line => {
      try {
        const row = JSON.parse(line);
        if (row.event === 'ready') { latest = row; ready(row); return; }
        const waiter = replies.get(row.id);
        if (waiter) { replies.delete(row.id); row.error ? waiter.reject(Error(row.error)) : waiter.resolve(row.result); }
      } catch (error) { report.errors.push('protocol: ' + error.message); }
    });
    await Promise.race([started, delay(10000).then(() => { throw Error('Python fixture did not start'); })]);
    win = new BrowserWindow({ show: false, width: 1120, height: 850, webPreferences: {
      preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, callback) => callback({ cancel: true }));
    const handle = { attachedWindow: win, async answerUi(value) {
      report.answers.push(value);
      const answer = await rpc('answer', value); return { ...answer, reason: answer.error || '' };
    } };
    ipcMain.handle('pi-session-answer-ui', require('../main/access-control/ipc').answerHandler({ get: value => value === ref ? handle : null }));
    const html = path.join(root, 'permission.html');
    fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>Isolated permission verification</title><main id="chat"><section class="fixture-conversation"><h1>SoduWork</h1><p>Permission verification · isolated workspace</p></section><div class="nchat-entry-dock"><div class="nbox"><textarea aria-label="Message"></textarea><div class="fixture-footer">Codex Harness · Default permissions</div></div></div></main>');
    await win.loadFile(html);
    for (const file of ['theme/variables.css', 'components/panels/access-controls.css']) {
      await js('(()=>{const s=document.createElement("style");s.textContent=' + JSON.stringify(read(file)) + ';document.head.appendChild(s)})()');
    }
    await js(`(()=>{const s=document.createElement('style');s.textContent='*{box-sizing:border-box}body{margin:0;background:var(--bg-0);font:15px var(--font-ui);color:var(--ink)}#chat{height:100vh;padding:28px 18px;display:flex;flex-direction:column;align-items:center}.fixture-conversation{width:min(100%,940px);flex:1;padding:12px;color:var(--ink-3)}.fixture-conversation h1{font-size:24px;color:var(--ink)}.nchat-entry-dock{position:relative;width:min(100%,940px)}.nbox{border:1px solid var(--line-3);border-radius:22px;overflow:hidden;background:var(--bg-0)}textarea{display:block;width:100%;height:100px;border:0;outline:0;resize:none;background:transparent}.fixture-footer{padding:12px 20px;border-top:1px solid var(--line);font-size:13px;color:var(--ink-3)}';document.head.appendChild(s)})()`);
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file) + '\nvoid 0;');
    for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/access-controls.js']) await js(read(file) + '\nvoid 0;');
    await js(`window.renderSnapshot=snapshot=>{window.currentSnapshot=snapshot;AccessControls.sync(document.querySelector('#chat'),${JSON.stringify(ref)},snapshot,text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),button=>AccessControls.answer(button,soduWorkAPI.conversationSession,${JSON.stringify(ref)}))};SoduWorkI18n.setLocale('zh-CN');document.documentElement.dataset.theme='azure';`);
    await refresh();
    poll = setInterval(() => refresh().catch(error => report.errors.push(error.message)), 40);

    await start('diff', 'file-diff'); const diff = await pending('file-diff');
    assert.equal(diff.allowSession, false); assert.match(diff.target, /file-diff\.md$/);
    assert.equal(diff.arguments.changes[0].newText, '# Permission verified\nActual isolated output.\n');
    assert.equal(await js('Boolean(document.querySelector(".access-request [data-ui-value=session]"))'), false);
    await click('.access-request summary');
    assert.equal(await js('document.querySelector(".access-request").textContent.includes("input: null")'), false);
    assert.equal(await js('document.querySelector(".access-request").textContent.includes("Actual isolated output.")'), true);
    for (const [width, locale, theme] of [[1120, 'zh-CN', 'azure'], [1120, 'en-US', 'ruby'], [360, 'zh-CN', 'ruby'], [360, 'en-US', 'azure']]) {
      win.setSize(width, 850); await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
      await delay(120); await verifyLayout('file-diff-' + width + '-' + locale + '-' + theme);
    }
    await choose('file-diff', 'once', true);
    report.cases.push('Metadata-only Codex edit recovers live path/diff, shows only once/deny, and writes exact isolated bytes only after real mouse consent.');
    win.setSize(1120, 850); await delay(100);
    await start('missing', 'missing-details'); await pending('missing-details');
    assert.equal(await js('Boolean(document.querySelector(".access-request [data-ui-value=session]"))'), false);
    await shot('missing-input-never-session'); await choose('missing-details', 'deny', false);
    await start('deny-diff', 'denied-file'); await pending('denied-file'); await choose('denied-file', 'deny', false);
    report.cases.push('Missing operation details and denied edits never execute or receive reusable permission.');

    await start('command', 'shell-first'); const shell = await pending('shell-first');
    assert.equal(shell.action, 'native.command'); assert.equal(shell.tool, 'codex.shell');
    for (const [width, locale, theme] of [[1120, 'zh-CN', 'azure'], [360, 'zh-CN', 'ruby'], [360, 'en-US', 'azure']]) {
      win.setSize(width, 850); await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
      await delay(120); await verifyLayout('shell-three-buttons-' + width + '-' + locale + '-' + theme);
    }
    await choose('shell-first', 'session', true);
    win.setSize(1120, 850); await delay(100);
    const answersBefore = report.answers.length;
    await rpc('next-turn'); await start('command', 'shell-next-turn'); await complete('shell-next-turn', true);
    assert.equal(report.answers.length, answersBefore); assert.equal(latest.pendingPermissions.length, 0);
    report.cases.push('An exact native Codex command retains consent across a new turn and changed itemId/title/reason.');

    await start('browser-goto', 'browser-first'); const browser = await pending('browser-first');
    assert.equal(browser.sessionScope?.kind, 'browser-preview', JSON.stringify(browser));
    for (const [width, height, locale, theme] of [[1120, 850, 'en-US', 'azure'], [360, 700, 'zh-CN', 'ruby'], [360, 700, 'en-US', 'azure']]) {
      win.setSize(width, height); await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
      await delay(120); await verifyLayout('browser-preview-scope-' + width + '-' + locale + '-' + theme);
      const text = await js('document.querySelector(".access-request").textContent');
      assert.match(text, locale === 'zh-CN' ? /会话授权范围/ : /Chat permission scope/);
    }
    await choose('browser-first', 'session', true);
    win.setSize(1120, 850); await delay(100);
    const browserAnswers = report.answers.length;
    for (const kind of ['browser-shot', 'browser-errors', 'browser-title', 'browser-scroll', 'browser-do', 'browser-shot-again', 'browser-anchor']) {
      await start(kind, kind); await complete(kind, true);
    }
    assert.equal(report.answers.length, browserAnswers);
    report.cases.push('Explicit page-preview session consent covers later screenshots, errors, literal title/scroll, bounded combined preview steps and local anchors without another prompt. Current-page actions do not assert that the page URL is local.');
    for (const kind of ['browser-arbitrary-js', 'browser-outside', 'browser-network']) {
      await start(kind, kind); const row = await pending(kind);
      assert.equal(row.sessionScope?.kind, undefined);
      await choose(kind, 'deny', false);
    }
    report.cases.push('Arbitrary page JavaScript, writes outside the workspace and external URLs still request separate consent; denial creates no output.');
    await start('browser-arbitrary-js', 'repeat-denial'); await complete('repeat-denial', false);
    assert.equal(report.answers.at(-1).decision, 'deny');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(error => { report.failure = error.stack || String(error); console.error(error); }).finally(async () => {
    shuttingDown = true; clearInterval(poll);
    try { if (python && !python.killed) await rpc('close'); } catch (_) { /* preserve the primary failure */ }
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) { /* cleanup */ }
    if (python && !python.killed) python.kill();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, layouts: report.layouts.length, report: path.join(out, 'results.json'), failure: report.failure || null }));
    app.exit(report.ok ? 0 : 1);
  });
}
